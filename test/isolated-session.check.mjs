/**
 * The session rules of the isolated-session runner.
 *
 * These are the refusals that keep a test off the console user's desktop.
 * They are checked here as plain functions, so no second user, no second
 * session and no After Effects are needed to prove them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertTrustedResult, cancelJob } from "../scripts/isolated-session/dispatch.mjs";
import { describeMissingSession } from "../scripts/isolated-session/run-in-isolated-session.mjs";

import {
  assertJobRunnable,
  assertJobSession,
  assertNoRunningAfterEffects,
  assertOutcomeSession,
  assertReportIsolation,
  assertResultSession,
  assertTargetSession,
  jobFileIsTrusted,
  parseAeProcesses,
  parseTerminalResult,
  sessionFromOffstageStatus,
  sessionIsolation,
  sharedDirIsUsable,
  sharedDirIsUsableForOthers,
  shellCommandLine,
  shellQuote,
  targetSessionFrom,
} from "../scripts/isolated-session/session-rules.mjs";

const aqua = { uid: 502, username: "test", asid: 100040, kind: "Aqua" };
const consoleUser = { uid: 501, username: "rebui", asid: 100021, kind: "Aqua" };

test("a target session must exist", () => {
  assert.throws(() => assertTargetSession(null, 502, 501), /no login session/);
});

test("a target session must belong to the target user", () => {
  assert.throws(() => assertTargetSession({ ...aqua, uid: 501 }, 502, 501), /belongs to uid 501/);
});

test("a background session is not a graphical one", () => {
  assert.throws(() => assertTargetSession({ ...aqua, kind: "Background" }, 502, 501), /not a graphical one/);
});

test("the console session is refused", () => {
  assert.throws(() => assertTargetSession(consoleUser, 501, 501), /owns the console session/);
});

test("an unreadable console owner is a refusal, not a pass", () => {
  assert.throws(() => assertTargetSession(aqua, 502, -1), /console session's owner could not be read/);
  assert.throws(() => assertTargetSession(aqua, 502, Number.NaN), /console session's owner could not be read/);
  // The same for the post-job check: without an owner, isolation is unproven.
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: 109086, onConsole: false }, { uid: 502 }, { uid: -1, asid: null }),
    /console session's owner could not be read/,
  );
});

test("a separate graphical session is accepted", () => {
  assert.equal(assertTargetSession(aqua, 502, 501), aqua);
});

test("a session that cannot be read from here is not reported as a logged-out user", () => {
  // From the console, launchctl may refuse another user's domain. That is a
  // limit of the observer, not evidence that the account has no session; the
  // message must not send the caller to log in again.
  const error = describeMissingSession(502, "Operation not permitted");
  assert.match(error.message, /could not be verified from this session/);
  assert.match(error.message, /may still be logged in/);
  assert.match(error.message, /session agent/);
  assert.doesNotMatch(error.message, /has no login session/);
});

test("a user with no login domain is reported as not logged in, with a remedy", () => {
  const error = describeMissingSession(502, "Bad request.\nCould not find domain for user gui: 502");
  assert.match(error.message, /has no login session/);
  assert.match(error.message, /fast user switch/);
});

test("an unreadable console owner never yields an isolated session", () => {
  // -1 is not "somebody else". When /dev/console cannot be read, a difference
  // cannot be proven, so the session is not isolated.
  const unknown = sessionIsolation({ uid: 502, consoleUid: -1 });
  assert.equal(unknown.isolated, false);
  assert.match(unknown.reason, /could not be read/);
  assert.equal(sessionIsolation({ uid: 501, consoleUid: 501 }).isolated, false);
  assert.equal(sessionIsolation({ uid: 502, consoleUid: 501 }).isolated, true);
});

test("a report claiming isolation with an unknown console owner is rejected", () => {
  assert.throws(
    () => assertReportIsolation({ session: { uid: 502, consoleUid: -1, isolated: true } }),
    /could not be read/,
  );
  assert.throws(
    () => assertReportIsolation({ session: { uid: 501, consoleUid: 501, isolated: true } }),
    /owns the console session/,
  );
  assert.throws(
    () => assertReportIsolation({ session: { uid: 502, consoleUid: 501, isolated: false } }),
    /not proven isolated/,
  );
  const report = { session: { uid: 502, consoleUid: 501, isolated: true } };
  assert.equal(assertReportIsolation(report), report);
});

test("a result from another session is not trusted", () => {
  assert.throws(() => assertResultSession({ session: { uid: 501 } }, 502), /not trusted/);
  assert.throws(() => assertResultSession({}, 502), /not trusted/);
});

test("a result from the requested session is accepted", () => {
  const result = { session: { uid: 502, asid: 100040 } };
  assert.equal(assertResultSession(result, 502), result);
});

test("the agent refuses a job that names another session", () => {
  assert.throws(() => assertJobSession({ session: { uid: 501 } }, aqua), /was not run/);
});

test("the target session comes from offstage when it says the session exists", () => {
  const status = {
    available: true,
    accountExists: true,
    user: "test",
    uid: 502,
    guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
  };
  // 258 is offstage's own number, not launchd's asid, so it is not carried.
  assert.deepEqual(targetSessionFrom(status, null), {
    uid: 502,
    username: "test",
    asid: null,
    kind: "Aqua",
  });
});

test("offstage's unavailability is not evidence that the account has no session", () => {
  const local = { uid: 502, username: "test", asid: 109086, kind: "Aqua" };
  const unavailable = { available: false, reason: "helper session is not logged in" };
  assert.equal(targetSessionFrom(unavailable, local), local);
  // No answer from either side stays null; the caller reports why.
  assert.equal(targetSessionFrom(null, null), null);
});

test("a shared directory is usable only with the sticky bit", () => {
  // 0o777 on its own lets either account delete the other's files; the
  // dir must be 0o1777. A 0o777 mask would have hidden the difference.
  assert.equal(sharedDirIsUsable(0o041777), true);
  assert.equal(sharedDirIsUsable(0o040777), false);
  assert.equal(sharedDirIsUsable(0o041755), false);
  // A directory owned by the other account cannot be chmod'ed: it counts as
  // usable only when it is world-writable *and* sticky.
  assert.equal(sharedDirIsUsableForOthers(0o041777), true);
  assert.equal(sharedDirIsUsableForOthers(0o040777), false);
  assert.equal(sharedDirIsUsableForOthers(0o041775), false);
});

test("a job file is run only when it is attributable to the controller", () => {
  const file = (over) => ({ isFile: () => true, uid: 501, mode: 0o100644, ...over });
  assert.equal(jobFileIsTrusted(file({}), 501), true);
  // Written by somebody else, or writable by group/others (so it could be
  // replaced between the check and the read).
  assert.equal(jobFileIsTrusted(file({ uid: 502 }), 501), false);
  assert.equal(jobFileIsTrusted(file({ mode: 0o100666 }), 501), false);
  assert.equal(jobFileIsTrusted(file({ mode: 0o100664 }), 501), false);
  // A symlink's own stat is not a regular file.
  assert.equal(jobFileIsTrusted(file({ isFile: () => false }), 501), false);
});

test("the agent runs a job that names its own session", () => {
  const job = { session: { uid: 502 }, command: ["node", "e2e.mjs"] };
  assert.equal(assertJobSession(job, aqua), job);
});

test("the agent runs a job that names no session", () => {
  const job = { command: ["node", "e2e.mjs"] };
  assert.equal(assertJobSession(job, aqua), job);
});

test("a job that arrives before its deadline still runs", () => {
  const job = { id: "1700000000000-abcd", command: ["node", "e2e.mjs"], deadline: 1_700_000_600_000 };
  assert.equal(assertJobRunnable(job, 1_700_000_000_000, false), job);
});

test("a job published, timed out and cancelled is never run by a later agent pass", () => {
  // The controller gave up waiting. The job file is still in the shared
  // directory, so an agent starting now would otherwise run it — an
  // operation the caller was told did not finish, executed afterwards.
  const dir = mkdtempSync(join(tmpdir(), "a8n-cancel-"));
  try {
    const id = "1700000000000-abcd";
    const job = { id, command: ["node", "e2e.mjs"], deadline: 1_700_000_600_000 };
    assert.equal(assertJobRunnable(job, 1_700_000_000_000, false), job);
    cancelJob(dir, id);
    assert.equal(existsSync(join(dir, `${id}.cancel`)), true);
    assert.throws(() => assertJobRunnable(job, 1_700_000_000_000, true), /cancelled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that arrives after its deadline is not run", () => {
  const job = { id: "1700000000000-abcd", command: ["node", "e2e.mjs"], deadline: 1_700_000_600_000 };
  assert.throws(() => assertJobRunnable(job, 1_700_000_600_001, false), /deadline/);
  // A job without a deadline is an unknown state, not a live one.
  assert.throws(() => assertJobRunnable({ id: "no-deadline", command: ["node"] }, 1_700_000_000_000, false), /deadline/);
});

test("a job that ran as another user is not trusted", () => {
  assert.throws(
    () => assertOutcomeSession({ uid: 501, asid: 100021, onConsole: false }, { uid: 502 }, { uid: 501, asid: 100021 }),
    /ran as uid 501, not 502/,
  );
});

test("a job that says it ran on the console is not trusted", () => {
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: 100040, onConsole: true }, { uid: 502 }, { uid: 501, asid: 100021 }),
    /ran on the console/,
  );
});

test("a job that ran in the console session is not trusted", () => {
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: 100021, onConsole: false }, { uid: 502 }, { uid: 501, asid: 100021 }),
    /which is the console session/,
  );
});

test("a job that ran while the target user owned the console is not trusted", () => {
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: 100040, onConsole: false }, { uid: 502 }, { uid: 502, asid: 100040 }),
    /owns the console now/,
  );
});

test("a job in a session id other than the console's is trusted", () => {
  const outcome = { uid: 502, asid: 100040, onConsole: false };
  assert.equal(assertOutcomeSession(outcome, { uid: 502 }, { uid: 501, asid: 100021 }), outcome);
});

test("an unknown session id is never accepted as isolation", () => {
  // Neither side may be missing: "not equal" is not the same as "different".
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: null, onConsole: false }, { uid: 502 }, { uid: 501, asid: 100021 }),
    /did not report a session id/,
  );
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: undefined, onConsole: false }, { uid: 502 }, { uid: 501, asid: 100021 }),
    /did not report a session id/,
  );
  assert.throws(
    () => assertOutcomeSession({ uid: 502, asid: 100040, onConsole: false }, { uid: 502 }, { uid: 501, asid: null }),
    /console session's id could not be read/,
  );
});

test("a result without a session id is never complete", () => {
  const unknown = parseTerminalResult("uid=502\nusername=test\nonconsole=0\nexit=0\n");
  assert.equal(unknown.complete, false);
  assert.equal(unknown.asid, null);
  const empty = parseTerminalResult("uid=502\nusername=test\nasid=\nonconsole=0\nexit=0\n");
  assert.equal(empty.complete, false);
});

test("a job is trusted even when offstage's session number disagrees", () => {
  // Measured on 2026-11-03: offstage reported session 258 for a session whose
  // launchd asid and CGSession audit id were both 109086. The job was off the
  // console and ran as the target user, so it is an isolated run; the number
  // offstage prints is not in the same space and is not a reason to refuse.
  const outcome = { uid: 502, asid: 109086, onConsole: false };
  assert.equal(assertOutcomeSession(outcome, { uid: 502 }, { uid: 501, asid: 108197 }), outcome);
});

test("an After Effects process of any user is recognised", () => {
  const listing = [
    "  4242   502 /Applications/After Effects 2026/After Effects",
    "  4243   501 /Applications/After Effects 2025/After Effects",
    "  4244   501 /usr/bin/WindowServer",
  ].join("\n");
  assert.deepEqual(parseAeProcesses(listing), [
    { pid: 4242, uid: 502, executable: "/Applications/After Effects 2026/After Effects" },
    { pid: 4243, uid: 501, executable: "/Applications/After Effects 2025/After Effects" },
  ]);
});

test("the After Effects binary is recognised under its application name", () => {
  // The current release ships the executable as `AfterFX`, not
  // `After Effects`; a miss here would let a run start beside a live AE.
  const listing = [
    "  4242   502 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/AfterFX",
    "  4243   501 /usr/libexec/AfterFXHelper",
  ].join("\n");
  assert.deepEqual(parseAeProcesses(listing), [
    {
      pid: 4242,
      uid: 502,
      executable: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/AfterFX",
    },
  ]);
});

test("a running After Effects stops the run, and nothing is killed", () => {
  assert.throws(
    () => assertNoRunningAfterEffects([{ pid: 4242, uid: 501, executable: "/Applications/After Effects" }]),
    /one OS user at a time/,
  );
  assert.doesNotThrow(() => assertNoRunningAfterEffects([]));
});

test("a plain word needs no quoting", () => {
  assert.equal(shellQuote("node"), "node");
  assert.equal(shellQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(shellQuote("e2e-v2.mjs"), "e2e-v2.mjs");
});

test("a word with a space or a quote stays one word", () => {
  assert.equal(shellQuote("two words"), "'two words'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("a;rm -rf /tmp"), "'a;rm -rf /tmp'");
  assert.equal(shellQuote(""), "''");
});

test("a command line quotes every word", () => {
  assert.equal(shellCommandLine(["node", "/tmp/ae e2e.mjs", "--flag"]), "node '/tmp/ae e2e.mjs' --flag");
});

test("the job's own account of where it ran is read as data", () => {
  const result = parseTerminalResult(
    ["uid=502", "username=test", "asid=100040", "onconsole=0", "exit=0"].join("\n") + "\n",
  );
  assert.deepEqual(result, {
    complete: true,
    uid: 502,
    username: "test",
    asid: 100040,
    onConsole: false,
    exitCode: 0,
  });
});

test("a half-written result is not read as a result", () => {
  // The file is published by rename, but the controller may still catch a
  // write in progress. Without a complete uid and exit, "no answer yet" must
  // not turn into "uid -1, exit 1" and refuse or fail a run that is fine.
  const partial = parseTerminalResult("uid=5\nusername=test\n");
  assert.equal(partial.complete, false);
  const done = parseTerminalResult("uid=502\nusername=test\nasid=100040\nonconsole=0\nexit=0\n");
  assert.equal(done.complete, true);
  assert.equal(parseTerminalResult("").complete, false);
});

test("a job that reports the console as its own is marked as such", () => {
  const result = parseTerminalResult("uid=501\nusername=rebui\nasid=100021\nonconsole=1\nexit=0\n");
  assert.equal(result.onConsole, true);
});

test("a job that wrote nothing is not a result", () => {
  const result = parseTerminalResult("");
  assert.equal(result.uid, -1);
  assert.equal(result.asid, null);
  assert.equal(result.exitCode, 1);
});

test("a failed job keeps its exit code", () => {
  const result = parseTerminalResult("uid=502\nusername=test\nasid=100040\nexit=7\n");
  assert.equal(result.exitCode, 7);
});

test("a result file is read only when it is attributable to the target user", () => {
  const dir = mkdtempSync(join(tmpdir(), "a8n-result-"));
  try {
    const uid = process.getuid();
    const path = join(dir, "job.result.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    assert.doesNotThrow(() => assertTrustedResult(path, uid));
    assert.throws(() => assertTrustedResult(path, uid + 1), /was written by uid/);
    chmodSync(path, 0o666);
    assert.throws(() => assertTrustedResult(path, uid), /writable by group or others/);
    // lstat, not stat: a symlink to a file that would pass is still refused.
    const link = join(dir, "link.result.json");
    symlinkSync(path, link);
    assert.throws(() => assertTrustedResult(link, uid), /not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offstage's own report is the session fact", () => {
  const status = {
    available: true,
    accountExists: true,
    user: "test",
    uid: 502,
    guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
  };
  assert.deepEqual(sessionFromOffstageStatus(status), {
    uid: 502,
    username: "test",
    asid: 258,
    kind: "Aqua",
  });
});

test("an account that is not logged in has no graphical session", () => {
  const status = {
    available: true,
    accountExists: true,
    user: "test",
    uid: 502,
    guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
  };
  assert.equal(sessionFromOffstageStatus(status).kind, "none");
});

test("a session lane that is not available is a refusal", () => {
  const status = { available: false, reason: "no account", fix: "create it" };
  assert.throws(() => sessionFromOffstageStatus(status), /not available/);
});

test("a missing account is a refusal", () => {
  const status = { available: true, accountExists: false, fix: "create it" };
  assert.throws(() => sessionFromOffstageStatus(status), /no second session/);
});

test("no report at all leaves the question open", () => {
  assert.equal(sessionFromOffstageStatus(null), null);
});

/**
 * ax-grant.command and ax-grant-all.command compile and run a helper that
 * lives next to them. They are meant to be copied into /Users/Shared, which
 * is world-writable, so both must verify the helper before executing it.
 *
 * These cases copy the real scripts and helper into a temporary directory and
 * run them there. The compiler is replaced so a case that passes verification
 * stops at the compile step instead of building anything; a case that fails
 * verification never reaches it.
 */
const scriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "isolated-session");

function setupSandbox() {
  const root = mkdtempSync(join(tmpdir(), "a8n-ax-grant-"));
  for (const name of ["ax-grant.command", "ax-grant-all.command", "ax-prompt.swift", "ax-prompt.swift.sha256"]) {
    copyFileSync(join(scriptDir, name), join(root, name));
  }
  return root;
}

function runSetup(name, root, extraEnv = {}) {
  const result = spawnSync("/bin/sh", [join(root, name)], {
    encoding: "utf-8",
    env: { ...process.env, A8N_AX_SHARED: root, TMPDIR: root, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertRefused(result, pattern) {
  assert.notEqual(result.status, 0, `expected a refusal, got exit ${result.status}`);
  assert.match(result.stderr, pattern);
}

test("the pinned hash matches the helper source", () => {
  const source = readFileSync(join(scriptDir, "ax-prompt.swift"));
  const pinned = readFileSync(join(scriptDir, "ax-prompt.swift.sha256"), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  assert.equal(createHash("sha256").update(source).digest("hex"), pinned?.split(/\s+/)[0]);
});

test("the setup helpers check owner, mode, symlinks and the pinned hash before running", () => {
  for (const name of ["ax-grant.command", "ax-grant-all.command"]) {
    const text = readFileSync(join(scriptDir, name), "utf-8");
    assert.match(text, /-L "\$path"/, `${name} must reject symlinks`);
    assert.match(text, /stat -f '%u'/, `${name} must check the owner`);
    assert.match(text, /owned by root or by uid/, `${name} must allow only root or the invoking user`);
    assert.match(text, /\$\(\(0\$mode & 022\)\)/, `${name} must reject group/other write`);
    assert.match(text, /shasum -a 256/, `${name} must check the pinned SHA-256`);
    assert.match(text, /mktemp -d/, `${name} must build in a private directory`);
    assert.match(text, /PROMPT=\$BUILD_DIR\/ax-prompt/, `${name} must run only the privately built helper`);
    assert.doesNotMatch(text, /"\$SHARED\/ax-prompt"/, `${name} must not run a pre-existing shared binary`);
  }
});

test("ax-grant.command refuses a symlinked helper source", () => {
  const root = setupSandbox();
  try {
    const real = join(root, "real.swift");
    writeFileSync(real, "print(\"hello\")\n", { mode: 0o644 });
    rmSync(join(root, "ax-prompt.swift"));
    symlinkSync(real, join(root, "ax-prompt.swift"));
    assertRefused(runSetup("ax-grant.command", root), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ax-grant.command refuses a helper writable by group or others", () => {
  const root = setupSandbox();
  try {
    chmodSync(join(root, "ax-prompt.swift"), 0o666);
    assertRefused(runSetup("ax-grant.command", root), /writable by group or others/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ax-grant.command refuses a source that does not match the pinned hash", () => {
  const root = setupSandbox();
  try {
    writeFileSync(join(root, "ax-prompt.swift"), "// replaced\n");
    assertRefused(runSetup("ax-grant.command", root), /does not match the pinned SHA-256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ax-grant.command refuses when the pinned hash is missing", () => {
  const root = setupSandbox();
  try {
    rmSync(join(root, "ax-prompt.swift.sha256"));
    assertRefused(runSetup("ax-grant.command", root), /pinned hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified helper is compiled privately, and a shared binary is never executed", () => {
  const root = setupSandbox();
  try {
    const marker = join(root, "shared-binary-ran");
    const decoy = join(root, "ax-prompt");
    writeFileSync(decoy, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    // The real source passes verification; the forced compiler failure proves
    // execution stopped at the build step, after every check.
    const result = runSetup("ax-grant.command", root, { A8N_AX_SWIFTC: "/usr/bin/false" });
    assertRefused(result, /could not be compiled/);
    // The shared binary must not have run.
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ax-grant-all.command applies the same checks", () => {
  const root = setupSandbox();
  try {
    chmodSync(join(root, "ax-prompt.swift.sha256"), 0o664);
    assertRefused(runSetup("ax-grant-all.command", root), /writable by group or others/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
