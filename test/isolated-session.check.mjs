/**
 * The session rules of the isolated-session runner.
 *
 * These are the refusals that keep a test off the console user's desktop.
 * They are checked here as plain functions, so no second user, no second
 * session and no After Effects are needed to prove them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertJobSession,
  assertNoRunningAfterEffects,
  assertResultSession,
  assertTargetSession,
  parseAeProcesses,
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

test("the agent runs a job that names its own session", () => {
  const job = { session: { uid: 502 }, command: ["node", "e2e.mjs"] };
  assert.equal(assertJobSession(job, aqua), job);
});

test("the agent runs a job that names no session", () => {
  const job = { command: ["node", "e2e.mjs"] };
  assert.equal(assertJobSession(job, aqua), job);
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

test("a running After Effects stops the run, and nothing is killed", () => {
  assert.throws(
    () => assertNoRunningAfterEffects([{ pid: 4242, uid: 501, executable: "/Applications/After Effects" }]),
    /one OS user at a time/,
  );
  assert.doesNotThrow(() => assertNoRunningAfterEffects([]));
});
