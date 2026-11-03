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
import { readdir, readFile, writeFile, mkdir, appendFile, chmod, lstat, rename, rm, stat } from "node:fs/promises";
import { execFile, execFileSync as syncExecFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertJobSession,
  jobFileIsTrusted,
  sharedDirIsUsable,
  sharedDirIsUsableForOthers,
} from "./session-rules.mjs";

const DEFAULT_ROOT = "/Users/Shared/ae-a8n";
const POLL_MS = 500;

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

/** The user who owns the console right now. */
function readConsoleUid() {
  try {
    return Number(syncExecFileSync("stat", ["-f", "%u", "/dev/console"], { encoding: "utf-8" }).trim());
  } catch {
    return -1;
  }
}

async function main() {
  const { root, allowUid } = parseArgs(process.argv.slice(2));
  const jobs = join(root, "jobs");
  const results = join(root, "results");
  const logs = join(root, "logs");
  const session = readSession();
  const consoleUid = readConsoleUid();
  if (session.uid === consoleUid) {
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
  const trustedUid = Number.isInteger(allowUid) ? allowUid : consoleUid;
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
  for (const dir of [jobs, results, logs]) {
    await ensureSharedDir(dir);
  }
  const banner = {
    startedAt: new Date().toISOString(),
    session,
    consoleUid,
    trustedUid,
    isolated: session.uid !== consoleUid,
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
      `console uid ${consoleUid}, accepting jobs from uid ${trustedUid}. Waiting for jobs in ${jobs}\n`,
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
        continue;
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
        continue;
      }
      await runJob({ id, job, resultPath, logs, session });
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/**
 * The same rule as dispatch.mjs: the two accounts can start in either order,
 * and only a directory's owner can `chmod` it.
 */
async function ensureSharedDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o1777 });
  if (sharedDirIsUsable((await stat(dir)).mode)) {
    return;
  }
  try {
    await chmod(dir, 0o1777);
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
    if (!sharedDirIsUsableForOthers((await stat(dir)).mode)) {
      throw new Error(
        `the shared directory ${dir} belongs to another account and is not writable-and-sticky for others, ` +
          "so results could not be written there safely. No job is run.",
      );
    }
  }
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
  const consoleUid = readConsoleUid();
  return !Number.isInteger(consoleUid) || consoleUid < 0 || consoleUid === uid;
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
  await appendFile(logPath, `--- ${startedAt} ${command.join(" ")}\n`);
  const outcome = await new Promise((done) => {
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd, env: { ...process.env, ...(job.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        done({ error, stdout, stderr });
      },
    );
    child.stdout?.on("data", (chunk) => {
      void appendFile(logPath, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      void appendFile(logPath, chunk);
    });
  });
  await writeResult(resultPath, {
    id,
    ok: outcome.error === null || outcome.error === undefined,
    exitCode: typeof outcome.error?.code === "number" ? outcome.error.code : outcome.error === null || outcome.error === undefined ? 0 : 1,
    error: outcome.error === null || outcome.error === undefined ? undefined : String(outcome.error.message ?? outcome.error),
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
