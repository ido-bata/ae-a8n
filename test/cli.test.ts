import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli/args.js";
import type { CliEnvelope } from "../src/cli/envelope.js";
import { EXIT } from "../src/cli/exit-code.js";
import { runCli, type CliDependencies } from "../src/cli/run.js";
import { diagnostic } from "../src/doctor/diagnostics.js";
import {
  FakeAdapter,
  FAKE_CAPABILITIES,
  FAKE_IDENTITY,
  type FakeAdapterOptions,
} from "../src/platform/fake-adapter.js";
import type { AdapterSelection, SelectOptions } from "../src/platform/select.js";
import { stateLayout, targetKey, writeQuarantine } from "../src/runner/state.js";
import { unsupportedPlatformCheck } from "../src/platform/select.js";
import type {
  AdapterProbe,
  Capabilities,
  CommandOutcome,
  IsolatedSession,
  PlatformAdapter,
  RecoveryFinding,
  SetupResult,
  SetupStep,
  TargetSpec,
} from "../src/platform/contract.js";

type Harness = {
  readonly deps: CliDependencies;
  readonly out: () => string;
  readonly err: () => string;
};

function harness(
  selection: AdapterSelection | ((options: SelectOptions) => AdapterSelection),
  extra: Partial<Pick<CliDependencies, "stateRoot">> = {},
): Harness {
  let out = "";
  let err = "";
  return {
    deps: {
      select: typeof selection === "function" ? selection : () => selection,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        err += text;
      },
      env: { A8N_COMMIT: "deadbeef" },
      ...extra,
    },
    out: () => out,
    err: () => err,
  };
}

function jsonEnvelope(text: string): CliEnvelope {
  return JSON.parse(text) as CliEnvelope;
}

class RecordingAdapter extends FakeAdapter {
  readonly targets: TargetSpec[] = [];

  override probe(target: TargetSpec): Promise<AdapterProbe> {
    this.targets.push(target);
    return super.probe(target);
  }
}

type ApplyOptions = { readonly yes: boolean; readonly dryRun: boolean };

class SetupAdapter extends FakeAdapter {
  readonly planTargets: TargetSpec[] = [];
  readonly applies: ApplyOptions[] = [];
  readonly #steps: readonly SetupStep[];
  readonly #apply: (steps: readonly SetupStep[], options: ApplyOptions) => Promise<SetupResult>;

  constructor(
    steps: readonly SetupStep[],
    apply: (steps: readonly SetupStep[], options: ApplyOptions) => Promise<SetupResult>,
  ) {
    super("darwin");
    this.#steps = steps;
    this.#apply = apply;
  }

  override plan(target: TargetSpec): Promise<readonly SetupStep[]> {
    this.planTargets.push(target);
    return Promise.resolve(this.#steps);
  }

  override apply(
    steps: readonly SetupStep[],
    options: ApplyOptions,
  ): Promise<SetupResult> {
    this.applies.push(options);
    return this.#apply(steps, options);
  }
}

const DONE_STEP: SetupStep = {
  id: "macos.ae",
  state: "done",
  reason: "After Effects 24.0 is installed",
  action: null,
  automatable: true,
};

const HUMAN_STEP: SetupStep = {
  id: "macos.signin",
  state: "needs-human",
  reason: "the Adobe sign-in has not been completed",
  action: "Sign in to Creative Cloud in the target account",
  automatable: false,
};

class ThrowingAdapter implements PlatformAdapter {
  readonly platform = "darwin" as const;
  readonly id = "broken";

  capabilities(): Promise<Capabilities> {
    return Promise.resolve(FAKE_CAPABILITIES);
  }

  probe(_target: TargetSpec): Promise<AdapterProbe> {
    return Promise.reject(new Error("the host said nothing"));
  }

  plan(_target: TargetSpec): Promise<readonly SetupStep[]> {
    return Promise.resolve([]);
  }

  apply(
    _steps: readonly SetupStep[],
    _options: { readonly yes: boolean; readonly dryRun: boolean },
  ): Promise<SetupResult> {
    return Promise.resolve({ stateFile: "", outcomes: [] });
  }

  open(_target: TargetSpec): Promise<IsolatedSession> {
    return Promise.reject(new Error("not used"));
  }

  recover(_runDir: string): Promise<readonly RecoveryFinding[]> {
    return Promise.resolve([]);
  }
}

describe("argument parsing", () => {
  it("parses the doctor flags the contract and issue name", () => {
    const parsed = parseArgs([
      "doctor",
      "--json",
      "--target",
      "mac-1",
      "--user",
      "ae-test",
      "--host",
      "WIN-AE-01",
      "--verbose",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "command") {
      return;
    }
    expect(parsed.command).toBe("doctor");
    expect(parsed.options).toMatchObject({
      json: true,
      target: "mac-1",
      user: "ae-test",
      host: "WIN-AE-01",
      verbose: true,
    });
  });

  it("accepts --flag=value spelling", () => {
    const parsed = parseArgs(["doctor", "--user=ae-test", "--json"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "command") {
      return;
    }
    expect(parsed.options).toMatchObject({ user: "ae-test" });
  });

  it("rejects unknown flags, missing values and unknown commands", () => {
    expect(parseArgs(["doctor", "--wat"]).ok).toBe(false);
    expect(parseArgs(["doctor", "--target"]).ok).toBe(false);
    expect(parseArgs(["--nonsense"]).ok).toBe(false);
    expect(parseArgs(["wat"]).ok).toBe(false);
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(["report", "--format", "xml"]).ok).toBe(false);
  });

  it("requires test's -- delimiter and the command after it", () => {
    expect(parseArgs(["test", "./tests/example.ts"]).ok).toBe(false);
    expect(parseArgs(["test", "--"]).ok).toBe(false);
    const parsed = parseArgs(["test", "--timeout", "1000", "--", "node", "test.js"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "command") {
      return;
    }
    expect(parsed.options).toMatchObject({ timeoutMs: 1000 });
    if ("command" in parsed.options) {
      expect(parsed.options.command).toEqual(["node", "test.js"]);
    }
  });

  it("does not let another command consume test's command flags", () => {
    expect(parseArgs(["doctor", "--timeout", "1000"]).ok).toBe(false);
    expect(parseArgs(["recover", "--keep"]).ok).toBe(false);
    expect(parseArgs(["doctor", "--format", "json"]).ok).toBe(false);
  });

  it("treats --help with no command as help, not usage", () => {
    const parsed = parseArgs(["--help"]);
    expect(parsed).toMatchObject({ ok: true, kind: "help", command: null });
  });
});

describe("the doctor command", () => {
  it("prints exactly one JSON envelope with the contract's shape", async () => {
    const adapter = new FakeAdapter("darwin");
    const test = harness({ ok: true, adapter });
    const code = await runCli(
      ["doctor", "--json", "--target", "local-test-user"],
      test.deps,
    );

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.schemaVersion).toBe("1.0");
    expect(envelope.command).toBe("doctor");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.startedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(envelope.finishedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(envelope.platform).toEqual({
      os: "darwin",
      release: expect.any(String),
      arch: expect.any(String),
      backend: "fake-darwin",
    });
    expect(envelope.package).toEqual({
      name: "@ido-bata/ae-a8n",
      version: "0.1.0-alpha.1",
      commit: "deadbeef",
    });
    expect(envelope.target).toEqual({
      name: "local-test-user",
      isolation: "session",
    });
    expect(envelope.checks).toEqual([]);
    expect(envelope.nextActions).toEqual([]);
    expect(test.err()).toBe("");
    // The probe is the only adapter call doctor may make.
    expect(adapter.calls).toEqual(["probe:local-test-user"]);
  });

  it("reports a blocker, exits 3, and carries the full check shape", async () => {
    const check = diagnostic("A8N-SESSION-001", {
      detail: "the target account does not exist",
      remedy: "Create the account, then re-run doctor.",
      remedyKind: "human",
      evidence: { user: "missing" },
    });
    const adapter = new FakeAdapter("darwin", { checks: [check] });
    const test = harness({ ok: true, adapter });
    const code = await runCli(["doctor", "--json"], test.deps);

    expect(code).toBe(EXIT.blocked);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("blocked");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.checks).toHaveLength(1);
    expect(envelope.checks[0]).toEqual({
      code: "A8N-SESSION-001",
      severity: "blocker",
      title: "Target account does not exist",
      detail: "the target account does not exist",
      remedy: "Create the account, then re-run doctor.",
      remedyKind: "human",
      evidence: { user: "missing" },
    });
    expect(envelope.nextActions).toEqual([
      {
        kind: "human",
        code: "A8N-SESSION-001",
        action: "Create the account, then re-run doctor.",
      },
    ]);
  });

  it("does not fail on a warning alone", async () => {
    const warning = diagnostic("A8N-ENV-004", {
      detail: "two installations were found",
      remedy: "Keep one installation.",
      remedyKind: "human",
    });
    const adapter = new FakeAdapter("darwin", { checks: [warning] });
    const test = harness({ ok: true, adapter });
    const code = await runCli(["doctor", "--json"], test.deps);
    expect(code).toBe(EXIT.ok);
    expect(jsonEnvelope(test.out()).status).toBe("ok");
  });

  it("passes the target account and host to the adapter", async () => {
    const adapter = new RecordingAdapter("win32");
    const test = harness({ ok: true, adapter });
    await runCli(
      [
        "doctor",
        "--json",
        "--target",
        "win-target",
        "--user",
        "ae-test",
        "--host",
        "WIN-AE-01",
      ],
      test.deps,
    );
    expect(adapter.targets).toEqual([
      {
        name: "win-target",
        isolation: "remote-host",
        user: "ae-test",
        host: "WIN-AE-01",
      },
    ]);
  });

  it("turns an unsupported platform into a typed blocker, not a crash", async () => {
    const test = harness({
      ok: false,
      platform: "linux",
      check: unsupportedPlatformCheck("linux"),
    });
    const code = await runCli(["doctor", "--json"], test.deps);

    expect(code).toBe(EXIT.blocked);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("blocked");
    expect(envelope.platform.os).toBe("linux");
    expect(envelope.platform.backend).toBe("unsupported");
    expect(envelope.checks.map((check) => check.code)).toEqual(["A8N-ENV-001"]);
    expect(envelope.checks[0]?.severity).toBe("blocker");
    expect(envelope.checks[0]?.detail).toContain("linux");
  });

  it("exits 6 and never reports success when doctor throws", async () => {
    const adapter = new FakeAdapter("darwin");
    const test = harness({ ok: true, adapter });
    const deps: CliDependencies = {
      ...test.deps,
      select: () => ({ ok: true, adapter: new ThrowingAdapter() }),
    };

    const code = await runCli(["doctor", "--json"], deps);
    expect(code).toBe(EXIT.unknown);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("unknown");
    expect(envelope.exitCode).toBe(6);
    expect(envelope.notice).toContain("could not finish");
  });
});

describe("usage errors and help", () => {
  it("prints help for a command and never probes", async () => {
    const adapter = new FakeAdapter("darwin");
    const test = harness({ ok: true, adapter });
    const code = await runCli(["doctor", "--help"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(test.out()).toContain("Usage: ae-a8n doctor");
    expect(test.out()).toContain("--json");
    expect(adapter.calls).toEqual([]);
  });

  it("prints general help with --help", async () => {
    const test = harness({ ok: false, platform: "unknown", check: unsupportedPlatformCheck("unknown") });
    const code = await runCli(["--help"], test.deps);
    expect(code).toBe(EXIT.ok);
    expect(test.out()).toContain("ae-a8n <command>");
    expect(test.out()).toContain("doctor");
  });

  it("exits 2 and keeps stdout empty on a usage error without --json", async () => {
    const test = harness({ ok: false, platform: "unknown", check: unsupportedPlatformCheck("unknown") });
    const code = await runCli(["wat"], test.deps);
    expect(code).toBe(EXIT.usage);
    expect(test.out()).toBe("");
    expect(test.err()).toContain("unknown command");
  });

  it("exits 2 and emits exactly one JSON document when --json was asked for", async () => {
    const test = harness({ ok: false, platform: "unknown", check: unsupportedPlatformCheck("unknown") });
    const code = await runCli(["wat", "--json"], test.deps);
    expect(code).toBe(EXIT.usage);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("failed");
    expect(envelope.exitCode).toBe(2);
    expect(envelope.notice).toContain("unknown command");
    expect(test.err()).toContain("ae-a8n:");
  });
});

describe("the setup command", () => {
  it("plans, applies, reports every step and exits 0 when all are done", async () => {
    const adapter = new SetupAdapter([DONE_STEP], () =>
      Promise.resolve({
        stateFile: "/tmp/ae-a8n/setup-state.json",
        outcomes: [{ id: "macos.ae", state: "done", detail: "already installed" }],
      }),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json", "--target", "mac-1"], test.deps);

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.command).toBe("setup");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.stateFile).toBe("/tmp/ae-a8n/setup-state.json");
    expect(envelope.steps).toEqual([
      {
        id: "macos.ae",
        state: "done",
        reason: "After Effects 24.0 is installed",
        action: null,
        automatable: true,
        detail: "already installed",
      },
    ]);
    expect(adapter.planTargets).toEqual([
      { name: "mac-1", isolation: "session", user: null, host: null },
    ]);
    expect(adapter.applies).toEqual([{ yes: false, dryRun: false }]);
    expect(test.err()).toBe("");
  });

  it("exits 7 and names the human action when a step needs a person", async () => {
    const adapter = new SetupAdapter([DONE_STEP, HUMAN_STEP], () =>
      Promise.resolve({
        stateFile: "/tmp/state.json",
        outcomes: [
          { id: "macos.ae", state: "done", detail: "already installed" },
          { id: "macos.signin", state: "needs-human", detail: "not signed in" },
        ],
      }),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.setupIncomplete);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("setup-incomplete");
    expect(envelope.exitCode).toBe(7);
    const signin = envelope.steps?.find((step) => step.id === "macos.signin");
    expect(signin).toMatchObject({
      state: "needs-human",
      automatable: false,
      action: "Sign in to Creative Cloud in the target account",
      detail: "not signed in",
    });
  });

});

const stateRoots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "a8n-cli-state-"));
  stateRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of stateRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A session whose command writes the output files the runner copies. */
class RunningAdapter extends FakeAdapter {
  readonly sent: string[] = [];

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
    options: FakeAdapterOptions = {},
  ) {
    super("darwin", options);
  }

  override open(target: TargetSpec): Promise<IsolatedSession> {
    this.calls.push(`open:${target.name}`);
    const session: IsolatedSession = {
      identity: FAKE_IDENTITY,
      open: (): Promise<void> => {
        this.calls.push("session.open");
        return Promise.resolve();
      },
      run: (argv: readonly string[]): Promise<CommandOutcome> => {
        this.sent.push(argv.join(" "));
        const output = mkdtempSync(join(tmpdir(), "a8n-cli-out-"));
        stateRoots.push(output);
        const stdoutPath = join(output, "stdout.log");
        const stderrPath = join(output, "stderr.log");
        writeFileSync(stdoutPath, this.result.stdout);
        writeFileSync(stderrPath, this.result.stderr);
        return Promise.resolve({
          exitCode: this.result.exitCode,
          stdoutPath,
          stderrPath,
        });
      },
      close: (): Promise<{ readonly closed: boolean; readonly reason: string | null }> =>
        Promise.resolve({ closed: true, reason: null }),
    };
    return Promise.resolve(session);
  }
}

describe("the test command", () => {
  it("runs the command once and prints exactly one JSON document", async () => {
    const adapter = new RunningAdapter({ exitCode: 0, stdout: "hello\n", stderr: "" });
    const test = harness({ ok: true, adapter }, { stateRoot: stateRoot() });
    const code = await runCli(
      ["test", "--json", "--target", "local-test-user", "--", "node", "test.js"],
      test.deps,
    );

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.schemaVersion).toBe("1.0");
    expect(envelope.command).toBe("test");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.runId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
    expect(envelope.verdicts).toEqual([
      { id: "command", verdict: "pass", message: "the command exited 0" },
    ]);
    expect(envelope.artifacts?.report).toContain("report.json");
    expect(envelope.artifacts?.files).toEqual([
      "artifacts/stdout.log",
      "artifacts/stderr.log",
    ]);
    expect(envelope.target.identity).toEqual(FAKE_IDENTITY);
    expect(adapter.sent).toEqual(["node test.js"]);
    // The human summary is written to stderr; stdout stays one JSON document.
    expect(test.err()).toContain(`run ${String(envelope.runId)}`);
    expect(test.err()).toContain("report:");
  });

  it("maps a failing command to exit 5 and keeps the run directory", async () => {
    const adapter = new RunningAdapter({ exitCode: 3, stdout: "", stderr: "boom\n" });
    const test = harness({ ok: true, adapter }, { stateRoot: stateRoot() });
    const code = await runCli(["test", "--json", "--", "node", "test.js"], test.deps);

    expect(code).toBe(EXIT.testFailed);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("test-failed");
    expect(envelope.exitCode).toBe(5);
    expect(envelope.verdicts).toEqual([
      { id: "command", verdict: "fail", message: "the command exited 3" },
    ]);
    expect(envelope.artifacts?.manifest).toContain(String(envelope.runId));
  });

  it("stops at a blocker with exit 3 before opening the session", async () => {
    const adapter = new RunningAdapter(
      { exitCode: 0, stdout: "", stderr: "" },
      {
        checks: [
          diagnostic("A8N-ENV-003", {
            detail: "no After Effects installation was found",
            remedy: "Install After Effects.",
            remedyKind: "human",
          }),
        ],
      },
    );
    const test = harness({ ok: true, adapter }, { stateRoot: stateRoot() });
    const code = await runCli(["test", "--json", "--", "node", "test.js"], test.deps);

    expect(code).toBe(EXIT.blocked);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("blocked");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.checks[0]?.code).toBe("A8N-ENV-003");
    expect(envelope.verdicts?.[0]?.id).toBe("environment");
    expect(adapter.sent).toEqual([]);
    expect(adapter.calls).not.toContain("open:local");
  });

  it("prints the run and its verdicts in human mode and says when the directory was dropped", async () => {
    const adapter = new RunningAdapter({ exitCode: 0, stdout: "", stderr: "" });
    const test = harness({ ok: true, adapter }, { stateRoot: stateRoot() });
    const code = await runCli(["test", "--", "node", "test.js"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(test.out()).toContain("ae-a8n test — ok (exit 0)");
    expect(test.out()).toContain("verdicts:");
    expect(test.out()).toContain("[pass] command: the command exited 0");
    expect(test.out()).toContain("(directory not kept)");
    expect(test.err()).toContain("the run directory was not kept");
    expect(adapter.sent).toEqual(["node test.js"]);
  });
});

describe("the recover command", () => {
  function quarantined(root: string): string {
    const path = writeQuarantine(stateLayout(root), "local", {
      runId: "20261110T120000Z-4f2a8c11",
      quarantinedAt: "2026-01-02T03:04:05.000Z",
      detail: "the command timed out and may still be running",
    });
    return path;
  }

  it("reports the quarantine and its remedy without clearing it", async () => {
    const root = stateRoot();
    const path = quarantined(root);
    const test = harness({ ok: true, adapter: new FakeAdapter("darwin") }, { stateRoot: root });
    const code = await runCli(["recover", "--json"], test.deps);

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.command).toBe("recover");
    expect(envelope.status).toBe("ok");
    expect(envelope.cleared).toBe(false);
    expect(envelope.runId).toBe("20261110T120000Z-4f2a8c11");
    expect(envelope.findings?.[0]).toMatchObject({ code: "A8N-JOB-002", action: "reported" });
    expect(envelope.nextActions[0]?.action).toContain("--force");
    expect(existsSync(path)).toBe(true);
  });

  it("clears the quarantine with --force and says so", async () => {
    const root = stateRoot();
    const path = quarantined(root);
    const test = harness({ ok: true, adapter: new FakeAdapter("darwin") }, { stateRoot: root });
    const code = await runCli(["recover", "--json", "--force"], test.deps);

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.cleared).toBe(true);
    expect(envelope.findings?.[0]).toMatchObject({ action: "cleared" });
    expect(existsSync(path)).toBe(false);
  });

  it("changes nothing on a dry run and says so", async () => {
    const root = stateRoot();
    const path = quarantined(root);
    const test = harness({ ok: true, adapter: new FakeAdapter("darwin") }, { stateRoot: root });
    const code = await runCli(["recover", "--json", "--dry-run", "--force"], test.deps);

    expect(code).toBe(EXIT.ok);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.notice).toBe("dry run: nothing was changed");
    expect(envelope.cleared).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("prints its findings in human mode", async () => {
    const root = stateRoot();
    quarantined(root);
    const test = harness({ ok: true, adapter: new FakeAdapter("darwin") }, { stateRoot: root });
    const code = await runCli(["recover"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(test.out()).toContain("ae-a8n recover — ok (exit 0)");
    expect(test.out()).toContain("findings (not cleared):");
    expect(test.out()).toContain("[reported] A8N-JOB-002:");
    expect(test.out()).toContain("next: ");
  });

  it("exits 6 when the state cannot be decided", async () => {
    const root = stateRoot();
    mkdirSync(stateLayout(root).locks, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateLayout(root).locks, `${targetKey("local")}.lock`), "{not json");
    const test = harness({ ok: true, adapter: new FakeAdapter("darwin") }, { stateRoot: root });
    const code = await runCli(["recover", "--json"], test.deps);

    expect(code).toBe(EXIT.unknown);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("unknown");
    expect(envelope.findings?.[0]).toMatchObject({ action: "refused" });
  });

  it("does not accept --force on a command that never clears anything", () => {
    expect(parseArgs(["doctor", "--force"]).ok).toBe(false);
    expect(parseArgs(["recover", "--force"]).ok).toBe(true);
  });
});

const REPORT_RUN_ID = "20261110T120000Z-4f2a8c11";

type StoredVerdict = { readonly id: string; readonly verdict: string; readonly message: string };

function storedRun(
  root: string,
  runId: string,
  verdicts: readonly StoredVerdict[],
  status = "test-failed",
): string {
  const directory = join(stateLayout(root).runs, runId);
  mkdirSync(join(directory, "artifacts"), { recursive: true, mode: 0o700 });
  const report = {
    schemaVersion: "1.0",
    runId,
    status,
    verdicts,
    startedAt: "2026-11-10T12:00:00.000Z",
    finishedAt: "2026-11-10T12:00:05.000Z",
  };
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: "1.0",
      runId,
      command: ["node", "--test"],
      adapter: "fake",
      startedAt: "2026-11-10T12:00:00.000Z",
      finishedAt: "2026-11-10T12:00:05.000Z",
      exitCode: 1,
      timedOut: false,
      stdout: { path: join("artifacts", "stdout.log"), sha256: "ab", bytes: 2 },
      stderr: { path: join("artifacts", "stderr.log"), sha256: "cd", bytes: 0 },
    })}\n`,
  );
  return directory;
}

const unsupported = (): AdapterSelection => ({
  ok: false,
  platform: "unknown",
  check: unsupportedPlatformCheck("unknown"),
});

describe("the report command", () => {
  it("prints one envelope and never asks for an adapter", async () => {
    const root = stateRoot();
    const directory = storedRun(root, REPORT_RUN_ID, [
      { id: "command", verdict: "fail", message: "the command exited 1" },
    ]);
    let selected = 0;
    const test = harness(
      () => {
        selected += 1;
        return unsupported();
      },
      { stateRoot: root },
    );

    const code = await runCli(["report", "--json"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(selected).toBe(0);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.command).toBe("report");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.runId).toBe(REPORT_RUN_ID);
    expect(envelope.report?.status).toBe("test-failed");
    expect(envelope.verdicts).toEqual([
      { id: "command", verdict: "fail", message: "the command exited 1" },
    ]);
    expect(envelope.artifacts?.report).toBe(join(directory, "report.json"));
    expect(envelope.artifacts?.files).toEqual([
      join("artifacts", "stdout.log"),
      join("artifacts", "stderr.log"),
    ]);
  });

  it("summarises the run in human form", async () => {
    const root = stateRoot();
    storedRun(root, REPORT_RUN_ID, [
      { id: "build", verdict: "pass", message: "built" },
      { id: "command", verdict: "fail", message: "the command exited 1" },
    ]);
    const test = harness(unsupported(), { stateRoot: root });

    const code = await runCli(["report"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(test.out()).toContain(`ae-a8n report — run ${REPORT_RUN_ID} — test-failed`);
    expect(test.out()).toContain("command:   node --test");
    expect(test.out()).toContain("exit code: 1");
    expect(test.out()).toContain("[pass] build: built");
    expect(test.out()).toContain("[fail] command: the command exited 1");
  });

  it("prints the stored document unchanged for --format json", async () => {
    const root = stateRoot();
    const directory = storedRun(root, REPORT_RUN_ID, [
      { id: "command", verdict: "fail", message: "the command exited 1" },
    ]);
    const stored = readFileSync(join(directory, "report.json"), "utf-8");
    const test = harness(unsupported(), { stateRoot: root });

    const code = await runCli(["report", "--format", "json"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(test.out()).toBe(stored);
  });

  it("maps verdicts to JUnit and never reports an indeterminate run as a pass", async () => {
    const root = stateRoot();
    storedRun(root, REPORT_RUN_ID, [
      { id: "build", verdict: "pass", message: "built" },
      { id: "command", verdict: "fail", message: "the command exited 1" },
      { id: "session", verdict: "unknown", message: "the call timed out <no reply>" },
    ]);
    const test = harness(unsupported(), { stateRoot: root });

    const code = await runCli(["report", "--format", "junit"], test.deps);

    expect(code).toBe(EXIT.ok);
    const xml = test.out();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('tests="3" failures="1" errors="1"');
    expect(xml).toContain('<testcase classname="ae-a8n" name="build"/>');
    expect(xml).toContain('<failure message="the command exited 1">');
    expect(xml).toContain('<error message="the call timed out &lt;no reply&gt;">');
  });

  it("exits 1 on a missing run and keeps stdout empty", async () => {
    const root = stateRoot();
    const test = harness(unsupported(), { stateRoot: root });

    const code = await runCli(["report"], test.deps);

    expect(code).toBe(EXIT.failed);
    expect(test.out()).toBe("");
    expect(test.err()).toContain("no run");
  });

  it("exits 1 with exactly one JSON document when --json was asked for", async () => {
    const root = stateRoot();
    const test = harness(unsupported(), { stateRoot: root });

    const code = await runCli(["report", "--json", "--run", REPORT_RUN_ID], test.deps);

    expect(code).toBe(EXIT.failed);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("failed");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.runId).toBe(REPORT_RUN_ID);
    expect(envelope.notice).toContain("Nothing is being reported as a success");
  });

  it("refuses --json together with --format", () => {
    expect(parseArgs(["report", "--json", "--format", "junit"]).ok).toBe(false);
    expect(parseArgs(["report", "--format", "junit"]).ok).toBe(true);
    expect(parseArgs(["report", "--json"]).ok).toBe(true);
  });

  it("refuses a run id that is not one", () => {
    expect(parseArgs(["report", "--run", "../../etc"]).ok).toBe(false);
    expect(parseArgs(["recover", "--run", "../../etc"]).ok).toBe(false);
    expect(parseArgs(["report", "--run", REPORT_RUN_ID]).ok).toBe(true);
  });
});
