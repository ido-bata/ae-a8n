import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JobExecutor } from "../src/platform/windows/agent.js";
import { main } from "../src/platform/windows/agent-main.js";
import { signJob, signResult, encodeKeyFile, type JobKey } from "../src/platform/windows/auth.js";
import { DirectoryChannel, type FileChannel } from "../src/platform/windows/channel.js";
import {
  JOB_SCHEMA_VERSION,
  claimDiagnosticPath,
  encodeJob,
  encodeResult,
  jobPaths,
  newJobId,
  sha256Hex,
  type Job,
  type JobResult,
} from "../src/platform/windows/job.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const PAYLOAD = new TextEncoder().encode('{"argv":["/bin/echo","hi"]}\n');
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };
const IDENTITY = {
  id: "agent-1",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-alpha.1",
};

const roots: string[] = [];

async function makeChannel(): Promise<{ root: string; channel: DirectoryChannel }> {
  const root = await mkdtemp(join(tmpdir(), "a8n-agent-main-"));
  roots.push(root);
  return { root, channel: new DirectoryChannel(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function args(root: string, overrides: Partial<Record<string, string>> = {}): string[] {
  const values = {
    "--channel": root,
    "--key-file": join(root, "agent.key"),
    "--agent-id": IDENTITY.id,
    "--host": IDENTITY.host,
    "--user": IDENTITY.user,
    "--session-id": String(IDENTITY.sessionId),
    "--version": IDENTITY.version,
    ...overrides,
  };
  return Object.entries(values).flatMap(([flag, value]) => [flag, value]);
}

function jobFor(jobId: string): Job {
  return signJob(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      runId: "20261110T120000Z-run00001",
      createdAt: NOW.toISOString(),
      payloadSha256: sha256Hex(PAYLOAD),
      payloadFile: "payload.json",
      writer: { host: "controller", user: "tester" },
    },
    KEY,
  );
}

async function publishJob(channel: DirectoryChannel, jobId: string): Promise<void> {
  const job = jobFor(jobId);
  await channel.writeAtomic(jobPaths(jobId).payload(job.payloadFile), PAYLOAD);
  await channel.writeAtomic(jobPaths(jobId).manifest, encodeJob(job));
}

function resultFor(jobId: string): JobResult {
  return signResult(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      status: "ok",
      code: null,
      exitCode: 0,
      message: "from an earlier run",
      payloadSha256: sha256Hex(PAYLOAD),
      agent: IDENTITY,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    },
    KEY,
  );
}

function recordingExecutor(executed: string[]): JobExecutor {
  return {
    execute: (input) => {
      executed.push(input.job.jobId);
      return Promise.resolve({ status: "ok", message: "ran" });
    },
  };
}

class UnreadableChannel implements FileChannel {
  read(_path: string): Promise<Uint8Array | null> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  writeAtomic(_path: string, _bytes: Uint8Array): Promise<void> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  createExclusive(_path: string, _bytes: Uint8Array): Promise<boolean> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  ensureDirectory(_path: string): Promise<void> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  list(_directory: string): Promise<readonly string[]> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  listDirectories(_directory: string): Promise<readonly string[]> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  isDirectory(_path: string): Promise<boolean> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
  remove(_path: string): Promise<void> {
    return Promise.reject(new Error("EACCES: unreadable"));
  }
}

describe("the Windows agent entry", () => {
  it("claims and runs one job, then stops when signalled", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);

    const executed: string[] = [];
    const messages: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      pollMs: 1,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
      stderr: (text) => messages.push(text),
    });

    expect(code).toBe(0);
    expect(executed).toEqual([jobId]);
    expect(messages).toEqual([]);
    expect(await channel.read(jobPaths(jobId).result)).not.toBeNull();
  });

  it("runs every pending job in one poll", async () => {
    const { root, channel } = await makeChannel();
    const first = newJobId(NOW, new Uint8Array([1, 1, 1, 1]));
    const second = newJobId(NOW, new Uint8Array([2, 2, 2, 2]));
    await publishJob(channel, first);
    await publishJob(channel, second);

    const executed: string[] = [];
    const controller = new AbortController();
    await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect([...executed].sort()).toEqual([first, second].sort());
  });

  it("does not re-run a job that already has a result", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);
    await channel.writeAtomic(jobPaths(jobId).result, encodeResult(resultFor(jobId)));

    const executed: string[] = [];
    const controller = new AbortController();
    await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(executed).toEqual([]);
  });

  it("ignores a directory that is not a job id", async () => {
    const { root, channel } = await makeChannel();
    await channel.writeAtomic("jobs/not-a-job/payload.json", PAYLOAD);

    const executed: string[] = [];
    const controller = new AbortController();
    await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(executed).toEqual([]);
  });

  it("refuses to poll in a non-interactive session", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);
    const executed: string[] = [];
    const messages: string[] = [];

    const code = await main(args(root, { "--session-id": "0" }), {
      channel,
      key: KEY,
      // The OS agrees: this really is a session-0 process, which has no
      // interactive desktop to show After Effects on.
      measureSession: () => 0,
      executor: recordingExecutor(executed),
      now: () => NOW,
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(1);
    expect(executed).toEqual([]);
    expect(messages.join("")).toContain("interactive desktop");
    expect(await channel.read(jobPaths(jobId).claim)).toBeNull();
  });

  it("quarantines a planted claim, records it, and keeps polling", async () => {
    const { root, channel } = await makeChannel();
    const planted = "20261110T120000Z-aaaaaaaa";
    const healthy = "20261110T120000Z-bbbbbbbb";
    await publishJob(channel, planted);
    await publishJob(channel, healthy);
    await channel.writeAtomic(
      jobPaths(planted).claim,
      new TextEncoder().encode(
        JSON.stringify({ jobId: planted, claimedAt: NOW.toISOString(), agent: IDENTITY }),
      ),
    );

    const executed: string[] = [];
    const messages: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
      stderr: (text) => messages.push(text),
    });

    expect(code).toBe(0);
    expect(executed).toEqual([healthy]);
    expect(await channel.read(jobPaths(planted).result)).toBeNull();
    expect(messages.join("")).toContain(`job ${planted} is quarantined`);

    const diagnostic = await channel.read(claimDiagnosticPath(planted));
    expect(diagnostic).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(diagnostic ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({ jobId: planted, quarantinedAt: NOW.toISOString() });
    expect(String(parsed["detail"])).toContain("not valid");
  });

  it("fails non-zero with a message when the channel cannot be read", async () => {
    const messages: string[] = [];
    const code = await main(args("ignored"), {
      channel: new UnreadableChannel(),
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor([]),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(1);
    expect(messages.join("")).toContain("channel could not be read");
  });

  it("fails non-zero when the channel root does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "a8n-agent-main-missing-"));
    roots.push(root);
    const messages: string[] = [];
    const code = await main(args(join(root, "missing")), {
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor([]),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(1);
    expect(messages.join("")).toContain("channel root does not exist");
  });

  it("rejects incomplete arguments before touching anything", async () => {
    const messages: string[] = [];
    const code = await main(["--channel", "ignored"], {
      channel: new UnreadableChannel(),
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor([]),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(2);
    expect(messages.join("")).toContain("--key-file is required");
  });

  it("rejects an empty flag value instead of using it as a path", async () => {
    const messages: string[] = [];
    const code = await main(args("/ignored", { "--channel": "" }), {
      channel: new UnreadableChannel(),
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor([]),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(2);
    expect(messages.join("")).toContain("--channel needs a value");
  });

  it("refuses when the claimed session is not the one the OS measured", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);
    const executed: string[] = [];
    const messages: string[] = [];

    const code = await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 2,
      executor: recordingExecutor(executed),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(1);
    expect(executed).toEqual([]);
    expect(messages.join("")).toContain("does not match the measured session");
    expect(await channel.read(jobPaths(jobId).claim)).toBeNull();
  });

  it("refuses when its own session cannot be measured", async () => {
    const messages: string[] = [];
    const code = await main(args("/ignored"), {
      channel: new UnreadableChannel(),
      key: KEY,
      measureSession: () => null,
      executor: recordingExecutor([]),
      stderr: (text) => messages.push(text),
    });
    expect(code).toBe(1);
    expect(messages.join("")).toContain("could not be measured");
  });

  it("loads the channel key from --key-file when none is injected", async () => {
    const { root, channel } = await makeChannel();
    const keyFile = join(root, "agent.key");
    await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o600 });
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);

    const executed: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root, { "--key-file": keyFile }), {
      channel,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(executed).toEqual([jobId]);
  });

  // Windows does not model POSIX mode bits, so `key-store.ts` skips the
  // readable-by-others check there (ACLs are the equivalent, and verifying
  // them is T092 work). Asserting the refusal on Windows would not fail: the
  // agent accepts the key, enters its job loop and never returns, so the test
  // hangs until the timeout. Observed on a real Windows 11 host, where the
  // full suite is not part of CI.
  it.skipIf(process.platform === "win32")(
    "refuses a key file readable by group or others",
    async () => {
      const { root, channel } = await makeChannel();
      const keyFile = join(root, "agent.key");
      await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o644 });
      await chmod(keyFile, 0o644);
      const messages: string[] = [];
      const code = await main(args(root, { "--key-file": keyFile }), {
        channel,
        measureSession: () => 1,
        executor: recordingExecutor([]),
        stderr: (text) => messages.push(text),
      });
      expect(code).toBe(1);
      expect(messages.join("")).toContain("readable by group or others");
    },
  );

  it("opens the channel from --channel when none is injected", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);

    const executed: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root), {
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(executed).toEqual([jobId]);
  });
});
