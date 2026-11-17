import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { signRunManifest, type JobKey } from "../src/platform/windows/auth.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  RUN_MANIFEST_SCHEMA_VERSION,
  encodeRunManifest,
  readRunManifest,
  runManifestPath,
  writeRunManifest,
  type RunManifest,
} from "../src/platform/windows/manifest.js";

const RUN_ID = "20261110T120000Z-abcdef01";
const HASH = "a".repeat(64);

const KEY: JobKey = { keyId: "manifest-key", secret: new Uint8Array(32).fill(7) };
const OTHER_KEY: JobKey = { keyId: "other-key", secret: new Uint8Array(32).fill(3) };

const MANIFEST: RunManifest = {
  schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
  runId: RUN_ID,
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  agentId: "agent-1",
  agentVersion: "0.1.0-alpha.1",
  agentVerified: true,
  aeVersion: "26.5.0",
  jobId: "20261110T120000Z-12345678",
  payloadSha256: HASH,
  resultSha256: "b".repeat(64),
  outcome: "ok",
  destinationProof: "marker",
  ownershipProof: "unproven",
  startedAt: "2026-11-10T12:00:00.000Z",
  finishedAt: "2026-11-10T12:00:01.000Z",
  artifactProof: "verified",
};

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-manifest-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the run manifest", () => {
  it("round-trips through runs/<runId>/manifest.json, signed", async () => {
    const files = await channel();
    await writeRunManifest(files, RUN_ID, MANIFEST, KEY);
    expect(await files.read(runManifestPath(RUN_ID))).not.toBeNull();
    expect(await readRunManifest(files, RUN_ID, [KEY])).toEqual({
      ok: true,
      value: signRunManifest(MANIFEST, KEY),
    });
  });

  it("detects a manifest rewritten after publication", async () => {
    // The manifest makes trust claims; a channel writer without the key can
    // flip `outcome` but cannot re-sign it. Reading with the keyring refuses.
    const files = await channel();
    await writeRunManifest(files, RUN_ID, MANIFEST, KEY);
    const signed = signRunManifest(MANIFEST, KEY);
    await files.writeAtomic(
      runManifestPath(RUN_ID),
      encodeRunManifest({ ...signed, outcome: "failed" }),
    );
    const read = await readRunManifest(files, RUN_ID, [KEY]);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.detail).toContain("not authentic");
    }
  });

  it("refuses an unsigned manifest when a keyring is given, and reports it unproven without one", async () => {
    const files = await channel();
    // A manifest written before signing existed: shape-valid, no auth.
    await files.writeAtomic(runManifestPath(RUN_ID), encodeRunManifest(MANIFEST));

    const verified = await readRunManifest(files, RUN_ID, [KEY]);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.detail).toContain("no signature");
    }

    const shapeOnly = await readRunManifest(files, RUN_ID);
    expect(shapeOnly).toMatchObject({ ok: true });
    if (shapeOnly.ok) {
      expect(shapeOnly.value.auth).toBeUndefined();
    }
  });

  it("refuses a manifest signed with a key the reader does not hold", async () => {
    const files = await channel();
    await writeRunManifest(files, RUN_ID, MANIFEST, KEY);
    const read = await readRunManifest(files, RUN_ID, [OTHER_KEY]);
    expect(read.ok).toBe(false);
  });

  it("records an unproven AE version as null", async () => {
    const files = await channel();
    const manifest: RunManifest = { ...MANIFEST, aeVersion: null, outcome: "unknown" };
    await writeRunManifest(files, RUN_ID, manifest, KEY);
    expect(await readRunManifest(files, RUN_ID, [KEY])).toMatchObject({
      ok: true,
      value: { aeVersion: null, outcome: "unknown" },
    });
  });

  it("reports a missing manifest as missing, not as an empty one", async () => {
    const files = await channel();
    expect(await readRunManifest(files, RUN_ID)).toEqual({
      ok: false,
      detail: "manifest.json is missing",
    });
  });

  it("refuses a manifest that names another run", async () => {
    const files = await channel();
    const other = "20261110T110000Z-00000000";
    await expect(
      writeRunManifest(files, RUN_ID, { ...MANIFEST, runId: other }, KEY),
    ).rejects.toThrow("does not match");
  });

  it("rejects a malformed or unsafe document", async () => {
    const files = await channel();
    const path = runManifestPath(RUN_ID);
    const cases: readonly unknown[] = [
      { ...MANIFEST, schemaVersion: "2.0" },
      { ...MANIFEST, outcome: "maybe" },
      { ...MANIFEST, sessionId: "1" },
      { ...MANIFEST, payloadSha256: "nope" },
      { ...MANIFEST, aeVersion: "" },
      { ...MANIFEST, destinationProof: "guessed" },
      { ...MANIFEST, ownershipProof: "presumed" },
      { ...MANIFEST, artifactProof: "probably" },
      { ...MANIFEST, auth: { alg: "hmac-sha256", keyId: "k", signature: "not-hex" } },
      { ...MANIFEST, destinationProof: undefined },
      { ...MANIFEST, runId: "../escape" },
      { ...MANIFEST, startedAt: "yesterday" },
      { ...MANIFEST, host: "" },
    ];
    for (const value of cases) {
      await files.writeAtomic(path, new TextEncoder().encode(JSON.stringify(value)));
      expect((await readRunManifest(files, RUN_ID)).ok).toBe(false);
    }

    await files.writeAtomic(path, new TextEncoder().encode("{"));
    expect((await readRunManifest(files, RUN_ID)).ok).toBe(false);

    await files.writeAtomic(path, new TextEncoder().encode(JSON.stringify({ ...MANIFEST, runId: "other" })));
    expect(await readRunManifest(files, RUN_ID)).toMatchObject({ ok: false, detail: expect.stringContaining("but it is in") });
  });
});
