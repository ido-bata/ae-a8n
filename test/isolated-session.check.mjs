/**
 * The session rules of the isolated-session runner.
 *
 * These are the refusals that keep a test off the console user's desktop.
 * They are checked here as plain functions, so no second user, no second
 * session and no After Effects are needed to prove them.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertTrustedResult } from "../scripts/isolated-session/dispatch.mjs";

import {
  assertJobSession,
  assertNoRunningAfterEffects,
  assertOutcomeSession,
  assertResultSession,
  assertTargetSession,
  jobFileIsTrusted,
  parseAeProcesses,
  parseTerminalResult,
  sessionFromOffstageStatus,
  shellCommandLine,
  shellQuote,
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
