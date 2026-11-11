import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TargetSpec } from "../src/platform/contract.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import type { AgentIdentity } from "../src/platform/windows/job.js";
import {
  PROBE_COMMANDS,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";
import {
  SETUP_STATE_PATH,
  WindowsAdapter,
} from "../src/platform/windows/runner.js";

const TARGET: TargetSpec = {
  name: "win-ae",
  isolation: "remote-host",
  user: "a8n",
  host: "WIN-AE-01",
};

const AGENT: AgentIdentity = {
  id: "agent-1",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-alpha.1",
};

const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";

type HostFacts = {
  readonly os: string;
  readonly sessionId: string;
  readonly currentUser: string;
  readonly consoleUser: string;
  readonly installs: string;
  readonly processes: string;
};

const CLEAN: HostFacts = {
  os: "Microsoft Windows 11 Pro|10.0.26100",
  sessionId: "1",
  currentUser: "WIN-AE-01\\a8n",
  consoleUser: "WIN-AE-01\\a8n",
  installs: `${INSTALL}|26.5.0`,
  processes: "INFO: No tasks are running which match the specified criteria.\r\n",
};

function fakeProbe(overrides: Partial<HostFacts> = {}): CommandRunner {
  const facts = { ...CLEAN, ...overrides };
  return {
    run(command: ProbeCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (command.program === "tasklist.exe") {
        return Promise.resolve({ stdout: facts.processes, stderr: "", exitCode: 0 });
      }
      if (command.program === "net.exe") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
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

class UnreadableChannel extends DirectoryChannel {
  override list(_directory: string): Promise<readonly string[]> {
    return Promise.reject(new Error("EACCES: the channel root is not readable"));
  }
}

const roots: string[] = [];

const AUTOSTART =
  "C:\\Users\\a8n\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\a8n-agent.lnk";

async function setup(options: {
  readonly probe?: CommandRunner;
  readonly agentExists?: boolean;
  readonly autostartExists?: boolean;
  readonly autostartEntry?: string | null;
  readonly channel?: DirectoryChannel;
} = {}): Promise<{ readonly channel: DirectoryChannel; readonly adapter: WindowsAdapter }> {
  const root = await mkdtemp(join(tmpdir(), "a8n-setup-"));
  roots.push(root);
  const channel = options.channel ?? new DirectoryChannel(root);
  const autostartEntry = options.autostartEntry === undefined ? AUTOSTART : options.autostartEntry;
  const adapter = new WindowsAdapter({
    channel,
    host: "WIN-AE-01",
    user: "a8n",
    agent: AGENT,
    probe: options.probe ?? fakeProbe(),
    // The injected probe answers for WIN-AE-01: a fake host, not this machine.
    simulatedHostProbe: true,
    runDirectory: join(root, "runs-local"),
    agentEntry: "C:\\a8n\\scripts\\windows-agent.mjs",
    ...(autostartEntry === null ? {} : { autostartEntry }),
    exists: (path) =>
      Promise.resolve(
        path === autostartEntry
          ? options.autostartExists ?? true
          : options.agentExists ?? true,
      ),
  });
  return { channel, adapter };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows setup steps", () => {
  it("plans the six idempotent steps and never automates sign-in", async () => {
    const { adapter } = await setup();
    const steps = await adapter.plan(TARGET);
    expect(steps.map((step) => step.id)).toEqual([
      "windows.channel",
      "windows.channel-permissions",
      "windows.agent",
      "windows.agent-autostart",
      "windows.ae",
      "windows.signin",
    ]);
    expect(steps.slice(0, 5).map((step) => step.state)).toEqual([
      "done",
      "needs-human",
      "done",
      "done",
      "done",
    ]);
    expect(steps[4]?.reason).toContain("26.5.0");
    expect(steps[5]).toMatchObject({
      state: "needs-human",
      automatable: false,
    });
    expect(steps[5]?.action).toContain("Sign in");
    expect(steps.find((step) => step.id === "windows.channel-permissions")).toMatchObject({
      state: "needs-human",
      automatable: false,
    });
  });

  it("changes nothing on a dry run", async () => {
    const { channel, adapter } = await setup();
    const steps = await adapter.plan(TARGET);
    const result = await adapter.apply(steps, { yes: true, dryRun: true });
    expect(result.outcomes.map((outcome) => outcome.detail)).toEqual(
      steps.map(() => "dry run: nothing was changed"),
    );
    expect(await channel.read(SETUP_STATE_PATH)).toBeNull();
  });

  it("reports skipped the second time, and writes no credential", async () => {
    const { channel, adapter } = await setup();
    const steps = await adapter.plan(TARGET);

    const first = await adapter.apply(steps, { yes: true, dryRun: false });
    expect(first.stateFile).toBe(SETUP_STATE_PATH);
    expect(first.outcomes.map((outcome) => outcome.state)).toEqual([
      "done",
      "needs-human",
      "done",
      "done",
      "done",
      "needs-human",
    ]);

    const stateBytes = await channel.read(SETUP_STATE_PATH);
    const state = new TextDecoder().decode(stateBytes ?? new Uint8Array());
    expect(state).toContain("windows.channel");
    expect(state).not.toMatch(/password|token|secret|credential/i);

    const second = await adapter.apply(steps, { yes: true, dryRun: false });
    expect(second.outcomes.map((outcome) => outcome.state)).toEqual([
      "skipped",
      "needs-human",
      "skipped",
      "skipped",
      "skipped",
      "needs-human",
    ]);
  });

  it("checks the logon entry instead of registering it", async () => {
    const missing = await setup({ autostartExists: false });
    const missingSteps = await missing.adapter.plan(TARGET);
    const step = missingSteps.find((entry) => entry.id === "windows.agent-autostart");
    expect(step).toMatchObject({ state: "planned", automatable: false });
    expect(step?.reason).toContain("does not exist");
    const applied = await missing.adapter.apply(missingSteps, { yes: true, dryRun: false });
    expect(applied.outcomes.find((outcome) => outcome.id === "windows.agent-autostart")).toMatchObject({
      state: "failed",
    });

    const none = await setup({ autostartEntry: null });
    const noneSteps = await none.adapter.plan(TARGET);
    expect(noneSteps.find((entry) => entry.id === "windows.agent-autostart")).toMatchObject({
      state: "planned",
      reason: "no agent logon entry is configured",
    });
  });

  it("plans a missing agent entry and fails it without pretending", async () => {
    const { adapter } = await setup({ agentExists: false });
    const steps = await adapter.plan(TARGET);
    expect(steps.find((step) => step.id === "windows.agent")).toMatchObject({
      state: "planned",
      automatable: false,
    });
    const result = await adapter.apply(steps, { yes: true, dryRun: false });
    expect(result.outcomes.find((outcome) => outcome.id === "windows.agent")).toMatchObject({
      state: "failed",
    });
  });

  it("plans an unreadable channel as a planned automatable step", async () => {
    const root = await mkdtemp(join(tmpdir(), "a8n-setup-"));
    roots.push(root);
    const { adapter } = await setup({ channel: new UnreadableChannel(root) });
    const steps = await adapter.plan(TARGET);
    expect(steps.find((step) => step.id === "windows.channel")).toMatchObject({
      state: "planned",
      automatable: true,
    });
  });

  it("reports a missing or ambiguous After Effects as needs-human", async () => {
    const missing = await setup({ probe: fakeProbe({ installs: "" }) });
    const missingSteps = await missing.adapter.plan(TARGET);
    expect(missingSteps.find((step) => step.id === "windows.ae")).toMatchObject({
      state: "needs-human",
    });

    const ambiguous = await setup({
      probe: fakeProbe({ installs: `${INSTALL}|26.0\r\n${INSTALL}|26.5\r\n` }),
    });
    const ambiguousSteps = await ambiguous.adapter.plan(TARGET);
    expect(ambiguousSteps.find((step) => step.id === "windows.ae")).toMatchObject({
      state: "needs-human",
    });
    const reason = ambiguousSteps.find((step) => step.id === "windows.ae")?.reason ?? "";
    expect(reason).toContain("cannot be proved");
    // A real host had 26.0 and 26.5 registered at once. Naming them is what
    // lets a person act; "more than one version" alone does not.
    expect(reason).toContain("26.0, 26.5");
  });

  it("reports a real recovery observation instead of the old placeholder", async () => {
    const { adapter } = await setup();
    const findings = await adapter.recover("runs/20261110T120000Z-abcdef01");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "A8N-JOB-002", action: "reported" });
    expect(findings[0]?.detail).toContain("no AfterFX.exe process was running");
    expect(findings[0]?.detail).toContain("nothing was acted on");
    expect(findings[0]?.detail).not.toContain("not implemented");
  });
});
