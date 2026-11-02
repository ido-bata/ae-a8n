#!/usr/bin/env node
/**
 * Runs a command inside another user's macOS session, and proves afterwards
 * that it really ran there.
 *
 *   node run-in-isolated-session.mjs --user test -- node ae-e2e.mjs
 *
 * Two substrates, one contract:
 *
 *   offstage (default)  `offstage run --lane session --user <user> -- …`
 *                       The helper account owns a second, logged-in Aqua
 *                       session with its own framebuffer and HID stream.
 *                       offstage never falls back to the console session.
 *   native              a job file the session agent (running inside that
 *                       session) picks up. No global install, but the agent
 *                       has to be started in the target session first.
 *
 * What this runner does *not* do: it never enters the other user's session by
 * force. There is no `sudo`, no `launchctl asuser`, no TCC database edit.
 * The other session has to exist because that user logged in.
 *
 * What it refuses:
 *   - a target user who has no graphical session, or who owns the console;
 *   - a machine where After Effects is already running (Adobe allows one OS
 *     user at a time), and it never kills a process;
 *   - a result that does not name the requested session.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoRunningAfterEffects, assertResultSession, assertTargetSession, parseAeProcesses } from "./session-rules.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = resolve(SELF, "..");

function parseArgs(argv) {
  const options = {
    user: undefined,
    substrate: "offstage",
    root: "/Users/Shared/ae-a8n",
    timeoutMs: 20 * 60_000,
    report: undefined,
    command: [],
  };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--user") {
      options.user = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--substrate") {
      options.substrate = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--root") {
      options.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--report") {
      options.report = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  for (; index < argv.length; index += 1) {
    options.command.push(argv[index]);
  }
  return options;
}

function commandOutput(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
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

function consoleUid() {
  try {
    return Number(commandOutput("stat", ["-f", "%u", "/dev/console"]));
  } catch {
    return -1;
  }
}

function uidOfUser(user) {
  const text = commandOutput("id", ["-u", user]);
  if (!/^\d+$/.test(text)) {
    throw new Error(`cannot resolve the uid of "${user}"`);
  }
  return Number(text);
}

/** The offstage command on the PATH, or null. */
function offstageBinary() {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, "offstage");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Everything that has to be true before a test may start, whatever the
 * substrate. Each check refuses rather than repairs.
 */
export function preflight({ user, targetUid, consoleUidValue, psOutput, binary }) {
  const session = assertTargetSession(readGuiSession(targetUid), targetUid, consoleUidValue);
  assertNoRunningAfterEffects(parseAeProcesses(psOutput));
  if (binary === null) {
    throw new Error(
      "the offstage command was not found. Install it with `npm i -g @exla/offstage`, or run the native " +
        "substrate (`--substrate native`) with a session agent started in the target session.",
    );
  }
  return { session, user };
}

function runOffstage(options, targetUid) {
  const args = ["run", "--lane", "session", "--user", options.user, "--timeout", String(options.timeoutMs), "--"];
  const child = spawnSync("offstage", [...args, ...options.command], { stdio: "inherit", shell: false });
  if (child.error) {
    throw child.error;
  }
  // 69 means the substrate was unavailable and offstage skipped the run: the
  // command did not run anywhere, and that is not a test result.
  if (child.status === 69) {
    throw new Error(
      "offstage skipped the run: the isolated session was not available (nothing ran anywhere). " +
        "Check `offstage session status`.",
    );
  }
  return child.status ?? 1;
}

function runNative(options, targetUid) {
  const args = [join(HERE, "dispatch.mjs"), "--root", options.root, "--uid", String(targetUid), "--timeout", String(options.timeoutMs), "--"];
  const child = spawnSync(process.execPath, [...args, ...options.command], { stdio: "inherit", shell: false });
  if (child.error) {
    throw child.error;
  }
  if (child.status === 69) {
    throw new Error("the session agent did not run the job; nothing ran anywhere.");
  }
  return child.status ?? 1;
}

/**
 * The report the end-to-end run writes. It is only believed when it names
 * the session it was asked to run in.
 */
function readReport(path, targetUid) {
  if (!existsSync(path)) {
    throw new Error(`the run wrote no report at ${path}; the result is not trusted.`);
  }
  const report = JSON.parse(readFileSync(path, "utf-8"));
  assertResultSession(report, targetUid);
  if (report.session?.isolated !== true) {
    throw new Error(
      `the run reported that it was not isolated (uid ${report.session?.uid}, console uid ` +
        `${report.session?.consoleUid}); the result is not trusted.`,
    );
  }
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.user === undefined) {
    throw new Error("pass --user <the test user's name>");
  }
  if (options.command.length === 0) {
    throw new Error("pass the command to run after --");
  }
  const targetUid = uidOfUser(options.user);
  const consoleUidValue = consoleUid();
  const binary = options.substrate === "native" ? "native" : offstageBinary();
  preflight({
    user: options.user,
    targetUid,
    consoleUidValue,
    psOutput: commandOutput("ps", ["-axo", "pid=,uid=,comm="]),
    binary,
  });
  process.stderr.write(
    `[ae-a8n] running in ${options.user}'s session (uid ${targetUid}); the console is uid ${consoleUidValue}. ` +
      `Substrate: ${options.substrate}.\n`,
  );
  const status =
    options.substrate === "native" ? runNative(options, targetUid) : runOffstage(options, targetUid);
  if (options.report !== undefined && status === 0) {
    const report = readReport(options.report, targetUid);
    process.stderr.write(
      `[ae-a8n] the run reported session uid ${report.session.uid} (asid ${report.session.asid}), ` +
        `console uid ${report.session.consoleUid}.\n`,
    );
  }
  process.exitCode = status;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ae-a8n refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
