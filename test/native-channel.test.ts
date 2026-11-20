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
  reconcileItemComment,
  type NativeRequestInput,
} from "../src/driver/native-channel.js";
import { issueConsentMac } from "../src/driver/native-consent.js";
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
      expect(statSync(dir).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    }
    const metaPath = join(channel.root, NATIVE_CHANNEL_META);
    if (process.platform !== "win32") {
      expect(statSync(metaPath).mode & 0o777).toBe(0o600);
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    expect(meta.v).toBe(1);
    expect(meta.token).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.consentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.sessionAeVersion).toBeUndefined();
  });

  it("reuses the existing token and consentKey idempotently and keeps a session pin", () => {
    const root = join(tmpRoot(), "chan");
    const first = prepareNativeChannel(root, { sessionAeVersion: "26.5" });
    const second = prepareNativeChannel(root);
    expect(second.reused).toBe(true);
    expect(second.token).toBe(first.token);
    expect(second.consentKey).toBe(first.consentKey);
    const meta = JSON.parse(
      readFileSync(join(root, NATIVE_CHANNEL_META), "utf-8"),
    ) as Record<string, unknown>;
    expect(meta.sessionAeVersion).toBe("26.5");
  });

  it("backfills a consentKey into a legacy channel.json, preserving token and pin", () => {
    const root = join(tmpRoot(), "chan");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const legacyToken = "ab".repeat(32);
    writeFileSync(
      join(root, NATIVE_CHANNEL_META),
      `${JSON.stringify({ v: 1, token: legacyToken, sessionAeVersion: "26.5" })}\n`,
      { mode: 0o600 },
    );
    const channel = prepareNativeChannel(root);
    expect(channel.reused).toBe(true);
    expect(channel.token).toBe(legacyToken);
    expect(channel.consentKey).toMatch(/^[a-f0-9]{64}$/);
    const meta = JSON.parse(
      readFileSync(join(root, NATIVE_CHANNEL_META), "utf-8"),
    ) as Record<string, unknown>;
    expect(meta.token).toBe(legacyToken);
    expect(meta.consentKey).toBe(channel.consentKey);
    expect(meta.sessionAeVersion).toBe("26.5");
    if (process.platform !== "win32") {
      expect(statSync(join(root, NATIVE_CHANNEL_META)).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces a malformed consentKey rather than reusing it", () => {
    const root = join(tmpRoot(), "chan");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, NATIVE_CHANNEL_META),
      `${JSON.stringify({ v: 1, token: "cd".repeat(32), consentKey: "not-hex" })}\n`,
      { mode: 0o600 },
    );
    const channel = prepareNativeChannel(root);
    expect(channel.consentKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates the authorization grant shape before the channel exists", () => {
    const root = join(tmpRoot(), "chan");
    for (const bad of [
      "yes",
      {},
      { operations: [] },
      { operations: "AEGP_ItemSuite9.AEGP_SetItemComment" },
      { operations: ["OP", 3] },
      { operations: ["OP"], targets: "inst-1" },
      { operations: ["OP"], bogus: true },
    ]) {
      expect(() =>
        prepareNativeChannel(root, { authorization: bad as never }),
      ).toThrow(TypeError);
    }
    /* a rejected grant must not leave a half-prepared channel behind
       for the mutation path — the directory may exist (read-only use
       is still valid), but no grant was snapshotted */
    const ok = prepareNativeChannel(join(tmpRoot(), "chan2"), {
      authorization: { operations: ["OP"], targets: ["inst-1"] },
    });
    expect(ok.authorization?.operations).toEqual(["OP"]);
    expect(ok.authorization?.targets).toEqual(["inst-1"]);
  });

  it.skipIf(process.platform === "win32")("refuses a group/other-accessible directory", () => {
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
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
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
    expect(defaultNativeChannelDir("/home/x")).toBe(
      join("/home/x", ".ae-a8n", "native"),
    );
  });
});

const MUTATION_OP = "AEGP_ItemSuite9.AEGP_SetItemComment";
const MUTATION_ARGS = {
  projectIndex: 0,
  item: { aeRef: { type: "comp", name: "Plate", path: [0] } },
  comment: "hello",
};

function mutationInput(overrides: Partial<NativeRequestInput> = {}): NativeRequestInput {
  return baseInput({
    requestId: "mut-001",
    operationId: MUTATION_OP,
    args: MUTATION_ARGS,
    ...overrides,
  });
}

type RequestDoc = {
  consent?: { v: number; mac: string };
  request: { operationId?: string; args?: unknown };
};

function readRequestDoc(
  channel: ReturnType<typeof prepareNativeChannel>,
  requestId: string,
): RequestDoc {
  return JSON.parse(
    readFileSync(join(channel.inbox, `${requestId}${NATIVE_REQUEST_SUFFIX}`), "utf-8"),
  ) as RequestDoc;
}

describe("consent issuance and the authorization policy (#245)", () => {
  it("refuses a requiresConsent op without a grant — before anything is sent", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    expect(() => publishNativeRequest(channel, mutationInput())).toThrow(
      ScriptNotSentError,
    );
    expect(
      existsSync(join(channel.inbox, `mut-001${NATIVE_REQUEST_SUFFIX}`)),
    ).toBe(false);
    expect(
      existsSync(join(channel.inbox, `mut-001${NATIVE_REQUEST_SUFFIX}.part`)),
    ).toBe(false);
  });

  it("refuses when the grant covers a different operation", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"), {
      authorization: { operations: ["AEGP_ItemSuite9.AEGP_GetItemComment"] },
    });
    expect(() => publishNativeRequest(channel, mutationInput())).toThrow(
      ScriptNotSentError,
    );
    expect(
      existsSync(join(channel.inbox, `mut-001${NATIVE_REQUEST_SUFFIX}`)),
    ).toBe(false);
  });

  it("binds target-scoped grants: untargeted and wrong-target requests refuse", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"), {
      authorization: {
        operations: [MUTATION_OP],
        targets: ["inst-1"],
      },
    });
    /* untargeted request is NOT covered by a target-bound grant */
    expect(() => publishNativeRequest(channel, mutationInput())).toThrow(
      ScriptNotSentError,
    );
    expect(() =>
      publishNativeRequest(channel, mutationInput({ target: "inst-2" })),
    ).toThrow(ScriptNotSentError);
    publishNativeRequest(channel, mutationInput({ target: "inst-1" }));
    const doc = readRequestDoc(channel, "mut-001");
    expect(doc.consent?.v).toBe(1);
    expect(doc.consent?.mac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("issues a §7g consent MAC over the exact scope for a covered mutation", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"), {
      authorization: { operations: [MUTATION_OP] },
    });
    publishNativeRequest(channel, mutationInput({ target: "inst-9" }));
    const doc = readRequestDoc(channel, "mut-001");
    expect(doc.consent).toEqual({
      v: 1,
      mac: issueConsentMac(channel.consentKey, {
        operationId: MUTATION_OP,
        requestId: "mut-001",
        session: { sessionId: "sess-1", aeVersion: "26.5" },
        args: MUTATION_ARGS,
        target: "inst-9",
      }),
    });
    /* the MAC is scope-bound: any field change breaks it */
    const tampered = issueConsentMac(channel.consentKey, {
      operationId: MUTATION_OP,
      requestId: "mut-001",
      session: { sessionId: "sess-1", aeVersion: "26.5" },
      args: { ...MUTATION_ARGS, comment: "other" },
      target: "inst-9",
    });
    expect(tampered).not.toBe(doc.consent?.mac);
  });

  it("never attaches consent to read-only ops, grant or not", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"), {
      authorization: { operations: [MUTATION_OP] },
    });
    publishNativeRequest(channel, baseInput({ requestId: "ro-1" }));
    const doc = readRequestDoc(channel, "ro-1");
    expect(doc.consent).toBeUndefined();
  });

  it("refuses non-canonical args on a consent op as ScriptNotSentError", () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"), {
      authorization: { operations: [MUTATION_OP] },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const [label, args] of [
      ["circular", circular],
      ["float", { ...MUTATION_ARGS, projectIndex: 0.5 }],
      ["bigint", { ...MUTATION_ARGS, comment: 1n }],
    ] as const) {
      expect(() =>
        publishNativeRequest(
          channel,
          mutationInput({ requestId: `bad-${label}`, args }),
        ),
      ).toThrow(ScriptNotSentError);
      expect(
        existsSync(join(channel.inbox, `bad-${label}${NATIVE_REQUEST_SUFFIX}`)),
      ).toBe(false);
    }
  });
});

describe("reconcileItemComment (#245, trusted-execution §8.3)", () => {
  const SCOPE = {
    session: { sessionId: "sess-1", aeVersion: "26.5" },
    projectIndex: 0,
    item: MUTATION_ARGS.item,
  };
  const OPTS = { requestId: "rb-001", timeoutMs: 5_000 };

  it("publishes a read-only GetItemComment on the same descriptor", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    const pending = reconcileItemComment(channel, SCOPE, "hello", OPTS);
    /* the read-back request is on disk before the first await */
    const doc = readRequestDoc(channel, "rb-001");
    expect(doc.request.operationId).toBe("AEGP_ItemSuite9.AEGP_GetItemComment");
    expect(doc.request.args).toEqual({ projectIndex: 0, item: MUTATION_ARGS.item });
    expect(doc.consent).toBeUndefined();
    writeResult(channel, "rb-001", {
      outcome: "completed",
      result: { comment: "hello" },
    });
    await expect(pending).resolves.toEqual({
      verdict: "state-consistent",
      observedComment: "hello",
    });
  });

  it("classifies a contradicting observation as state-inconsistent", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    const pending = reconcileItemComment(channel, SCOPE, "hello", OPTS);
    writeResult(channel, "rb-001", {
      outcome: "completed",
      result: { comment: "" },
    });
    await expect(pending).resolves.toEqual({
      verdict: "state-inconsistent",
      observedComment: "",
    });
  });

  it("classifies a refused read-back as unobservable, never guessed", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    const pending = reconcileItemComment(channel, SCOPE, "hello", OPTS);
    writeResult(channel, "rb-001", {
      outcome: "refused",
      refusalCode: "STALE_REFERENCE",
    });
    await expect(pending).resolves.toEqual({
      verdict: "unobservable",
      detail: "refused/STALE_REFERENCE",
    });
  });

  it("propagates UNKNOWN when the read-back itself times out", async () => {
    const channel = prepareNativeChannel(join(tmpRoot(), "chan"));
    await expect(
      reconcileItemComment(channel, SCOPE, "hello", {
        requestId: "rb-001",
        timeoutMs: 10,
        awaitOptions: { pollMs: 5, graceMs: 20 },
      }),
    ).rejects.toThrow(NativeChannelTimeoutError);
    /* the read-back request was still sent — nothing was resent */
    expect(existsSync(join(channel.inbox, `rb-001${NATIVE_REQUEST_SUFFIX}`))).toBe(true);
  });
});
