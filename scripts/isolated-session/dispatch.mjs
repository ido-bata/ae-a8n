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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOutcomeSession,
  assertResultSession,
  assertTargetSession,
  sharedDirIsUsable,
  sharedDirIsUsableForOthers,
  targetSessionFrom,
} from "./session-rules.mjs";
import { randomUUID } from "node:crypto";

const DEFAULT_ROOT = "/Users/Shared/ae-a8n";

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
      timeoutMs = Number(argv[index + 1]);
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

/** The login session of a uid, or null when that user is not logged in. */
export function readGuiSession(uid) {
  try {
    const text = execFileSync("launchctl", ["print", `gui/${uid}`], {
      encoding: "utf-8",
      // Captured, not inherited: from the console this call is refused, and
      // launchctl's complaint belongs in our error message, not on the
      // user's terminal.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const asid = /\b(?:gui )?asid = (\d+)/.exec(text);
    const kind = /^\s*session = (\w+)\s*$/m.exec(text);
    return {
      uid,
      username: execFileSync("id", ["-un", String(uid)], { encoding: "utf-8" }).trim(),
      asid: asid === null ? null : Number(asid[1]),
      kind: kind === null ? "none" : kind[1],
    };
  } catch {
    return null;
  }
}

export function consoleUid() {
  try {
    return Number(execFileSync("stat", ["-f", "%u", "/dev/console"], { encoding: "utf-8" }).trim());
  } catch {
    return -1;
  }
}

/** Why `launchctl print gui/<uid>` failed, or null when it did not. */
export function guiDomainError(uid) {
  try {
    execFileSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (error) {
    const text = error?.stderr;
    return (typeof text === "string" && text.trim().length > 0 ? text : String(error?.message ?? error)).trim();
  }
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

/** offstage's report of an account's session, or null when it cannot be had. */
export function readOffstageStatus(username) {
  try {
    const text = execFileSync("offstage", ["session", "status", "--user", username, "--json"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1));
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

/** The console session's id, read from the console owner's launchd domain. */
export function consoleAsid(uid) {
  if (!Number.isInteger(uid) || uid < 0) {
    return null;
  }
  try {
    const text = execFileSync("launchctl", ["print", `gui/${uid}`], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const asid = /asid = (\d+)/.exec(text);
    return asid === null ? null : Number(asid[1]);
  } catch {
    return null;
  }
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

/**
 * Makes a directory both accounts can use, whichever of them creates it.
 *
 * `mkdir` applies the umask, so the mode it is given comes out as 0755. The
 * directory then has to be `chmod`ed — but only its owner can do that, and
 * the other account may have created it (the agent and the controller can
 * start in either order). A directory that is already usable is left alone;
 * one that is not and cannot be fixed is a refusal, not a guess.
 */
function ensureSharedDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o1777 });
  if (sharedDirIsUsable(statSync(dir).mode)) {
    return;
  }
  try {
    chmodSync(dir, 0o1777);
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
    // Owned by the other account, so it cannot be fixed from here. It is
    // usable only if that account already made it writable by everyone *and*
    // sticky, so the other account cannot delete or replace files that are not
    // its own; the attribution checks then decide what may be read from it.
    if (!sharedDirIsUsableForOthers(statSync(dir).mode)) {
      throw new Error(
        `the shared directory ${dir} belongs to another account and is not writable-and-sticky for others, ` +
          "so the job could not be written there safely. Nothing was run.",
      );
    }
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
    ensureSharedDir(dir);
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
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          id,
          command: options.command,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
      if (result.ok === false || result.exitCode === undefined) {
        // A refused job is written with `ok: false` and no exit code. Reading
        // that as exit 0 would report the defense as a successful run.
        if (typeof result.error === "string" && result.error.length > 0) {
          process.stderr.write(`[ae-a8n dispatch] the job was refused: ${result.error}\n`);
        }
        process.exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
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
