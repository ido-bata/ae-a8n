import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JobExecutor } from "../src/platform/windows/agent.js";
import { A8N_VERSION } from "../src/version.js";
import { main } from "../src/platform/windows/agent-main.js";
import { signClaim, signJob, signResult, encodeKeyFile, type JobKey } from "../src/platform/windows/auth.js";
import { DirectoryChannel, type FileChannel } from "../src/platform/windows/channel.js";
import {
  JOB_SCHEMA_VERSION,
  claimDiagnosticPath,
  encodeClaim,
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

  it("stops between jobs, not after the whole queue", async () => {
    // A signal must not wait for every queued job: each can run for the
    // executor's whole timeout, and an operator who sees Ctrl+C do nothing
    // for minutes force-kills the process, stranding a claim.
    const { root, channel } = await makeChannel();
    const first = "20261110T120000Z-eeeeeeee";
    const second = "20261110T120000Z-ffffffff";
    await publishJob(channel, first);
    await publishJob(channel, second);

    const executed: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: {
        execute: (input) => {
          executed.push(input.job.jobId);
          controller.abort();
          return Promise.resolve({ status: "ok", message: "ran" });
        },
      },
      now: () => NOW,
      sleep: () => Promise.resolve(),
      signal: controller.signal,
    });

    expect(code).toBe(0);
    expect(executed).toEqual([first]);
    expect(await channel.read(jobPaths(second).result)).toBeNull();
  });

  it("keeps polling when one job's result path cannot be read", async () => {
    // This read used to be the only channel operation outside a try/catch: a
    // single unreadable directory rejected `main`, the resident agent exited,
    // and its heartbeat stopped with it.
    const { root, channel } = await makeChannel();
    const broken = "20261110T120000Z-cccccccc";
    const healthy = "20261110T120000Z-dddddddd";
    await publishJob(channel, broken);
    await publishJob(channel, healthy);

    const executed: string[] = [];
    const messages: string[] = [];
    const controller = new AbortController();
    const code = await main(args(root), {
      channel: {
        read: (path) =>
          path === jobPaths(broken).result
            ? Promise.reject(new Error("ENOENT: the directory vanished"))
            : channel.read(path),
        writeAtomic: (path, bytes) => channel.writeAtomic(path, bytes),
        createExclusive: (path, bytes) => channel.createExclusive(path, bytes),
        ensureDirectory: (path) => channel.ensureDirectory(path),
        list: (directory) => channel.list(directory),
        listDirectories: (directory) => channel.listDirectories(directory),
        isDirectory: (path) => channel.isDirectory(path),
        remove: (path) => channel.remove(path),
      },
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
    expect(messages.join("")).toContain(`job ${broken}'s result could not be read`);
  });

  it("names a trusted claim that strands a job, once", async () => {
    // A claim left by an agent that died has no result and no later poll can
    // run the job: the fail-closed direction, but silent. The notice names the
    // claimant and the file a human has to remove.
    const { root, channel } = await makeChannel();
    const jobId = "20261110T120000Z-99999999";
    await publishJob(channel, jobId);
    await channel.writeAtomic(
      jobPaths(jobId).claim,
      encodeClaim(
        signClaim(
          {
            schemaVersion: JOB_SCHEMA_VERSION,
            jobId,
            claimedAt: NOW.toISOString(),
            agent: { ...IDENTITY, id: "agent-left" },
          },
          KEY,
        ),
      ),
    );

    const executed: string[] = [];
    const messages: string[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    const code = await main(args(root), {
      channel,
      key: KEY,
      measureSession: () => 1,
      executor: recordingExecutor(executed),
      now: () => NOW,
      pollMs: 1,
      sleep: () => {
        sleeps += 1;
        if (sleeps >= 2) {
          controller.abort();
        }
        return Promise.resolve();
      },
      signal: controller.signal,
      stderr: (text) => messages.push(text),
    });

    expect(code).toBe(0);
    expect(executed).toEqual([]);
    const notices = messages.filter((text) =>
      text.includes(`job ${jobId} is claimed by agent "agent-left"`),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(jobPaths(jobId).claim);
    expect(await channel.read(jobPaths(jobId).result)).toBeNull();
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

  // POSIX mode bits. Windows has no equivalent, so the same property is
  // checked there through the ACL, in the test below.
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

  // The Windows counterpart: the key is refused before the agent polls,
  // because `loadKeyFile` reads the file's ACL there. This is the check that
  // used to be skipped on Windows, which left the real host with no
  // agent-level proof that a shared key is refused.
  it.skipIf(process.platform !== "win32")(
    "refuses a key file another account can read, by its ACL",
    async () => {
      const { root, channel } = await makeChannel();
      const keyFile = join(root, "agent.key");
      await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o600 });
      const { execFileSync } = await import("node:child_process");
      execFileSync("icacls", [keyFile, "/grant", "BUILTIN\\Users:(R)"]);
      const messages: string[] = [];
      const code = await main(args(root, { "--key-file": keyFile }), {
        channel,
        measureSession: () => 1,
        executor: recordingExecutor([]),
        stderr: (text) => messages.push(text),
      });
      expect(code).toBe(1);
      expect(messages.join("")).toContain("BUILTIN\\Users");
      expect(messages.join("")).toContain("nothing was polled");
    },
  );

  // The help and the setup plan both show this short form. The flags it omits
  // used to be required, so the documented command failed before it polled.
  it("starts from the four identity flags, defaulting the rest", async () => {
    const { root, channel } = await makeChannel();
    const jobId = newJobId(NOW, new Uint8Array([1, 2, 3, 4]));
    await publishJob(channel, jobId);

    const executed: string[] = [];
    const controller = new AbortController();
    const code = await main(
      [
        "--channel",
        root,
        "--key-file",
        join(root, "agent.key"),
        "--host",
        IDENTITY.host,
        "--user",
        IDENTITY.user,
      ],
      {
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
      },
    );
    expect(code).toBe(0);
    expect(executed).toEqual([jobId]);
    const result = await channel.read(jobPaths(jobId).result);
    expect(new TextDecoder().decode(result ?? new Uint8Array())).toContain(A8N_VERSION);
  });

  it("refuses when --session-id is absent and no session can be measured", async () => {
    const { root, channel } = await makeChannel();
    const messages: string[] = [];
    const code = await main(
      ["--channel", root, "--key-file", join(root, "agent.key"), "--host", IDENTITY.host, "--user", IDENTITY.user],
      {
        channel,
        key: KEY,
        measureSession: () => null,
        stderr: (text) => messages.push(text),
      },
    );
    expect(code).toBe(2);
    expect(messages.join("")).toContain("--session-id");
  });

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
