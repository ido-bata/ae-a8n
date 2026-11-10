import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentNotInteractiveError,
  assertInteractiveIdentity,
  runJob,
  type JobExecutor,
} from "../src/platform/windows/agent.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  JOB_SCHEMA_VERSION,
  decodeResult,
  encodeJob,
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
  type Job,
} from "../src/platform/windows/job.js";
import { submitJob } from "../src/platform/windows/remote.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode('{"command":"echo hi"}\n');
const JOB_ID = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));

const IDENTITY: AgentIdentity = {
  id: "agent-1",
  host: "WIN-TEST",
  user: "tester",
  sessionId: 1,
  version: "0.1.0",
};

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-agent-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: JOB_ID,
    createdAt: NOW.toISOString(),
    payloadSha256: sha256Hex(PAYLOAD),
    payloadFile: "payload.json",
    writer: { host: "controller", user: "tester" },
    ...overrides,
  };
}

async function publish(files: DirectoryChannel, manifest: Job = job()): Promise<void> {
  await files.writeAtomic(jobPaths(manifest.jobId).payload(manifest.payloadFile), PAYLOAD);
  await files.writeAtomic(jobPaths(manifest.jobId).manifest, encodeJob(manifest));
}

const OK_EXECUTOR: JobExecutor = {
  execute: () =>
    Promise.resolve({
      status: "ok",
      message: "ran",
      artifacts: { "artifacts/out.txt": new TextEncoder().encode("artifact") },
    }),
};

describe("the agent", () => {
  it("claims one job, runs it, and publishes the result and artifacts", async () => {
    const files = await channel();
    await publish(files);
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "finished", result: { status: "ok", message: "ran" } });
    expect(await files.read(jobPaths(JOB_ID).claim)).not.toBeNull();
    expect(await files.read(`${jobPaths(JOB_ID).resultDirectory}/artifacts/out.txt`)).not.toBeNull();

    const stored = decodeResult((await files.read(jobPaths(JOB_ID).result)) ?? new Uint8Array());
    expect(stored).toMatchObject({ ok: true, value: { jobId: JOB_ID, payloadSha256: sha256Hex(PAYLOAD) } });
  });

  it("does not run the same job twice", async () => {
    const files = await channel();
    await publish(files);
    const options = { channel: files, identity: IDENTITY, executor: OK_EXECUTOR, jobId: JOB_ID };
    await runJob({ ...options, now: () => NOW });
    expect(await runJob({ ...options, now: () => NOW })).toEqual({ state: "claimed-by-other" });
  });

  it("never re-runs a job that already has a result", async () => {
    const files = await channel();
    await publish(files);
    const result = {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId: JOB_ID,
      status: "unknown",
      code: "A8N-AE-004",
      message: "from an earlier agent",
      payloadSha256: sha256Hex(PAYLOAD),
      agent: IDENTITY,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    } as const;
    await files.writeAtomic(jobPaths(JOB_ID).result, new TextEncoder().encode(JSON.stringify(result)));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "already-finished", result: { message: "from an earlier agent" } });
  });

  it("refuses a payload that was altered after publication", async () => {
    const files = await channel();
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), new TextEncoder().encode("evil"));
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(job()));

    let ran = false;
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: {
        execute: () => {
          ran = true;
          return Promise.resolve({ status: "ok", message: "" });
        },
      },
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(ran).toBe(false);
    expect(outcome).toMatchObject({
      state: "refused",
      result: { status: "refused", code: "A8N-JOB-001" },
    });
  });

  it("refuses a manifest that names another job", async () => {
    const files = await channel();
    const other = newJobId(NOW, new Uint8Array([9, 9, 9, 9]));
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), PAYLOAD);
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(job({ jobId: other })));
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-001" } });
    if (outcome.state === "refused") {
      expect(outcome.result.message).toContain("but it is in");
    }
  });

  it("refuses a stale job", async () => {
    const files = await channel();
    await publish(files);
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => new Date(NOW.getTime() + 11 * 60 * 1000),
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-001" } });
  });

  it("refuses a missing manifest", async () => {
    const files = await channel();
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused", result: { message: "job.json is missing" } });
  });

  it("reports an executor failure as a failed result, not an exception", async () => {
    const files = await channel();
    await publish(files);
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      executor: { execute: () => Promise.reject(new Error("AE crashed")) },
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome.state).toBe("finished");
    if (outcome.state === "finished") {
      expect(outcome.result.status).toBe("failed");
      expect(outcome.result.message).toContain("AE crashed");
    }
  });

  it("refuses to run outside an interactive session", () => {
    expect(() => assertInteractiveIdentity({ ...IDENTITY, sessionId: 0 })).toThrow(
      AgentNotInteractiveError,
    );
    expect(() => assertInteractiveIdentity(IDENTITY)).not.toThrow();
  });
});

describe("the controller", () => {
  it("publishes a job and accepts the agent's result", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: async () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the agent never finished");
        }
        if (calls === 1) {
          await runJob({ channel: files, identity: IDENTITY, executor: OK_EXECUTOR, jobId: JOB_ID, now: () => NOW });
        }
      },
    });
    expect(result).toMatchObject({ status: "ok", jobId: JOB_ID, result: { message: "ran" } });
  });

  it("reports a refusal with the agent's code", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: async () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the agent never finished");
        }
        if (calls === 1) {
          // The controller's own payload is replaced after publication.
          await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), new TextEncoder().encode("evil"));
          await runJob({ channel: files, identity: IDENTITY, executor: OK_EXECUTOR, jobId: JOB_ID, now: () => NOW });
        }
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-001" });
  });

  it("reports a timeout as unknown and leaves the job in place", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    const result = await submitJob(files, {
      payload: PAYLOAD,
      timeoutMs: 10,
      writer: { host: "controller", user: "tester" },
      now: () => new Date(clock),
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 5,
      sleep: () => {
        clock += 5;
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004", jobId: JOB_ID });
    expect(await files.read(jobPaths(JOB_ID).manifest)).not.toBeNull();
  });

  it("refuses an unreadable result rather than treating it as no result", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the result was never read");
        }
        return files.writeAtomic(
          jobPaths(JOB_ID).result,
          new TextEncoder().encode("{\"schemaVersion\":\"1.0\""),
        );
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-001" });
  });

  it("refuses a result that names another job", async () => {
    const files = await channel();
    let calls = 0;
    const other = newJobId(NOW, new Uint8Array([9, 9, 9, 9]));
    const result = await submitJob(files, {
      payload: PAYLOAD,
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the result was never read");
        }
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: JOB_SCHEMA_VERSION,
            jobId: other,
            status: "ok",
            code: null,
            message: "wrong job",
            payloadSha256: null,
            agent: IDENTITY,
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
          }),
        );
        return files.writeAtomic(jobPaths(JOB_ID).result, bytes);
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-001" });
  });

  it("rejects a non-positive timeout before publishing anything", async () => {
    const files = await channel();
    await expect(
      submitJob(files, {
        payload: PAYLOAD,
        timeoutMs: 0,
        writer: { host: "controller", user: "tester" },
      }),
    ).rejects.toThrow("timeoutMs must be a positive number");
    expect(await files.list("jobs")).toEqual([]);
  });
});
