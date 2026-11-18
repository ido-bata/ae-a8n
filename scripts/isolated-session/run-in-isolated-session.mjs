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
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertOutcomeSession,
  assertNoRunningAfterEffects,
  assertReportIsolation,
  assertResultSession,
  assertTargetSession,
  classifyJobArtifact,
  consoleAsid,
  consoleUid,
  describeMissingSession,
  ensureSharedDir,
  guiDomainError,
  isStaleTemporary,
  jobEntryKind,
  jobFileIsTrusted,
  logEntryKind,
  parseAgentBanner,
  parseAeProcesses,
  parseSessionAgentProcesses,
  parseTerminalResult,
  readGuiSession,
  readOffstageStatus,
  resultEntryKind,
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
  // The report's own `isolated` flag is not evidence on its own: check the
  // console owner it recorded. An unreadable /dev/console is -1, which must
  // never read as a proven difference from the run's uid.
  assertReportIsolation(report);
  return report;
}

/* ------------------------------------------------------------------ */
/* status / prune — T038                                              */
/*                                                                    */
/* `status` reports what the shared root, the session and the process */
/* list say about in-flight and leftover work. `prune` removes only   */
/* what this account owns and what provably can never run again. It   */
/* never kills a process, never deletes a result or a job that could  */
/* still produce one, and never retries anything.                     */
/* ------------------------------------------------------------------ */

function parseInspectArgs(argv) {
  const options = {
    user: undefined,
    root: "/Users/Shared/ae-a8n",
    json: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--user") {
      options.user = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--root") {
      options.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function listEntries(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names) {
    let info;
    try {
      info = lstatSync(join(dir, name));
    } catch {
      continue;
    }
    entries.push({ name, info });
  }
  return entries;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** The id a shared artifact belongs to, or null for a name that has none. */
function artifactId(name) {
  const match = /^(.*)\.(?:job\.json|result\.json|cancel|done|out|err)(?:\.\d+\.[0-9a-f]{8}\.tmp)?$/.exec(name);
  return match === null ? null : match[1];
}

/**
 * Scans the shared root's jobs/, results/ and logs/ directories.
 *
 * `targetUid` is the account jobs are expected to run as (results are
 * trusted only from it); `trustedUid` is the account allowed to publish job
 * files (the controller — the banner's `trustedUid` when an agent recorded
 * one, else the console uid, which is what the agent defaults to).
 * Everything is reported, nothing is acted on here.
 */
export function inspectSharedRoot(root, { targetUid, trustedUid, now = Date.now() }) {
  const jobsDir = join(root, "jobs");
  const resultsDir = join(root, "results");
  const logsDir = join(root, "logs");
  const inspection = {
    jobsDir,
    resultsDir,
    logsDir,
    jobs: [],
    results: [],
    logs: [],
    banner: null,
    findings: [],
  };
  const jobEntries = listEntries(jobsDir) ?? [];
  const resultEntries = listEntries(resultsDir) ?? [];
  const logEntries = listEntries(logsDir) ?? [];
  const resultNames = new Set(resultEntries.map((entry) => entry.name));
  const jobNames = new Set(jobEntries.map((entry) => entry.name));

  const jobStates = new Map();
  const pendingCancels = [];
  for (const { name, info } of jobEntries) {
    const kind = jobEntryKind(name);
    if (kind === "job") {
      const id = artifactId(name);
      const trusted = Number.isInteger(trustedUid) ? jobFileIsTrusted(info, trustedUid) : null;
      const job = trusted === true && info.isFile() ? readJson(join(jobsDir, name)) : null;
      const classified = classifyJobArtifact({
        trusted,
        job,
        hasResult: id !== null && resultNames.has(`${id}.result.json`),
        hasCancel: id !== null && jobNames.has(`${id}.cancel`),
        now,
      });
      jobStates.set(id ?? name, classified.state);
      inspection.jobs.push({
        id,
        name,
        kind,
        state: classified.state,
        reason: classified.reason,
        trusted,
        ownedBySelf: info.uid === process.getuid(),
        mtimeMs: info.mtimeMs,
      });
      continue;
    }
    if (kind === "job-tmp" || kind === "cancel-tmp") {
      inspection.jobs.push({
        id: artifactId(name),
        name,
        kind,
        stale: isStaleTemporary(info.mtimeMs, now),
        ownedBySelf: info.uid === process.getuid(),
        mtimeMs: info.mtimeMs,
      });
      continue;
    }
    if (kind === "cancel") {
      // Second pass below: readdir order puts `<id>.cancel` before
      // `<id>.job.json`, so the job's state is not known yet.
      pendingCancels.push({ name, info });
      continue;
    }
    inspection.jobs.push({ name, kind: kind ?? "other", ownedBySelf: info.uid === process.getuid(), mtimeMs: info.mtimeMs });
  }
  for (const { name, info } of pendingCancels) {
    const id = artifactId(name);
    inspection.jobs.push({
      id,
      name,
      kind: "cancel",
      jobState: id === null ? null : (jobStates.get(id) ?? "absent"),
      ownedBySelf: info.uid === process.getuid(),
      mtimeMs: info.mtimeMs,
    });
  }

  for (const { name, info } of resultEntries) {
    const kind = resultEntryKind(name);
    if (kind === "agent-banner") {
      inspection.banner = parseAgentBanner(info.isFile() ? readFileSync(join(resultsDir, name), "utf-8") : "");
      continue;
    }
    if (kind === "result") {
      const id = artifactId(name);
      inspection.results.push({
        id,
        name,
        kind,
        trusted: targetUid === undefined ? null : resultFileIsTrusted(info, targetUid),
        orphan: id === null || !jobNames.has(`${id}.job.json`),
        ownedBySelf: info.uid === process.getuid(),
        mtimeMs: info.mtimeMs,
      });
      continue;
    }
    if (kind === "result-tmp") {
      inspection.results.push({
        id: artifactId(name),
        name,
        kind,
        stale: isStaleTemporary(info.mtimeMs, now),
        ownedBySelf: info.uid === process.getuid(),
        mtimeMs: info.mtimeMs,
      });
      continue;
    }
    inspection.results.push({ name, kind: kind ?? "other", ownedBySelf: info.uid === process.getuid(), mtimeMs: info.mtimeMs });
  }

  for (const { name, info } of logEntries) {
    const kind = logEntryKind(name);
    inspection.logs.push({ name, kind: kind ?? "other", ownedBySelf: info.uid === process.getuid(), mtimeMs: info.mtimeMs });
  }
  return inspection;
}

/**
 * What `prune` may remove, decided entry by entry.
 *
 * The rule is ownership plus a terminal state: only files this account owns,
 * and only files that provably cannot produce or consume work again —
 * interrupted publish temporaries, jobs whose deadline passed or that were
 * cancelled, their cancellation tokens once the job is gone, and stale
 * result temporaries. A pending, malformed, finished or untrusted artifact
 * is kept and reported; a result, a log or the agent banner is never
 * removed.
 */
export function planPrune(inspection) {
  const removals = [];
  const kept = [];
  for (const dir of ["jobs", "results"]) {
    const base = dir === "jobs" ? inspection.jobsDir : inspection.resultsDir;
    for (const entry of inspection[dir]) {
      const path = join(base, entry.name);
      const decide = (remove, reason) => {
        if (entry.ownedBySelf !== true) {
          kept.push({ path, reason: "owned by another account; not this tool's to remove" });
        } else if (remove) {
          removals.push({ path, reason });
        } else {
          kept.push({ path, reason });
        }
      };
      if (dir === "jobs") {
        if (entry.kind === "job-tmp" || entry.kind === "cancel-tmp") {
          decide(entry.stale === true, entry.stale === true ? "interrupted publish temporary" : "publish may still be in flight");
        } else if (entry.kind === "job") {
          const terminal = entry.state === "stale" || entry.state === "cancelled";
          decide(terminal, terminal ? `job is ${entry.state} and can never run` : `job is ${entry.state}`);
        } else if (entry.kind === "cancel") {
          const state = entry.jobState;
          const orphan = state === "absent" || state === "stale" || state === "cancelled" || state === "finished";
          decide(orphan, orphan ? "cancellation token without a runnable job" : "job may still honour the cancellation");
        } else {
          kept.push({ path, reason: "not a prunable artifact" });
        }
      } else {
        if (entry.kind === "result-tmp") {
          decide(entry.stale === true, entry.stale === true ? "interrupted publish temporary" : "publish may still be in flight");
        } else {
          kept.push({ path, reason: "results are evidence; never removed by prune" });
        }
      }
    }
  }
  for (const entry of inspection.logs) {
    kept.push({ path: join(inspection.logsDir, entry.name), reason: "logs are evidence; never removed by prune" });
  }
  return { removals, kept };
}

/**
 * The whole status report: shared-root artifacts, the target session, the
 * processes that matter, and the findings an operator acts on.
 *
 * Nothing here throws for a missing piece — status is also the tool you run
 * when things are already wrong, so every section degrades to "unknown"
 * instead of refusing.
 */
export function collectStatus(options) {
  const now = Date.now();
  const report = {
    generatedAt: new Date(now).toISOString(),
    root: resolve(options.root),
    findings: [],
  };
  const finding = (code, message, path) => {
    report.findings.push(path === undefined ? { code, message } : { code, message, path });
  };

  let targetUid;
  let user;
  if (options.user !== undefined) {
    user = options.user;
    targetUid = uidOfUser(user);
  }
  const consoleUidValue = consoleUid();
  report.console = { uid: consoleUidValue, asid: consoleAsid(consoleUidValue) };
  if (targetUid !== undefined) {
    report.target = { user, uid: targetUid };
    let session = null;
    let sessionSource = null;
    try {
      const offstageStatus = readOffstageStatus(user);
      session = resolveTargetSession(user, targetUid, offstageStatus);
      sessionSource = sessionFromOffstageStatus(offstageStatus) !== null ? "offstage" : "launchd";
    } catch {
      session = null;
    }
    report.session = { session, source: sessionSource };
    if (session === null) {
      finding("target-session-unknown", `${user} (uid ${targetUid}) has no readable graphical session`);
    } else if (session.uid !== targetUid) {
      finding("target-session-mismatch", `the session belongs to uid ${session.uid}, not ${targetUid}`);
    } else if (session.kind !== "Aqua") {
      finding("target-session-not-aqua", `the session is ${session.kind}, not graphical`);
    } else if (consoleUidValue === targetUid) {
      finding("target-owns-console", `${user} owns the console session; nothing may run there`);
    }
  }

  // The trusted uid job files are accepted from: the agent's banner records
  // it; without a banner the agent's own default (the console uid) applies.
  let trustedUid = consoleUidValue >= 0 ? consoleUidValue : undefined;
  let psComm = "";
  let psArgs = "";
  try {
    psComm = commandOutput("ps", ["-axo", "pid=,uid=,comm="]);
  } catch {
    finding("ps-unavailable", "the process list could not be read; agent and After Effects state is unknown");
  }
  try {
    psArgs = commandOutput("ps", ["-axo", "pid=,uid=,args="]);
  } catch {
    // The args listing is best-effort; the comm listing already covers AE.
  }
  const aeProcesses = psComm.length === 0 ? [] : parseAeProcesses(psComm);
  const agents = psArgs.length === 0 ? [] : parseSessionAgentProcesses(psArgs);
  report.afterEffects = aeProcesses;
  report.sessionAgents = agents;
  if (aeProcesses.length > 0) {
    finding(
      "ae-already-running",
      `After Effects is running (pids ${aeProcesses.map((p) => p.pid).join(", ")}); Adobe allows one OS user at a time`,
    );
  }
  if (agents.length > 0 && targetUid !== undefined && consoleUidValue >= 0) {
    const foreign = agents.filter((agent) => agent.uid !== targetUid);
    if (foreign.length > 0) {
      finding(
        "agent-uid-mismatch",
        `session-agent processes run as uid ${[...new Set(foreign.map((a) => a.uid))].join(", ")}, not the target uid ${targetUid}`,
      );
    }
  }

  let inspection = inspectSharedRoot(report.root, { targetUid, trustedUid, now });
  report.jobsDir = inspection.jobsDir;
  report.resultsDir = inspection.resultsDir;
  report.logsDir = inspection.logsDir;
  report.jobs = inspection.jobs;
  report.results = inspection.results;
  report.logs = inspection.logs;
  report.agentBanner = inspection.banner;
  if (inspection.banner !== null && Number.isInteger(inspection.banner.trustedUid)) {
    trustedUid = inspection.banner.trustedUid;
  }
  // Re-classify jobs with the banner's trusted uid when it differs: the first
  // pass used the console default, which is only a guess.
  if (trustedUid !== consoleUidValue) {
    inspection = inspectSharedRoot(report.root, { targetUid, trustedUid, now });
    report.jobs = inspection.jobs;
    report.results = inspection.results;
    report.agentBanner = inspection.banner;
  }

  for (const entry of report.jobs) {
    if (entry.kind === "job" && entry.state === "stale") {
      finding("job-stale", `${entry.id}: ${entry.reason}`, join(inspection.jobsDir, entry.name));
    } else if (entry.kind === "job" && entry.state === "untrusted") {
      finding("job-untrusted", `${entry.id}: ${entry.reason}`, join(inspection.jobsDir, entry.name));
    } else if (entry.kind === "job" && entry.state === "pending" && agents.length === 0) {
      finding("job-pending-no-agent", `${entry.id} is waiting but no session agent is running`, join(inspection.jobsDir, entry.name));
    }
  }
  for (const entry of report.results) {
    if (entry.kind === "result" && entry.orphan === true) {
      finding("result-orphaned", `${entry.id}: a result exists but its job file does not`, join(inspection.resultsDir, entry.name));
    } else if (entry.kind === "result" && entry.trusted === false) {
      finding("result-untrusted", `${entry.id}: the result is not attributable to the target account`, join(inspection.resultsDir, entry.name));
    }
  }
  // The guided setup's own state file: an interrupted setup leaves it
  // behind, and "which steps were already done" is what a resume needs.
  // Reported, never modified.
  const setupPath = join(homedir(), ".ae-a8n", "setup-state.json");
  const setup = { path: setupPath, state: "missing", completed: [] };
  if (existsSync(setupPath)) {
    const parsed = readJson(setupPath);
    if (parsed !== null && Array.isArray(parsed["completed"])) {
      setup.state = "ok";
      setup.completed = parsed["completed"].filter((id) => typeof id === "string");
    } else {
      setup.state = "unreadable";
    }
  }
  report.setupState = setup;

  if (report.agentBanner !== null && report.agentBanner.session !== null && consoleAsid(consoleUidValue) !== null) {
    const bannerAsid = report.agentBanner.session.asid;
    const consoleAsidValue = consoleAsid(consoleUidValue);
    if (Number.isInteger(bannerAsid) && Number.isInteger(consoleAsidValue) && bannerAsid === consoleAsidValue) {
      finding("agent-in-console-session", "the session agent's banner names the console session; it is not isolated");
    }
  }
  return { report, inspection };
}

function printStatus(report) {
  const lines = [];
  lines.push(`root: ${report.root}`);
  if (report.target !== undefined) {
    lines.push(`target: ${report.target.user} (uid ${report.target.uid})`);
  }
  lines.push(`console: uid ${report.console.uid}, asid ${report.console.asid}`);
  if (report.session !== undefined) {
    const session = report.session.session;
    lines.push(
      session === null
        ? "session: none readable"
        : `session: uid ${session.uid}, asid ${session.asid}, kind ${session.kind} (via ${report.session.source})`,
    );
  }
  lines.push(`after effects: ${report.afterEffects.length === 0 ? "not running" : report.afterEffects.map((p) => `pid ${p.pid}`).join(", ")}`);
  lines.push(`session agents: ${report.sessionAgents.length === 0 ? "none" : report.sessionAgents.map((a) => `pid ${a.pid} (uid ${a.uid})`).join(", ")}`);
  const count = (entries, state) => entries.filter((e) => e.state === state || e.kind === state).length;
  lines.push(
    `jobs: ${report.jobs.length} (${["pending", "stale", "cancelled", "finished", "malformed", "untrusted", "unknown"].map((s) => `${s} ${count(report.jobs, s)}`).join(", ")})`,
  );
  lines.push(`results: ${report.results.length}, logs: ${report.logs.length}`);
  if (report.setupState !== undefined) {
    lines.push(
      `setup state: ${report.setupState.state}` +
        (report.setupState.completed.length > 0 ? ` (${report.setupState.completed.length} step(s) done)` : ""),
    );
  }
  if (report.agentBanner !== null) {
    const b = report.agentBanner;
    lines.push(
      `agent banner: started ${b.startedAt ?? "unknown"}, session uid ${b.session?.uid ?? "?"}, trusted uid ${b.trustedUid ?? "?"}`,
    );
  }
  if (report.findings.length > 0) {
    lines.push("findings:");
    for (const f of report.findings) {
      lines.push(`  - ${f.code}: ${f.message}`);
    }
  } else {
    lines.push("findings: none");
  }
  return `${lines.join("\n")}\n`;
}

function runInspect(command, argv) {
  const options = parseInspectArgs(argv);
  const { report, inspection } = collectStatus(options);
  let prune = null;
  if (command === "prune") {
    const plan = planPrune(inspection);
    const removed = [];
    const failed = [];
    if (!options.dryRun) {
      for (const { path } of plan.removals) {
        try {
          rmSync(path);
          removed.push(path);
        } catch (error) {
          failed.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      for (const { path } of plan.removals) {
        removed.push(path);
      }
    }
    prune = { dryRun: options.dryRun, removed, failed, kept: plan.kept };
    report.prune = prune;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(printStatus(report));
    if (prune !== null) {
      process.stdout.write(
        prune.dryRun
          ? `prune (dry run): ${prune.removed.length} file(s) would be removed\n`
          : `prune: ${prune.removed.length} file(s) removed, ${prune.failed.length} failed\n`,
      );
      for (const path of prune.removed) {
        process.stdout.write(`  - ${path}\n`);
      }
      for (const { path, error } of prune.failed) {
        process.stdout.write(`  ! ${path}: ${error}\n`);
      }
    }
  }
  if (prune !== null && prune.failed.length > 0) {
    process.exitCode = 1;
  }
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
  if (session === null) {
    // The launchd fallback is unreadable from the console for another user,
    // and offstage may have no answer either. Report which happened instead
    // of turning "cannot verify from here" into "not logged in".
    throw describeMissingSession(targetUid, guiDomainError(targetUid));
  }
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
  const command = process.argv[2];
  try {
    if (command === "status" || command === "prune") {
      runInspect(command, process.argv.slice(3));
    } else {
      main();
    }
  } catch (error) {
    process.stderr.write(`ae-a8n refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
