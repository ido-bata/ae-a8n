import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryChannel, UnsupportedChannelPathError } from "../src/platform/windows/channel.js";
import {
  JOB_SCHEMA_VERSION,
  decodeJob,
  decodeResult,
  encodeJob,
  encodeResult,
  isJobId,
  jobPaths,
  newJobId,
  sha256Hex,
  validateJob,
  type Job,
  type JobResult,
} from "../src/platform/windows/job.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode('{"command":"echo hi"}\n');

function validJob(overrides: Partial<Job> = {}): Job {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: newJobId(NOW, new Uint8Array([1, 2, 3, 4])),
    runId: "20261110T120000Z-run00001",
    createdAt: NOW.toISOString(),
    payloadSha256: sha256Hex(PAYLOAD),
    payloadFile: "payload.json",
    writer: { host: "controller", user: "tester" },
    ...overrides,
  };
}

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-channel-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("job identifiers", () => {
  it("are sortable and match the accepted form", () => {
    const id = newJobId(NOW, new Uint8Array([0xab, 0xcd, 0xef, 0x01]));
    expect(id).toBe("20261110T120000Z-abcdef01");
    expect(isJobId(id)).toBe(true);
  });

  it("reject a free-form name", () => {
    expect(isJobId("../../etc/passwd")).toBe(false);
    expect(isJobId("2026-11-10-abc")).toBe(false);
  });

  it("place every path under the channel root", () => {
    const paths = jobPaths("20261110T120000Z-abcdef01");
    expect(paths.manifest).toBe("jobs/20261110T120000Z-abcdef01/job.json");
    expect(paths.payload("payload.json")).toBe("jobs/20261110T120000Z-abcdef01/payload.json");
    expect(paths.claim).toBe("claims/20261110T120000Z-abcdef01.json");
    expect(paths.result).toBe("results/20261110T120000Z-abcdef01/result.json");
  });
});

describe("the job manifest", () => {
  it("round-trips", () => {
    const job = validJob();
    const decoded = decodeJob(encodeJob(job));
    expect(decoded).toEqual({ ok: true, value: job });
  });

  it("rejects an unknown schema version", () => {
    const bytes = encodeJob({ ...validJob(), schemaVersion: "2.0" as typeof JOB_SCHEMA_VERSION });
    expect(decodeJob(bytes)).toMatchObject({ ok: false });
  });

  it("rejects a payload file that is a path", () => {
    const bytes = encodeJob(validJob({ payloadFile: "../payload.json" }));
    expect(decodeJob(bytes)).toEqual({
      ok: false,
      detail: 'payloadFile "../payload.json" is a path, not a file name',
    });
  });

  it("rejects a malformed job id and hash", () => {
    expect(decodeJob(encodeJob(validJob({ jobId: "abc" }))).ok).toBe(false);
    expect(decodeJob(encodeJob(validJob({ payloadSha256: "nope" }))).ok).toBe(false);
  });

  it("requires a run id the agent can name without guessing", () => {
    const missing = encodeJob(validJob());
    const withoutRunId = JSON.parse(Buffer.from(missing).toString("utf-8")) as Record<string, unknown>;
    delete withoutRunId["runId"];
    expect(decodeJob(new TextEncoder().encode(JSON.stringify(withoutRunId)))).toEqual({
      ok: false,
      detail: "job.json is missing a required field",
    });
    expect(decodeJob(encodeJob(validJob({ runId: "../escape" })))).toMatchObject({ ok: false });
  });

  it("rejects invalid JSON", () => {
    expect(decodeJob(new TextEncoder().encode("{"))).toEqual({
      ok: false,
      detail: "job.json is not valid JSON",
    });
  });
});

describe("the decision to execute a job", () => {
  const base = () => ({
    directoryJobId: validJob().jobId,
    job: validJob(),
    payload: PAYLOAD,
    now: NOW,
  });

  it("accepts a fresh, intact job", () => {
    expect(validateJob(base())).toEqual({ ok: true });
  });

  it("rejects a job that sits in another job's directory", () => {
    expect(validateJob({ ...base(), directoryJobId: "20261110T120000Z-00000000" })).toMatchObject({
      ok: false,
      code: "A8N-JOB-001",
    });
  });

  it("rejects a payload that does not match its hash", () => {
    const outcome = validateJob({ ...base(), payload: new TextEncoder().encode("{}") });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("does not match");
    }
  });

  it("rejects a job older than the limit, as a possible replay", () => {
    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    const outcome = validateJob({ ...base(), now: later });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("replay");
    }
  });

  it("tolerates a small clock difference, not a large one", () => {
    const slightlyAhead = new Date(NOW.getTime() - 60 * 1000);
    expect(validateJob({ ...base(), now: slightlyAhead })).toEqual({ ok: true });
    const farAhead = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(validateJob({ ...base(), now: farAhead })).toMatchObject({ ok: false });
  });

  it("rejects an unparseable creation time", () => {
    expect(validateJob({ ...base(), job: validJob({ createdAt: "yesterday" }) })).toMatchObject({
      ok: false,
    });
  });
});

describe("the result file", () => {
  const result: JobResult = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: newJobId(NOW, new Uint8Array([1, 2, 3, 4])),
    status: "ok",
    code: null,
    exitCode: 0,
    message: "done",
    payloadSha256: sha256Hex(PAYLOAD),
    agent: { id: "agent-1", host: "WIN", user: "tester", sessionId: 1, version: "0.1.0" },
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
  };

  it("round-trips", () => {
    expect(decodeResult(encodeResult(result))).toEqual({ ok: true, value: result });
  });

  it("rejects an unknown status and an incomplete agent", () => {
    expect(decodeResult(new TextEncoder().encode(JSON.stringify({ ...result, status: "maybe" }))).ok).toBe(false);
    expect(
      decodeResult(new TextEncoder().encode(JSON.stringify({ ...result, agent: { id: "a" } }))).ok,
    ).toBe(false);
  });
});

describe("the directory channel", () => {
  it("publishes a file and overwrites it", async () => {
    const files = await channel();
    await files.writeAtomic("a/b.json", new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await files.read("a/b.json")) ?? new Uint8Array())).toBe("first");
    await files.writeAtomic("a/b.json", new TextEncoder().encode("second"));
    expect(new TextDecoder().decode((await files.read("a/b.json")) ?? new Uint8Array())).toBe("second");
    expect(await files.list("a")).toEqual(["b.json"]);
  });

  it("reports a missing file and an empty directory as absent, not as an error", async () => {
    const files = await channel();
    expect(await files.read("nope.json")).toBeNull();
    expect(await files.list("nope")).toEqual([]);
  });

  it("claims a job exactly once", async () => {
    const files = await channel();
    expect(await files.createExclusive("claims/j.json", new TextEncoder().encode("a"))).toBe(true);
    expect(await files.createExclusive("claims/j.json", new TextEncoder().encode("b"))).toBe(false);
    expect(new TextDecoder().decode((await files.read("claims/j.json")) ?? new Uint8Array())).toBe("a");
  });

  it("refuses to leave the root", async () => {
    const files = await channel();
    await expect(files.read("../escape")).rejects.toBeInstanceOf(UnsupportedChannelPathError);
    await expect(files.writeAtomic("/etc/passwd", new Uint8Array())).rejects.toBeInstanceOf(
      UnsupportedChannelPathError,
    );
    await expect(files.list("a/../../b")).rejects.toBeInstanceOf(UnsupportedChannelPathError);
  });

  it("removes a file that is there and ignores one that is not", async () => {
    const files = await channel();
    await files.writeAtomic("x.json", new Uint8Array());
    await files.remove("x.json");
    await files.remove("x.json");
    expect(await files.read("x.json")).toBeNull();
  });
});
