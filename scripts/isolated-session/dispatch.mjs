#!/usr/bin/env node
/**
 * Runs a command inside another user's macOS session.
 *
 * The controller writes a job into the shared directory; the session agent
 * (running in that user's session) picks it up and runs it there. The
 * controller waits for the result and checks that it really came from that
 * session — a result that names another user, or no session at all, is
 * refused rather than believed.
 *
 *   node dispatch.mjs --uid 502 -- node /path/to/e2e.mjs
 *
 * What this does *not* do: nothing here enters the other user's session by
 * force. There is no `sudo`, no `launchctl asuser`, no TCC database edit.
 * The other session has to exist because that user logged in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOutcomeSession,
  assertResultSession,
  assertTargetSession,
  consoleAsid,
  ensureSharedDir,
  consoleUid,
  guiDomainError,
  readGuiSession,
  readOffstageStatus,
  targetSessionFrom,
} from "./session-rules.mjs";
import { randomUUID } from "node:crypto";

const DEFAULT_ROOT = "/Users/Shared/ae-a8n";
/**
 * How much of the controller's `--timeout` the job does not get.
 *
 * The agent stops the job and then publishes the result; the controller
 * keeps polling until its own deadline. If both deadlines were the same, the
 * controller could give up on a job that had just ended, reporting "no
 * result was produced" for a run that produced one.
 */
const AGENT_STOP_MARGIN_MS = 15_000;

export function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let uid;
  let cwd;
  let timeoutMs = 15 * 60_000;
  const command = [];
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--root") {
      root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--uid") {
      uid = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      cwd = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      const raw = argv[index + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        // NaN reaches the deadline arithmetic and turns it into "never", which
        // is the one value this flag must not silently mean.
        throw new Error(`--timeout needs a positive number of milliseconds, not ${String(raw)}`);
      }
      timeoutMs = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  for (; index < argv.length; index += 1) {
    command.push(argv[index]);
  }
  return { root: resolve(root), uid, cwd, timeoutMs, command };
}

/** The account name of a uid, or null. */
function usernameOf(uid) {
  try {
    return execFileSync("id", ["-un", String(uid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The target session, as far as this controller can see it.
 *
 * From the console session, another user's launchd domain is unreadable
 * ("Operation not permitted"), so the launchd document alone would report a
 * logged-in account as absent. offstage can see the session from inside it.
 *
 * offstage's answer is used only when it says the session is there. Its
 * "unavailable" is about offstage's own helper daemon, not about whether the
 * account has a GUI session, so it is not treated as an answer.
 *
 * offstage's session number is not launchd's asid (docs/offstage-macos.md
 * §10.12), so it is not carried as one.
 */
export function readTargetSession(uid) {
  const username = usernameOf(uid);
  const status = username === null ? null : readOffstageStatus(username);
  return targetSessionFrom(status, readGuiSession(uid));
}

/**
 * Whether a result file may be read.
 *
 * The results directory is 1777 so the target account can write there; that
 * also means another local process could leave a plausible-looking file at a
 * guessed job id. Only a regular file written by the target uid, with no
 * group/other write bit, is read as that job's result. `lstat` (not `stat`),
 * so a symlink planted at the result path is refused rather than followed.
 */
export function assertTrustedResult(path, targetUid) {
  const info = lstatSync(path);
  if (!info.isFile()) {
    throw new Error(`the result ${path} is not a regular file; it is not trusted.`);
  }
  if (info.uid !== targetUid) {
    throw new Error(
      `the result ${path} was written by uid ${info.uid}, not by the target uid ${targetUid}; it is not trusted.`,
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(
      `the result ${path} is writable by group or others, so it could have been changed after it was written; ` +
        "it is not trusted.",
    );
  }
}


function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.uid === undefined || !Number.isInteger(options.uid)) {
    throw new Error("pass --uid <the test user's uid>");
  }
  if (options.command.length === 0) {
    throw new Error("pass the command to run after --");
  }
  const session = readTargetSession(options.uid);
  if (session === null) {
    // Neither offstage nor launchd could describe the session. Say which, so
    // "cannot read another user's launchd domain" is not reported as "that
    // user is not logged in".
    const reason = guiDomainError(options.uid);
    throw new Error(
      `the session of uid ${options.uid} could not be confirmed from this session` +
        (reason === null ? "" : `: ${reason}`) +
        ". Check `offstage session status`; nothing was run.",
    );
  }
  assertTargetSession(session, options.uid, consoleUid());
  const jobs = join(options.root, "jobs");
  const results = join(options.root, "results");
  for (const dir of [jobs, results]) {
    ensureSharedDir(dir, "job");
  }
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const jobPath = join(jobs, `${id}.job.json`);
  const resultPath = join(results, `${id}.result.json`);
  // Published by rename: the agent polls this directory, and a direct write
  // can be read half-finished and turned into a parse error for a job that
  // was never run. 0644: the agent accepts only a file it can attribute —
  // group/other write bits would let another local process replace the
  // payload between the write and the agent's read.
  const temporary = `${jobPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  // The deadline travels with the job: the agent runs the command inside the
  // target session, where a hung child would otherwise own its only poll loop
  // and keep After Effects open for every later run. Shorter than the
  // controller's own wait, so the agent's timeout result is published before
  // the controller stops looking for one.
  const timeoutMs = Math.max(1_000, options.timeoutMs - AGENT_STOP_MARGIN_MS);
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          id,
          command: options.command,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          timeoutMs,
          session: { uid: options.uid, asid: session.asid },
        },
        null,
        2,
      ),
      { mode: 0o644 },
    );
    renameSync(temporary, jobPath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw error;
  }
  process.stderr.write(
    `[ae-a8n dispatch] job ${id} → ${session.username} (uid ${options.uid}` +
      (session.asid === null ? "" : `, asid ${session.asid}`) +
      ")\n",
  );
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (existsSync(resultPath)) {
      assertTrustedResult(resultPath, options.uid);
      const result = JSON.parse(readFileSync(resultPath, "utf-8"));
      // The path is not the identity: a local process can hardlink a stale
      // result (from an earlier run, or another job) to this id's path, and it
      // would pass the file, owner and mode checks while describing a
      // different job. The agent already binds its own payload this way.
      if (result?.id !== id) {
        throw new Error(
          `the result ${resultPath} says id ${String(result?.id)}, not ${id}; it is not trusted.`,
        );
      }
      rmSync(jobPath, { force: true });
      assertResultSession(result, options.uid);
      // The console may have moved while the job ran (a fast user switch is
      // how the helper session is reached). The agent reports what it saw;
      // the controller checks it against the console *now*, which it can read
      // itself.
      const consoleNow = consoleUid();
      assertOutcomeSession(
        {
          uid: result.session?.uid,
          asid: result.session?.asid ?? null,
          onConsole: result.onConsole === true,
        },
        { uid: options.uid },
        { uid: consoleNow, asid: consoleAsid(consoleNow) },
      );
      // Collected. The file is target-owned and the directory is sticky, but
      // leaving it would only give a later run more material to hardlink.
      rmSync(resultPath, { force: true });
      // Only a genuine agent refusal omits the exit code. A failing command
      // also arrives with `ok: false`, but carries the child's numeric exit
      // status — reading that as "the job was refused" mislabels an ordinary
      // test failure as a security decision, and returns before the e2e's own
      // step log (on stdout) is echoed.
      if (result.exitCode === undefined) {
        if (typeof result.error === "string" && result.error.length > 0) {
          process.stderr.write(`[ae-a8n dispatch] the job was refused: ${result.error}\n`);
        }
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `[ae-a8n dispatch] job ${id} finished in ${result.session?.username}'s session (uid ${result.session?.uid}, ` +
          `asid ${result.session?.asid}), exit ${result.exitCode}\n`,
      );
      if (typeof result.stdout === "string" && result.stdout.length > 0) {
        process.stdout.write(result.stdout);
      }
      if (typeof result.stderr === "string" && result.stderr.length > 0) {
        process.stderr.write(result.stderr);
      }
      process.exitCode = result.exitCode ?? 0;
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the job ${id} did not finish within ${options.timeoutMs}ms; no result was produced`);
    }
    execFileSync("sleep", ["0.5"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ae-a8n dispatch refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
