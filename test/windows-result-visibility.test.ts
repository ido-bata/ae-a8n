/**
 * What the controller does when the result is hard to see.
 *
 * Found on the real host on 2026-11-10: the agent refused a job and published
 * `results/<jobId>/result.json` three milliseconds after claiming it, and the
 * controller still reported a timeout 57 seconds later. The controller had
 * polled the result path while the agent had not yet created the job's result
 * directory; the macOS SMB client kept answering "no such file" for a
 * directory that had existed for a minute. None of this can happen against a
 * local directory, so the channel here is instrumented to behave like the
 * share did.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runJob, type JobExecutor } from "../src/platform/windows/agent.js";
import { DirectoryChannel, type FileChannel } from "../src/platform/windows/channel.js";
import { signClaim, signResult, type JobKey } from "../src/platform/windows/auth.js";
import {
  JOB_SCHEMA_VERSION,
  encodeClaim,
  encodeResult,
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
} from "../src/platform/windows/job.js";
import { submitJob, type SubmitOptions } from "../src/platform/windows/remote.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode('{"command":"echo hi"}\n');
const JOB_ID = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
const RUN_ID = "20261110T120000Z-run00001";
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };
const IDENTITY: AgentIdentity = {
  id: "agent-1",
  host: "WIN-TEST",
  user: "tester",
  sessionId: 1,
  version: "0.1.0",
};
const RESULT = jobPaths(JOB_ID).result;

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-visibility-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every call the controller makes on the channel, in order. */
function recording(inner: FileChannel): { channel: FileChannel; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    channel: {
      read: (path) => inner.read(path),
      writeAtomic: (path, bytes) => {
        calls.push(`write ${path}`);
        return inner.writeAtomic(path, bytes);
      },
      ensureDirectory: (path) => {
        calls.push(`mkdir ${path}`);
        return inner.ensureDirectory(path);
      },
      createExclusive: (path, bytes) => inner.createExclusive(path, bytes),
      list: (directory) => inner.list(directory),
      listDirectories: (directory) => inner.listDirectories(directory),
      isDirectory: (path) => inner.isDirectory(path),
      remove: (path) => inner.remove(path),
    },
  };
}

/** The same channel, with `read` replaced. */
function withRead(inner: FileChannel, read: (path: string) => Promise<Uint8Array | null>): FileChannel {
  return {
    read,
    writeAtomic: (path, bytes) => inner.writeAtomic(path, bytes),
    ensureDirectory: (path) => inner.ensureDirectory(path),
    createExclusive: (path, bytes) => inner.createExclusive(path, bytes),
    list: (directory) => inner.list(directory),
    listDirectories: (directory) => inner.listDirectories(directory),
    isDirectory: (path) => inner.isDirectory(path),
    remove: (path) => inner.remove(path),
  };
}

function options(overrides: Partial<SubmitOptions> = {}): SubmitOptions {
  return {
    payload: PAYLOAD,
    runId: RUN_ID,
    timeoutMs: 10_000,
    writer: { host: "controller", user: "tester" },
    key: KEY,
    now: () => NOW,
    random: () => new Uint8Array([1, 2, 3, 4]),
    pollMs: 1,
    ...overrides,
  };
}

const OK_EXECUTOR: JobExecutor = {
  execute: () => Promise.resolve({ status: "ok", message: "ran", exitCode: 0 }),
};

function signedResult(status: "ok" | "failed", exitCode: number): Uint8Array {
  return encodeResult(
    signResult(
      {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId: JOB_ID,
        status,
        code: null,
        exitCode,
        message: "exited",
        payloadSha256: sha256Hex(PAYLOAD),
        agent: IDENTITY,
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      },
      KEY,
    ),
  );
}

describe("the controller's view of the result file", () => {
  it("creates the job's result directory before it publishes the job", async () => {
    const files = await channel();
    const { channel: recorded, calls } = recording(files);
    let calls2 = 0;
    const result = await submitJob(
      recorded,
      options({
        sleep: async () => {
          calls2 += 1;
          if (calls2 === 1) {
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
      }),
    );
    expect(result).toMatchObject({ status: "ok" });
    const mkdir = calls.indexOf(`mkdir ${jobPaths(JOB_ID).resultDirectory}`);
    const manifest = calls.indexOf(`write ${jobPaths(JOB_ID).manifest}`);
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(mkdir).toBeLessThan(manifest);
  });

  it("keeps polling through a read that fails, and still takes the result", async () => {
    const files = await channel();
    let reads = 0;
    const flaky = withRead(files, (path) => {
      reads += 1;
      if (reads <= 2) {
        return Promise.reject(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
      }
      return files.read(path);
    });
    let sleeps = 0;
    const result = await submitJob(
      flaky,
      options({
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) {
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
      }),
    );
    expect(result).toMatchObject({ status: "ok", result: { exitCode: 0 } });
  });

  it("reports unknown, not a crash, when the channel keeps failing", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    const dead = withRead(files, () =>
      Promise.reject(Object.assign(new Error("the connection was reset"), { code: "ECONNRESET" })),
    );
    const result = await submitJob(
      dead,
      options({
        timeoutMs: 10,
        now: () => new Date(clock),
        sleep: () => {
          clock += 5;
          return Promise.resolve();
        },
      }),
    );
    expect(result).toMatchObject({
      status: "unknown",
      code: "A8N-AE-004",
      lateResult: null,
    });
    if (result.status === "unknown") {
      expect(result.message).toContain("ECONNRESET");
      expect(result.evidence.failed).toBeGreaterThan(0);
      expect(result.evidence.absent).toBe(0);
    }
    // The job is still there: it may be running, and is never re-sent.
    expect(await files.read(jobPaths(JOB_ID).manifest)).not.toBeNull();
  });

  it("names a trusted claim that stranded the job when no result follows", async () => {
    // A claim left by an agent that died is the one cause of "no result" a
    // human can clear without touching the job. Without naming it, the next
    // run times out exactly the same way.
    const files = await channel();
    let clock = NOW.getTime();
    const result = await submitJob(
      files,
      options({
        timeoutMs: 10,
        now: () => new Date(clock),
        sleep: async () => {
          clock += 5;
          await files.writeAtomic(
            jobPaths(JOB_ID).claim,
            encodeClaim(
              signClaim(
                {
                  schemaVersion: JOB_SCHEMA_VERSION,
                  jobId: JOB_ID,
                  claimedAt: NOW.toISOString(),
                  agent: { ...IDENTITY, id: "agent-gone" },
                },
                KEY,
              ),
            ),
          );
        },
      }),
    );
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    if (result.status === "unknown") {
      expect(result.message).toContain('claimed by agent "agent-gone"');
      expect(result.message).toContain("remove the claim");
    }
  });

  it("does not name a claim it cannot attribute to a trusted agent", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    const result = await submitJob(
      files,
      options({
        timeoutMs: 10,
        now: () => new Date(clock),
        sleep: async () => {
          clock += 5;
          await files.writeAtomic(
            jobPaths(JOB_ID).claim,
            new TextEncoder().encode(
              JSON.stringify({ jobId: JOB_ID, claimedAt: NOW.toISOString(), agent: IDENTITY }),
            ),
          );
        },
      }),
    );
    expect(result).toMatchObject({ status: "unknown" });
    if (result.status === "unknown") {
      expect(result.message).not.toContain("remove the claim");
    }
  });

  it("does not hang when a read never answers", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    const stalled = withRead(files, () => new Promise<Uint8Array | null>(() => undefined));
    const started = Date.now();
    const result = await submitJob(
      stalled,
      options({
        timeoutMs: 10,
        now: () => new Date(clock),
        sleep: () => {
          clock += 5;
          return Promise.resolve();
        },
        readTimeoutMs: 2,
      }),
    );
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    // A read that never returns must not keep the controller past its deadline
    // by more than the read budget allows.
    expect(Date.now() - started).toBeLessThan(2_000);
    if (result.status === "unknown") {
      expect(result.evidence.failed).toBeGreaterThan(0);
      expect(result.message).toContain("did not answer");
    }
  });

  it("takes a result that is there on the last poll before the deadline", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    let written = false;
    const result = await submitJob(
      files,
      options({
        timeoutMs: 20,
        now: () => new Date(clock),
        sleep: async () => {
          clock += 5;
          if (!written && clock >= NOW.getTime() + 15) {
            written = true;
            await files.writeAtomic(RESULT, signedResult("ok", 0));
          }
        },
      }),
    );
    expect(result).toMatchObject({ status: "ok", jobId: JOB_ID });
  });

  it("records a signed result that appears after the deadline without accepting it", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    let written = false;
    const result = await submitJob(
      files,
      options({
        timeoutMs: 10,
        now: () => new Date(clock),
        sleep: async () => {
          clock += 5;
          if (!written && clock >= NOW.getTime() + 10) {
            written = true;
            await files.writeAtomic(RESULT, signedResult("ok", 0));
          }
        },
      }),
    );
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    if (result.status === "unknown") {
      const late = result.lateResult;
      expect(late).toMatchObject({ status: "ok", exitCode: 0 });
      expect(late?.resultSha256).toBe(
        sha256Hex((await files.read(RESULT)) ?? new Uint8Array()),
      );
      expect(result.message).toContain("after the deadline");
      // Accepted is not the same as observed: the run is not a success.
      expect(result.message).toContain("quarantined");
    }
  });

  it("does not promote a result the first read finds after the deadline", async () => {
    const files = await channel();
    await files.writeAtomic(RESULT, signedResult("ok", 0));
    // Publishing the job over a slow share can outlast a short timeout, so the
    // first read may start after the deadline — and find a result that is
    // already there. It cannot have been produced in time: it is evidence,
    // not the run's outcome.
    let ticks = 0;
    const result = await submitJob(
      files,
      options({
        timeoutMs: 5,
        now: () => {
          ticks += 1;
          return new Date(NOW.getTime() + ticks * 10);
        },
        sleep: () => Promise.resolve(),
      }),
    );
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    if (result.status === "unknown") {
      expect(result.evidence.polls).toBe(1);
      expect(result.lateResult).toMatchObject({ status: "ok", exitCode: 0 });
      expect(result.message).toContain("after the deadline");
      expect(result.message).toContain("will not be re-sent");
    }
  });

  it("looks at least once, even when publishing the job used up the timeout", async () => {
    const files = await channel();
    // Publishing over a share is slow; a short timeout can be spent before the
    // first poll. "Never looked" is not a verdict, so one read still happens.
    let ticks = 0;
    const result = await submitJob(
      files,
      options({
        timeoutMs: 5,
        now: () => {
          ticks += 1;
          return new Date(NOW.getTime() + ticks * 10);
        },
        sleep: () => Promise.resolve(),
      }),
    );
    expect(result).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    if (result.status === "unknown") {
      expect(result.evidence.polls).toBe(1);
      expect(result.message).toContain("1 read(s)");
    }
  });

  it("counts every poll, so a repeat is diagnosable", async () => {
    const files = await channel();
    let clock = NOW.getTime();
    const result = await submitJob(
      files,
      options({
        timeoutMs: 20,
        now: () => new Date(clock),
        sleep: () => {
          clock += 5;
          return Promise.resolve();
        },
      }),
    );
    expect(result).toMatchObject({ status: "unknown" });
    if (result.status === "unknown") {
      expect(result.evidence.polls).toBeGreaterThan(1);
      expect(result.evidence.polls).toBe(result.evidence.absent + result.evidence.failed);
      expect(result.message).toContain(`${String(result.evidence.polls)} read(s)`);
    }
  });
});
