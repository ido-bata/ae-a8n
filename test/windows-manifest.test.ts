import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  RUN_MANIFEST_SCHEMA_VERSION,
  readRunManifest,
  runManifestPath,
  writeRunManifest,
  type RunManifest,
} from "../src/platform/windows/manifest.js";

const RUN_ID = "20261110T120000Z-abcdef01";
const HASH = "a".repeat(64);

const MANIFEST: RunManifest = {
  schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
  runId: RUN_ID,
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  agentId: "agent-1",
  agentVersion: "0.1.0-alpha.1",
  aeVersion: "26.5.0",
  jobId: "20261110T120000Z-12345678",
  payloadSha256: HASH,
  resultSha256: "b".repeat(64),
  outcome: "ok",
  startedAt: "2026-11-10T12:00:00.000Z",
  finishedAt: "2026-11-10T12:00:01.000Z",
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
  it("round-trips through runs/<runId>/manifest.json", async () => {
    const files = await channel();
    await writeRunManifest(files, RUN_ID, MANIFEST);
    expect(await files.read(runManifestPath(RUN_ID))).not.toBeNull();
    expect(await readRunManifest(files, RUN_ID)).toEqual({ ok: true, value: MANIFEST });
  });

  it("records an unproven AE version as null", async () => {
    const files = await channel();
    const manifest: RunManifest = { ...MANIFEST, aeVersion: null, outcome: "unknown" };
    await writeRunManifest(files, RUN_ID, manifest);
    expect(await readRunManifest(files, RUN_ID)).toMatchObject({
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
      writeRunManifest(files, RUN_ID, { ...MANIFEST, runId: other }),
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
