/**
 * The Mac (or any controller) → Windows agent path, end to end.
 *
 * The controller here is this test process; it is not Windows. Everything it
 * learns about the host comes through the channel: the probe commands are
 * signed jobs the agent runs, and the agent's liveness, identity, session and
 * version come from its signed heartbeat. No `powershell.exe` is spawned on
 * the controller — a probe runner that throws proves it.
 *
 * This is an `automated test` against the in-repo fake host. It is not a
 * real-host verification: no After Effects is installed or started.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/run.js";
import type { TargetSpec } from "../src/platform/contract.js";
import { main as agentMain } from "../src/platform/windows/agent-main.js";
import type { JobExecutor } from "../src/platform/windows/agent.js";
import { encodeKeyFile, type JobKey } from "../src/platform/windows/auth.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  decodeHostConfig,
  openComms,
  resolveComms,
  type RemoteHostConfig,
} from "../src/platform/windows/comms.js";
import { decodeJobPayload } from "../src/platform/windows/executor.js";
import type { AgentIdentity } from "../src/platform/windows/job.js";
import {
  PRESENCE_SCHEMA_VERSION,
  checkPresence,
  decodePresence,
  encodePresence,
  presencePath,
  signPresence,
  verifyPresenceAuth,
  type Presence,
} from "../src/platform/windows/presence.js";
import {
  PROBE_COMMANDS,
  type CommandRunner,
} from "../src/platform/windows/probe.js";
import { WindowsAdapter } from "../src/platform/windows/runner.js";

const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";
const NOW = new Date("2026-11-10T12:00:00.000Z");

const KEY: JobKey = { keyId: "remote-key", secret: new Uint8Array(32).fill(9) };

const AGENT: AgentIdentity = {
  id: "ae-a8n",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 4,
  version: "0.1.0-alpha.1",
};

const TARGET: TargetSpec = {
  name: "win-ae",
  isolation: "remote-host",
  user: "a8n",
  host: "WIN-AE-01",
};

const roots: string[] = [];

async function tempDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A probe runner that must never be used: it would answer for this machine. */
const noLocalProbe: CommandRunner = {
  run: () => {
    throw new Error("the controller ran a local probe command");
  },
};

/** The agent's executor: answers the probe scripts, echoes everything else. */
class RemoteFakeHostExecutor implements JobExecutor {
  readonly seen: string[][] = [];

  execute(input: { readonly payload: Uint8Array }): Promise<{
    readonly status: "ok";
    readonly exitCode: number;
    readonly message: string;
    readonly artifacts: Record<string, Uint8Array>;
  }> {
    const decoded = decodeJobPayload(input.payload);
    const argv = decoded.ok ? decoded.value.argv : [];
    this.seen.push([...argv]);
    const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
    // The controller sends absolute host paths; compare on the file name.
    const program = (argv[0] ?? "").split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
    let stdout = "";
    if (program === "tasklist.exe") {
      stdout = "INFO: No tasks are running which match the specified criteria.\r\n";
    } else if (program === "net.exe") {
      stdout = "The command completed successfully.";
    } else if (program === "powershell.exe") {
      const script = argv.at(-1);
      stdout =
        script === PROBE_COMMANDS.os.args.at(-1)
          ? "Microsoft Windows 11 Pro|10.0.26100"
          : script === PROBE_COMMANDS.sessionId.args.at(-1)
            ? String(AGENT.sessionId)
            : script === PROBE_COMMANDS.currentUser.args.at(-1)
              ? "WIN-AE-01\\a8n"
              : script === PROBE_COMMANDS.consoleUser.args.at(-1)
                ? "WIN-AE-01\\someone-else"
                : script === PROBE_COMMANDS.installs.args.at(-1)
                  ? `${INSTALL}|26.5.0`
                  : "";
    } else {
      stdout = `${argv.join(" ")}\n`;
    }
    return Promise.resolve({
      status: "ok",
      exitCode: 0,
      message: "exited 0",
      artifacts: {
        "stdout.log": utf8(stdout),
        "stderr.log": utf8(""),
      },
    });
  }
}

type Rig = {
  readonly channelRoot: string;
  readonly keyFile: string;
  readonly executor: RemoteFakeHostExecutor;
  readonly adapter: WindowsAdapter;
  readonly stop: () => Promise<void>;
};

async function startAgent(options: { readonly presence?: boolean } = {}): Promise<Rig> {
  const channelRoot = await tempDirectory("a8n-remote-channel-");
  const runDirectory = await tempDirectory("a8n-remote-runs-");
  const keyFile = join(await tempDirectory("a8n-remote-key-"), "channel.key");
  await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o600 });
  const channel = new DirectoryChannel(channelRoot);
  const executor = new RemoteFakeHostExecutor();
  const controller = new AbortController();
  const done =
    options.presence === false
      ? Promise.resolve(0)
      : agentMain(
          [
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
          ],
          {
            executor,
            measureSession: () => AGENT.sessionId,
            pollMs: 5,
            sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
            signal: controller.signal,
          },
        );
  const adapter = new WindowsAdapter({
    channel,
    host: AGENT.host,
    user: AGENT.user,
    agent: AGENT,
    key: KEY,
    probe: noLocalProbe,
    remote: {
      host: AGENT.host,
      user: AGENT.user,
      channel: channelRoot,
      keyFile,
      agentId: AGENT.id,
    },
    runDirectory,
    pollMs: 5,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  });
  return {
    channelRoot,
    keyFile,
    executor,
    adapter,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function waitFor<T>(produce: () => Promise<T | null>, budgetMs = 3000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await produce();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the channel");
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

describe("a payload that names a Windows program", () => {
  it("decodes a drive and a UNC path on any controller", async () => {
    const { decodeJobPayload: decode } = await import("../src/platform/windows/executor.js");
    expect(
      decode(
        new TextEncoder().encode(
          JSON.stringify({ argv: ["C:\\Windows\\System32\\tasklist.exe", "/FO", "CSV"] }),
        ),
      ).ok,
    ).toBe(true);
    expect(
      decode(
        new TextEncoder().encode(JSON.stringify({ argv: ["\\\\WIN-AE-01\\tools\\probe.exe"] })),
      ).ok,
    ).toBe(true);
    // Still not an escape hatch for a bare name.
    expect(
      decode(new TextEncoder().encode(JSON.stringify({ argv: ["powershell.exe"] }))).ok,
    ).toBe(false);
  });
});

describe("the remote host connection settings", () => {
  const config = (channel: string, keyFile: string): string =>
    JSON.stringify({
      schemaVersion: "1.0",
      hosts: [{ name: "WIN-AE-01", user: "a8n", channel, keyFile, agentId: "ae-a8n" }],
    });

  it("reads a host entry and refuses an unknown field", () => {
    const good = decodeHostConfig(
      new TextEncoder().encode(config("\\\\WIN-AE-01\\a8n", "C:\\keys\\a.key")),
      "WIN-AE-01",
    );
    expect(good).toMatchObject({
      ok: true,
      config: { host: "WIN-AE-01", user: "a8n", agentId: "ae-a8n" },
    });

    const typo = decodeHostConfig(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: "1.0",
          hosts: [{ name: "WIN-AE-01", chanel: "\\\\WIN-AE-01\\a8n" }],
        }),
      ),
      "WIN-AE-01",
    );
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.detail).toContain('unknown host entry field "chanel"');
    }
  });

  it("prefers flags, and never mixes one host's channel with another's key", async () => {
    const path = join(await tempDirectory("a8n-hosts-"), "hosts.json");
    await writeFile(path, config("\\\\WIN-AE-01\\a8n", "C:\\keys\\a.key"));

    const fromConfig = await resolveComms({
      host: "WIN-AE-01",
      user: null,
      channel: null,
      keyFile: null,
      agentId: null,
      configPath: path,
    });
    expect(fromConfig).toMatchObject({ ok: true, source: "config" });

    const fromFlags = await resolveComms({
      host: "WIN-AE-01",
      user: "a8n2",
      channel: "/Volumes/a8n",
      keyFile: "/keys/a.key",
      agentId: null,
      configPath: path,
    });
    expect(fromFlags).toMatchObject({
      ok: true,
      source: "flags",
      config: { channel: "/Volumes/a8n", keyFile: "/keys/a.key", user: "a8n2" },
    });

    const half = await resolveComms({
      host: "WIN-AE-01",
      user: null,
      channel: "/Volumes/a8n",
      keyFile: null,
      agentId: null,
      configPath: path,
    });
    expect(half.ok).toBe(false);
  });

  it("says so when there is no channel and no hosts file", async () => {
    const missing = await resolveComms({
      host: "WIN-AE-09",
      user: null,
      channel: null,
      keyFile: null,
      agentId: null,
      configPath: join(tmpdir(), "a8n-no-such-hosts.json"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.detail).toContain("--channel");
    }
  });
});

describe("the agent heartbeat", () => {
  const signed = (overrides: Partial<Presence["agent"]> = {}): Presence => {
    const presence = signPresence(
      {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        agent: { ...AGENT, ...overrides },
        heartbeatAt: NOW.toISOString(),
        interactive: true,
      },
      KEY,
    );
    return presence;
  };

  it("survives a round trip and refuses a changed field", () => {
    const presence = signed();
    const decoded = decodePresence(encodePresence(presence));
    expect(decoded.ok).toBe(true);
    expect(verifyPresenceAuth(presence, [KEY])).toEqual({ ok: true });

    const tampered = { ...presence, agent: { ...presence.agent, user: "someone-else" } };
    expect(verifyPresenceAuth(tampered, [KEY]).ok).toBe(false);
    // A key the controller does not hold is not a trusted issuer.
    const other: JobKey = { keyId: "other", secret: new Uint8Array(32).fill(1) };
    expect(verifyPresenceAuth(presence, [other]).ok).toBe(false);
  });

  it("refuses a heartbeat older than the limit", () => {
    const verdict = checkPresence(
      signed(),
      [KEY],
      { host: "WIN-AE-01", user: "a8n", version: AGENT.version },
      new Date(NOW.getTime() + 31_000),
    );
    expect(verdict).toMatchObject({ ok: false, code: "A8N-JOB-005" });
  });

  it("refuses a non-interactive session, whatever the host says", () => {
    const verdict = checkPresence(
      signed({ sessionId: 0 }),
      [KEY],
      { host: "WIN-AE-01", user: "a8n", version: AGENT.version },
      NOW,
    );
    expect(verdict).toMatchObject({ ok: false, code: "A8N-JOB-005" });
  });

  it("refuses a host, user or version the target did not name", () => {
    const wrongHost = checkPresence(
      signed({ host: "WIN-AE-02" }),
      [KEY],
      { host: "WIN-AE-01", user: "a8n", version: AGENT.version },
      NOW,
    );
    expect(wrongHost).toMatchObject({ ok: false, code: "A8N-JOB-006" });

    const wrongUser = checkPresence(
      signed({ user: "someone-else" }),
      [KEY],
      { host: "WIN-AE-01", user: "a8n", version: AGENT.version },
      NOW,
    );
    expect(wrongUser).toMatchObject({ ok: false, code: "A8N-JOB-006" });

    const wrongVersion = checkPresence(
      signed({ version: "0.0.9" }),
      [KEY],
      { host: "WIN-AE-01", user: "a8n", version: AGENT.version },
      NOW,
    );
    expect(wrongVersion).toMatchObject({ ok: false, code: "A8N-JOB-006" });
  });
});

describe("opening the channel to a host", () => {
  const config: RemoteHostConfig = {
    host: "WIN-AE-01",
    user: "a8n",
    channel: "",
    keyFile: "",
    agentId: AGENT.id,
    systemRoot: "C:\\Windows",
  };

  it("refuses when no agent has ever checked in", async () => {
    const root = await tempDirectory("a8n-empty-channel-");
    const keyFile = join(await tempDirectory("a8n-empty-key-"), "channel.key");
    await writeFile(keyFile, encodeKeyFile(KEY), { mode: 0o600 });
    const state = await openComms(
      { channel: new DirectoryChannel(root), version: AGENT.version },
      { ok: true, config, source: "flags" },
      { ...config, channel: root, keyFile },
    );
    expect(state.ok).toBe(false);
    if (!state.ok) {
      const codes = state.checks.map((check) => check.code);
      expect(codes).toContain("A8N-JOB-005");
    }
  });

  it("refuses when the channel root is not reachable", async () => {
    const state = await openComms(
      {
        channel: new DirectoryChannel(join(tmpdir(), "a8n-definitely-not-mounted")),
        version: AGENT.version,
      },
      { ok: true, config, source: "flags" },
      { ...config, channel: "/mnt/nonexistent", keyFile: "/nonexistent" },
    );
    expect(state.ok).toBe(false);
    if (!state.ok) {
      expect(state.checks.map((check) => check.code)).toEqual(["A8N-JOB-007"]);
    }
  });
});

describe("through the channel, with an agent on the other side", () => {
  it("probes the host with jobs and sends the run's command the same way", async () => {
    const rig = await startAgent();
    try {
      // The heartbeat appears only once the agent is in its loop.
      await waitFor(async () => {
        const bytes = await new DirectoryChannel(rig.channelRoot).read(presencePath(AGENT.id));
        return bytes === null ? null : bytes;
      });

      const probed = await rig.adapter.probe(TARGET);
      expect(probed.checks).toEqual([]);
      // Every probe command travelled as a job; the local runner never ran.
      const probePrograms = rig.executor.seen.map(
        (argv) => (argv[0] ?? "").split(/[\\/]/u).at(-1)?.toLowerCase() ?? "",
      );
      expect(probePrograms).toContain("powershell.exe");
      expect(probePrograms).toContain("tasklist.exe");
      // Every program is absolute: the payload contract refuses a bare name.
      expect(rig.executor.seen.every((argv) => /^[A-Za-z]:[\\/]/u.test(argv[0] ?? ""))).toBe(true);

      const session = await rig.adapter.open(TARGET);
      await session.open();
      const outcome = await session.run(["C:\\tools\\probe.exe", "one"], {
        timeoutMs: 10_000,
        env: {},
      });
      expect(outcome.exitCode).toBe(0);
      expect(rig.executor.seen.at(-1)).toEqual(["C:\\tools\\probe.exe", "one"]);
      // The result was retrieved over the channel as an artifact.
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(outcome.stdoutPath, "utf8")).toBe("C:\\tools\\probe.exe one\n");
    } finally {
      await rig.stop();
    }
  }, 30_000);

  it("refuses a job when the agent stops checking in", async () => {
    const rig = await startAgent();
    try {
      await waitFor(async () => {
        const bytes = await new DirectoryChannel(rig.channelRoot).read(presencePath(AGENT.id));
        return bytes === null ? null : bytes;
      });
      const session = await rig.adapter.open(TARGET);
      await session.open();
      // The agent stops, and its last heartbeat ages past the limit. A fresh
      // heartbeat alone cannot tell a stopped agent from an idle one, so the
      // send-time check is specifically about a *stale* heartbeat.
      await rig.stop();
      const stale = signPresence(
        {
          schemaVersion: PRESENCE_SCHEMA_VERSION,
          agent: AGENT,
          heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
          interactive: true,
        },
        KEY,
      );
      await new DirectoryChannel(rig.channelRoot).writeAtomic(
        presencePath(AGENT.id),
        encodePresence(stale),
      );
      await expect(
        session.run(["C:\\tools\\probe.exe", "two"], { timeoutMs: 5_000, env: {} }),
      ).rejects.toThrow(/agent is not available/u);
    } finally {
      await rig.stop();
    }
  }, 30_000);

  it("blocks doctor when --host is given with no channel at all", async () => {
    const out = { value: "" };
    const code = await runCli(["doctor", "--host", "WIN-AE-09", "--json"], {
      now: () => NOW,
      writeOut: (text) => {
        out.value += text;
      },
      writeErr: () => undefined,
      env: {},
    });
    expect(code).toBe(3);
    const envelope = JSON.parse(out.value) as { status: string; checks: { code: string }[] };
    expect(envelope.status).toBe("blocked");
    expect(envelope.checks.map((check) => check.code)).toContain("A8N-JOB-007");
  });
});

describe("the packaged agent entry point", () => {
  it("answers --help without starting a loop, and refuses an unknown flag", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runCli(["agent", "--help"])).toBe(0);
      expect(writes.join("")).toContain("ae-a8n agent --channel <dir>");
      expect(await runCli(["agent", "--nonsense"])).toBe(2);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
