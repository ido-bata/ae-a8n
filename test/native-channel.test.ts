/**
 * Contract tests for the NativeProbe intake channel client (#238).
 *
 * Both peers are fake: this module prepares/publishes/collects on a
 * private directory while hand-written files play the plug-in side
 * (state.json heartbeat, result envelopes). Nothing here touches a real
 * After Effects or a real NativeProbe plug-in — every result is
 * `fake/mock only` evidence, and the `verifiedOnRealHost` /
 * `externalDispatchVerified` gates stay false.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  awaitNativeResult,
  claimedRequestPath,
  defaultNativeChannelDir,
  hasClaimedRequest,
  NATIVE_CHANNEL_META,
  NATIVE_DISPATCH_SCHEMA,
  NATIVE_REQUEST_SUFFIX,
  NATIVE_RESULT_SUFFIX,
  NativeChannelTimeoutError,
  prepareNativeChannel,
  publishNativeRequest,
  readNativeChannelState,
  type NativeRequestInput,
} from "../src/driver/native-channel.js";
import { HostUnavailableError } from "../src/driver/driver.js";
import { ScriptNotSentError } from "../src/driver/transport.js";

const cleanups: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-native-channel-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

function baseInput(overrides: Partial<NativeRequestInput> = {}): NativeRequestInput {
  return {
    requestId: "req-001",
    timeoutMs: 5_000,
    session: { sessionId: "sess-1", aeVersion: "26.5" },
    operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
    ...overrides,
  };
}

/** Play the plug-in: write a contract-shaped result envelope. */
function writeResult(
  channel: ReturnType<typeof prepareNativeChannel>,
  requestId: string,
  result: Record<string, unknown>,
): void {
  const path = join(channel.outbox, `${requestId}${NATIVE_RESULT_SUFFIX}`);
  const doc = {
    v: 1,
    instance: "inst-1",
    host: { plugin: "ae-a8n NativeProbe", pluginId: 4242, aeVersion: "26.5" },
    result: {
      schema: NATIVE_DISPATCH_SCHEMA,
      requestId,
      ...result,
    },
  };
  writeFileSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
}

const FAST = { pollMs: 5, graceMs: 200 };

describe("prepareNativeChannel", () => {
  it("creates a private root with inbox/outbox and a 0600 channel.json", () => {
    const root = join(tmpRoot(), "chan");
    const channel = prepareNativeChannel(root);
    expect(channel.reused).toBe(false);
    for (const dir of [channel.root, channel.inbox, channel.outbox]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const metaPath = join(channel.root, NATIVE_CHANNEL_META);
    expect(statSync(metaPath).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    expect(meta.v).toBe(1);
    expect(meta.token).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.sessionAeVersion).toBeUndefined();
  });

  it("reuses the existing token idempotently and keeps a session pin", () => {
    const root = join(tmpRoot(), "chan");
    const first = prepareNativeChannel(root, { sessionAeVersion: "26.5" });
    const second = prepareNativeChannel(root);
    expect(second.reused).toBe(true);
    expect(second.token).toBe(first.token);
    const meta = JSON.parse(
      readFileSync(join(root, NATIVE_CHANNEL_META), "utf-8"),
    ) as Record<string, unknown>;
    expect(meta.sessionAeVersion).toBe("26.5");
  });

  it("refuses a group/other-accessible directory", () => {
    const root = join(tmpRoot(), "chan");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    expect(() => prepareNativeChannel(root)).toThrow(HostUnavailableError);
  });

  it("refuses a symlinked channel root", () => {
    const real = tmpRoot();
    const link = join(tmpRoot(), "link");
    symlinkSync(real, link);
    expect(() => prepareNativeChannel(link)).toThrow(HostUnavailableError);
  });

  it("refuses a relative root", () => {
    expect(() => prepareNativeChannel("relative/chan")).toThrow(HostUnavailableError);
  });

  it("refuses malformed channel.json", () => {
    const root = join(tmpRoot(), "chan");
    prepareNativeChannel(root);
    writeFileSync(join(root, NATIVE_CHANNEL_META), '{"v":1,"token":"nope"}\n');
    expect(() => prepareNativeChannel(root)).toThrow(HostUnavailableError);
  });
});

describe("readNativeChannelState", () => {
  it("returns null without a state file", () => {
    const root = join(tmpRoot(), "chan");
    prepareNativeChannel(root);
    expect(readNativeChannelState(root)).toBeNull();
  });

  it("parses a well-formed heartbeat", () => {
    const root = join(tmpRoot(), "chan");
    prepareNativeChannel(root);
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({
        v: 1,
        instance: "inst-9",
        pluginId: 4242,
        lastTick: 1_700_000_000_000,
        aeVersion: "26.5",
        allowlist: ["AEGP_ProjSuite6.AEGP_GetNumProjects"],
      }),
      { mode: 0o600 },
    );
    const state = readNativeChannelState(root);
    expect(state?.instance).toBe("inst-9");
    expect(state?.aeVersion).toBe("26.5");
    expect(state?.allowlist).toEqual(["AEGP_ProjSuite6.AEGP_GetNumProjects"]);
  });

  it("returns null on malformed state.json", () => {
    const root = join(tmpRoot(), "chan");
    prepareNativeChannel(root);
    writeFileSync(join(root, "state.json"), "{not json", { mode: 0o600 });
    expect(readNativeChannelState(root)).toBeNull();
  });
});

describe("publishNativeRequest", () => {
  it("writes the contract envelope atomically at 0600", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput({ target: "inst-1" }));
    const path = join(channel.inbox, `req-001${NATIVE_REQUEST_SUFFIX}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.part`)).toBe(false);
    const doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(doc.v).toBe(1);
    expect(doc.token).toBe(channel.token);
    expect(doc.timeoutMs).toBe(5_000);
    expect(doc.target).toBe("inst-1");
    const inner = doc.request as Record<string, unknown>;
    expect(inner.schema).toBe(NATIVE_DISPATCH_SCHEMA);
    expect(inner.requestId).toBe("req-001");
    expect(inner.operationId).toBe("AEGP_ProjSuite6.AEGP_GetNumProjects");
  });

  it("refuses an unsafe requestId before anything is sent", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    for (const requestId of ["../escape", "a/b", "", "x".repeat(200), ".hidden"]) {
      expect(() => publishNativeRequest(channel, baseInput({ requestId }))).toThrow(
        ScriptNotSentError,
      );
    }
  });

  it("refuses out-of-bounds timeoutMs", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 3_600_001]) {
      expect(() => publishNativeRequest(channel, baseInput({ timeoutMs }))).toThrow(
        ScriptNotSentError,
      );
    }
  });

  it("refuses a duplicate requestId as not-sent", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    expect(() => publishNativeRequest(channel, baseInput())).toThrow(ScriptNotSentError);
  });

  it("passes args and authorizationRef through to the inner envelope", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput({ args: null, authorizationRef: "grant-1" }));
    const doc = JSON.parse(
      readFileSync(join(channel.inbox, `req-001${NATIVE_REQUEST_SUFFIX}`), "utf-8"),
    ) as { request: Record<string, unknown> };
    expect(doc.request.args).toBeNull();
    expect(doc.request.authorizationRef).toBe("grant-1");
  });
});

describe("awaitNativeResult", () => {
  it("collects a completed verdict with host attestation", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    writeResult(channel, "req-001", { outcome: "completed", result: { numProjects: 1 } });
    const delivery = await awaitNativeResult(channel, "req-001", 5_000, FAST);
    expect(delivery.instance).toBe("inst-1");
    expect(delivery.host.pluginId).toBe(4242);
    expect(delivery.result.outcome).toBe("completed");
    expect(delivery.result.result).toEqual({ numProjects: 1 });
  });

  it("collects refused/failed/not-sent verdicts as typed results", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    for (const [id, result] of [
      ["req-a", { outcome: "refused", refusalCode: "CHANNEL_TOKEN_MISMATCH" }],
      ["req-b", { outcome: "failed", mayHaveMutated: false }],
      ["req-c", { outcome: "not-sent" }],
    ] as const) {
      publishNativeRequest(channel, baseInput({ requestId: id }));
      writeResult(channel, id, result);
      const delivery = await awaitNativeResult(channel, id, 5_000, FAST);
      expect(delivery.result.outcome).toBe(result.outcome);
    }
  });

  it("times out to UNKNOWN when nothing arrives", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    await expect(awaitNativeResult(channel, "req-001", 10, { pollMs: 5, graceMs: 20 })).rejects.toThrow(
      NativeChannelTimeoutError,
    );
  });

  it("ignores a mismatched requestId and keeps waiting", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    const path = join(channel.outbox, `req-001${NATIVE_RESULT_SUFFIX}`);
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        instance: "inst-1",
        host: { plugin: "p", pluginId: 1, aeVersion: "26.5" },
        result: {
          schema: NATIVE_DISPATCH_SCHEMA,
          requestId: "someone-else",
          outcome: "completed",
          result: {},
        },
      }),
      { mode: 0o600 },
    );
    await expect(awaitNativeResult(channel, "req-001", 10, { pollMs: 5, graceMs: 30 })).rejects.toThrow(
      NativeChannelTimeoutError,
    );
    // The mismatched file stays as evidence.
    expect(existsSync(path)).toBe(true);
  });

  it("rejects an internally inconsistent result envelope", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    // outcome=refused without refusalCode must not be delivered.
    writeResult(channel, "req-001", { outcome: "refused" });
    await expect(awaitNativeResult(channel, "req-001", 10, { pollMs: 5, graceMs: 30 })).rejects.toThrow(
      NativeChannelTimeoutError,
    );
  });

  it("a malformed result file is evidence, not a delivery", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    const path = join(channel.outbox, `req-001${NATIVE_RESULT_SUFFIX}`);
    writeFileSync(path, "{broken", { mode: 0o600 });
    await expect(awaitNativeResult(channel, "req-001", 10, { pollMs: 5, graceMs: 30 })).rejects.toThrow(
      NativeChannelTimeoutError,
    );
    expect(existsSync(path)).toBe(true);
  });
});

describe("claimed artifacts", () => {
  it("reports a surviving .claimed file without deleting it", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    // Play the plug-in's interrupted claim: request → <id>.claimed.
    const req = join(channel.inbox, `req-001${NATIVE_REQUEST_SUFFIX}`);
    const claimed = claimedRequestPath(channel, "req-001");
    writeFileSync(claimed, readFileSync(req));
    rmSync(req);
    expect(hasClaimedRequest(channel, "req-001")).toBe(true);
    expect(existsSync(claimed)).toBe(true);
  });

  it("request mtime is the deadline base the plug-in uses", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    publishNativeRequest(channel, baseInput());
    const req = join(channel.inbox, `req-001${NATIVE_REQUEST_SUFFIX}`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(req, old, old);
    expect(statSync(req).mtimeMs).toBeLessThan(Date.now() - 60_000);
  });
});

describe("defaultNativeChannelDir", () => {
  it("places the channel under ~/.ae-a8n/native", () => {
    expect(defaultNativeChannelDir("/home/x")).toBe("/home/x/.ae-a8n/native");
  });
});
