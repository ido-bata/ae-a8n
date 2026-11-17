/**
 * Reading a signed result's artifacts as verified bytes.
 *
 * `automated test` against the in-repo channel: no real host, no After
 * Effects. The property under test is the one finding 58 named — a file
 * rewritten after `result.json` was signed must be refused, not decoded.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  signResult,
  type JobKey,
  type UnsignedJobResult,
} from "../src/platform/windows/auth.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  JOB_SCHEMA_VERSION,
  encodeResult,
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
} from "../src/platform/windows/job.js";
import { readResultArtifact } from "../src/platform/windows/result-artifacts.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const JOB_ID = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };

const AGENT: AgentIdentity = {
  id: "agent-1",
  host: "WIN-TEST",
  user: "tester",
  sessionId: 1,
  version: "0.1.0",
};

const STDOUT = new TextEncoder().encode("the real output\n");
const STDERR = new TextEncoder().encode("");

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-artifacts-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

async function publish(
  files: DirectoryChannel,
  result: ReturnType<typeof signResult>,
  artifacts: Readonly<Record<string, Uint8Array>>,
): Promise<void> {
  const directory = jobPaths(JOB_ID).resultDirectory;
  for (const [name, bytes] of Object.entries(artifacts)) {
    await files.writeAtomic(`${directory}/${name}`, bytes);
  }
  await files.writeAtomic(jobPaths(JOB_ID).result, encodeResult(result));
}

function unsignedResult(artifacts?: Readonly<Record<string, string>>): UnsignedJobResult {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: JOB_ID,
    status: "ok",
    code: null,
    exitCode: 0,
    message: "done",
    payloadSha256: "a".repeat(64),
    agent: AGENT,
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readResultArtifact", () => {
  it("returns verified bytes when they match the signed digest", async () => {
    const files = await channel();
    const result = signResult(
      unsignedResult({
        "stdout.log": sha256Hex(STDOUT),
        "stderr.log": sha256Hex(STDERR),
      }),
      KEY,
    );
    await publish(files, result, { "stdout.log": STDOUT, "stderr.log": STDERR });

    const read = await readResultArtifact(files, JOB_ID, result, "stdout.log");
    expect(read.proof).toBe("verified");
    if (read.proof === "refused") {
      throw new Error("unreachable");
    }
    expect(read.bytes).toEqual(STDOUT);
  });

  it("refuses bytes rewritten after the result was signed", async () => {
    const files = await channel();
    const result = signResult(
      unsignedResult({ "stdout.log": sha256Hex(STDOUT) }),
      KEY,
    );
    // The digest names the real bytes; the channel holds a forgery.
    await publish(files, result, {
      "stdout.log": new TextEncoder().encode("forged output\n"),
    });

    const read = await readResultArtifact(files, JOB_ID, result, "stdout.log");
    expect(read.proof).toBe("refused");
    if (read.proof === "refused") {
      expect(read.detail).toContain("does not match the digest");
    }
  });

  it("refuses an artifact the result does not name", async () => {
    const files = await channel();
    const result = signResult(unsignedResult({ "stdout.log": sha256Hex(STDOUT) }), KEY);
    await publish(files, result, { "stdout.log": STDOUT, "other.log": STDERR });

    const read = await readResultArtifact(files, JOB_ID, result, "other.log");
    expect(read.proof).toBe("refused");
  });

  it("refuses a named artifact that is missing", async () => {
    const files = await channel();
    const result = signResult(unsignedResult({ "stdout.log": sha256Hex(STDOUT) }), KEY);
    await publish(files, result, {});

    const read = await readResultArtifact(files, JOB_ID, result, "stdout.log");
    expect(read.proof).toBe("refused");
  });

  it("reads an unsigned-digest result as unproven, not refused", async () => {
    // A result from an agent that predates the field: today's behaviour —
    // the bytes are read — with the proof honestly named.
    const files = await channel();
    const result = signResult(unsignedResult(), KEY);
    await publish(files, result, { "stdout.log": STDOUT });

    const read = await readResultArtifact(files, JOB_ID, result, "stdout.log");
    expect(read.proof).toBe("unproven");
    if (read.proof === "refused") {
      throw new Error("unreachable");
    }
    expect(read.bytes).toEqual(STDOUT);
  });
});
