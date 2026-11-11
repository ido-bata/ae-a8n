#!/usr/bin/env node
/**
 * Runs a command inside another user's macOS session, and proves afterwards
 * that it really ran there.
 *
 *   node run-in-isolated-session.mjs --user test -- node ae-e2e.mjs
 *
 * Three substrates, one contract:
 *
 *   terminal (default)  the command runs as a child of Terminal.app inside
 *                       the target session.
 *   offstage            `offstage run --lane session --user <user> -- …`
 *                       The helper account owns a second, logged-in Aqua
 *                       session with its own framebuffer and HID stream.
 *                       offstage never falls back to the console session.
 *   native              a job file the session agent (running inside that
 *                       session) picks up. No global install, but the agent
 *                       has to be started in the target session first.
 *
 * Why the terminal substrate is the default: macOS decides who may send
 * Apple Events, take a screenshot or read a window by the *responsible
 * process* — the nearest enclosing application bundle. The offstage daemon
 * is a bundle-less binary, so macOS cannot attribute anything to it and
 * refuses at once (measured: -1743, "no permission to send Apple Events",
 * with no prompt the human could ever see). Terminal.app is a bundle, so a
 * grant made to it in the target session appears in System Settings and is
 * inherited by the node process that runs the test.
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
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOutcomeSession,
  assertNoRunningAfterEffects,
  assertResultSession,
  assertTargetSession,
  consoleAsid,
  consoleUid,
  ensureSharedDir,
  parseAeProcesses,
  parseTerminalResult,
  readGuiSession,
  readOffstageStatus,
  resultFileIsTrusted,
  sessionFromOffstageStatus,
  shellCommandLine,
} from "./session-rules.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = resolve(SELF, "..");

function parseArgs(argv) {
  const options = {
    user: undefined,
    substrate: "terminal",
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
      const raw = argv[index + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        // NaN reaches the deadline arithmetic and turns it into "never", which
        // is the one value this flag must not silently mean.
        throw new Error(`--timeout needs a positive number of milliseconds, not ${String(raw)}`);
      }
      options.timeoutMs = value;
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

/**
 * Refuses a file in the shared results directory that the target account did
 * not write.
 *
 * The directory is 1777 so the job can write there; that also lets any local
 * process leave a plausible-looking `<id>.done` at a guessed id and have the
 * controller believe it. The job ids are not secrets: the `.command` files
 * next to them say what each id runs.
 */
function assertTrustedSharedFile(path, targetUid, what) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw new Error(`the ${what} ${path} could not be inspected: ${error instanceof Error ? error.message : String(error)}. It is not trusted.`);
  }
  if (!resultFileIsTrusted(info, targetUid)) {
    throw new Error(
      `the ${what} ${path} was not written by the target uid ${targetUid} as a regular file that nobody ` +
        "else can change; it is not trusted.",
    );
  }
}

function readTrustedOutput(path, targetUid, what) {
  assertTrustedSharedFile(path, targetUid, `${what} file`);
  return readFileSync(path, "utf-8");
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
 * The target session, as far as the controller can see it.
 *
 * Offstage's report is preferred: it is made from inside the target
 * session. The launchd document is the fallback, and it only works for a
 * controller that is already in that session (or root).
 */
export function resolveTargetSession(user, targetUid, offstageStatus) {
  const fromOffstage = sessionFromOffstageStatus(offstageStatus);
  if (fromOffstage !== null) {
    return fromOffstage;
  }
  return readGuiSession(targetUid);
}

/**
 * Everything that has to be true before a test may start, whatever the
 * substrate. Each check refuses rather than repairs.
 */
export function preflight({ user, targetUid, consoleUidValue, psOutput, binary, session }) {
  assertTargetSession(session, targetUid, consoleUidValue);
  assertNoRunningAfterEffects(parseAeProcesses(psOutput));
  if (binary === null) {
    throw new Error(
      "the offstage command was not found. Install it with `npm i -g @exla/offstage`, or run the native " +
        "substrate (`--substrate native`) with a session agent started in the target session.",
    );
  }
  return { session, user };
}

function runOffstage(options) {
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

/**
 * Runs the command as a child of Terminal.app inside the target session.
 *
 * Terminal.app is what makes the run possible at all: macOS attributes
 * permissions to the nearest enclosing application bundle, and the offstage
 * daemon is a bundle-less binary that macOS therefore refuses at once
 * (-1743, with no prompt the human could answer). Under Terminal the grant
 * is visible in System Settings and reaches the test process.
 *
 * The job writes down which session it ran in; the controller believes that
 * account only when it names the session it asked for.
 */
export function runTerminal(options, targetUid) {
  const root = resolve(options.root);
  const jobs = join(root, "jobs");
  const results = join(root, "results");
  for (const dir of [jobs, results]) {
    // The job runs as the other user and writes its own result there, so the
    // directory has to be writable by it: 1777. The shared helper tolerates a
    // directory the other account created first (chmod then refuses EPERM),
    // which a bare mkdir+chmod here would have turned into a refusal.
    ensureSharedDir(dir, "job");
  }
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const commandPath = join(jobs, `${id}.cmd`);
  const launcherPath = join(jobs, `${id}.command`);
  const donePath = join(results, `${id}.done`);
  const outPath = join(results, `${id}.out`);
  const errPath = join(results, `${id}.err`);

  // The command is written as data and read by a shell in the other session:
  // every word is quoted, so a path with a space or a quote stays one word.
  writeFileSync(commandPath, `${shellCommandLine(options.command)}\n`, { mode: 0o755 });
  writeFileSync(
    launcherPath,
    [
      "#!/bin/sh",
      "# Runs one job in this session and writes down where it ran.",
      `ROOT=${JSON.stringify(root)}`,
      `ID=${JSON.stringify(id)}`,
      `COMMAND=${JSON.stringify(commandPath)}`,
      `OUT=${JSON.stringify(outPath)}`,
      `ERR=${JSON.stringify(errPath)}`,
      `DONE=${JSON.stringify(donePath)}`,
      'cd / || exit 127',
      '/bin/sh "$COMMAND" > "$OUT" 2> "$ERR"',
      "code=$?",
      'asid=$(/bin/launchctl print "gui/$(/usr/bin/id -u)" 2>/dev/null | /usr/bin/sed -n "s/.*asid = \\([0-9]*\\).*/\\1/p" | /usr/bin/head -1)',
      'onconsole=0',
      // The console's owner, read from inside the job: 1 means this job ran
      // on the desktop the human is looking at.
      'if [ "$(/usr/bin/stat -f %u /dev/console)" = "$(/usr/bin/id -u)" ]; then onconsole=1; fi',
      "{",
      '  echo "uid=$(/usr/bin/id -u)"',
      '  echo "username=$(/usr/bin/id -un)"',
      '  echo "asid=$asid"',
      '  echo "onconsole=$onconsole"',
      '  echo "exit=$code"',
      // Published by rename, so the controller never reads a half-written
      // result. A direct write was measurable as a partial file under the
      // 500 ms poll; the temporary name is in the same directory, so the
      // rename stays atomic.
      '} > "$DONE.tmp" && /bin/mv -f "$DONE.tmp" "$DONE"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const opened = spawnSync(
    "offstage",
    ["session", "open", "--user", options.user, "--", "-a", "Terminal", launcherPath],
    { stdio: "inherit", shell: false },
  );
  if (opened.error) {
    throw opened.error;
  }
  if (opened.status !== 0) {
    throw new Error(
      `could not open Terminal.app in ${options.user}'s session (exit ${opened.status}); nothing ran. ` +
        "Check `offstage session status`.",
    );
  }
  process.stderr.write(
    `[ae-a8n] job ${id} opened in Terminal.app in ${options.user}'s session; waiting for it to finish.\n`,
  );

  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (existsSync(donePath)) {
      assertTrustedSharedFile(donePath, targetUid, "job's result");
      const outcome = parseTerminalResult(readFileSync(donePath, "utf-8"));
      // A file that exists is not necessarily finished; publish-by-rename
      // makes this rare, and `complete` turns "rarely" into "never read as a
      // result". Keep polling until every field is there.
      if (!outcome.complete) {
        if (Date.now() >= deadline) {
          throw new Error(
            `the job's result file never became complete: ${donePath}. No result is trusted.`,
          );
        }
        execFileSync("sleep", ["0.5"]);
        continue;
      }
      // The console is checked again here, not only in the preflight: the
      // human may have switched to the target session while the job ran, and
      // a job that ran on the console desktop is not an isolated run.
      const consoleUidValue = consoleUid();
      assertOutcomeSession(outcome, { uid: targetUid }, { uid: consoleUidValue, asid: consoleAsid(consoleUidValue) });
      const stdout = existsSync(outPath) ? readTrustedOutput(outPath, targetUid, "stdout") : "";
      const stderr = existsSync(errPath) ? readTrustedOutput(errPath, targetUid, "stderr") : "";
      if (stdout.length > 0) {
        process.stdout.write(stdout);
      }
      if (stderr.length > 0) {
        process.stderr.write(stderr);
      }
      process.stderr.write(
        `[ae-a8n] the job finished in ${outcome.username}'s session (uid ${outcome.uid}, asid ${outcome.asid}), ` +
          `exit ${outcome.exitCode}\n`,
      );
      return outcome.exitCode;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the job did not finish within ${options.timeoutMs}ms; no result was produced`);
    }
    execFileSync("sleep", ["0.5"]);
  }
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
  assertTrustedSharedFile(path, targetUid, "report");
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
  if (!["terminal", "offstage", "native"].includes(options.substrate)) {
    // A typo must not fall through to offstage: the runs differ in what they
    // touch, and the wrong one is not a smaller version of the right one.
    throw new Error(`unknown substrate "${options.substrate}"; pass terminal, offstage or native`);
  }
  if (options.user === undefined) {
    throw new Error("pass --user <the test user's name>");
  }
  if (options.command.length === 0) {
    throw new Error("pass the command to run after --");
  }
  const targetUid = uidOfUser(options.user);
  const consoleUidValue = consoleUid();
  const binary = options.substrate === "native" ? "native" : offstageBinary();
  // The offstage *status* is needed to resolve the session on every substrate,
  // native included: from the console, `launchctl print gui/<other uid>` is
  // refused ("Operation not permitted"), so offstage's in-session answer is
  // the only channel that works there. Reading status runs nothing.
  const offstageStatus = readOffstageStatus(options.user);
  const session = resolveTargetSession(options.user, targetUid, offstageStatus);
  preflight({
    user: options.user,
    targetUid,
    consoleUidValue,
    psOutput: commandOutput("ps", ["-axo", "pid=,uid=,comm="]),
    binary,
    session,
  });
  process.stderr.write(
    `[ae-a8n] running in ${options.user}'s session (uid ${targetUid}); the console is uid ${consoleUidValue}. ` +
      `Substrate: ${options.substrate}.\n`,
  );
  let status;
  if (options.substrate === "native") {
    status = runNative(options, targetUid);
  } else if (options.substrate === "terminal") {
    status = runTerminal(options, targetUid);
  } else {
    status = runOffstage(options);
  }
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
