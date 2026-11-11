import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnostic, type DiagnosticCheck } from "../src/doctor/diagnostics.js";
import { HostLeftRunningError } from "../src/driver/driver.js";
import {
  assertProvenIdentity,
  type AdapterProbe,
  type Capabilities,
  type CommandOutcome,
  type IsolatedSession,
  type PlatformAdapter,
  type RecoveryFinding,
  type RunOptions,
  type SessionIdentity,
  type SetupResult,
  type SetupStep,
  type TargetSpec,
} from "../src/platform/contract.js";
import { FAKE_CAPABILITIES } from "../src/platform/fake-adapter.js";
import { RUN_ID_PATTERN } from "../src/runner/run-id.js";
import { acquireTargetLock, readQuarantine, stateLayout, targetKey } from "../src/runner/state.js";
import { runTest, type TestRunResult } from "../src/runner/test-run.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");

const IDENTITY: SessionIdentity = {
  kind: "uid-asid",
  user: "fake-test",
  detail: { uid: 900, asid: 1 },
  proven: true,
};

const TARGET: TargetSpec = {
  name: "local-test-user",
  isolation: "session",
  user: "fake-test",
  host: null,
};

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What the command does: real files, so the runner has something to copy. */
type Behaviour = (argv: readonly string[]) => Promise<CommandOutcome>;

function outputs(
  exitCode: number,
  content: { readonly stdout?: string; readonly stderr?: string; readonly timedOut?: boolean } = {},
): Behaviour {
  return (): Promise<CommandOutcome> => {
    const dir = tempDir("a8n-output-");
    const stdoutPath = join(dir, "stdout.log");
    const stderrPath = join(dir, "stderr.log");
    writeFileSync(stdoutPath, content.stdout ?? "hello from the test\n");
    writeFileSync(stderrPath, content.stderr ?? "");
    return Promise.resolve({
      exitCode,
      stdoutPath,
      stderrPath,
      ...(content.timedOut === true ? { timedOut: true } : {}),
    });
  };
}

type AdapterOptions = {
  readonly behaviour?: Behaviour;
  readonly checks?: readonly DiagnosticCheck[];
  readonly identity?: SessionIdentity;
  readonly probeThrows?: Error;
  /** What `session.close()` answers; defaults to a clean close. */
  readonly close?: () => Promise<{ readonly closed: boolean; readonly reason: string | null }>;
};

/** Records every call, so a test can prove nothing was opened or run. */
class RunnerAdapter implements PlatformAdapter {
  readonly platform = "darwin" as const;
  readonly id = "fake-darwin";
  readonly calls: string[] = [];

  private readonly behaviour: Behaviour;
  private readonly checksValue: readonly DiagnosticCheck[];
  private readonly identityValue: SessionIdentity;
  private readonly probeFailure: Error | null;
  private readonly closeBehaviour: AdapterOptions["close"];

  constructor(options: AdapterOptions = {}) {
    this.behaviour = options.behaviour ?? outputs(0);
    this.checksValue = options.checks ?? [];
    this.identityValue = options.identity ?? IDENTITY;
    this.probeFailure = options.probeThrows ?? null;
    this.closeBehaviour = options.close;
  }

  capabilities(): Promise<Capabilities> {
    this.calls.push("capabilities");
    return Promise.resolve(FAKE_CAPABILITIES);
  }

  probe(_target: TargetSpec): Promise<AdapterProbe> {
    this.calls.push("probe");
    if (this.probeFailure !== null) {
      return Promise.reject(this.probeFailure);
    }
    return Promise.resolve({ checks: this.checksValue, capabilities: FAKE_CAPABILITIES });
  }

  plan(_target: TargetSpec): Promise<readonly SetupStep[]> {
    return Promise.resolve([]);
  }

  apply(): Promise<SetupResult> {
    return Promise.resolve({ stateFile: "", outcomes: [] });
  }

  open(_target: TargetSpec): Promise<IsolatedSession> {
    this.calls.push("open");
    const identity = this.identityValue;
    let opened = false;
    const session: IsolatedSession = {
      identity,
      open: (): Promise<void> => {
        this.calls.push("session.open");
        opened = true;
        return Promise.resolve();
      },
      run: (argv: readonly string[], _options: RunOptions): Promise<CommandOutcome> => {
        try {
          assertProvenIdentity(identity);
          if (!opened) {
            throw new Error("the session is not open");
          }
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        // Recorded only after the identity guard: a call here means the
        // command was actually sent.
        this.calls.push(`run:${argv.join(" ")}`);
        return this.behaviour(argv);
      },
      close: (): Promise<{ readonly closed: boolean; readonly reason: string | null }> => {
        this.calls.push("session.close");
        return this.closeBehaviour === undefined
          ? Promise.resolve({ closed: true, reason: null })
          : this.closeBehaviour();
      },
    };
    return Promise.resolve(session);
  }

  recover(_runDir: string): Promise<readonly RecoveryFinding[]> {
    return Promise.resolve([]);
  }
}

function random(seed: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(seed);
}

async function run(
  adapter: RunnerAdapter,
  options: {
    readonly stateRoot?: string;
    readonly randomSeed?: number;
    readonly keepOnSuccess?: boolean;
    readonly timeoutMs?: number;
    readonly argv?: readonly string[];
  } = {},
): Promise<{ result: TestRunResult; stateRoot: string }> {
  const stateRoot = options.stateRoot ?? tempDir("a8n-state-");
  const result = await runTest({
    adapter,
    target: TARGET,
    argv: options.argv ?? ["node", "test.js"],
    timeoutMs: options.timeoutMs ?? 1000,
    keepOnSuccess: options.keepOnSuccess ?? true,
    stateRoot,
    now: () => NOW,
    random: random(options.randomSeed ?? 1),
    pid: 4242,
  });
  return { result, stateRoot };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("the test runner", () => {
  it("records a passing run, writes the four artifacts, and drops the directory unless asked", async () => {
    const adapter = new RunnerAdapter();
    const kept = await run(adapter);
    const { result } = kept;

    expect(result.status).toBe("ok");
    expect(result.runId).toMatch(RUN_ID_PATTERN);
    expect(result.verdicts).toEqual([
      { id: "command", verdict: "pass", message: "the command exited 0" },
    ]);
    expect(result.runDir).not.toBeNull();
    expect(result.artifacts).not.toBeNull();
    const artifacts = result.artifacts as NonNullable<TestRunResult["artifacts"]>;
    for (const path of [artifacts.manifest, artifacts.report, artifacts.trace]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(artifacts.files).toEqual(["artifacts/stdout.log", "artifacts/stderr.log"]);

    const manifest = readJson(artifacts.manifest);
    expect(manifest["schemaVersion"]).toBe("1.0");
    expect(manifest["runId"]).toBe(result.runId);
    expect(manifest["command"]).toEqual(["node", "test.js"]);
    expect(manifest["adapter"]).toBe("fake-darwin");
    expect(manifest["exitCode"]).toBe(0);
    expect(manifest["timedOut"]).toBe(false);
    expect(manifest["environment"]).toEqual({ A8N_RUN_ID: result.runId });
    expect(manifest["identity"]).toEqual(IDENTITY);

    const report = readJson(artifacts.report);
    expect(report["status"]).toBe("ok");
    expect(report["verdicts"]).toEqual(result.verdicts);

    const trace = readFileSync(artifacts.trace, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly event: string });
    expect(trace.map((event) => event.event)).toContain("command.finished");

    const dropped = await run(new RunnerAdapter(), { randomSeed: 2, keepOnSuccess: false });
    expect(dropped.result.status).toBe("ok");
    expect(dropped.result.runDir).toBeNull();
    expect(dropped.result.artifacts).toBeNull();
    expect(existsSync(join(stateLayout(dropped.stateRoot).runs, dropped.result.runId))).toBe(false);
  });

  it("closes the session after the command, and keeps the result in the trace", async () => {
    // The Windows session holds the run's channel lock until close(); nothing
    // else ever releases it, because every run uses a fresh run id.
    const adapter = new RunnerAdapter();
    const { result } = await run(adapter);

    expect(adapter.calls.filter((call) => call === "session.close")).toHaveLength(1);
    const closed = adapter.calls.indexOf("session.close");
    const ran = adapter.calls.findIndex((call) => call.startsWith("run:"));
    expect(closed).toBeGreaterThan(ran);
    const artifacts = result.artifacts as NonNullable<TestRunResult["artifacts"]>;
    const events = readFileSync(artifacts.trace, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly event: string });
    expect(events.map((event) => event.event)).toContain("session.closed");
  });

  it("keeps a refusing close out of the run's verdict", async () => {
    // On Windows a close refuses to quit After Effects when the session marker
    // is not this run's. That refusal is evidence; the run's own outcome
    // stands.
    const adapter = new RunnerAdapter({
      behaviour: outputs(1),
      close: () =>
        Promise.resolve({
          closed: false,
          reason: "A8N-AE-002: the session marker names another run; nothing was quit",
        }),
    });
    const { result } = await run(adapter);

    expect(result.status).toBe("test-failed");
    const artifacts = result.artifacts as NonNullable<TestRunResult["artifacts"]>;
    const trace = readFileSync(artifacts.trace, "utf-8");
    expect(trace).toContain("session.closed");
    expect(trace).toContain("A8N-AE-002");
  });

  it("does not let a close that throws change the run", async () => {
    const adapter = new RunnerAdapter({
      close: () => Promise.reject(new Error("the channel dropped")),
    });
    const { result } = await run(adapter);

    expect(result.status).toBe("ok");
    const artifacts = result.artifacts as NonNullable<TestRunResult["artifacts"]>;
    const trace = readFileSync(artifacts.trace, "utf-8");
    expect(trace).toContain("the session could not be closed");
    expect(trace).toContain("the channel dropped");
  });

  it("reports a non-zero exit as a test failure and keeps the run", async () => {
    const adapter = new RunnerAdapter({ behaviour: outputs(3) });
    const { result } = await run(adapter, { keepOnSuccess: false });

    expect(result.status).toBe("test-failed");
    expect(result.verdicts).toEqual([
      { id: "command", verdict: "fail", message: "the command exited 3" },
    ]);
    expect(result.runDir).not.toBeNull();
    expect(result.artifacts).not.toBeNull();
    expect(readJson((result.artifacts as NonNullable<TestRunResult["artifacts"]>).report)["status"])
      .toBe("test-failed");
  });

  it("stops at a blocker without opening the session, and quarantines nothing", async () => {
    const adapter = new RunnerAdapter({
      checks: [
        diagnostic("A8N-ENV-003", {
          detail: "no After Effects installation was found",
          remedy: "Install After Effects.",
          remedyKind: "human",
        }),
      ],
    });
    const { result, stateRoot } = await run(adapter);

    expect(result.status).toBe("blocked");
    expect(result.verdicts[0]?.id).toBe("environment");
    expect(result.checks[0]?.code).toBe("A8N-ENV-003");
    expect(adapter.calls).toEqual(["probe"]);
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(false);
  });

  it("refuses while another run holds the target's lock, without touching the adapter", async () => {
    const stateRoot = tempDir("a8n-state-");
    const layout = stateLayout(stateRoot);
    const held = acquireTargetLock(layout, TARGET.name, {
      runId: "20261110T000000Z-aaaaaaaa",
      pid: 999,
      startedAt: NOW.toISOString(),
    });
    expect(held.ok).toBe(true);

    const adapter = new RunnerAdapter();
    const { result } = await run(adapter, { stateRoot });

    expect(result.status).toBe("refused");
    expect(result.verdicts[0]?.id).toBe("run-lock");
    expect(result.checks[0]?.code).toBe("A8N-JOB-002");
    expect(adapter.calls).toEqual([]);
    expect(existsSync(join(layout.locks, `${targetKey(TARGET.name)}.lock`))).toBe(true);
  });

  it("quarantines an indeterminate outcome and refuses the next run", async () => {
    const stateRoot = tempDir("a8n-state-");
    const failing = new RunnerAdapter({
      behaviour: () => Promise.reject(new Error("the bridge stopped answering")),
    });
    const first = await run(failing, { stateRoot });

    expect(first.result.status).toBe("unknown");
    expect(first.result.verdicts).toEqual([
      { id: "command", verdict: "unknown", message: "the bridge stopped answering" },
    ]);
    const quarantine = readQuarantine(stateLayout(stateRoot), TARGET.name);
    expect(quarantine.quarantined).toBe(true);
    expect(first.result.notice).toContain("quarantined");

    const second = new RunnerAdapter();
    const again = await run(second, { stateRoot, randomSeed: 9 });
    expect(again.result.status).toBe("refused");
    expect(again.result.verdicts[0]?.id).toBe("run-quarantine");
    expect(again.result.checks[0]?.code).toBe("A8N-JOB-002");
    expect(second.calls).toEqual([]);
  });

  it("quarantines an After Effects the run started but could not prove, and names it", async () => {
    // The failure observed on a real helper session: the process appeared, the
    // readiness probe was denied, and the run ended with AE still running.
    // That is unknown, not a failed test, and the next run must not treat the
    // leftover as a fresh, unoccupied target.
    const stateRoot = tempDir("a8n-state-");
    const left = new HostLeftRunningError(
      {
        pid: 91135,
        startedAt: Date.parse("2026-11-11T11:13:00Z"),
        executable: "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects",
        presentAtLastLookup: true,
        session: { uid: 502, user: "test", asid: 100002 },
      },
      new Error("Not authorized to send Apple events to Adobe After Effects 2027. (-1743)"),
    );
    const failing = new RunnerAdapter({ behaviour: () => Promise.reject(left) });
    const first = await run(failing, { stateRoot });

    expect(first.result.status).toBe("unknown");
    expect(first.result.verdicts[0]?.verdict).toBe("unknown");
    expect(first.result.checks[0]?.code).toBe("A8N-AE-005");
    expect(first.result.checks[0]?.evidence).toMatchObject({
      stage: "run",
      pid: 91135,
      startedAt: "2026-11-11T11:13:00.000Z",
      executable: left.launch.executable,
      presentAtLastLookup: true,
    });
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(true);
    expect(first.result.notice).toContain("quarantined");

    const again = await run(new RunnerAdapter(), { stateRoot, randomSeed: 4 });
    expect(again.result.status).toBe("refused");
    expect(again.result.verdicts[0]?.id).toBe("run-quarantine");
  });

  it.skipIf(process.platform === "win32")(
    "still reports an unknown outcome when the quarantine record cannot be written",
    async () => {
      // The record is the guard for the *next* run. If writing it fails, the
      // run must still say its outcome is unknown, and must not claim the next
      // run will be refused — the guard does not exist.
      const stateRoot = tempDir("a8n-state-");
      mkdirSync(join(stateRoot, "quarantine"));
      chmodSync(join(stateRoot, "quarantine"), 0o500);
      const adapter = new RunnerAdapter({
        behaviour: () => Promise.reject(new Error("the bridge stopped answering")),
      });
      const { result } = await run(adapter, { stateRoot });

      expect(result.status).toBe("unknown");
      expect(result.notice).toContain("could not be written");
      expect(result.notice).toContain("will not be refused");
    },
  );

  it("treats a timeout as unknown and quarantined, never as a failed test", async () => {
    const adapter = new RunnerAdapter({ behaviour: outputs(0, { timedOut: true }) });
    const { result, stateRoot } = await run(adapter, { timeoutMs: 250 });

    expect(result.status).toBe("unknown");
    expect(result.verdicts[0]?.verdict).toBe("unknown");
    expect(result.verdicts[0]?.message).toContain("250 ms");
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(true);
  });

  it("refuses an unproven session before the command is sent", async () => {
    const adapter = new RunnerAdapter({ identity: { ...IDENTITY, proven: false } });
    const { result } = await run(adapter);

    expect(result.status).toBe("refused");
    expect(result.checks[0]?.code).toBe("A8N-AE-003");
    expect(adapter.calls).toContain("session.open");
    expect(adapter.calls.some((call) => call.startsWith("run:"))).toBe(false);
  });

  it("quarantines a run whose output could not be captured", async () => {
    const adapter = new RunnerAdapter({
      behaviour: () =>
        Promise.resolve({
          exitCode: 0,
          stdoutPath: join(tmpdir(), "a8n-does-not-exist-stdout"),
          stderrPath: join(tmpdir(), "a8n-does-not-exist-stderr"),
        }),
    });
    const { result, stateRoot } = await run(adapter);

    expect(result.status).toBe("unknown");
    expect(result.verdicts[0]?.id).toBe("artifacts");
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(true);
  });

  it("classifies a coded environment error as blocked without quarantining", async () => {
    const error = Object.assign(new Error("the target account has no GUI session"), {
      code: "A8N-SESSION-002",
    });
    const adapter = new RunnerAdapter({ probeThrows: error });
    const { result, stateRoot } = await run(adapter);

    expect(result.status).toBe("blocked");
    expect(result.checks[0]?.code).toBe("A8N-SESSION-002");
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(false);
  });

  it("still refuses when the quarantine record itself cannot be read", async () => {
    const stateRoot = tempDir("a8n-state-");
    const layout = stateLayout(stateRoot);
    mkdirSync(layout.quarantine, { recursive: true, mode: 0o700 });
    writeFileSync(join(layout.quarantine, `${targetKey(TARGET.name)}.json`), "{not json");

    const adapter = new RunnerAdapter();
    const { result } = await run(adapter, { stateRoot });

    expect(result.status).toBe("refused");
    expect(result.checks[0]?.detail).toContain("not valid JSON");
    expect(adapter.calls).toEqual([]);
  });
});
