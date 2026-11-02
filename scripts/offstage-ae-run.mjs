#!/usr/bin/env node
/**
 * Experimental macOS-only entry point for running a real AE test inside
 * offstage's background Aqua account. Does not set up accounts or TCC.
 *
 * Usage:
 *   node scripts/offstage-ae-run.mjs -- node /absolute/path/to/ae-test.mjs
 *
 * This is a preflight, NOT proof that Apple Events target the right session.
 * Do not make this the default test runner before the real-host gates in #49.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HELPER = "computeruse";
const LOCK = "/tmp/ae-a8n-offstage.lock";

function commandOutput(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function uid(value, description) {
  if (!/^\d+$/.test(value)) throw new Error(description + " is not a numeric UID");
  return Number(value);
}

/** Conservative: any exact AE binary (including another installed version) blocks launch. */
export function parseAeProcesses(psOutput) {
  const processes = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("cannot parse macOS process list; refusing to start After Effects");
    const executable = match[3];
    if (/(?:^|\/)After Effects$/.test(executable)) {
      processes.push({ pid: Number(match[1]), uid: Number(match[2]), executable });
    }
  }
  return processes;
}

/** A separate user is necessary but does not establish Apple Events routing. */
export function assertSessionIdentity(mode, selfUid, helperUid, consoleUid) {
  for (const value of [selfUid, helperUid, consoleUid]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid session UID; refusing");
  }
  if (helperUid === 0 || consoleUid === 0) {
    throw new Error("root/helper or unknown console session; refusing");
  }
  if (helperUid === consoleUid) {
    throw new Error("offstage helper is the physical console user; refusing");
  }
  if (mode === "parent" && selfUid === helperUid) {
    throw new Error("controller must run outside the helper account");
  }
  if (mode === "helper" && selfUid !== helperUid) {
    throw new Error("offstage did not switch to the expected helper UID; refusing");
  }
  if (mode === "helper" && selfUid === consoleUid) {
    throw new Error("session is on the physical console; refusing");
  }
}

export function offstageArguments(helperUid, command) {
  if (!command.length) throw new Error("pass a test command after --");
  return ["run", "--lane", "session", "--", process.execPath, SELF, "--helper", String(helperUid), "--", ...command];
}

function preflight(mode, expectedHelperUid) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid === undefined) {
    throw new Error("offstage AE isolation is supported only on Apple Silicon macOS");
  }
  const helperUid = uid(commandOutput("id", ["-u", HELPER]), "helper UID");
  const consoleUid = uid(commandOutput("stat", ["-f", "%u", "/dev/console"]), "console UID");
  if (expectedHelperUid !== undefined && helperUid !== expectedHelperUid) {
    throw new Error("helper UID changed between controller and session; refusing");
  }
  assertSessionIdentity(mode, process.getuid(), helperUid, consoleUid);
  const running = parseAeProcesses(commandOutput("ps", ["-axo", "pid=,uid=,comm="]));
  if (running.length) {
    throw new Error("After Effects already running (pid/uid: " +
      running.map((p) => p.pid + "/" + p.uid).join(", ") +
      "); quit it normally before testing. No process was killed.");
  }
  return helperUid;
}

function run(cmd, args) {
  const child = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(cmd + " ended with signal " + child.signal);
  process.exitCode = child.status ?? 1;
}

function main(argv) {
  const helperMode = argv[0] === "--helper";
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("usage: node scripts/offstage-ae-run.mjs -- <command> [args]");
  }
  const command = argv.slice(separator + 1);
  if (helperMode) {
    const expectedUid = uid(argv[1] ?? "", "expected helper UID");
    preflight("helper", expectedUid);
    // No shell, no direct desktop fallback: run only in the proven helper UID.
    run(command[0], command.slice(1));
    return;
  }
  if (argv[0] !== "--") throw new Error("unexpected arguments; use -- <command>");
  const helperUid = preflight("parent");
  // A machine-wide lock prevents this runner from starting overlapping AE tests.
  // A stale lock is intentionally not auto-reclaimed: inspect the host first.
  mkdirSync(LOCK, { mode: 0o700 });
  try {
    run("offstage", offstageArguments(helperUid, command));
  } finally {
    rmdirSync(LOCK);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("ae-a8n offstage preflight refused:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
