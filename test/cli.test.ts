import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli/args.js";
import type { CliEnvelope } from "../src/cli/envelope.js";
import { EXIT } from "../src/cli/exit-code.js";
import { runCli, type CliDependencies } from "../src/cli/run.js";
import { diagnostic } from "../src/doctor/diagnostics.js";
import { FakeAdapter, FAKE_CAPABILITIES } from "../src/platform/fake-adapter.js";
import type { AdapterSelection, SelectOptions } from "../src/platform/select.js";
import { unsupportedPlatformCheck } from "../src/platform/select.js";
import type {
  AdapterProbe,
  Capabilities,
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

  it("treats an adapter outcome the plan omits as a failure, never a silent pass", async () => {
    const adapter = new SetupAdapter([DONE_STEP, HUMAN_STEP], () =>
      Promise.resolve({ stateFile: "/tmp/state.json", outcomes: [] }),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.setupIncomplete);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("setup-incomplete");
    expect(envelope.steps?.map((step) => step.state)).toEqual(["failed", "failed"]);
    expect(envelope.steps?.[0]?.detail).toContain("reported no outcome");
  });

  it("keeps an outcome the plan does not describe visible in the report", async () => {
    const adapter = new SetupAdapter([DONE_STEP], () =>
      Promise.resolve({
        stateFile: "/tmp/state.json",
        outcomes: [
          { id: "macos.ae", state: "done", detail: "already installed" },
          { id: "macos.setup-state", state: "failed", detail: "the state file is unreadable" },
        ],
      }),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.setupIncomplete);
    const envelope = jsonEnvelope(test.out());
    const refusal = envelope.steps?.find((step) => step.id === "macos.setup-state");
    expect(refusal).toMatchObject({ state: "failed", detail: "the state file is unreadable" });
  });

  it("passes --yes and --dry-run through and reports planned steps on a dry run", async () => {
    const adapter = new SetupAdapter([HUMAN_STEP], (steps, options) =>
      Promise.resolve({
        stateFile: "/tmp/state.json",
        outcomes: steps.map((step) => ({
          id: step.id,
          state: options.dryRun ? "planned" : "done",
          detail: "not changed",
        })),
      }),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json", "--yes", "--dry-run"], test.deps);

    expect(code).toBe(EXIT.ok);
    expect(adapter.applies).toEqual([{ yes: true, dryRun: true }]);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("ok");
    expect(envelope.steps?.[0]?.state).toBe("planned");
    expect(envelope.notice).toContain("dry run");
  });

  it("exits 1 and claims nothing when apply throws", async () => {
    const adapter = new SetupAdapter([DONE_STEP], () =>
      Promise.reject(new Error("the state file could not be written")),
    );
    const test = harness({ ok: true, adapter });

    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.failed);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("failed");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.notice).toContain("could not finish");
    expect(envelope.notice).toContain("No step is being reported as done");
    expect(envelope.steps).toBeUndefined();
  });

  it("exits 3 when the platform cannot be selected, before plan or apply", async () => {
    const test = harness({
      ok: false,
      platform: "unknown",
      check: unsupportedPlatformCheck("unknown"),
    });

    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.blocked);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("blocked");
    expect(envelope.checks).toHaveLength(1);
    expect(envelope.steps).toBeUndefined();
  });

  it("prints the steps and the state file in the human output", async () => {
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

    const code = await runCli(["setup"], test.deps);

    expect(code).toBe(EXIT.setupIncomplete);
    const text = test.out();
    expect(text).toContain("ae-a8n setup — setup-incomplete (exit 7)");
    expect(text).toContain("[done] macos.ae");
    expect(text).toContain("[needs-human] macos.signin");
    expect(text).toContain("action (human): Sign in to Creative Cloud");
    expect(text).toContain("state file: /tmp/state.json");
    expect(test.err()).toBe("");
  });
});

describe("commands not implemented in this increment", () => {
  it.each(["test", "recover", "report"] as const)(
    "fails %s closed with exit 3 and a notice",
    async (command) => {
      const adapter = new FakeAdapter("darwin");
      const test = harness({ ok: true, adapter });
      const argv =
        command === "test"
          ? [command, "--json", "--", "node", "test.js"]
          : [command, "--json"];
      const code = await runCli(argv, test.deps);

      expect(code).toBe(EXIT.blocked);
      const envelope = jsonEnvelope(test.out());
      expect(envelope.status).toBe("blocked");
      expect(envelope.exitCode).toBe(3);
      expect(envelope.notice).toContain("not implemented in this increment");
      expect(adapter.calls).toEqual([]);
    },
  );
});
