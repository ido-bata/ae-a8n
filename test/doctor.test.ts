import { describe, expect, it, vi } from "vitest";

import { runCli, type CliDependencies } from "../src/cli/run.js";
import type { CliEnvelope } from "../src/cli/envelope.js";
import { aggregateDiagnosticStatus } from "../src/doctor/diagnostics.js";
import {
  DarwinAdapter,
  NODE_FLOOR_MAJOR,
  parseAeProcesses,
  probeDarwin,
  readDarwinFacts,
  resolveDarwinSession,
  type DarwinExec,
  type DarwinFacts,
} from "../src/platform/darwin/adapter.js";
import {
  UnprovenTargetError,
  type CommandOutcome,
  type TargetSpec,
} from "../src/platform/contract.js";
import {
  PROBE_COMMANDS,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";
import { selectAdapter } from "../src/platform/select.js";

const TARGET: TargetSpec = {
  name: "ae-test",
  isolation: "session",
  user: "ae-test",
  host: null,
};

const EVIDENCE = {
  os: "26.5.0|arm64",
  node: "v24.0.0",
  installs: "/Applications/Adobe After Effects 2026|26.5.0|selected",
  targetUser: "ae-test|502",
  guiSession: "Aqua|100022",
  consoleUid: "501",
  aeProcesses: "none",
} as const;

/** A fully readable, dedicated-account fixture. Override one field per test. */
function darwinFacts(overrides: Partial<DarwinFacts> = {}): DarwinFacts {
  return {
    release: "26.5.0",
    arch: "arm64",
    nodeVersion: "v24.0.0",
    nodeFloorMajor: NODE_FLOOR_MAJOR,
    aeInstalls: [
      {
        location: "/Applications/Adobe After Effects 2026",
        version: "26.5.0",
        selected: true,
      },
    ],
    installLookupFailure: null,
    targetUser: "ae-test",
    targetUid: 502,
    targetUserFailure: null,
    guiSession: { uid: 502, username: "ae-test", asid: 100022, kind: "Aqua" },
    guiSessionFailure: null,
    consoleUid: 501,
    aeProcesses: [],
    aeProcessesReadable: true,
    aeProcessesFailure: null,
    evidence: EVIDENCE,
    ...overrides,
  };
}

function probe(facts: DarwinFacts) {
  return probeDarwin(facts);
}

function checkFor(facts: DarwinFacts, code: string) {
  return probe(facts).checks.find((check) => check.code === code);
}

describe("the macOS probe is honest about what it read", () => {
  it("reports no checks for a readable, dedicated account", () => {
    const result = probe(darwinFacts());
    expect(result.checks).toEqual([]);
    expect(result.capabilities).toEqual({
      // The read-only probe did not measure non-interference; the runner owns
      // that proof, so this must not be "proven" here.
      nonInterference: "unproven",
      provesOwnership: false,
      provesDestination: false,
      guiRecovery: false,
      sessionIdentity: "uid-asid",
    });
  });

  it("reports a target account that does not exist or cannot be resolved", () => {
    const result = probe(
      darwinFacts({
        targetUser: "missing",
        targetUid: null,
        targetUserFailure: "The user name could not be found",
        guiSession: null,
      }),
    );
    const check = result.checks.find((entry) => entry.code === "A8N-SESSION-001");
    expect(check).toMatchObject({ code: "A8N-SESSION-001", severity: "blocker" });
    expect(check?.detail).toContain("could not be resolved");
    expect(check?.evidence).toMatchObject({ targetUser: "missing", uid: null });
  });

  it("reports the console user as the target session", () => {
    const check = checkFor(
      darwinFacts({
        targetUser: "rebui",
        targetUid: 501,
        consoleUid: 501,
        guiSession: { uid: 501, username: "rebui", asid: 100021, kind: "Aqua" },
      }),
      "A8N-SESSION-003",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("console user");
    expect(check?.evidence).toEqual({ targetUid: 501, consoleUid: 501 });
  });

  it("reports no Aqua session as a blocker", () => {
    const check = checkFor(
      darwinFacts({ guiSession: null, guiSessionFailure: null }),
      "A8N-SESSION-002",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("no GUI (Aqua) session");
  });

  it("distinguishes an unreadable session from a logged-out one", () => {
    const check = checkFor(
      darwinFacts({
        guiSession: null,
        guiSessionFailure: "Operation not permitted",
      }),
      "A8N-SESSION-002",
    );
    expect(check?.detail).toContain("could not be read");
    expect(check?.detail).toContain("Operation not permitted");
    expect(check?.detail).not.toContain("has no GUI");
  });

  it("reports a missing After Effects as a blocker", () => {
    const check = checkFor(darwinFacts({ aeInstalls: [] }), "A8N-ENV-003");
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("no After Effects installation");
  });

  it("does not assume After Effects is absent when the folder is unreadable", () => {
    const check = checkFor(
      darwinFacts({
        aeInstalls: [],
        installLookupFailure: "the Applications folder could not be read: EACCES",
      }),
      "A8N-ENV-003",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("could not be read");
    expect(check?.detail).not.toContain("no After Effects installation");
  });

  it("does not assume a version it could not read", () => {
    const check = checkFor(
      darwinFacts({
        aeInstalls: [
          {
            location: "/Applications/Adobe After Effects 2026",
            version: null,
            selected: true,
          },
        ],
      }),
      "A8N-ENV-003",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("version could not be read");
  });

  it("reports another After Effects as a blocker", () => {
    const check = checkFor(
      darwinFacts({
        aeProcesses: [
          {
            pid: 4242,
            uid: 501,
            name: "/Applications/Adobe After Effects 2026/After Effects",
          },
        ],
        evidence: {
          ...EVIDENCE,
          aeProcesses:
            "4242|501|/Applications/Adobe After Effects 2026/After Effects",
        },
      }),
      "A8N-AE-001",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("pid 4242");
  });

  it("never turns unreadable facts into success", () => {
    const result = probe(
      darwinFacts({
        release: null,
        arch: null,
        targetUser: null,
        targetUid: null,
        targetUserFailure: "the current account could not be resolved",
        guiSession: null,
        guiSessionFailure: null,
        consoleUid: null,
        aeInstalls: [],
        aeProcessesReadable: false,
        aeProcessesFailure: "ps: Operation not permitted",
      }),
    );
    const found = result.checks.map((entry) => entry.code);
    expect(found).toEqual(
      expect.arrayContaining([
        "A8N-ENV-001",
        "A8N-ENV-003",
        "A8N-SESSION-001",
        "A8N-SESSION-003",
        "A8N-AE-001",
      ]),
    );
    expect(aggregateDiagnosticStatus(result.checks)).toBe("blocked");
    expect(result.checks.every((entry) => entry.severity === "blocker")).toBe(true);
  });

  it("reports the Node floor", () => {
    const check = checkFor(
      darwinFacts({ nodeVersion: `v${NODE_FLOOR_MAJOR - 1}.0.0` }),
      "A8N-ENV-002",
    );
    expect(check).toMatchObject({ severity: "blocker" });
  });

  it("reports multiple installations as a warning, not a failure", () => {
    const result = probe(
      darwinFacts({
        aeInstalls: [
          {
            location: "/Applications/Adobe After Effects 2026",
            version: "26.5.0",
            selected: true,
          },
          {
            location: "/Applications/Adobe After Effects 2025",
            version: "25.6.0",
            selected: false,
          },
        ],
      }),
    );
    const check = result.checks.find((entry) => entry.code === "A8N-ENV-004");
    expect(check).toMatchObject({ severity: "warning" });
    expect(check?.detail).toContain("found 2 After Effects installation locations");
    expect(aggregateDiagnosticStatus(result.checks)).toBe("ok");
  });

  it("does not mutate the facts it was given", () => {
    const facts = darwinFacts();
    const snapshot = structuredClone(facts);
    probe(facts);
    expect(facts).toEqual(snapshot);
  });

  it("matches the AE executable, not a helper with that text in its path", () => {
    const text =
      "  123  501 /Applications/Adobe After Effects 2026/After Effects\n" +
      "  456  501 /usr/local/bin/After Effects helper\n";
    expect(parseAeProcesses(text)).toEqual([
      {
        pid: 123,
        uid: 501,
        name: "/Applications/Adobe After Effects 2026/After Effects",
      },
    ]);
  });
});

describe("the macOS fact reader", () => {
  it("uses only read-only commands and reports what they returned", () => {
    const commands: string[] = [];
    const exec: DarwinExec = (program, args) => {
      commands.push([program, ...args].join(" "));
      switch (program) {
        case "sw_vers":
          return { status: 0, stdout: "26.1\n", stderr: "" };
        case "uname":
          return { status: 0, stdout: "arm64\n", stderr: "" };
        case "id":
          return { status: 0, stdout: "502\n", stderr: "" };
        case "ps":
          return {
            status: 0,
            stdout:
              "  42  502 /Applications/Adobe After Effects 2026/After Effects\n",
            stderr: "",
          };
        case "plutil":
          return { status: 0, stdout: "26.5.0\n", stderr: "" };
        default:
          return { status: 127, stdout: "", stderr: "not found" };
      }
    };

    const facts = readDarwinFacts("ae-test", exec);
    expect(facts.release).toBe("26.1");
    expect(facts.arch).toBe("arm64");
    expect(facts.targetUser).toBe("ae-test");
    expect(facts.targetUid).toBe(502);
    expect(facts.aeProcessesReadable).toBe(true);
    expect(facts.aeProcesses).toEqual([
      {
        pid: 42,
        uid: 502,
        name: "/Applications/Adobe After Effects 2026/After Effects",
      },
    ]);
    for (const command of commands) {
      expect(command).toMatch(/^(sw_vers|uname|id|ps|plutil)( |$)/);
    }
  });

  it("reports an unreadable process list instead of assuming none", () => {
    const exec: DarwinExec = (program) => {
      switch (program) {
        case "sw_vers":
          return { status: 0, stdout: "26.1\n", stderr: "" };
        case "uname":
          return { status: 0, stdout: "arm64\n", stderr: "" };
        case "id":
          return { status: 0, stdout: "502\n", stderr: "" };
        case "ps":
          return { status: 1, stdout: "", stderr: "ps: Operation not permitted" };
        default:
          return { status: 127, stdout: "", stderr: "not found" };
      }
    };

    const facts = readDarwinFacts("ae-test", exec);
    expect(facts.aeProcessesReadable).toBe(false);
    expect(facts.aeProcesses).toEqual([]);
    expect(facts.aeProcessesFailure).toContain("Operation not permitted");
    expect(probe(facts).checks.map((entry) => entry.code)).toContain("A8N-AE-001");
  });
});

describe("the macOS session identity", () => {
  it("is proven only when the uid, Aqua session, asid and console separation are known", () => {
    expect(resolveDarwinSession(darwinFacts()).identity.proven).toBe(true);

    const console = resolveDarwinSession(
      darwinFacts({
        targetUid: 501,
        consoleUid: 501,
        guiSession: { uid: 501, username: "rebui", asid: 100021, kind: "Aqua" },
      }),
    );
    expect(console.identity.proven).toBe(false);

    const loggedOut = resolveDarwinSession(
      darwinFacts({ guiSession: null, guiSessionFailure: null }),
    );
    expect(loggedOut.identity.proven).toBe(false);

    const unknownConsole = resolveDarwinSession(darwinFacts({ consoleUid: null }));
    expect(unknownConsole.identity.proven).toBe(false);
  });
});

describe("the Darwin adapter's non-probe methods do not lie", () => {
  it("refuses run before anything is sent when the identity is unproven", async () => {
    const runCommand = vi.fn(
      (): Promise<CommandOutcome> =>
        Promise.resolve({
          exitCode: 0,
          stdoutPath: "/tmp/out",
          stderrPath: "/tmp/err",
        }),
    );
    const adapter = new DarwinAdapter({
      readFacts: () => darwinFacts({ guiSession: null, guiSessionFailure: null }),
      runCommand,
    });
    const session = await adapter.open(TARGET);

    await expect(
      session.run(["/bin/echo", "hi"], { timeoutMs: 1000, env: {} }),
    ).rejects.toBeInstanceOf(UnprovenTargetError);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("requires open() and then delegates a proven command", async () => {
    const runCommand = vi.fn(
      (): Promise<CommandOutcome> =>
        Promise.resolve({
          exitCode: 7,
          stdoutPath: "/tmp/out",
          stderrPath: "/tmp/err",
        }),
    );
    const adapter = new DarwinAdapter({
      readFacts: () => darwinFacts(),
      runCommand,
    });
    const session = await adapter.open(TARGET);

    await expect(
      session.run(["/bin/echo", "hi"], { timeoutMs: 1000, env: {} }),
    ).rejects.toThrow("not open");
    expect(runCommand).not.toHaveBeenCalled();

    await session.open();
    const outcome = await session.run(["/bin/echo", "hi"], {
      timeoutMs: 1000,
      env: {},
    });
    expect(outcome.exitCode).toBe(7);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("reports setup as needs-human and recovery as uninspected, never as done", async () => {
    const adapter = new DarwinAdapter({ readFacts: () => darwinFacts() });
    const steps = await adapter.plan(TARGET);
    expect(steps.every((step) => step.state === "needs-human")).toBe(true);
    expect(steps.every((step) => step.automatable === false)).toBe(true);

    const dryRun = await adapter.apply(steps, { yes: false, dryRun: true });
    expect(dryRun.outcomes.every((outcome) => outcome.state === "planned")).toBe(true);
    expect(dryRun.stateFile).toContain("not written");

    const applied = await adapter.apply(steps, { yes: true, dryRun: false });
    expect(applied.outcomes.every((outcome) => outcome.state === "needs-human")).toBe(
      true,
    );

    const findings = await adapter.recover("/tmp/a8n-run");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("A8N-JOB-002");
    // The stub must not read as a clean sweep: it says nothing was inspected.
    expect(findings[0]?.detail).toContain("cannot yet inspect");
    expect(findings[0]?.detail).toContain("nothing in /tmp/a8n-run was acted on");
  });
});

const WINDOWS_BASE = {
  os: "Microsoft Windows 11 Pro|10.0.26100",
  sessionId: "1",
  currentUser: "WIN-AE-01\\ae-test",
  consoleUser: "WIN-AE-01\\someone-else",
  installs: "D:\\Adobe\\Adobe After Effects 2026|26.5.0",
  processes: "INFO: No tasks are running which match the specified criteria.\r\n",
  targetUserExitCode: 0,
} as const;

type WindowsFixture = {
  readonly os?: string;
  readonly sessionId?: string;
  readonly currentUser?: string;
  readonly consoleUser?: string;
  readonly installs?: string;
  readonly processes?: string;
  readonly targetUserExitCode?: number;
};

/** The real probe over a fake host: no Windows and no side effects. */
function windowsRunner(overrides: WindowsFixture = {}): CommandRunner {
  const facts = { ...WINDOWS_BASE, ...overrides };
  return {
    run(command: ProbeCommand): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> {
      if (command.program === "tasklist.exe") {
        return Promise.resolve({
          stdout: facts.processes,
          stderr: "",
          exitCode: 0,
        });
      }
      if (command.program === "net.exe") {
        return Promise.resolve({
          stdout:
            facts.targetUserExitCode === 0 ? "The command completed successfully." : "",
          stderr: facts.targetUserExitCode === 0 ? "" : "The user name could not be found.",
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

function cliDeps(runner: CommandRunner, output: { value: string }): CliDependencies {
  return {
    select: (options) => selectAdapter({ ...options, probeRunner: runner }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    writeOut: (text) => {
      output.value += text;
    },
    writeErr: () => undefined,
    env: {},
  };
}

describe("doctor on a Windows host, through the same CLI", () => {
  it("selects the Windows adapter for --host and reports a clean host as ok", async () => {
    const output = { value: "" };
    const code = await runCli(
      ["doctor", "--host", "WIN-AE-01", "--json"],
      cliDeps(windowsRunner(), output),
    );

    expect(code).toBe(0);
    const envelope = JSON.parse(output.value) as CliEnvelope;
    expect(envelope.status).toBe("ok");
    expect(envelope.platform.os).toBe("win32");
    expect(envelope.platform.backend).toBe("windows-remote-host");
    expect(envelope.target).toEqual({
      name: "WIN-AE-01",
      isolation: "remote-host",
    });
    expect(envelope.checks).toEqual([]);
    expect(envelope.capabilities).toMatchObject({
      nonInterference: "by-construction",
      provesOwnership: false,
      // T090's session marker proves which agent ran the job; ownership of
      // the AE process is still unproven on Windows.
      provesDestination: true,
      guiRecovery: false,
      sessionIdentity: "host-and-user",
    });
  });

  it("turns a probe that cannot run into blockers, not an assumed pass", async () => {
    const output = { value: "" };
    const unavailable: CommandRunner = {
      run: () =>
        Promise.resolve({ stdout: "", stderr: "not found", exitCode: 127 }),
    };
    const code = await runCli(
      ["doctor", "--host", "WIN-AE-01", "--json"],
      cliDeps(unavailable, output),
    );

    expect(code).toBe(3);
    const envelope = JSON.parse(output.value) as CliEnvelope;
    expect(envelope.status).toBe("blocked");
    const found = envelope.checks.map((check) => check.code);
    expect(found).toEqual(
      expect.arrayContaining([
        "A8N-ENV-001",
        "A8N-ENV-003",
        "A8N-SESSION-002",
      ]),
    );
    expect(envelope.checks.every((check) => check.severity === "blocker")).toBe(
      true,
    );
  });

  it("selects the Windows backend for any named host, on this platform", () => {
    const selection = selectAdapter({
      target: {
        name: "win",
        isolation: "remote-host",
        user: null,
        host: "WIN-AE-01",
      },
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.adapter.platform).toBe("win32");
      expect(selection.adapter.id).toBe("windows-remote-host");
    }
  });
});
