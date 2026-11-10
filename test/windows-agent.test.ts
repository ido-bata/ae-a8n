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
import { DirectoryChannel, type FileChannel } from "../src/platform/windows/channel.js";
import {
  signClaim,
  signJob,
  signResult,
  verifyClaimAuth,
  type JobKey,
} from "../src/platform/windows/auth.js";
import {
  JOB_SCHEMA_VERSION,
  decodeClaim,
  decodeResult,
  encodeClaim,
  encodeJob,
  encodeResult,
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
  type Job,
} from "../src/platform/windows/job.js";
import { submitJob } from "../src/platform/windows/remote.js";
import {
  readSessionMarker,
  sessionMarkerPath,
} from "../src/platform/windows/session-marker.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode('{"command":"echo hi"}\n');
const JOB_ID = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };
const OTHER_KEY: JobKey = { keyId: "other-key", secret: new Uint8Array(32).fill(9) };

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

function job(overrides: Partial<Omit<Job, "auth">> = {}): Job {
  return signJob(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId: JOB_ID,
      runId: "20261110T120000Z-run00001",
      createdAt: NOW.toISOString(),
      payloadSha256: sha256Hex(PAYLOAD),
      payloadFile: "payload.json",
      writer: { host: "controller", user: "tester" },
      ...overrides,
    },
    KEY,
  );
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
      key: KEY,
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

  it("leaves a run directory with no job.json alone and runs it on a later poll", async () => {
    // The controller creates the run directory, then publishes job.json. An
    // agent that polls in between must not claim or refuse a job that has not
    // been published yet: doing so used to turn a valid submission into a
    // spurious "job.json is missing" refusal.
    const files = await channel();
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), PAYLOAD);
    let executions = 0;
    const executor: JobExecutor = {
      execute: () => {
        executions += 1;
        return Promise.resolve({ status: "ok", message: "ran" });
      },
    };

    const early = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(early).toEqual({ state: "not-ready" });
    expect(await files.read(jobPaths(JOB_ID).claim)).toBeNull();
    expect(await files.read(jobPaths(JOB_ID).result)).toBeNull();
    expect(executions).toBe(0);

    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(job()));
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "finished", result: { status: "ok" } });
    expect(executions).toBe(1);
  });

  it("writes the run's session marker before the executor runs", async () => {
    const files = await channel();
    await publish(files);
    let markerBeforeExecute: boolean | null = null;
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      jobId: JOB_ID,
      now: () => NOW,
      random: () => new Uint8Array(32).fill(0xab),
      executor: {
        execute: async () => {
          const read = await readSessionMarker(files, JOB_ID);
          markerBeforeExecute =
            read.state === "ok" && read.marker.runId === job().runId && read.marker.secret === "ab".repeat(32);
          return { status: "ok", message: "ran" };
        },
      },
    });
    expect(outcome).toMatchObject({ state: "finished" });
    expect(markerBeforeExecute).toBe(true);
    expect(await readSessionMarker(files, JOB_ID)).toMatchObject({
      state: "ok",
      marker: { runId: job().runId, jobId: JOB_ID, agent: IDENTITY },
    });
    expect(await files.read(sessionMarkerPath(JOB_ID))).not.toBeNull();
  });

  it("writes no marker for a job it refuses", async () => {
    const files = await channel();
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), new TextEncoder().encode("evil"));
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(job()));
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: {
        execute: () => Promise.reject(new Error("must not run")),
      },
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused" });
    expect(await readSessionMarker(files, JOB_ID)).toEqual({ state: "missing" });
  });

  it("does not run the same job twice", async () => {
    const files = await channel();
    await publish(files);
    const options = { channel: files, identity: IDENTITY, key: KEY, executor: OK_EXECUTOR, jobId: JOB_ID };
    await runJob({ ...options, now: () => NOW });
    expect(await runJob({ ...options, now: () => NOW })).toEqual({ state: "claimed-by-other" });
  });

  it("writes a signed claim that another agent accepts as its own", async () => {
    const files = await channel();
    await publish(files);
    await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    const stored = decodeClaim((await files.read(jobPaths(JOB_ID).claim)) ?? new Uint8Array());
    expect(stored).toMatchObject({ ok: true, value: { jobId: JOB_ID, agent: IDENTITY } });
    if (stored.ok) {
      expect(verifyClaimAuth(stored.value, [KEY])).toEqual({ ok: true });
    }
  });

  it("quarantines a claim that was planted without a signature", async () => {
    const files = await channel();
    await publish(files);
    await files.writeAtomic(
      jobPaths(JOB_ID).claim,
      new TextEncoder().encode(
        JSON.stringify({ jobId: JOB_ID, claimedAt: NOW.toISOString(), agent: IDENTITY }),
      ),
    );

    let ran = false;
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
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
    expect(outcome).toMatchObject({ state: "claim-unauthenticated" });
    expect(await files.read(jobPaths(JOB_ID).result)).toBeNull();
  });

  it("quarantines a claim signed with a key it does not hold", async () => {
    const files = await channel();
    await publish(files);
    const foreign = signClaim(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: JOB_ID,
        claimedAt: NOW.toISOString(),
        agent: IDENTITY,
      },
      OTHER_KEY,
    );
    await files.writeAtomic(jobPaths(JOB_ID).claim, encodeClaim(foreign));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "claim-unauthenticated" });
    if (outcome.state === "claim-unauthenticated") {
      expect(outcome.detail).toContain("not from a trusted issuer");
    }
  });

  it("quarantines a valid claim that names another job", async () => {
    const files = await channel();
    await publish(files);
    const other = newJobId(NOW, new Uint8Array([9, 9, 9, 9]));
    const misplaced = signClaim(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: other,
        claimedAt: NOW.toISOString(),
        agent: IDENTITY,
      },
      KEY,
    );
    await files.writeAtomic(jobPaths(JOB_ID).claim, encodeClaim(misplaced));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "claim-unauthenticated" });
    if (outcome.state === "claim-unauthenticated") {
      expect(outcome.detail).toContain("names job");
    }
  });

  it("quarantines an oversized claim without parsing it", async () => {
    const files = await channel();
    await publish(files);
    await files.writeAtomic(jobPaths(JOB_ID).claim, new Uint8Array(17 * 1024).fill(0x20));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "claim-unauthenticated" });
  });

  it("treats a claim that vanished before it could be verified as unknown", async () => {
    const files = await channel();
    await publish(files);
    const racing: FileChannel = {
      read: (path) => (path === jobPaths(JOB_ID).claim ? Promise.resolve(null) : files.read(path)),
      writeAtomic: (path, bytes) => files.writeAtomic(path, bytes),
      createExclusive: (path, bytes) =>
        path === jobPaths(JOB_ID).claim ? Promise.resolve(false) : files.createExclusive(path, bytes),
      ensureDirectory: (path) => files.ensureDirectory(path),
      list: (directory) => files.list(directory),
      listDirectories: (directory) => files.listDirectories(directory),
      isDirectory: (path) => files.isDirectory(path),
      remove: (path) => files.remove(path),
    };

    const outcome = await runJob({
      channel: racing,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "claim-unauthenticated" });
    if (outcome.state === "claim-unauthenticated") {
      expect(outcome.detail).toContain("disappeared");
    }
  });

  it("never re-runs a job that already has a result", async () => {
    const files = await channel();
    await publish(files);
    const result = signResult(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: JOB_ID,
        status: "unknown",
        code: "A8N-AE-004",
        message: "from an earlier agent",
        exitCode: null,
        payloadSha256: sha256Hex(PAYLOAD),
        agent: IDENTITY,
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      },
      KEY,
    );
    await files.writeAtomic(jobPaths(JOB_ID).result, encodeResult(result));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
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
      key: KEY,
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

  it("refuses a job signed with a key it does not hold, and never runs it", async () => {
    const files = await channel();
    const foreign = signJob(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: JOB_ID,
        runId: "20261110T120000Z-run00001",
        createdAt: NOW.toISOString(),
        payloadSha256: sha256Hex(PAYLOAD),
        payloadFile: "payload.json",
        writer: { host: "mallory", user: "mallory" },
      },
      OTHER_KEY,
    );
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), PAYLOAD);
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(foreign));

    let ran = false;
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
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
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-003" } });
  });

  it("refuses a job whose signed fields were changed after it was signed", async () => {
    const files = await channel();
    const signed = job();
    const tampered: Job = { ...signed, writer: { ...signed.writer, user: "mallory" } };
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), PAYLOAD);
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(tampered));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-003" } });
  });

  it("refuses an oversized manifest without parsing it", async () => {
    const files = await channel();
    await files.writeAtomic(jobPaths(JOB_ID).manifest, new Uint8Array(70 * 1024).fill(0x20));
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-004" } });
  });

  it("refuses an oversized payload", async () => {
    const files = await channel();
    const big = new Uint8Array(1024 * 1024 + 1).fill(0x61);
    const manifest = signJob(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: JOB_ID,
        runId: "20261110T120000Z-run00001",
        createdAt: NOW.toISOString(),
        payloadSha256: sha256Hex(big),
        payloadFile: "payload.json",
        writer: { host: "controller", user: "tester" },
      },
      KEY,
    );
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), big);
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(manifest));

    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-004" } });
  });

  it("refuses a manifest that names another job", async () => {
    const files = await channel();
    const other = newJobId(NOW, new Uint8Array([9, 9, 9, 9]));
    await files.writeAtomic(jobPaths(JOB_ID).payload("payload.json"), PAYLOAD);
    await files.writeAtomic(jobPaths(JOB_ID).manifest, encodeJob(job({ jobId: other })));
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
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
      key: KEY,
      executor: OK_EXECUTOR,
      jobId: JOB_ID,
      now: () => new Date(NOW.getTime() + 11 * 60 * 1000),
    });
    expect(outcome).toMatchObject({ state: "refused", result: { code: "A8N-JOB-001" } });
  });

  it("never runs a run directory whose manifest is absent", async () => {
    // Nothing was published, so nothing can be run; and since the agent cannot
    // tell a submission still being published from a withdrawn one, it claims
    // and refuses nothing. The controller times out and quarantines the run.
    const files = await channel();
    let executions = 0;
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ status: "ok", message: "ran" });
        },
      },
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome).toEqual({ state: "not-ready" });
    expect(executions).toBe(0);
    expect(await files.read(jobPaths(JOB_ID).claim)).toBeNull();
    expect(await files.read(jobPaths(JOB_ID).result)).toBeNull();
  });

  it("reports an executor failure as a failed result, not an exception", async () => {
    const files = await channel();
    await publish(files);
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
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

  it("keeps an executor's unknown outcome and its diagnostic code", async () => {
    const files = await channel();
    await publish(files);
    const outcome = await runJob({
      channel: files,
      identity: IDENTITY,
      key: KEY,
      executor: {
        execute: () =>
          Promise.resolve({
            status: "unknown",
            code: "A8N-AE-004",
            message: "the child timed out; the outcome is unknown",
          }),
      },
      jobId: JOB_ID,
      now: () => NOW,
    });
    expect(outcome.state).toBe("finished");
    if (outcome.state === "finished") {
      expect(outcome.result.status).toBe("unknown");
      expect(outcome.result.code).toBe("A8N-AE-004");
    }
    const stored = decodeResult((await files.read(jobPaths(JOB_ID).result)) ?? new Uint8Array());
    expect(stored).toMatchObject({
      ok: true,
      value: { status: "unknown", code: "A8N-AE-004" },
    });
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
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: async () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the agent never finished");
        }
        if (calls === 1) {
          await runJob({ channel: files, identity: IDENTITY, executor: OK_EXECUTOR, jobId: JOB_ID, key: KEY, now: () => NOW });
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
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
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
          await runJob({ channel: files, identity: IDENTITY, executor: OK_EXECUTOR, jobId: JOB_ID, key: KEY, now: () => NOW });
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
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10,
      writer: { host: "controller", user: "tester" },
      key: KEY,
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
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
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
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: () => {
        calls += 1;
        if (calls > 5) {
          throw new Error("the result was never read");
        }
        const bytes = encodeResult(
          signResult(
            {
              schemaVersion: JOB_SCHEMA_VERSION,
              jobId: other,
              status: "ok",
              code: null,
              exitCode: 0,
              message: "wrong job",
              payloadSha256: sha256Hex(PAYLOAD),
              agent: IDENTITY,
              startedAt: NOW.toISOString(),
              finishedAt: NOW.toISOString(),
            },
            KEY,
          ),
        );
        return files.writeAtomic(jobPaths(JOB_ID).result, bytes);
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-001" });
  });

  it("refuses a result signed with a key it does not hold", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
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
          encodeResult(
            signResult(
              {
                schemaVersion: JOB_SCHEMA_VERSION,
                jobId: JOB_ID,
                status: "ok",
                code: null,
                exitCode: 0,
                message: "forged",
                payloadSha256: sha256Hex(PAYLOAD),
                agent: IDENTITY,
                startedAt: NOW.toISOString(),
                finishedAt: NOW.toISOString(),
              },
              OTHER_KEY,
            ),
          ),
        );
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-003" });
  });

  it("refuses a signed result that is bound to another payload", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
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
          encodeResult(
            signResult(
              {
                schemaVersion: JOB_SCHEMA_VERSION,
                jobId: JOB_ID,
                status: "ok",
                code: null,
                exitCode: 0,
                message: "ran something else",
                payloadSha256: sha256Hex(new TextEncoder().encode("evil")),
                agent: IDENTITY,
                startedAt: NOW.toISOString(),
                finishedAt: NOW.toISOString(),
              },
              KEY,
            ),
          ),
        );
      },
    });
    expect(result).toMatchObject({ status: "refused", code: "A8N-JOB-001" });
    if (result.status === "refused") {
      expect(result.message).toContain("bound to payload");
    }
  });

  it("returns the hash of the bytes it accepted", async () => {
    const files = await channel();
    let calls = 0;
    const result = await submitJob(files, {
      payload: PAYLOAD,
      runId: "20261110T120000Z-run00001",
      timeoutMs: 10_000,
      writer: { host: "controller", user: "tester" },
      key: KEY,
      now: () => NOW,
      random: () => new Uint8Array([1, 2, 3, 4]),
      pollMs: 1,
      sleep: async () => {
        calls += 1;
        if (calls === 1) {
          await runJob({
            channel: files,
            identity: IDENTITY,
            executor: OK_EXECUTOR,
            jobId: JOB_ID,
            key: KEY,
            now: () => NOW,
          });
        }
      },
    });
    if (result.status !== "ok") {
      throw new Error(`unexpected status ${result.status}`);
    }
    const stored = (await files.read(jobPaths(JOB_ID).result)) ?? new Uint8Array();
    expect(result.resultSha256).toBe(sha256Hex(stored));
  });

  it("rejects a non-positive timeout before publishing anything", async () => {
    const files = await channel();
    await expect(
      submitJob(files, {
        payload: PAYLOAD,
        runId: "20261110T120000Z-run00001",
        timeoutMs: 0,
        writer: { host: "controller", user: "tester" },
      key: KEY,
      }),
    ).rejects.toThrow("timeoutMs must be a positive number");
    expect(await files.list("jobs")).toEqual([]);
  });
});
