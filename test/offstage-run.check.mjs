import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSessionIdentity, offstageArguments, parseAeProcesses } from "../scripts/offstage-ae-run.mjs";

test("finds AE from all UIDs and all installed versions, not helpers", () => {
  const input = [
    " 12 501 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
    " 13 502 /Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/After Effects",
    " 14 502 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/crashpad_handler",
    " 15 501 /usr/bin/osascript",
  ].join("\n");
  assert.deepEqual(parseAeProcesses(input).map(({ pid, uid }) => [pid, uid]), [[12, 501], [13, 502]]);
});

test("unparseable process data refuses instead of assuming no AE", () => {
  assert.throws(() => parseAeProcesses("malformed process row"), /cannot parse/);
});

test("helper must differ from physical console and parent", () => {
  assert.doesNotThrow(() => assertSessionIdentity("parent", 501, 502, 501));
  assert.doesNotThrow(() => assertSessionIdentity("helper", 502, 502, 501));
  assert.throws(() => assertSessionIdentity("helper", 501, 502, 501), /did not switch/);
  assert.throws(() => assertSessionIdentity("helper", 502, 502, 502), /physical console/);
  assert.throws(() => assertSessionIdentity("parent", 502, 502, 501), /outside the helper/);
  assert.throws(() => assertSessionIdentity("helper", 502, 502, 0), /unknown console/);
  assert.throws(() => assertSessionIdentity("helper", 502, 0, 501), /root\/helper/);
});

test("offstage is forced into the session lane; never chooses headless", () => {
  const args = offstageArguments(502, ["node", "/tmp/ae-test.mjs"]);
  assert.deepEqual(args.slice(0, 4), ["run", "--lane", "session", "--"]);
  assert.equal(args[4], process.execPath);
  assert.equal(args[6], "--helper");
  assert.equal(args[7], "502");
  assert.deepEqual(args.slice(8), ["--", "node", "/tmp/ae-test.mjs"]);
  assert.throws(() => offstageArguments(502, []), /pass a test command/);
});
