#!/usr/bin/env node
/**
 * The job runner for an isolated macOS session.
 *
 * It runs **inside** the session of the test user — the one that was logged
 * in through a fast user switch, not the console session. Everything it does
 * therefore happens in that session: the After Effects it starts is that
 * user's, the Apple Events it sends go to that user's After Effects, and the
 * screen it captures is that user's screen.
 *
 * The controller (another session, often the console one) writes a job file;
 * this agent picks it up, runs it, and writes the result back. No root, no
 * `launchctl asuser`, no TCC database editing: the agent is an ordinary
 * program in an ordinary logged-in session.
 *
 *   node session-agent.mjs --root /Users/Shared/ae-a8n
 *
 * Job file:   <root>/jobs/<id>.job.json   { "id": "...", "command": ["node", "..."] }
 * Result:     <root>/results/<id>.result.json
 * Log:        <root>/logs/<id>.log
 */
import { readdir, readFile, writeFile, appendFile, lstat, rename, rm } from "node:fs/promises";
import { execFile, execFileSync as syncExecFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { assertJobSession, consoleUid, ensureSharedDir, jobFileIsTrusted } from "./session-rules.mjs";

const DEFAULT_ROOT = "/Users/Shared/ae-a8n";
const POLL_MS = 500;
/** The exit status `timeout(1)` uses, so a killed job is not read as exit 1. */
const TIMEOUT_EXIT_CODE = 124;
/**
 * How long a job that ignored SIGTERM gets before it is killed outright.
 * Without it, a child that never exits (an After Effects blocked on a dialog)
 * would keep the agent's single poll loop stuck forever.
 */
const KILL_GRACE_MS = 5_000;

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let allowUid;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      root = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--allow-uid") {
      allowUid = Number(argv[index + 1]);
      index += 1;
    }
  }
  return { root: resolve(root), allowUid };
}

/** The login session this process is in, as macOS reports it. */
function readSession() {
  try {
    const text = syncExecFileSync("launchctl", ["print", `gui/${process.getuid()}`], { encoding: "utf-8" });
    const asid = /\b(?:gui )?asid = (\d+)/.exec(text);
    const kind = /^\s*session = (\w+)\s*$/m.exec(text);
    return {
      uid: process.getuid(),
      username: syncExecFileSync("id", ["-un"], { encoding: "utf-8" }).trim(),
      asid: asid === null ? null : Number(asid[1]),
      kind: kind === null ? "none" : kind[1],
    };
  } catch {
    return { uid: process.getuid(), username: "unknown", asid: null, kind: "none" };
  }
}

async function main() {
  const { root, allowUid } = parseArgs(process.argv.slice(2));
  const jobs = join(root, "jobs");
  const results = join(root, "results");
  const logs = join(root, "logs");
  const session = readSession();
  const consoleUidNow = consoleUid();
  if (session.uid === consoleUidNow) {
    // Running jobs here would run them on the screen the human is looking
    // at. That is the one thing this agent exists to avoid, so it refuses
    // rather than warn: measured 2026-11-03, an agent left running in the
    // console session would otherwise have executed any job it found.
    process.stderr.write(
      `[ae-a8n session agent] refusing to start: uid ${session.uid} owns the console. ` +
        "This agent must run inside the isolated account's own GUI session. No job is run.\n",
    );
    process.exitCode = 1;
    return;
  }
  // Jobs are accepted only from the account that drives the session (the
  // console user, unless one is named). The jobs directory is world-writable
  // so the other account can write there; without this check any local
  // process could have code run as the test user.
  const trustedUid = Number.isInteger(allowUid) ? allowUid : consoleUidNow;
  if (!Number.isInteger(trustedUid) || trustedUid < 0) {
    process.stderr.write(
      "[ae-a8n session agent] refusing to start: the controlling uid could not be determined " +
        "(pass --allow-uid). No job is run.\n",
    );
    process.exitCode = 1;
    return;
  }
  // Only now, having refused every reason to not run at all, touch the
  // shared directories.
  for (const [dir, what] of [
    [jobs, "job"],
    [results, "result"],
    [logs, "log"],
  ]) {
    ensureSharedDir(dir, what);
  }
  const banner = {
    startedAt: new Date().toISOString(),
    session,
    consoleUid: consoleUidNow,
    trustedUid,
    isolated: session.uid !== consoleUidNow,
  };
  // Diagnostic only: no job depends on it. A file the other account left
  // behind in the sticky results directory cannot be replaced from here
  // (EACCES), and that must not stop the agent.
  try {
    await writeResult(join(results, "agent.json"), JSON.stringify(banner, null, 2));
  } catch (error) {
    process.stderr.write(
      `[ae-a8n session agent] could not write the startup banner: ${
        error instanceof Error ? error.message : String(error)
      }. Continuing.\n`,
    );
  }
  process.stdout.write(
    `[ae-a8n session agent] uid ${session.uid} (${session.username}), session ${session.kind} asid ${session.asid}, ` +
      `console uid ${consoleUidNow}, accepting jobs from uid ${trustedUid}. Waiting for jobs in ${jobs}\n`,
  );

  // Files that were looked at and refused. Without this, a foreign file in the
  // shared directory (a symlink, or one writable by everyone) is re-checked
  // and re-reported every poll, and the log fills with the same line forever.
  const ignored = new Set();

  for (;;) {
    let entries = [];
    try {
      entries = await readdir(jobs);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".job.json")) continue;
      const id = entry.slice(0, -".job.json".length);
      const jobPath = join(jobs, entry);
      const resultPath = join(results, `${id}.result.json`);
      if (existsSync(resultPath)) {
        // Already done; the controller has not collected it yet.
        continue;
      }
      if (ignored.has(entry)) {
        continue;
      }
      if (!(await isTrustedJob(jobPath, trustedUid))) {
        ignored.add(entry);
        process.stderr.write(
          `[ae-a8n session agent] ignored ${entry}: it is not a file written by uid ${trustedUid}. No job was run.\n`,
        );
        continue;
      }
      try {
        await handleJob({ id, jobPath, resultPath, logs, session });
      } catch (error) {
        // Publishing the result can fail (a foreign file at the result path in
        // the sticky directory, a full disk). The command itself may already
        // have run, so the id is recorded: re-running it on the next poll
        // would run it twice. The agent stays alive for later jobs; this one's
        // controller times out.
        ignored.add(entry);
        process.stderr.write(
          `[ae-a8n session agent] could not publish a result for ${id}: ${
            error instanceof Error ? error.message : String(error)
          }. The job is not re-run; the controller will time out.\n`,
        );
      }
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/**
 * Reads, checks and runs one job, and publishes its result.
 *
 * Throws when the result could not be published — the caller keeps the agent
 * alive and remembers the id. It never throws for a job that was refused:
 * that refusal *is* a result, and the controller is entitled to read it.
 */
async function handleJob({ id, jobPath, resultPath, logs, session }) {
  let job;
  try {
    job = JSON.parse(await readFile(jobPath, "utf-8"));
  } catch (error) {
    await writeResult(resultPath, {
      id,
      ok: false,
      error: `the job file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      session,
      startedAt: new Date().toISOString(),
    });
    return;
  }
  try {
    assertJobSession(job, session);
    if (job?.id !== id) {
      throw new Error(`the job file says id ${job?.id}, not ${id}; it was not run.`);
    }
  } catch (error) {
    await writeResult(resultPath, {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      session,
      startedAt: new Date().toISOString(),
    });
    return;
  }
  await runJob({ id, job, resultPath, logs, session });
}

async function writeResult(path, payload) {
  // Published by rename: the controller polls for this path and parses it as
  // soon as it exists, so a direct write can be read half-finished.
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    // A rename over a file the other account owns is refused in a sticky
    // directory. Do not leave the half-written temporary behind.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Whether a job file may be run. The rule itself is in session-rules.mjs,
 * where it is checked without a second session; only the `lstat` is here.
 */
async function isTrustedJob(path, trustedUid) {
  try {
    return jobFileIsTrusted(await lstat(path), trustedUid);
  } catch {
    return false;
  }
}

/** Whether this account owns the console — including when that is unknowable. */
function consoleIsOwn(uid) {
  const consoleUidNow = consoleUid();
  return !Number.isInteger(consoleUidNow) || consoleUidNow < 0 || consoleUidNow === uid;
}

/**
 * Appends to a job's log without ever taking the agent down.
 *
 * A log is diagnostic: losing it must not lose the job. An un-awaited
 * `appendFile` that rejects (EACCES, a full disk) would be an unhandled
 * rejection, which Node turns into a process exit — stopping every later job
 * too, mid-run.
 */
function appendLog(logPath, id, chunk) {
  appendFile(logPath, chunk).catch((error) => {
    process.stderr.write(
      `[ae-a8n session agent] the log for ${id} could not be written: ${
        error instanceof Error ? error.message : String(error)
      }. The job continues.\n`,
    );
  });
}

/** The deadline the controller gave this job, or undefined for none. */
function jobTimeoutMs(job) {
  const value = job?.timeoutMs;
  // A payload written before the controller sent a deadline has no field, and
  // keeps the old no-timeout behaviour. Anything else that is not a positive
  // integer is not a deadline: it is not turned into "never" silently, the
  // refusal is that no deadline applies.
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function runJob({ id, job, resultPath, logs, session }) {
  const startedAt = new Date().toISOString();
  const logPath = join(logs, `${id}.log`);
  const command = Array.isArray(job.command) ? job.command : [];
  if (command.length === 0) {
    await writeResult(resultPath, { id, ok: false, error: "the job has no command", session, startedAt });
    return;
  }
  // A fast user switch is how the human reaches this session, and it can put
  // this account on the console while the agent is running. Checking only at
  // startup would then run jobs on the screen the human is looking at.
  if (consoleIsOwn(session.uid)) {
    await writeResult(resultPath, {
      id,
      ok: false,
      error:
        "this account owns the console now (or the console's owner cannot be read); the job was not run, " +
        "because running it would happen on the screen the user is looking at.",
      session,
      onConsole: true,
      startedAt,
    });
    return;
  }
  const cwd = typeof job.cwd === "string" ? job.cwd : process.cwd();
  appendLog(logPath, id, `--- ${startedAt} ${command.join(" ")}\n`);
  const timeoutMs = jobTimeoutMs(job);
  let killedForTimeout = false;
  const outcome = await new Promise((done) => {
    const child = execFile(
      command[0],
      command.slice(1),
      {
        cwd,
        env: { ...process.env, ...(job.env ?? {}) },
        maxBuffer: 64 * 1024 * 1024,
        // The controller's --timeout bounds its own poll; without passing it
        // on, a child that never returns (After Effects blocked on a dialog)
        // would own the agent's only poll loop forever, and would keep After
        // Effects open for every later run's preflight.
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGTERM" }),
      },
      (error, stdout, stderr) => {
        done({ error, stdout, stderr });
      },
    );
    if (timeoutMs !== undefined) {
      // `timeout` sends killSignal once. A child that ignores SIGTERM would
      // then never exit, so the callback above would never run and the loop
      // would still be stuck: escalate to SIGKILL, which cannot be ignored.
      const escalate = setTimeout(() => {
        killedForTimeout = true;
        child.kill("SIGKILL");
      }, timeoutMs + KILL_GRACE_MS);
      child.once("exit", () => clearTimeout(escalate));
    }
    child.stdout?.on("data", (chunk) => {
      appendLog(logPath, id, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendLog(logPath, id, chunk);
    });
  });
  const failed = outcome.error !== null && outcome.error !== undefined;
  const timedOut = failed && (outcome.error.killed === true || outcome.error.code === "ETIMEDOUT" || killedForTimeout);
  await writeResult(resultPath, {
    id,
    ok: !failed,
    // A killed job has no exit status of its own; 124 is `timeout(1)`'s, so a
    // timeout cannot be read as the child's ordinary exit 1.
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : typeof outcome.error?.code === "number" ? outcome.error.code : failed ? 1 : 0,
    ...(timedOut ? { timedOut: true } : {}),
    error: failed ? String(outcome.error.message ?? outcome.error) : undefined,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    session,
    // What the console looked like when the job finished. The controller
    // checks this; a job that ran while the console moved here did not run in
    // isolation, whatever its exit code.
    onConsole: consoleIsOwn(session.uid),
    startedAt,
    endedAt: new Date().toISOString(),
  });
  process.stdout.write(`[ae-a8n session agent] job ${id} finished\n`);
}

await main();
