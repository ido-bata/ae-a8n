/**
 * The Windows execution path, end to end, against the in-repo fake host.
 *
 * `WindowsAdapter` -> `DirectoryChannel` -> the in-session agent's `main` ->
 * `SpawnJobExecutor` -> a separate fake AE host process. Two runs with
 * different jobs must both complete, publish their artifacts and results, and
 * leave the manifest, locks and job directories in a state that says exactly
 * what happened.
 *
 * Nothing here touches a real After Effects: the fake host is a Node process
 * under `test/fixtures/`, and the probe facts are fixed. This is an
 * `automated test` against a fake host, not a real-host verification.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TargetSpec } from "../src/platform/contract.js";
import { main } from "../src/platform/windows/agent-main.js";
import { encodeKeyFile, type JobKey } from "../src/platform/windows/auth.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  jobPaths,
  sha256Hex,
  type AgentIdentity,
} from "../src/platform/windows/job.js";
import { lockPath } from "../src/platform/windows/lock.js";
import { readRunManifest } from "../src/platform/windows/manifest.js";
import {
  PROBE_COMMANDS,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";
import { WindowsAdapter } from "../src/platform/windows/runner.js";

const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";
const FIXTURE = join(import.meta.dirname, "fixtures", "fake-ae-host.mjs");

const AGENT: AgentIdentity = {
  id: "agent-e2e",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-e2e",
};

const KEY: JobKey = { keyId: "e2e-key", secret: new Uint8Array(32).fill(5) };

const TARGET: TargetSpec = {
  name: "win-ae",
  isolation: "remote-host",
  user: "a8n",
  host: "WIN-AE-01",
};

/** The dedicated host's facts; no probe process is started. */
function fakeProbe(): CommandRunner {
  return {
    run(command: ProbeCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (command.program === "tasklist.exe") {
        return Promise.resolve({
          stdout: "INFO: No tasks are running which match the specified criteria.\r\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (command.program === "net.exe") {
        return Promise.resolve({
          stdout: "The command completed successfully.",
          stderr: "",
          exitCode: 0,
        });
      }
      const script = command.args.at(-1);
      const stdout =
        script === PROBE_COMMANDS.os.args.at(-1)
          ? "Microsoft Windows 11 Pro|10.0.26100"
          : script === PROBE_COMMANDS.sessionId.args.at(-1)
            ? "1"
            : script === PROBE_COMMANDS.currentUser.args.at(-1)
              ? "WIN-AE-01\\a8n"
              : script === PROBE_COMMANDS.consoleUser.args.at(-1)
                ? "WIN-AE-01\\a8n"
                : script === PROBE_COMMANDS.installs.args.at(-1)
                  ? `${INSTALL}|26.5.0`
                  : "";
      return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
    },
  };
}

const roots: string[] = [];

async function tempDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agentArguments(channelRoot: string, keyFile: string): readonly string[] {
  return [
    "--channel",
    channelRoot,
    "--key-file",
    keyFile,
    "--agent-id",
    AGENT.id,
    "--host",
    AGENT.host,
    "--user",
    AGENT.user,
    "--session-id",
    String(AGENT.sessionId),
    "--version",
    AGENT.version,
  ];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("the Windows execution path end to end", () => {
  it("runs two jobs through the agent and the fake host, and records the proof", async () => {
    const channelRoot = await tempDirectory("a8n-e2e-channel-");
    const runDirectory = await tempDirectory("a8n-e2e-runs-");
    const logPath = join(runDirectory, "fake-host.log");
    const keyFile = join(await tempDirectory("a8n-e2e-key-"), "agent.key");
    await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o600 });

    const channel = new DirectoryChannel(channelRoot);
    const adapter = new WindowsAdapter({
      channel,
      host: "WIN-AE-01",
      user: "a8n",
      agent: AGENT,
      key: KEY,
      probe: fakeProbe(),
      // The injected probe answers for WIN-AE-01: a fake host, not this machine.
      simulatedHostProbe: true,
      runDirectory,
      pollMs: 5,
      sleep,
    });

    // The real agent loop, with the real executor; only its child is fake.
    const controller = new AbortController();
    const agentDone = main(agentArguments(channelRoot, keyFile), {
      // The fake host has no desktop to measure; the probe facts say 1.
      measureSession: () => AGENT.sessionId,
      pollMs: 5,
      sleep,
      signal: controller.signal,
    });

    try {
      const session = await adapter.open(TARGET);
      await session.open();

      const first = await session.run([process.execPath, FIXTURE, "ok"], {
        timeoutMs: 10_000,
        env: { A8N_FAKE_HOST_LOG: logPath },
      });
      expect(first.exitCode).toBe(0);
      expect(await readFile(first.stdoutPath, "utf8")).toBe("fake-ae-host:ok\n");
      expect(await readFile(first.stderrPath, "utf8")).toBe("fake-ae-host:stderr-ok\n");

      const second = await session.run([process.execPath, FIXTURE, "fail"], {
        timeoutMs: 10_000,
        env: { A8N_FAKE_HOST_LOG: logPath },
      });
      expect(second.exitCode).toBe(3);
      expect(await readFile(second.stdoutPath, "utf8")).toBe("fake-ae-host:fail\n");
      expect(await readFile(second.stderrPath, "utf8")).toBe("fake-ae-host:stderr-fail\n");

      expect(await session.close()).toEqual({ closed: true, reason: null });
    } finally {
      controller.abort();
    }
    expect(await agentDone).toBe(0);

    // Exactly two runs: no job was submitted or executed twice.
    const runIds = await channel.listDirectories("runs");
    expect(runIds).toHaveLength(2);
    const jobIds = await channel.listDirectories("jobs");
    expect(jobIds).toHaveLength(2);
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);

    const outcomes: string[] = [];
    for (const runId of runIds) {
      const manifest = await readRunManifest(channel, runId);
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) {
        continue;
      }
      const value = manifest.value;
      outcomes.push(value.outcome);
      expect(value).toMatchObject({
        runId,
        host: "WIN-AE-01",
        user: "a8n",
        sessionId: 1,
        agentId: AGENT.id,
        agentVersion: AGENT.version,
        aeVersion: "26.5.0",
        destinationProof: "marker",
        ownershipProof: "unproven",
      });
      expect(value.jobId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      expect(jobIds).toContain(value.jobId);

      // The hashes name the bytes that were really exchanged.
      const payload = await channel.read(jobPaths(value.jobId).payload("payload.json"));
      expect(payload).not.toBeNull();
      expect(value.payloadSha256).toBe(sha256Hex(payload ?? new Uint8Array()));
      const result = await channel.read(jobPaths(value.jobId).result);
      expect(result).not.toBeNull();
      expect(value.resultSha256).toBe(sha256Hex(result ?? new Uint8Array()));

      // Every run released its own lock.
      expect(await channel.read(lockPath(runId))).toBeNull();
    }
    expect(outcomes.sort()).toEqual(["failed", "ok"]);
  }, 30_000);
});
