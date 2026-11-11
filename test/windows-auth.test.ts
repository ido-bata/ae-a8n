import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeKeyFile,
  encodeKeyFile,
  signClaim,
  signJob,
  signResult,
  verifyClaimAuth,
  verifyJobAuth,
  verifyResultAuth,
  type JobKey,
  type UnsignedClaim,
  type UnsignedJobResult,
} from "../src/platform/windows/auth.js";
import { loadKeyFile } from "../src/platform/windows/key-store.js";
import {
  JOB_SCHEMA_VERSION,
  decodeClaim,
  decodeJob,
  decodeResult,
  encodeClaim,
  encodeJob,
  encodeResult,
  sha256Hex,
  type Job,
} from "../src/platform/windows/job.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode("{}\n");
const KEY: JobKey = { keyId: "agent-key", secret: new Uint8Array(32).fill(7) };
const OTHER: JobKey = { keyId: "other-key", secret: new Uint8Array(32).fill(9) };

function job(): Job {
  return signJob(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId: "20261110T120000Z-abcdef01",
      runId: "20261110T120000Z-run00001",
      createdAt: NOW.toISOString(),
      payloadSha256: sha256Hex(PAYLOAD),
      payloadFile: "payload.json",
      writer: { host: "controller", user: "tester" },
    },
    KEY,
  );
}

function unsignedResult(): UnsignedJobResult {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: "20261110T120000Z-abcdef01",
    status: "ok",
    code: null,
    exitCode: 0,
    message: "done",
    payloadSha256: sha256Hex(PAYLOAD),
    agent: { id: "agent-1", host: "WIN", user: "a8n", sessionId: 1, version: "0.1.0" },
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
  };
}

const roots: string[] = [];

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a8n-auth-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("job and result signatures", () => {
  it("accepts a job and a result signed with the configured key", () => {
    expect(verifyJobAuth(job(), [KEY])).toEqual({ ok: true });
    expect(verifyResultAuth(signResult(unsignedResult(), KEY), [KEY])).toEqual({ ok: true });
  });

  it("refuses a job signed with a key this side does not hold", () => {
    const outcome = verifyJobAuth(job(), [OTHER]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("does not have");
    }
  });

  it("refuses a job whose signed field changed after signing", () => {
    const signed = job();
    const tampered: Job = { ...signed, createdAt: "2026-11-10T11:00:00.000Z" };
    expect(verifyJobAuth(tampered, [KEY])).toEqual({
      ok: false,
      detail: "the signature does not match the document",
    });
  });

  it("refuses a result whose status changed after signing", () => {
    const signed = signResult(unsignedResult(), KEY);
    const tampered = { ...signed, status: "failed" as const };
    expect(verifyResultAuth(tampered, [KEY]).ok).toBe(false);
  });

  it("refuses a signature with the right key id but the wrong bytes", () => {
    const signed = job();
    const tampered: Job = { ...signed, auth: { ...signed.auth, signature: "0".repeat(64) } };
    expect(verifyJobAuth(tampered, [KEY]).ok).toBe(false);
  });

  it("signs and verifies a claim in its own domain", () => {
    const claim = signClaim(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: "20261110T120000Z-abcdef01",
        claimedAt: NOW.toISOString(),
        agent: { id: "agent-1", host: "WIN", user: "a8n", sessionId: 1, version: "0.1.0" },
      },
      KEY,
    );
    expect(verifyClaimAuth(claim, [KEY])).toEqual({ ok: true });
    const decoded = decodeClaim(encodeClaim(claim));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(verifyClaimAuth(decoded.value, [KEY])).toEqual({ ok: true });
    }
  });

  it("refuses a claim whose signed field changed after signing", () => {
    const signed = signClaim(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: "20261110T120000Z-abcdef01",
        claimedAt: NOW.toISOString(),
        agent: { id: "agent-1", host: "WIN", user: "a8n", sessionId: 1, version: "0.1.0" },
      } satisfies UnsignedClaim,
      KEY,
    );
    const tampered = { ...signed, claimedAt: "2026-11-10T11:00:00.000Z" };
    expect(verifyClaimAuth(tampered, [KEY]).ok).toBe(false);
  });

  it("does not accept a claim or a job signature in the other's place", () => {
    const claim = signClaim(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: "20261110T120000Z-abcdef01",
        claimedAt: NOW.toISOString(),
        agent: { id: "agent-1", host: "WIN", user: "a8n", sessionId: 1, version: "0.1.0" },
      },
      KEY,
    );
    const job = signJob(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: "20261110T120000Z-abcdef01",
        runId: "20261110T120000Z-run00001",
        createdAt: NOW.toISOString(),
        payloadSha256: sha256Hex(PAYLOAD),
        payloadFile: "payload.json",
        writer: { host: "controller", user: "tester" },
      },
      KEY,
    );
    // The domain tag is what keeps the two from signing the same bytes.
    expect(verifyClaimAuth({ ...claim, auth: job.auth }, [KEY]).ok).toBe(false);
    expect(verifyJobAuth({ ...job, auth: claim.auth }, [KEY]).ok).toBe(false);
  });

  it("survives a round trip through the encoded document", () => {    const signed = job();
    const decoded = decodeJob(encodeJob(signed));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(verifyJobAuth(decoded.value, [KEY])).toEqual({ ok: true });
    }
    const result = signResult(unsignedResult(), KEY);
    const decodedResult = decodeResult(encodeResult(result));
    expect(decodedResult.ok).toBe(true);
    if (decodedResult.ok) {
      expect(verifyResultAuth(decodedResult.value, [KEY])).toEqual({ ok: true });
    }
  });
});

describe("key files", () => {
  it("round-trips a key", () => {
    expect(decodeKeyFile(encodeKeyFile(KEY))).toEqual({ ok: true, value: KEY });
  });

  it("refuses an unknown field, a short secret, and non-canonical base64", () => {
    const file = JSON.parse(new TextDecoder().decode(encodeKeyFile(KEY))) as Record<string, unknown>;
    expect(decodeKeyFile(new TextEncoder().encode(JSON.stringify({ ...file, role: "admin" })))).toEqual({
      ok: false,
      detail: 'unknown key-file field "role"',
    });
    const short = Buffer.from(new Uint8Array(16)).toString("base64");
    expect(
      decodeKeyFile(new TextEncoder().encode(JSON.stringify({ ...file, secret: short }))),
    ).toMatchObject({ ok: false });
    expect(
      decodeKeyFile(
        new TextEncoder().encode(JSON.stringify({ ...file, secret: `${String(file["secret"])}=` })),
      ),
    ).toMatchObject({ ok: false });
  });

  it.runIf(process.platform !== "win32")("loads an owner-only key file", async () => {
    const root = await directory();
    const path = join(root, "agent.key");
    await writeFile(path, encodeKeyFile(KEY), { mode: 0o600 });
    expect(await loadKeyFile(path)).toEqual({ ok: true, key: KEY });
  });

  it.runIf(process.platform !== "win32")("refuses a key file readable by others", async () => {
    const root = await directory();
    const path = join(root, "agent.key");
    await writeFile(path, encodeKeyFile(KEY), { mode: 0o644 });
    const loaded = await loadKeyFile(path);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.detail).toContain("readable by group or others");
    }
  });

  it("refuses a symlinked key file", async () => {
    const root = await directory();
    const target = join(root, "real.key");
    const link = join(root, "link.key");
    await writeFile(target, encodeKeyFile(KEY), { mode: 0o600 });
    await symlink(target, link);
    expect(await loadKeyFile(link)).toMatchObject({ ok: false });
  });

  it("reports a missing key file as a refusal, not a crash", async () => {
    const root = await directory();
    expect(await loadKeyFile(join(root, "missing.key"))).toMatchObject({ ok: false });
  });
});
