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
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  awaitNativeResult,
  NATIVE_CHANNEL_META,
  NATIVE_REQUEST_SUFFIX,
  NATIVE_RESULT_SUFFIX,
  NativeChannelTimeoutError,
  prepareNativeChannel,
  publishNativeRequest,
  readNativeChannelState,
  reconcileItemComment,
  type NativeRequestInput,
  type PreparedNativeChannel,
} from "../src/driver/native-channel.js";
import { issueConsentMac } from "../src/driver/native-consent.js";

const BIN = process.env.AE_DEVTOOLS_PROBE_TEST ?? "";

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
): ChildProcess {
  const args = ["--channel-server", root, watchId, String(deadlineMs)];
  if (fixture !== undefined) args.push(fixture);
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
        authorization: { operations: [SET_OP] },
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
          authorization: { operations: [SET_OP] },
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
