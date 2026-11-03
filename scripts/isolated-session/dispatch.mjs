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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertResultSession, assertTargetSession } from "./session-rules.mjs";
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
    const text = execFileSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8" });
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
  const session = assertTargetSession(readGuiSession(options.uid), options.uid, consoleUid());
  const jobs = join(options.root, "jobs");
  const results = join(options.root, "results");
  for (const dir of [jobs, results]) {
    mkdirSync(dir, { recursive: true, mode: 0o1777 });
    // mkdir applies the umask to the mode it is given, so 1777 would come
    // out as 0755 and the other account could not write its result there.
    chmodSync(dir, 0o1777);
  }
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const jobPath = join(jobs, `${id}.job.json`);
  const resultPath = join(results, `${id}.result.json`);
  writeFileSync(
    jobPath,
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
    // The agent accepts only a file it can attribute: group/other write
    // bits would let another local process replace the payload between the
    // write and the agent's read. 0644 keeps it readable by the target user
    // and writable only by this one.
    { mode: 0o644 },
  );
  process.stderr.write(
    `[ae-a8n dispatch] job ${id} → ${session.username} (uid ${options.uid}, asid ${session.asid})\n`,
  );
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (existsSync(resultPath)) {
      assertTrustedResult(resultPath, options.uid);
      const result = JSON.parse(readFileSync(resultPath, "utf-8"));
      rmSync(jobPath, { force: true });
      assertResultSession(result, options.uid);
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
