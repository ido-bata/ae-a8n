import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

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
import { selectAdapter, writerFor } from "../src/platform/select.js";

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
    aeScripting: {
      state: "allowed",
      prefsDir: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5",
      prefValue: "1",
    },
    aeScriptingComponent: {
      state: "present",
      found: [
        "/Applications/Adobe After Effects 2026/Plug-ins/Keyframe/Scripting.plugin",
      ],
      checked: [
        "/Applications/Adobe After Effects 2026/Plug-ins/Keyframe/Scripting.plugin",
        "/Applications/Adobe After Effects 2026.app/Contents/Frameworks/extendscript.framework",
        "/Applications/Adobe After Effects 2026.app/Contents/Frameworks/dvascripting.framework",
      ],
    },
    aeStartupFolder: {
      state: "present",
      path: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5/Scripts/Startup",
    },
    tccPermissions: {
      screenRecording: { state: "granted", detail: null },
      accessibility: { state: "granted", detail: null },
      mechanism: "preflight",
    },
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
  it("reports no blockers for a readable, dedicated account", () => {
    const result = probe(darwinFacts());
    // The script-invocation prerequisites that a read-only probe cannot prove
    // are still reported — as warnings/info, never as guessed success.
    expect(result.checks.map((check) => check.code).sort()).toEqual([
      "A8N-AE-007",
      "A8N-AE-008",
      "A8N-PERM-008",
    ]);
    expect(result.checks.every((check) => check.severity !== "blocker")).toBe(true);
    expect(result.capabilities).toEqual({
      // The read-only probe did not measure non-interference; the runner owns
      // that proof, so this must not be "proven" here.
      nonInterference: "unproven",
      provesOwnership: false,
      provesDestination: false,
      guiRecovery: false,
      sessionIdentity: "uid-asid",
      quitsOnlyOwned: true,
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

  it("reports AE script file/network permission off as a blocker", () => {
    const check = checkFor(
      darwinFacts({
        aeScripting: {
          state: "blocked",
          prefsDir: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5",
          prefValue: "0",
        },
      }),
      "A8N-PERM-003",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("Pref_SCRIPTING_FILE_NETWORK_SECURITY");
    expect(check?.evidence).toMatchObject({ prefValue: "0" });
  });

  it("does not report the scripting permission when allowed, unreadable or unevaluated", () => {
    for (const aeScripting of [
      {
        state: "allowed" as const,
        prefsDir: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5",
        prefValue: "1",
      },
      {
        state: "unreadable" as const,
        prefsDir: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5",
        prefValue: null,
      },
      null,
    ]) {
      expect(checkFor(darwinFacts({ aeScripting }), "A8N-PERM-003")).toBeUndefined();
    }
  });

  it("reports an undeterminable script permission as unproven, not blocked", () => {
    for (const aeScripting of [
      null,
      {
        state: "unreadable" as const,
        prefsDir: "/Users/ae-test/Library/Preferences/Adobe/After Effects/26.5",
        prefValue: null,
      },
    ]) {
      const check = checkFor(darwinFacts({ aeScripting }), "A8N-PERM-007");
      expect(check).toMatchObject({ severity: "warning" });
      expect(check?.detail).toContain("unproven");
      expect(checkFor(darwinFacts({ aeScripting }), "A8N-PERM-003")).toBeUndefined();
    }
  });

  it("reports script-trust approval as unproven with its granularity unmeasured", () => {
    const check = checkFor(darwinFacts(), "A8N-PERM-008");
    expect(check).toMatchObject({ severity: "warning" });
    expect(check?.evidence).toMatchObject({
      state: "unproven",
      approvalGranularity: "unproven",
    });
    expect(check?.detail).toContain("unproven");
  });

  it("reports a measured TCC denial as a blocker, per permission", () => {
    const denied = {
      screenRecording: { state: "denied" as const, detail: null },
      accessibility: { state: "granted" as const, detail: null },
      mechanism: "preflight" as const,
    };
    const screen = checkFor(darwinFacts({ tccPermissions: denied }), "A8N-PERM-001");
    expect(screen).toMatchObject({ severity: "blocker" });
    expect(screen?.detail).toContain("Screen Recording");
    expect(screen?.evidence).toMatchObject({ mechanism: "preflight" });
    expect(checkFor(darwinFacts({ tccPermissions: denied }), "A8N-PERM-002")).toBeUndefined();

    const ax = checkFor(
      darwinFacts({
        tccPermissions: {
          screenRecording: { state: "granted", detail: null },
          accessibility: { state: "denied", detail: null },
          mechanism: "preflight",
        },
      }),
      "A8N-PERM-002",
    );
    expect(ax).toMatchObject({ severity: "blocker" });
    expect(ax?.detail).toContain("Accessibility");
  });

  it("reports an unmeasured TCC state as a warning, never a pass or a blocker", () => {
    const unproven = {
      screenRecording: {
        state: "unproven" as const,
        detail: "the target account's TCC grants can only be probed inside its own session",
      },
      accessibility: {
        state: "unproven" as const,
        detail: "the target account's TCC grants can only be probed inside its own session",
      },
      mechanism: "deferred" as const,
    };
    const result = probe(darwinFacts({ tccPermissions: unproven }));
    const check = result.checks.find((entry) => entry.code === "A8N-PERM-009");
    expect(check).toMatchObject({ severity: "warning" });
    expect(check?.detail).toContain("Screen Recording");
    expect(check?.detail).toContain("Accessibility");
    expect(check?.evidence).toMatchObject({ mechanism: "deferred" });
    expect(result.checks.map((entry) => entry.code)).not.toContain("A8N-PERM-001");
    expect(result.checks.map((entry) => entry.code)).not.toContain("A8N-PERM-002");
    expect(aggregateDiagnosticStatus(result.checks)).toBe("ok");
  });

  it("reports a missing scripting component as a blocker", () => {
    const check = checkFor(
      darwinFacts({
        aeScriptingComponent: { state: "absent", found: [], checked: ["/x", "/y"] },
      }),
      "A8N-AE-006",
    );
    expect(check).toMatchObject({ severity: "blocker" });
    expect(check?.detail).toContain("component");
  });

  it("never treats component presence as proof it loads", () => {
    const present = checkFor(darwinFacts(), "A8N-AE-007");
    expect(present).toMatchObject({ severity: "warning" });
    expect(present?.detail).toContain("does not prove");

    const unreadable = checkFor(
      darwinFacts({
        aeScriptingComponent: { state: "unproven", found: [], checked: ["/x"] },
      }),
      "A8N-AE-007",
    );
    expect(unreadable).toMatchObject({ severity: "warning" });
    expect(unreadable?.detail).toContain("unproven");
  });

  it("reports the per-user startup folder state without claiming execution", () => {
    const present = checkFor(darwinFacts(), "A8N-AE-008");
    expect(present).toMatchObject({ severity: "info" });
    expect(present?.detail).toContain("present");

    const absent = checkFor(
      darwinFacts({
        aeStartupFolder: { state: "absent", path: "/x/Scripts/Startup" },
      }),
      "A8N-AE-008",
    );
    expect(absent?.detail).toContain("absent");
    expect(absent?.detail).toContain("unverified");
  });

  it("skips the script-invocation checks when no install resolved", () => {
    const result = probe(darwinFacts({ aeInstalls: [] }));
    const codes = result.checks.map((check) => check.code);
    for (const code of ["A8N-PERM-007", "A8N-PERM-008", "A8N-AE-006", "A8N-AE-007", "A8N-AE-008"]) {
      expect(codes).not.toContain(code);
    }
  });

  it("local intent drops session checks and reports a running AE as info", () => {
    const running = {
      aeProcesses: [
        {
          pid: 4242,
          uid: 501,
          name: "/Applications/Adobe After Effects 2026/After Effects",
        },
      ],
      evidence: {
        ...EVIDENCE,
        aeProcesses: "4242|501|/Applications/Adobe After Effects 2026/After Effects",
      },
    };
    const local = probeDarwin(
      darwinFacts({
        ...running,
        targetUser: "rebui",
        targetUid: 501,
        consoleUid: 501,
        guiSession: { uid: 501, username: "rebui", asid: 100021, kind: "Aqua" },
      }),
      "local",
    );
    const codes = local.checks.map((check) => check.code);
    expect(codes).not.toContain("A8N-SESSION-003");
    expect(codes).not.toContain("A8N-AE-001");
    expect(codes).toContain("A8N-AE-009");
    expect(local.checks.find((check) => check.code === "A8N-AE-009")).toMatchObject({
      severity: "info",
    });

    const session = probeDarwin(
      darwinFacts({
        ...running,
        targetUser: "rebui",
        targetUid: 501,
        consoleUid: 501,
        guiSession: { uid: 501, username: "rebui", asid: 100021, kind: "Aqua" },
      }),
      "session",
    );
    const sessionCodes = session.checks.map((check) => check.code);
    expect(sessionCodes).toContain("A8N-SESSION-003");
    expect(sessionCodes).toContain("A8N-AE-001");
    expect(sessionCodes).not.toContain("A8N-AE-009");
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

  it("runs the TCC preflight probe only for the local intent", () => {
    const commands: string[] = [];
    const exec: DarwinExec = (program, args) => {
      commands.push([program, ...args].join(" "));
      if (program.includes("python3")) {
        return { status: 0, stdout: "screen=1\nax=0\n", stderr: "" };
      }
      switch (program) {
        case "sw_vers":
          return { status: 0, stdout: "26.1\n", stderr: "" };
        case "uname":
          return { status: 0, stdout: "arm64\n", stderr: "" };
        case "id":
          return { status: 0, stdout: "502\n", stderr: "" };
        case "ps":
          return { status: 0, stdout: "", stderr: "" };
        default:
          return { status: 127, stdout: "", stderr: "not found" };
      }
    };

    const local = readDarwinFacts(null, exec, "local");
    expect(local.tccPermissions.mechanism).toBe("preflight");
    expect(local.tccPermissions.screenRecording.state).toBe("granted");
    expect(local.tccPermissions.accessibility.state).toBe("denied");
    expect(commands.some((command) => command.includes("python3"))).toBe(true);

    commands.length = 0;
    const session = readDarwinFacts(null, exec, "session");
    expect(session.tccPermissions.mechanism).toBe("deferred");
    expect(session.tccPermissions.screenRecording.state).toBe("unproven");
    expect(session.tccPermissions.accessibility.state).toBe("unproven");
    expect(commands.some((command) => command.includes("python3"))).toBe(false);
  });

  it("leaves TCC unproven when the probe cannot run or answer", () => {
    const exec: DarwinExec = (program) => {
      if (program.includes("python3")) {
        return { status: 1, stdout: "", stderr: "no such interpreter" };
      }
      return { status: 127, stdout: "", stderr: "not found" };
    };
    const facts = readDarwinFacts(null, exec, "local");
    expect(facts.tccPermissions.mechanism).toBe("unavailable");
    expect(facts.tccPermissions.screenRecording.state).toBe("unproven");
    expect(facts.tccPermissions.accessibility.state).toBe("unproven");
    expect(facts.tccPermissions.screenRecording.detail).toContain("no such interpreter");

    const silent: DarwinExec = (program) =>
      program.includes("python3")
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 127, stdout: "", stderr: "not found" };
    const unanswered = readDarwinFacts(null, silent, "local");
    expect(unanswered.tccPermissions.mechanism).toBe("preflight");
    expect(unanswered.tccPermissions.screenRecording.state).toBe("unproven");
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

  it("plans the account, session and permissions, and never claims a human step", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-mac-setup-"));
    const stateFile = join(root, "state.json");
    try {
      const adapter = new DarwinAdapter({
        // `null` is the honest state for another account's prefs: unreadable,
        // so the scripting step stays a human step.
        readFacts: () => darwinFacts({ aeScripting: null }),
        setupStateFile: stateFile,
        // A path that does not exist keeps the shared-root finding out of
        // this test regardless of what the host machine has under /Users/Shared.
        sharedSessionRoot: join(root, "shared"),
      });
      const steps = await adapter.plan(TARGET);
      const byId = new Map(steps.map((step) => [step.id, step]));
      expect(byId.get("macos.target-user")?.state).toBe("done");
      expect(byId.get("macos.session")?.state).toBe("done");
      expect(byId.get("macos.console-separation")?.state).toBe("done");
      expect(byId.get("macos.ae")?.state).toBe("done");
      for (const id of [
        "macos.screen-recording",
        "macos.accessibility",
        "macos.automation-system-events",
        "macos.ae-scripting",
        "macos.signin",
      ]) {
        expect(byId.get(id)?.state).toBe("needs-human");
      }
      expect(steps.every((step) => step.automatable === false)).toBe(true);

      const dryRun = await adapter.apply(steps, { yes: false, dryRun: true });
      expect(dryRun.stateFile).toBe(stateFile);
      expect(dryRun.outcomes.every((outcome) => outcome.detail.includes("dry run"))).toBe(true);
      expect(() => readFileSync(stateFile, "utf-8")).toThrow();

      const applied = await adapter.apply(steps, { yes: true, dryRun: false });
      const done = applied.outcomes
        .filter((outcome) => outcome.state === "done")
        .map((outcome) => outcome.id)
        .sort();
      expect(done).toEqual(
        ["macos.ae", "macos.console-separation", "macos.session", "macos.target-user"],
      );
      expect(applied.outcomes.some((outcome) => outcome.state === "failed")).toBe(false);
      const stored = JSON.parse(readFileSync(stateFile, "utf-8")) as {
        schemaVersion: string;
        completed: readonly string[];
      };
      expect(stored).toMatchObject({ schemaVersion: "1.0" });
      expect([...stored.completed].sort()).toEqual(done);

      // Idempotent: the second run performs no destructive action and skips
      // what the state file records.
      const again = await adapter.apply(steps, { yes: true, dryRun: false });
      expect(
        again.outcomes
          .filter((outcome) => outcome.state === "skipped")
          .map((outcome) => outcome.id)
          .sort(),
      ).toEqual(done);
      expect(
        again.outcomes
          .filter((outcome) => outcome.state === "needs-human")
          .map((outcome) => outcome.id)
          .sort(),
      ).toEqual([
        "macos.accessibility",
        "macos.ae-scripting",
        "macos.automation-system-events",
        "macos.screen-recording",
        "macos.signin",
      ]);

      const findings = await adapter.recover("/tmp/a8n-run-does-not-exist");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe("A8N-JOB-002");
      // Recovery reports what it can see and acts on nothing: an
      // unlistable run directory is reported, never guessed at.
      expect(findings[0]?.detail).toContain("could not be listed");

      // A real directory with a leftover entry and a running After Effects
      // is reported with both facts — and nothing is removed or signalled.
      const runDir = join(root, "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "stray.tmp"), "x");
      const withAe = new DarwinAdapter({
        readFacts: () =>
          darwinFacts({
            aeScripting: null,
            aeProcesses: [{ pid: 4321, uid: 502, name: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects" }],
          }),
        setupStateFile: stateFile,
        sharedSessionRoot: join(root, "shared"),
      });
      const seen = await withAe.recover(runDir);
      expect(seen.some((f) => f.detail.includes("stray.tmp"))).toBe(true);
      expect(seen.some((f) => f.detail.includes("pid 4321 uid 502"))).toBe(true);
      expect(existsSync(join(runDir, "stray.tmp"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks the scripting step done only when the preference was read as allowed", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-mac-setup-"));
    try {
      const adapter = new DarwinAdapter({
        readFacts: () =>
          darwinFacts({
            aeScripting: {
              state: "allowed",
              prefsDir: "/Users/rebui/Library/Preferences/Adobe/After Effects/26.5",
              prefValue: "1",
            },
          }),
        setupStateFile: join(root, "state.json"),
      });
      const steps = await adapter.plan(TARGET);
      const step = steps.find((entry) => entry.id === "macos.ae-scripting");
      expect(step?.state).toBe("done");
      expect(step?.action).toBeNull();

      const blocked = new DarwinAdapter({
        readFacts: () =>
          darwinFacts({
            aeScripting: {
              state: "blocked",
              prefsDir: "/Users/rebui/Library/Preferences/Adobe/After Effects/26.5",
              prefValue: "0",
            },
          }),
        setupStateFile: join(root, "state2.json"),
      });
      const blockedStep = (await blocked.plan(TARGET)).find(
        (entry) => entry.id === "macos.ae-scripting",
      );
      expect(blockedStep?.state).toBe("needs-human");
      expect(blockedStep?.reason).toContain("script file/network access is off");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans human steps when the account is missing or is the console user", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-mac-setup-"));
    try {
      const adapter = new DarwinAdapter({
        readFacts: () =>
          darwinFacts({
            targetUser: "missing",
            targetUid: null,
            targetUserFailure: "The user name could not be found",
            guiSession: null,
            consoleUid: 501,
          }),
        setupStateFile: join(root, "state.json"),
      });
      const steps = await adapter.plan({ ...TARGET, user: "missing" });
      const byId = new Map(steps.map((step) => [step.id, step]));
      expect(byId.get("macos.target-user")?.state).toBe("needs-human");
      expect(byId.get("macos.target-user")?.reason).toContain("could not be resolved");
      expect(byId.get("macos.session")?.state).toBe("needs-human");
      expect(byId.get("macos.console-separation")?.state).toBe("needs-human");

      const consoleAdapter = new DarwinAdapter({
        readFacts: () => darwinFacts({ consoleUid: 502 }),
        setupStateFile: join(root, "state.json"),
      });
      const consoleSteps = await consoleAdapter.plan(TARGET);
      expect(
        consoleSteps.find((step) => step.id === "macos.console-separation")?.state,
      ).toBe("needs-human");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call a session or an installation ready when a fact is unreadable", async () => {
    // `setup` plans before it probes, so these checks are the only gate. An
    // Aqua session whose id could not be read, and a non-Aqua session, must
    // not read as done while `doctor` calls the same machine blocked.
    const root = mkdtempSync(join(tmpdir(), "a8n-mac-setup-"));
    try {
      const plan = async (facts: DarwinFacts) => {
        const adapter = new DarwinAdapter({
          readFacts: () => facts,
          setupStateFile: join(root, "state.json"),
        });
        return new Map((await adapter.plan(TARGET)).map((step) => [step.id, step]));
      };

      const unreadableAsid = await plan(
        darwinFacts({ guiSession: { uid: 502, username: "ae-test", asid: null, kind: "Aqua" } }),
      );
      expect(unreadableAsid.get("macos.session")?.state).toBe("needs-human");
      expect(unreadableAsid.get("macos.session")?.reason).toContain(
        "session id (asid) could not be read",
      );

      const background = await plan(
        darwinFacts({
          guiSession: { uid: 502, username: "ae-test", asid: 100040, kind: "Background" },
        }),
      );
      expect(background.get("macos.session")?.state).toBe("needs-human");
      expect(background.get("macos.session")?.reason).toContain(
        "Background session, not an Aqua GUI session",
      );

      // One installation whose version could not be read is reported as that,
      // not as "more than one version is installed".
      const oneUnreadable = await plan(
        darwinFacts({
          aeInstalls: [
            { location: "/Applications/Adobe After Effects 2026", version: null, selected: false },
          ],
        }),
      );
      expect(oneUnreadable.get("macos.ae")?.state).toBe("needs-human");
      expect(oneUnreadable.get("macos.ae")?.reason).toContain("but its version could not be read");
      expect(oneUnreadable.get("macos.ae")?.reason).not.toContain("more than one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to reset a setup state file it cannot read", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-mac-setup-"));
    const stateFile = join(root, "state.json");
    try {
      writeFileSync(stateFile, "not json", "utf-8");
      const adapter = new DarwinAdapter({
        readFacts: () => darwinFacts(),
        setupStateFile: stateFile,
      });
      const steps = await adapter.plan(TARGET);
      const applied = await adapter.apply(steps, { yes: true, dryRun: false });
      expect(applied.outcomes).toHaveLength(1);
      expect(applied.outcomes[0]).toMatchObject({
        id: "macos.setup-state",
        state: "failed",
      });
      // The unreadable file is left exactly as it was, for a human to inspect.
      expect(readFileSync(stateFile, "utf-8")).toBe("not json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    // No blockers, but the script-invocation prerequisites Windows cannot
    // prove are still reported as unproven — never as a guessed pass.
    expect(envelope.checks.map((check) => check.code).sort()).toEqual([
      "A8N-AE-007",
      "A8N-AE-008",
      "A8N-PERM-008",
    ]);
    expect(envelope.checks.every((check) => check.severity !== "blocker")).toBe(true);
    expect(envelope.capabilities).toMatchObject({
      nonInterference: "by-construction",
      provesOwnership: false,
      // T090's session marker proves which agent ran the job; ownership of
      // the AE process is still unproven on Windows.
      provesDestination: true,
      guiRecovery: false,
      sessionIdentity: "host-and-user",
      quitsOnlyOwned: true,
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

  it("records this machine's own host and account as a local job's writer", () => {
    // A local Windows target has no host configuration to repair an empty
    // writer from, and the agent refuses an anonymous writer (A8N-JOB-001)
    // with a message that blames the channel for a missing identity.
    const local = writerFor({ name: "local", isolation: "session", user: null, host: null });
    expect(local.host).toBe(hostname());
    expect(local.user).toBe(userInfo().username);
    expect(local.user).not.toBe("");

    // A named account still wins, and "" is kept only for a remote target,
    // whose account the host's configuration supplies.
    expect(writerFor({ name: "local", isolation: "session", user: "a8n", host: null })).toEqual({
      host: hostname(),
      user: "a8n",
    });
    expect(
      writerFor({ name: "win", isolation: "remote-host", user: null, host: "WIN-AE-01" }),
    ).toEqual({ host: "WIN-AE-01", user: "" });
  });
});

describe("the in-session and packaged TCC probes cannot drift apart", () => {
  it("run the identical preflight script", async () => {
    const { TCC_PROBE_SCRIPT: packaged } = await import("../src/platform/darwin/tcc.js");
    const { TCC_PROBE_SCRIPT: inSession } = await import(
      "../scripts/isolated-session/permission-probe.mjs"
    );
    // The two measure the same grants for the same responsible process;
    // a change to one without the other would silently measure different
    // things under the same name.
    expect(inSession).toBe(packaged);
  });
});
