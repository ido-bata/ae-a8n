import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("commands not implemented in this increment", () => {
  it("fails setup closed with exit 7 and a notice", async () => {
    const adapter = new FakeAdapter("darwin");
    const test = harness({ ok: true, adapter });
    const code = await runCli(["setup", "--json"], test.deps);

    expect(code).toBe(EXIT.setupIncomplete);
    const envelope = jsonEnvelope(test.out());
    expect(envelope.status).toBe("setup-incomplete");
    expect(envelope.exitCode).toBe(7);
    expect(envelope.notice).toContain("not implemented in this increment");
    expect(adapter.calls).toEqual([]);
  });

  it.each(["recover", "report"] as const)(
    "fails %s closed with exit 3 and a notice",
    async (command) => {
      const adapter = new FakeAdapter("darwin");
      const test = harness({ ok: true, adapter });
      const argv = [command, "--json"];
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
