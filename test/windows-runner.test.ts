import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnprovenTargetError,
  type RunOptions,
  type TargetSpec,
} from "../src/platform/contract.js";
import { DirectoryChannel, type FileChannel } from "../src/platform/windows/channel.js";
import { signResult, type JobKey } from "../src/platform/windows/auth.js";
import { decodeJobPayload } from "../src/platform/windows/executor.js";
import {
  JOB_SCHEMA_VERSION,
  encodeResult,
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
  type JobResult,
} from "../src/platform/windows/job.js";
import { acquireRunLock, lockPath } from "../src/platform/windows/lock.js";
import { readRunManifest } from "../src/platform/windows/manifest.js";
import {
  PROBE_COMMANDS,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";
import type { SubmitOptions } from "../src/platform/windows/remote.js";
import {
  createSessionMarker,
  encodeSessionMarker,
  sessionMarkerPath,
} from "../src/platform/windows/session-marker.js";
import {
  WindowsAdapter,
  WindowsJobRefusedError,
  WindowsJobUnknownError,
  WindowsKeyNotConfiguredError,
  WindowsRunLockError,
  type SubmitFunction,
} from "../src/platform/windows/runner.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const RANDOM = new Uint8Array([1, 2, 3, 4]);
const RUN_ID = newJobId(NOW, RANDOM);
const JOB_ID = newJobId(NOW, new Uint8Array([9, 9, 9, 9]));
const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };

const AGENT: AgentIdentity = {
  id: "agent-1",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-alpha.1",
};

const MARKER_RANDOM = new Uint8Array(32).fill(7);

/** What the agent writes before it executes: a marker naming the run and job. */
async function writeMarker(
  files: FileChannel,
  runId: string,
  jobId = JOB_ID,
): Promise<void> {
  await files.writeAtomic(
    sessionMarkerPath(jobId),
    encodeSessionMarker(
      createSessionMarker({
        runId,
        jobId,
        agent: AGENT,
        now: () => NOW,
        random: () => MARKER_RANDOM,
      }),
    ),
  );
}

const TARGET: TargetSpec = {
  name: "win-ae",
  isolation: "remote-host",
  user: "a8n",
  host: "WIN-AE-01",
};

const RUN_OPTIONS: RunOptions = {
  timeoutMs: 5000,
  env: { A8N_RUN: "run-1" },
};

type HostFacts = {
  readonly os?: string;
  readonly sessionId?: string;
  readonly currentUser?: string;
  readonly consoleUser?: string;
  readonly installs?: string;
  readonly processes?: string;
  readonly targetUserExitCode?: number;
};

const BASE_FACTS: Required<HostFacts> = {
  os: "Microsoft Windows 11 Pro|10.0.26100",
  sessionId: "1",
  currentUser: "WIN-AE-01\\a8n",
  consoleUser: "WIN-AE-01\\a8n",
  installs: `${INSTALL}|26.5.0`,
  processes: "INFO: No tasks are running which match the specified criteria.\r\n",
  targetUserExitCode: 0,
};

function fakeProbe(overrides: HostFacts = {}): CommandRunner {
  const facts = { ...BASE_FACTS, ...overrides };
  return {
    run(command: ProbeCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (command.program === "tasklist.exe") {
        return Promise.resolve({ stdout: facts.processes, stderr: "", exitCode: 0 });
      }
      if (command.program === "net.exe") {
        return Promise.resolve({
          stdout: facts.targetUserExitCode === 0 ? "The command completed successfully." : "",
          stderr: "",
          exitCode: facts.targetUserExitCode,
        });
      }
      const script = command.args.at(-1);
      const stdout =
        script === PROBE_COMMANDS.os.args.at(-1)
          ? facts.os
          : script === PROBE_COMMANDS.sessionId.args.at(-1)
            ? facts.sessionId
            : script === PROBE_COMMANDS.currentUser.args.at(-1)
              ? facts.currentUser
              : script === PROBE_COMMANDS.consoleUser.args.at(-1)
                ? facts.consoleUser
                : script === PROBE_COMMANDS.installs.args.at(-1)
                  ? facts.installs
                  : "";
      return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
    },
  };
}

function result(
  status: "ok" | "failed",
  message: string,
  exitCode: number | null = status === "ok" ? 0 : 1,
): JobResult {
  return signResult(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId: JOB_ID,
      status,
      code: null,
      exitCode,
      message,
      payloadSha256: "a".repeat(64),
      agent: AGENT,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    },
    KEY,
  );
}

const roots: string[] = [];

async function makeChannel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-runner-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

async function makeRunDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a8n-runner-local-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = {
  readonly channel: DirectoryChannel;
  readonly adapter: WindowsAdapter;
  readonly submitCalls: SubmitOptions[];
};

async function fixture(options: {
  readonly probe?: CommandRunner;
  readonly submit?: SubmitFunction;
  readonly staleAfterMs?: number;
  /** Leave the channel key unconfigured, to prove the run refuses. */
  readonly withoutKey?: boolean;
}): Promise<Fixture> {
  const channel = await makeChannel();
  const runDirectory = await makeRunDirectory();
  const submitCalls: SubmitOptions[] = [];
  const submit: SubmitFunction = async (files, request) => {
    submitCalls.push(request);
    if (options.submit !== undefined) {
      return options.submit(files, request);
    }
    // The default submit stands in for the agent: it writes the session
    // marker first, then publishes the result, exactly as agent.ts does.
    await writeMarker(files, request.runId);
    const jobResult = result("ok", "exited with code 0");
    const bytes = encodeResult(jobResult);
    await files.writeAtomic(jobPaths(JOB_ID).result, bytes);
    return { status: "ok", jobId: JOB_ID, result: jobResult, resultSha256: sha256Hex(bytes) };
  };
  const adapter = new WindowsAdapter({
    channel,
    host: "WIN-AE-01",
    user: "a8n",
    agent: AGENT,
    ...(options.withoutKey === true ? {} : { key: KEY }),
    probe: options.probe ?? fakeProbe(),
    // The injected probe answers for WIN-AE-01: a fake host, not this machine.
    simulatedHostProbe: true,
    runDirectory,
    now: () => NOW,
    random: () => RANDOM,
    submit,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });
  return { channel, adapter, submitCalls };
}

describe("the Windows adapter", () => {
  it("maps only the capabilities it can prove", async () => {
    const { adapter } = await fixture({});
    const remote = await adapter.probe(TARGET);
    expect(remote.capabilities).toEqual({
      nonInterference: "by-construction",
      provesOwnership: false,
      provesDestination: true,
      guiRecovery: false,
      sessionIdentity: "host-and-user",
    });
    expect(remote.checks).toEqual([]);

    const session = await adapter.probe({ ...TARGET, isolation: "session" });
    expect(session.capabilities.nonInterference).toBe("unproven");
    expect((await adapter.capabilities()).nonInterference).toBe("unproven");
  });

  it("runs one job, writes the manifest and local artifacts, and releases the lock", async () => {
    const { channel, adapter, submitCalls } = await fixture({});
    const session = await adapter.open(TARGET);
    expect(session.identity).toEqual({
      kind: "host-and-user",
      user: "a8n",
      detail: { host: "WIN-AE-01", sessionId: 1 },
      proven: true,
    });
    await session.open();

    // The executor publishes these through the channel; the runner copies them
    // into its local run directory.
    await channel.writeAtomic(
      `${jobPaths(JOB_ID).resultDirectory}/stdout.log`,
      new TextEncoder().encode("out"),
    );
    await channel.writeAtomic(
      `${jobPaths(JOB_ID).resultDirectory}/stderr.log`,
      new TextEncoder().encode("err"),
    );

    const outcome = await session.run(["/bin/echo", "hi"], RUN_OPTIONS);
    expect(outcome.exitCode).toBe(0);
    expect(await readFileText(outcome.stdoutPath)).toBe("out");
    expect(await readFileText(outcome.stderrPath)).toBe("err");

    const request = submitCalls[0];
    expect(request).toMatchObject({
      runId: RUN_ID,
      timeoutMs: 5000,
      writer: { host: "WIN-AE-01", user: "a8n" },
    });
    const payload = decodeJobPayload(request?.payload ?? new Uint8Array());
    expect(payload).toMatchObject({
      ok: true,
      value: { argv: ["/bin/echo", "hi"], env: { A8N_RUN: "run-1" } },
    });

    const manifest = await readRunManifest(channel, RUN_ID);
    expect(manifest).toMatchObject({
      ok: true,
      value: {
        runId: RUN_ID,
        host: "WIN-AE-01",
        user: "a8n",
        sessionId: 1,
        agentId: AGENT.id,
        agentVersion: AGENT.version,
        agentVerified: true,
        aeVersion: "26.5.0",
        jobId: JOB_ID,
        outcome: "ok",
        destinationProof: "marker",
        ownershipProof: "unproven",
      },
    });
    if (manifest.ok) {
      expect(manifest.value.payloadSha256).toBe(
        sha256Hex(request?.payload ?? new Uint8Array()),
      );
      expect(manifest.value.resultSha256).toBe(sha256Hex(encodeResult(result("ok", "exited with code 0"))));
    }
    expect(await channel.read(lockPath(RUN_ID))).toBeNull();

    expect(await session.close()).toEqual({ closed: true, reason: null });
  });

  it("returns the executor's exit code from a failed job", async () => {
    const { adapter, channel } = await fixture({
      submit: async (files) => {
        const jobResult = result("failed", "exited with code 7", 7);
        const bytes = encodeResult(jobResult);
        await files.writeAtomic(jobPaths(JOB_ID).result, bytes);
        return { status: "failed", jobId: JOB_ID, result: jobResult, resultSha256: sha256Hex(bytes) };
      },
    });
    const session = await adapter.open(TARGET);
    await session.open();
    const outcome = await session.run(["/bin/false"], RUN_OPTIONS);
    expect(outcome.exitCode).toBe(7);

    expect(await readRunManifest(channel, RUN_ID)).toMatchObject({
      ok: true,
      value: { outcome: "failed" },
    });
  });

  it("throws a typed refusal with the agent's code and does not retry", async () => {
    let calls = 0;
    const { adapter, channel } = await fixture({
      submit: () => {
        calls += 1;
        return Promise.resolve({
          status: "refused",
          jobId: JOB_ID,
          code: "A8N-JOB-001",
          message: "the payload hash did not match",
          resultSha256: null,
        });
      },
    });
    const session = await adapter.open(TARGET);
    await session.open();

    const failure = session.run(["/bin/echo"], RUN_OPTIONS);
    await expect(failure).rejects.toBeInstanceOf(WindowsJobRefusedError);
    await expect(failure).rejects.toMatchObject({
      code: "A8N-JOB-001",
      jobId: JOB_ID,
    });
    expect(calls).toBe(1);
    expect(await readRunManifest(channel, RUN_ID)).toMatchObject({
      ok: true,
      value: { outcome: "refused" },
    });
    expect(await channel.read(lockPath(RUN_ID))).toBeNull();
  });

  it("throws unknown on a timeout, keeps the lock, and never re-sends", async () => {
    let calls = 0;
    const { adapter, channel } = await fixture({
      submit: () => {
        calls += 1;
        return Promise.resolve({
          status: "unknown",
          jobId: JOB_ID,
          code: "A8N-AE-004",
          message: "no result after 5000ms; the job was left in place",
          resultSha256: null,
        });
      },
    });
    const session = await adapter.open(TARGET);
    await session.open();

    const failure = session.run(["/bin/sleep", "30"], RUN_OPTIONS);
    await expect(failure).rejects.toBeInstanceOf(WindowsJobUnknownError);
    await expect(failure).rejects.toMatchObject({ code: "A8N-AE-004", jobId: JOB_ID });
    expect(calls).toBe(1);
    // No result was published, so the manifest must say null rather than
    // hashing an empty byte string and looking like a real result.
    expect(await readRunManifest(channel, RUN_ID)).toMatchObject({
      ok: true,
      value: { outcome: "unknown", resultSha256: null },
    });
    // The job may still be running, so the run's lock stays until close().
    expect(await channel.read(lockPath(RUN_ID))).not.toBeNull();
    // No marker was written, so the destination is unproven and nothing may be
    // acted on; close reports that instead of pretending it closed a session.
    const closed = await session.close();
    expect(closed.closed).toBe(false);
    expect(closed.reason).toContain("A8N-AE-002");
    expect(closed.reason).toContain("nothing was quit");
    expect(await channel.read(lockPath(RUN_ID))).toBeNull();
  });

  it("does not act on a marker that names another run, and says so", async () => {
    const { adapter, channel } = await fixture({
      submit: async (files) => {
        // A marker from some other run was delivered here. It must never be
        // accepted as this run's destination.
        await writeMarker(files, "20261110T120000Z-deadbeef");
        const jobResult = result("ok", "exited with code 0");
        await files.writeAtomic(jobPaths(JOB_ID).result, encodeResult(jobResult));
        return { status: "ok", jobId: JOB_ID, result: jobResult, resultSha256: "b".repeat(64) };
      },
    });
    const session = await adapter.open(TARGET);
    await session.open();
    await session.run(["/bin/echo"], RUN_OPTIONS);

    expect(await readRunManifest(channel, RUN_ID)).toMatchObject({
      ok: true,
      value: { outcome: "ok", destinationProof: "unproven", ownershipProof: "unproven" },
    });
    const closed = await session.close();
    expect(closed.closed).toBe(false);
    expect(closed.reason).toContain("A8N-AE-002");
    expect(closed.reason).toContain("names run");
    expect(closed.reason).toContain("nothing was quit");
    // The lock is this run's own bookkeeping, not an AE process.
    expect(await channel.read(lockPath(RUN_ID))).toBeNull();
  });

  it("refuses before sending anything when no channel key is configured", async () => {
    const { adapter, channel, submitCalls } = await fixture({ withoutKey: true });
    const session = await adapter.open(TARGET);
    await session.open();

    await expect(session.run(["/bin/echo"], RUN_OPTIONS)).rejects.toBeInstanceOf(
      WindowsKeyNotConfiguredError,
    );
    expect(submitCalls).toEqual([]);
    expect(await channel.listDirectories("locks")).toEqual([]);
    expect(await channel.listDirectories("runs")).toEqual([]);
  });

  it("refuses before writing anything when the identity is unproven", async () => {
    const { adapter, channel, submitCalls } = await fixture({
      probe: fakeProbe({ processes: '"AfterFX.exe","8028","Console","1","1,234 K"\r\n' }),
    });
    const session = await adapter.open(TARGET);
    expect(session.identity.proven).toBe(false);
    await session.open();

    await expect(session.run(["/bin/echo"], RUN_OPTIONS)).rejects.toBeInstanceOf(
      UnprovenTargetError,
    );
    expect(submitCalls).toEqual([]);
    expect(await channel.listDirectories("locks")).toEqual([]);
    expect(await channel.listDirectories("runs")).toEqual([]);
  });

  it("refuses a fresh lock held by another run without overwriting it", async () => {
    const { adapter, channel, submitCalls } = await fixture({});
    await acquireRunLock(channel, {
      runId: RUN_ID,
      owner: { host: "OTHER", user: "someone" },
      now: () => NOW,
    });
    const before = await channel.read(lockPath(RUN_ID));
    const session = await adapter.open(TARGET);
    await session.open();

    const failure = session.run(["/bin/echo"], RUN_OPTIONS);
    await expect(failure).rejects.toBeInstanceOf(WindowsRunLockError);
    await expect(failure).rejects.toMatchObject({ code: "A8N-JOB-002", state: "busy" });
    expect(submitCalls).toEqual([]);
    expect(await channel.read(lockPath(RUN_ID))).toEqual(before);
  });

  it("reports a stale lock and leaves it in place", async () => {
    const { adapter, channel, submitCalls } = await fixture({});
    const stale = {
      schemaVersion: "1.0",
      runId: RUN_ID,
      owner: { host: "OLD", user: "old-run" },
      acquiredAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    };
    await channel.writeAtomic(
      lockPath(RUN_ID),
      new TextEncoder().encode(JSON.stringify(stale)),
    );
    const before = await channel.read(lockPath(RUN_ID));
    const session = await adapter.open(TARGET);
    await session.open();

    await expect(session.run(["/bin/echo"], RUN_OPTIONS)).rejects.toMatchObject({
      code: "A8N-JOB-002",
      state: "stale",
    });
    await expect(session.run(["/bin/echo"], RUN_OPTIONS)).rejects.toThrow(
      `run lock ${RUN_ID} is stale`,
    );
    expect(submitCalls).toEqual([]);
    expect(await channel.read(lockPath(RUN_ID))).toEqual(before);
  });

  it("records a null AE version when the probe cannot prove one", async () => {
    const { adapter, channel } = await fixture({
      probe: fakeProbe({ installs: `${INSTALL}|26.0\r\n${INSTALL}|26.5\r\n` }),
    });
    const session = await adapter.open(TARGET);
    await session.open();
    await session.run(["/bin/echo"], RUN_OPTIONS);
    expect(await readRunManifest(channel, RUN_ID)).toMatchObject({
      ok: true,
      value: { aeVersion: null },
    });
  });
});

async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
