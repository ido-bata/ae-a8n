/**
 * Opt-in interop check for #238 Slice B: the REAL ae-a8n client
 * (prepareNativeChannel / publishNativeRequest / awaitNativeResult)
 * against the REAL ae-devtools intake — `probe_test --channel-server`
 * running probe.cpp + native_intake.cpp against FakeHost (no After
 * Effects). Point AE_DEVTOOLS_PROBE_TEST at the built test binary;
 * the suite skips when unset so CI stays hermetic. Evidence level:
 * fake/mock only — nothing here is real-host proof.
 *
 * #245 adds the mutation-consent vertical slice: consentKey minting,
 * per-request §7g MAC issuance behind the authorization grant, and the
 * denied/tampered/replayed/UNKNOWN/reconciliation cases — all against
 * the real C++ intake, not a mock.
 *
 * #247 adds the shared-fixture wire run: `wireCases` from the vendored
 * `native-consent-vectors.json` (ae-devtools #337) executed IN ORDER
 * against `probe_test --channel-server with-clip` — the same cases the
 * C++ suite runs in-process. Cases needing in-process host knobs
 * (`hostSetCommentError`, `nullItemEntry`) stay C++-suite-only and are
 * skipped here explicitly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  awaitNativeResult,
  NATIVE_CHANNEL_META,
  NATIVE_REQUEST_SUFFIX,
  NATIVE_RESULT_SUFFIX,
  NativeChannelTimeoutError,
  type NativeDispatchResult,
  prepareNativeChannel,
  publishNativeRequest,
  readNativeChannelState,
  reconcileItemComment,
  type NativeRequestInput,
  type PreparedNativeChannel,
} from "../src/driver/native-channel.js";
import { issueConsentMac } from "../src/driver/native-consent.js";

const BIN = process.env.AE_DEVTOOLS_PROBE_TEST ?? "";

/* Shared consent fixture (vendored from ae-devtools, #247). */
const HERE = dirname(fileURLToPath(import.meta.url));
const CONSENT_FIXTURE = JSON.parse(
  readFileSync(join(HERE, "fixtures", "native-consent-vectors.json"), "utf-8"),
) as {
  v: number;
  consentKey: string;
  channelToken: string;
  operationId: string;
  session: { sessionId: string; aeVersion: string };
  argsJson: string;
  wireCases: WireCase[];
};

type WireExpect = {
  outcome: string;
  refusalCode?: string;
  mayHaveMutated?: "true" | "false" | "absent";
  payload?: Record<string, unknown>;
  opCallsInclude?: string[];
  opCallsExclude?: string[];
};

type WireConsent =
  | { mode: "absent" }
  | { mode: "invalid"; mac: string }
  | { mode: "raw"; raw: string }
  | {
      mode: "valid" | "macFor";
      macFor?: {
        requestId?: string;
        operationId?: string;
        sessionJson?: string;
        argsJson?: string | null;
        target?: string;
      };
      expectedMac: string;
    };

type WireCase = {
  name: string;
  requestId: string;
  argsJson?: string;
  channelConsentKey: boolean;
  consent: WireConsent;
  hostSetCommentError?: boolean;
  nullItemEntry?: boolean;
  expect: WireExpect;
};

/** The scope a presented consent MAC was computed over: the request's
 *  own fields, overridden by consent.macFor where present. Mirrors the
 *  devtools fixture semantics (consent.test.ts presentedMacScope). */
function presentedMacScope(c: WireCase) {
  const over =
    c.consent.mode === "valid" || c.consent.mode === "macFor"
      ? c.consent.macFor
      : undefined;
  const argsJson =
    over?.argsJson !== undefined ? over.argsJson : (c.argsJson ?? CONSENT_FIXTURE.argsJson);
  return {
    operationId: over?.operationId ?? CONSENT_FIXTURE.operationId,
    requestId: over?.requestId ?? c.requestId,
    session: JSON.parse(over?.sessionJson ?? JSON.stringify(CONSENT_FIXTURE.session)),
    args: argsJson === null || argsJson === undefined ? null : JSON.parse(argsJson),
    ...(over?.target === undefined ? {} : { target: over.target }),
  };
}

const FAST = { pollMs: 50, graceMs: 25_000 };
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function spawnChannelServer(
  root: string,
  watchId: string,
  deadlineMs: number,
  fixture?: string,
  fault?: string,
): ChildProcess {
  const args = ["--channel-server", root, watchId, String(deadlineMs)];
  if (fixture !== undefined) args.push(fixture);
  /* devtools #352: optional fault arg ("setcomment-error" /
     "null-itementry") — one channel-server run serves one requestId,
     so fault cases each get a dedicated process. */
  if (fault !== undefined) args.push(fault);
  return spawn(BIN, args, { stdio: "ignore" });
}

const SET_OP = "AEGP_ItemSuite9.AEGP_SetItemComment";
const SESSION = { sessionId: "consent-interop", aeVersion: "26.5" };
const PLATE = { aeRef: { type: "comp", name: "Plate", path: [0] } };
const SET_ARGS = { projectIndex: 0, item: PLATE, comment: "note" };

function setCommentInput(requestId: string, comment: string): NativeRequestInput {
  return {
    requestId,
    timeoutMs: 30_000,
    session: SESSION,
    operationId: SET_OP,
    args: { projectIndex: 0, item: PLATE, comment },
  };
}

/** Hand-write a contract-shaped request file, bypassing the client. */
function writeRawRequest(
  root: string,
  token: string,
  requestId: string,
  envelope: Record<string, unknown>,
): void {
  writeFileSync(
    join(root, "inbox", `${requestId}${NATIVE_REQUEST_SUFFIX}`),
    `${JSON.stringify({ v: 1, token, timeoutMs: 30_000, ...envelope })}\n`,
    { mode: 0o600 },
  );
}

function channelSecrets(root: string): { token: string; consentKey?: string } {
  return JSON.parse(readFileSync(join(root, NATIVE_CHANNEL_META), "utf-8")) as {
    token: string;
    consentKey?: string;
  };
}

function rawSetRequest(
  requestId: string,
  consent?: { v: 1; mac: string },
): Record<string, unknown> {
  return {
    ...(consent === undefined ? {} : { consent }),
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId,
      session: SESSION,
      operationId: SET_OP,
      args: SET_ARGS,
    },
  };
}

describe.skipIf(BIN === "")("native-channel interop with ae-devtools probe_test (fake host)", () => {
  it("publishes a request the real intake processes and collects the typed result", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-native-interop-"));
    try {
      const channel = prepareNativeChannel(root);
      const input: NativeRequestInput = {
        requestId: "interop-1",
        timeoutMs: 30_000,
        session: { sessionId: "interop", aeVersion: "26.5" },
        operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
      };
      publishNativeRequest(channel, input);

      const child = spawn(BIN, ["--channel-server", root, "interop-1", "20000"], {
        stdio: "ignore",
      });
      const delivery = await awaitNativeResult(channel, "interop-1", 30_000, {
        graceMs: 25_000,
        pollMs: 50,
      });
      child.kill();

      expect(delivery.result.outcome).toBe("completed");
      expect(delivery.result.requestId).toBe("interop-1");
      expect(delivery.result.schema).toBe("ae-devtools/native-dispatch/v1");
      expect((delivery.result.result as { numProjects?: number }).numProjects).toBeTypeOf("number");
      expect(delivery.result.opCalls?.length).toBeGreaterThan(0);
      expect(delivery.host.plugin).toBe("ae-a8n NativeProbe");

      const state = readNativeChannelState(root);
      expect(state?.instance).toBe(delivery.instance);
      expect(state?.allowlist).toContain("AEGP_ProjSuite6.AEGP_GetNumProjects");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(BIN === "")(
  "native-channel mutation consent interop with ae-devtools probe_test (fake host, #245)",
  () => {
    let root = "";
    let channel: PreparedNativeChannel;
    let child: ChildProcess | undefined;

    afterAll(() => {
      child?.kill();
      if (root !== "") {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("authorized SetItemComment completes, marks mayHaveMutated, and reconciles", async () => {
      root = mkdtempSync(join(tmpdir(), "a8n-native-mutation-"));
      channel = prepareNativeChannel(root, {
        authorization: { grants: [{ operationId: SET_OP }] },
      });
      /* watch id is never published: the server keeps processing the
         whole inbox (one request per idle tick, name-sorted) until the
         deadline, so sequential mutation + read-back requests share
         one FakeHost — required because host state is per-process. */
      child = spawnChannelServer(root, "zz-live", 55000, "with-items");

      publishNativeRequest(channel, setCommentInput("a1-set", "note-1"));
      const delivery = await awaitNativeResult(channel, "a1-set", 30_000, FAST);
      expect(delivery.result.outcome).toBe("completed");
      expect(delivery.result.mayHaveMutated).toBe(true);
      expect(delivery.result.result).toEqual({ commentSet: true });
      expect(delivery.result.opCalls).toContain(SET_OP);

      const recon = await reconcileItemComment(
        channel,
        { session: SESSION, projectIndex: 0, item: PLATE },
        "note-1",
        { requestId: "a1-read", timeoutMs: 30_000, awaitOptions: FAST },
      );
      expect(recon).toEqual({ verdict: "state-consistent", observedComment: "note-1" });
    }, 60_000);

    it("a lost result is client-side UNKNOWN — never resent — and read-back is consistency evidence, not proof", async () => {
      publishNativeRequest(channel, setCommentInput("a2-set", "phantom"));
      /* let the real intake claim and complete the mutation, then
         remove the verdict file: the client can no longer prove the
         outcome — exactly the UNKNOWN case. */
      const resultPath = join(root, "outbox", `a2-set${NATIVE_RESULT_SUFFIX}`);
      await waitForFile(resultPath, 20_000);
      rmSync(resultPath);
      await expect(
        awaitNativeResult(channel, "a2-set", 50, { pollMs: 10, graceMs: 50 }),
      ).rejects.toThrow(NativeChannelTimeoutError);
      /* nothing was resent: the consumed request left no inbox file
         and no duplicate requestId exists */
      expect(existsSync(join(root, "inbox", `a2-set${NATIVE_REQUEST_SUFFIX}`))).toBe(false);

      const recon = await reconcileItemComment(
        channel,
        { session: SESSION, projectIndex: 0, item: PLATE },
        "phantom",
        { requestId: "a2-read", timeoutMs: 30_000, awaitOptions: FAST },
      );
      /* state-consistent records that observed state matches intent;
         it is NOT upgraded to "this request caused it" (§8.3). */
      expect(recon).toEqual({ verdict: "state-consistent", observedComment: "phantom" });
    }, 60_000);

    it("a stale descriptor refuses before the mutation; read-back shows it did not land", async () => {
      const ghost = { aeRef: { type: "comp", name: "Ghost", path: [0] } };
      publishNativeRequest(channel, {
        requestId: "a3-set",
        timeoutMs: 30_000,
        session: SESSION,
        operationId: SET_OP,
        args: { projectIndex: 0, item: ghost, comment: "boo" },
      });
      const delivery = await awaitNativeResult(channel, "a3-set", 30_000, FAST);
      expect(delivery.result.outcome).toBe("refused");
      expect(delivery.result.refusalCode).toBe("STALE_REFERENCE");
      expect(delivery.result.mayHaveMutated).not.toBe(true); // refused verdicts omit the field — pre-execution by definition
      expect(delivery.result.opCalls ?? []).not.toContain(SET_OP);

      const recon = await reconcileItemComment(
        channel,
        { session: SESSION, projectIndex: 0, item: PLATE },
        "boo",
        { requestId: "a3-read", timeoutMs: 30_000, awaitOptions: FAST },
      );
      /* observed "phantom" contradicts intended "boo" → the mutation
         provably did not land (effect fully observable via getter). */
      expect(recon).toEqual({ verdict: "state-inconsistent", observedComment: "phantom" });
    }, 60_000);

    it("a replayed requestId is refused DUPLICATE_REQUEST by the real seen-ring", async () => {
      publishNativeRequest(channel, setCommentInput("a4-set", "note-4"));
      const first = await awaitNativeResult(channel, "a4-set", 30_000, FAST);
      expect(first.result.outcome).toBe("completed");
      /* the verdict file would mask the second verdict — remove it so
         the replay's own result is what gets collected */
      rmSync(join(root, "outbox", `a4-set${NATIVE_RESULT_SUFFIX}`));
      publishNativeRequest(channel, setCommentInput("a4-set", "note-4"));
      const second = await awaitNativeResult(channel, "a4-set", 30_000, FAST);
      expect(second.result.outcome).toBe("refused");
      expect(second.result.refusalCode).toBe("DUPLICATE_REQUEST");
      expect(second.result.mayHaveMutated).not.toBe(true); // refused verdicts omit the field — pre-execution by definition
    }, 60_000);

    it("consent boundary: missing, wrong-scope, tampered and keyless proofs all refuse before execution", async () => {
      const root2 = mkdtempSync(join(tmpdir(), "a8n-native-refusals-"));
      const child2 = spawnChannelServer(root2, "zz-ref", 45000);
      try {
        const prepared = prepareNativeChannel(root2, {
          authorization: { grants: [{ operationId: SET_OP }] },
        });
        const { token, consentKey } = channelSecrets(root2);
        expect(consentKey).toMatch(/^[a-f0-9]{64}$/);

        /* no consent at all → CONSENT_REQUIRED */
        writeRawRequest(root2, token, "b1-nocon", rawSetRequest("b1-nocon"));
        /* well-formed but wrong MAC → CONSENT_INVALID */
        writeRawRequest(root2, token, "b2-badmac", rawSetRequest("b2-badmac", { v: 1, mac: "0".repeat(64) }));
        /* valid MAC over a DIFFERENT scope (other comment) → CONSENT_INVALID */
        const wrongScope = issueConsentMac(consentKey as string, {
          operationId: SET_OP,
          requestId: "b3-wrongscope",
          session: SESSION,
          args: { projectIndex: 0, item: PLATE, comment: "other" },
        });
        writeRawRequest(root2, token, "b3-wrongscope", rawSetRequest("b3-wrongscope", { v: 1, mac: wrongScope }));
        /* MAC minted for the untampered session, request carries a
           changed sessionId → CONSENT_INVALID (session is in scope) */
        const sessMac = issueConsentMac(consentKey as string, {
          operationId: SET_OP,
          requestId: "b4-sess",
          session: SESSION,
          args: SET_ARGS,
        });
        writeRawRequest(root2, token, "b4-sess", {
          consent: { v: 1, mac: sessMac },
          request: {
            schema: "ae-devtools/native-dispatch/v1",
            requestId: "b4-sess",
            session: { sessionId: "tampered", aeVersion: "26.5" },
            operationId: SET_OP,
            args: SET_ARGS,
          },
        });
        /* consent on a read-only op is ignored, never an error */
        writeRawRequest(root2, token, "b5-roconsent", {
          consent: { v: 1, mac: "0".repeat(64) },
          request: {
            schema: "ae-devtools/native-dispatch/v1",
            requestId: "b5-roconsent",
            session: SESSION,
            operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
            args: null,
          },
        });

        for (const [id, code] of [
          ["b1-nocon", "CONSENT_REQUIRED"],
          ["b2-badmac", "CONSENT_INVALID"],
          ["b3-wrongscope", "CONSENT_INVALID"],
          ["b4-sess", "CONSENT_INVALID"],
        ] as const) {
          const delivery = await awaitNativeResult(prepared, id, 30_000, FAST);
          expect(delivery.result.outcome).toBe("refused");
          expect(delivery.result.refusalCode).toBe(code);
          expect(delivery.result.mayHaveMutated).not.toBe(true); // refused verdicts omit the field — pre-execution by definition
          /* no AEGP mutation call may appear on a consent refusal */
          expect(delivery.result.opCalls ?? []).not.toContain(SET_OP);
        }
        const ro = await awaitNativeResult(prepared, "b5-roconsent", 30_000, FAST);
        expect(ro.result.outcome).toBe("completed");
      } finally {
        child2.kill();
        rmSync(root2, { recursive: true, force: true });
      }
    }, 60_000);

    it("a channel.json without consentKey refuses mutations CONSENT_REQUIRED (fail closed)", async () => {
      const root3 = mkdtempSync(join(tmpdir(), "a8n-native-nokey-"));
      try {
        for (const d of ["inbox", "outbox"]) {
          mkdirSync(join(root3, d), { recursive: true, mode: 0o700 });
          chmodSync(join(root3, d), 0o700);
        }
        const token = "ef".repeat(32);
        writeFileSync(
          join(root3, NATIVE_CHANNEL_META),
          `${JSON.stringify({ v: 1, token })}\n`,
          { mode: 0o600 },
        );
        const mac = issueConsentMac("ab".repeat(32), {
          operationId: SET_OP,
          requestId: "c5-set",
          session: SESSION,
          args: SET_ARGS,
        });
        writeRawRequest(root3, token, "c5-set", rawSetRequest("c5-set", { v: 1, mac }));

        const child3 = spawnChannelServer(root3, "c5-set", 20000);
        try {
          /* prepareNativeChannel would backfill a key — read results
             with a bare channel object instead */
          const bare = { root: root3, token, consentKey: "", inbox: join(root3, "inbox"), outbox: join(root3, "outbox"), reused: true };
          const delivery = await awaitNativeResult(bare, "c5-set", 30_000, FAST);
          child3.kill();
          expect(delivery.result.outcome).toBe("refused");
          expect(delivery.result.refusalCode).toBe("CONSENT_REQUIRED");
        } finally {
          child3.kill();
        }
      } finally {
        rmSync(root3, { recursive: true, force: true });
      }
    }, 60_000);
  },
);

/* Write channel.json for a wire case: fixture token always, consentKey
   only when the case declares channelConsentKey. The plug-in re-reads
   channel.json every tick, so per-case rewrites take effect without a
   restart. */
function writeWireChannelMeta(root: string, withKey: boolean): void {
  const meta: Record<string, unknown> = { v: 1, token: CONSENT_FIXTURE.channelToken };
  if (withKey) {
    meta.consentKey = CONSENT_FIXTURE.consentKey;
  }
  /* Atomic replace: the plug-in re-reads channel.json every tick, so a
     torn write must never be observable. */
  const target = join(root, NATIVE_CHANNEL_META);
  const part = `${target}.part`;
  writeFileSync(part, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  renameSync(part, target);
}

/* Build the contract envelope for a wire case. `macFor`/`valid` modes
   carry consent.expectedMac; `macFor` MACs are recomputed here and
   asserted against the fixture pin before the file is written. */
function wireEnvelope(c: WireCase): Record<string, unknown> {
  const argsJson = c.argsJson ?? CONSENT_FIXTURE.argsJson;
  const envelope: Record<string, unknown> = {
    v: 1,
    token: CONSENT_FIXTURE.channelToken,
    timeoutMs: 30_000,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: c.requestId,
      session: CONSENT_FIXTURE.session,
      operationId: CONSENT_FIXTURE.operationId,
      args: JSON.parse(argsJson),
    },
  };
  const consent = c.consent;
  if (consent.mode === "absent") {
    return envelope;
  }
  if (consent.mode === "raw") {
    envelope.consent = JSON.parse(consent.raw);
    return envelope;
  }
  if (consent.mode === "invalid") {
    envelope.consent = { v: 1, mac: consent.mac };
    return envelope;
  }
  /* valid | macFor: the presented MAC must equal the fixture pin —
     recompute over the presented scope (macFor overrides apply) so a
     drift in OUR issuance is caught before the wire even sees it. */
  const mac = issueConsentMac(CONSENT_FIXTURE.consentKey, presentedMacScope(c));
  expect(mac, `wireCase ${c.name} expectedMac`).toBe(consent.expectedMac);
  envelope.consent = { v: 1, mac };
  return envelope;
}

/* Publish one fixture wire case's envelope atomically (.part + rename,
   the same write shape the client uses). A repeated requestId (the
   replay case) would otherwise read the PREVIOUS verdict file — remove
   it first so the new verdict is what gets collected. */
function publishWireRequest(root: string, c: WireCase): void {
  rmSync(
    join(root, "outbox", `${c.requestId}${NATIVE_RESULT_SUFFIX}`),
    { force: true },
  );
  const envelope = wireEnvelope(c);
  const reqPath = join(root, "inbox", `${c.requestId}${NATIVE_REQUEST_SUFFIX}`);
  writeFileSync(`${reqPath}.part`, `${JSON.stringify(envelope)}\n`, {
    mode: 0o600,
  });
  renameSync(`${reqPath}.part`, reqPath);
}

/* Assert a collected delivery against the fixture's expect block.
   opCalls pins are SUBSTRING matches — the fixture's short names
   ("AEGP_SetItemComment") match the full operationIds the wire result
   carries, same as JValContains in the C++ suite. */
function assertWireDelivery(c: WireCase, r: NativeDispatchResult): void {
  expect(r.outcome, `wireCase ${c.name}`).toBe(c.expect.outcome);
  if (c.expect.refusalCode !== undefined) {
    expect(r.refusalCode, `wireCase ${c.name}`).toBe(c.expect.refusalCode);
  }
  if (c.expect.mayHaveMutated === "true") {
    expect(r.mayHaveMutated, `wireCase ${c.name}`).toBe(true);
  } else if (c.expect.mayHaveMutated === "false") {
    expect(r.mayHaveMutated, `wireCase ${c.name}`).toBe(false);
  } else {
    /* "absent": refused/not-sent verdicts omit the field — a
       pre-execution outcome must never claim possible mutation. */
    expect(r.mayHaveMutated, `wireCase ${c.name}`).toBeUndefined();
  }
  if (c.expect.payload !== undefined) {
    expect(r.result, `wireCase ${c.name}`).toEqual(c.expect.payload);
  }
  const calls = r.opCalls ?? [];
  for (const op of c.expect.opCallsInclude ?? []) {
    expect(
      calls.some((entry) => entry.includes(op)),
      `wireCase ${c.name} opCalls include ${op}`,
    ).toBe(true);
  }
  for (const op of c.expect.opCallsExclude ?? []) {
    expect(
      calls.some((entry) => entry.includes(op)),
      `wireCase ${c.name} opCalls exclude ${op}`,
    ).toBe(false);
  }
}

/* The devtools #352 channel-server fault arg for a wire case: exactly
   one host-knob flag per fault case, mapped to the C++ fixture mode. */
function wireCaseFault(c: WireCase): string {
  const faults = [
    ...(c.hostSetCommentError === true ? ["setcomment-error"] : []),
    ...(c.nullItemEntry === true ? ["null-itementry"] : []),
  ];
  expect(faults, `wireCase ${c.name} fault flags`).toHaveLength(1);
  return faults[0] as string;
}

describe.skipIf(BIN === "")(
  "shared consent wireCases against ae-devtools probe_test (fake host, #247)",
  () => {
    let root = "";
    let child: ChildProcess | undefined;

    afterAll(() => {
      child?.kill();
      if (root !== "") {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("executes the fixture wireCases in order on one channel + one host", async () => {
      root = mkdtempSync(join(tmpdir(), "a8n-native-wire-"));
      for (const d of ["inbox", "outbox"]) {
        mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
        chmodSync(join(root, d), 0o700);
      }
      /* with-clip (devtools #341): project Shot01 /tmp/shot01.aep with
         COMP item "Clip" itemId 7001 — the fixture argsJson descriptor. */
      child = spawnChannelServer(root, "zz-wire", 120_000, "with-clip");
      const channel = {
        root,
        token: CONSENT_FIXTURE.channelToken,
        consentKey: CONSENT_FIXTURE.consentKey,
        inbox: join(root, "inbox"),
        outbox: join(root, "outbox"),
        reused: true,
      };

      /* Host-knob cases (hostSetCommentError, nullItemEntry) run in the
         dedicated fault-injection block below — devtools #352 gives
         each its own channel-server process. */
      const runnable = CONSENT_FIXTURE.wireCases.filter(
        (c) => c.hostSetCommentError !== true && c.nullItemEntry !== true,
      );
      expect(runnable.length).toBe(CONSENT_FIXTURE.wireCases.length - 2);

      for (const c of runnable) {
        writeWireChannelMeta(root, c.channelConsentKey);
        publishWireRequest(root, c);
        const delivery = await awaitNativeResult(channel, c.requestId, 30_000, FAST);
        assertWireDelivery(c, delivery.result);
      }
    }, 180_000);

    it("executes the fault-injection wireCases, one channel-server process each (#256)", async () => {
      const faultCases = CONSENT_FIXTURE.wireCases.filter(
        (c) => c.hostSetCommentError === true || c.nullItemEntry === true,
      );
      expect(faultCases.length).toBe(2);

      for (const c of faultCases) {
        /* Fresh root per case: the fault is baked into the FakeHost at
           process start, and one channel-server run serves one
           requestId — cases cannot share a host. */
        const caseRoot = mkdtempSync(join(tmpdir(), "a8n-native-fault-"));
        const children: ChildProcess[] = [];
        try {
          for (const d of ["inbox", "outbox"]) {
            mkdirSync(join(caseRoot, d), { recursive: true, mode: 0o700 });
            chmodSync(join(caseRoot, d), 0o700);
          }
          writeWireChannelMeta(caseRoot, c.channelConsentKey);
          children.push(
            spawnChannelServer(
              caseRoot,
              c.requestId,
              30_000,
              "with-clip",
              wireCaseFault(c),
            ),
          );
          const channel = {
            root: caseRoot,
            token: CONSENT_FIXTURE.channelToken,
            consentKey: CONSENT_FIXTURE.consentKey,
            inbox: join(caseRoot, "inbox"),
            outbox: join(caseRoot, "outbox"),
            reused: true,
          };
          publishWireRequest(caseRoot, c);
          const delivery = await awaitNativeResult(
            channel,
            c.requestId,
            30_000,
            FAST,
          );
          assertWireDelivery(c, delivery.result);
        } finally {
          for (const ch of children) ch.kill();
          rmSync(caseRoot, { recursive: true, force: true });
        }
      }
    }, 120_000);
  },
);
