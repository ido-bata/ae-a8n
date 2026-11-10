import { describe, expect, it } from "vitest";

import {
  PROBE_COMMANDS,
  parseCsvLine,
  parseInstallListing,
  parseTasklistCsv,
  probeWindows,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";

const CAPTION = "Microsoft Windows 11 Home Insider Preview";
const VERSION = "10.0.29704";
const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";

type HostFacts = {
  readonly os?: string;
  readonly sessionId?: string;
  readonly currentUser?: string;
  readonly consoleUser?: string;
  readonly installs?: string;
  readonly processes?: string;
  readonly targetUserExitCode?: number;
};

const BASE: Required<HostFacts> = {
  os: `${CAPTION}|${VERSION}`,
  sessionId: "1",
  currentUser: "HOST\\tester",
  consoleUser: "HOST\\tester",
  installs: `${INSTALL}|26.5.0`,
  processes: "INFO: No tasks are running which match the specified criteria.\r\n",
  targetUserExitCode: 0,
};

/** Answers each probe command from a table; records what was asked. */
function fakeRunner(overrides: HostFacts = {}): CommandRunner & {
  readonly commands: ProbeCommand[];
} {
  const facts = { ...BASE, ...overrides };
  const commands: ProbeCommand[] = [];
  return {
    commands,
    run(command: ProbeCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      commands.push(command);
      if (command.program === "tasklist.exe") {
        return Promise.resolve({ stdout: facts.processes, stderr: "", exitCode: 0 });
      }
      if (command.program === "net.exe") {
        return Promise.resolve({
          stdout: facts.targetUserExitCode === 0 ? "The command completed successfully." : "",
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

describe("tasklist output", () => {
  it("reads pid and session, and keeps commas inside quoted fields", () => {
    const stdout =
      "\"AfterFX.exe\",\"8028\",\"Console\",\"1\",\"1,234 K\"\r\n" +
      "\"AfterFX.exe\",\"9001\",\"Services\",\"0\",\"2,000 K\"\r\n";
    expect(parseTasklistCsv(stdout)).toEqual([
      { pid: 8028, sessionId: 1 },
      { pid: 9001, sessionId: 0 },
    ]);
  });

  it("treats the no-match line as no processes", () => {
    expect(
      parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n"),
    ).toEqual([]);
  });

  it("splits quoted fields", () => {
    expect(parseCsvLine('"a,b","c""d",e')).toEqual(["a,b", 'c"d', "e"]);
  });
});

describe("uninstall registry output", () => {
  it("reads location and version", () => {
    expect(parseInstallListing(`${INSTALL}|26.5.0\r\n`)).toEqual([
      { location: INSTALL, version: "26.5.0" },
    ]);
  });

  it("reports a missing version as null", () => {
    expect(parseInstallListing(`${INSTALL}|\r\n`)).toEqual([{ location: INSTALL, version: null }]);
  });

  it("collapses the same entry registered twice with different case", () => {
    const stdout = `${INSTALL}|26.5\r\n${INSTALL.toLowerCase()}|26.5\r\n`;
    expect(parseInstallListing(stdout)).toEqual([{ location: INSTALL, version: "26.5" }]);
  });
});

describe("probeWindows", () => {
  it("reports no checks on a clean dedicated host", async () => {
    const result = await probeWindows(fakeRunner(), {
      isolation: "remote-host",
      targetUser: "tester",
    });
    expect(result.checks).toEqual([]);
    expect(result.facts).toMatchObject({
      osCaption: CAPTION,
      osVersion: VERSION,
      sessionId: 1,
      currentUser: "HOST\\tester",
      consoleUser: "HOST\\tester",
      targetUserExists: true,
      aeInstalls: [{ location: INSTALL, version: "26.5.0" }],
      aeProcesses: [],
    });
    expect(result.capabilities).toEqual({
      nonInterference: "by-construction",
      provesOwnership: true,
      provesDestination: true,
      guiRecovery: false,
      sessionIdentity: "host-and-user",
    });
  });

  it("refuses when After Effects is already running", async () => {
    const runner = fakeRunner({
      processes: '"AfterFX.exe","8028","Console","1","1,234 K"\r\n',
    });
    const result = await probeWindows(runner, { isolation: "remote-host", targetUser: null });
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("A8N-AE-001");
    expect(result.checks.find((check) => check.code === "A8N-AE-001")).toMatchObject({
      severity: "blocker",
      detail: "After Effects is already running: pid 8028 (session 1)",
    });
    expect(result.facts.aeProcesses).toEqual([{ pid: 8028, sessionId: 1 }]);
  });

  it("reports session 0 as no interactive desktop", async () => {
    const result = await probeWindows(fakeRunner({ sessionId: "0" }), {
      isolation: "remote-host",
      targetUser: null,
    });
    expect(result.checks.map((check) => check.code)).toContain("A8N-SESSION-002");
  });

  it("treats an unreadable session id as missing, not as zero", async () => {
    const result = await probeWindows(fakeRunner({ sessionId: "" }), {
      isolation: "remote-host",
      targetUser: null,
    });
    expect(result.facts.sessionId).toBeNull();
    expect(result.checks.map((check) => check.code)).toContain("A8N-SESSION-002");
  });

  it("reports the console user as the target only in session isolation", async () => {
    const session = await probeWindows(fakeRunner(), {
      isolation: "session",
      targetUser: null,
    });
    expect(session.capabilities.nonInterference).toBe("unproven");
    expect(session.checks.map((check) => check.code)).toContain("A8N-SESSION-003");

    const remote = await probeWindows(fakeRunner(), {
      isolation: "remote-host",
      targetUser: null,
    });
    expect(remote.checks.map((check) => check.code)).not.toContain("A8N-SESSION-003");
  });

  it("does not fire the console check when the console owner is signed out", async () => {
    const result = await probeWindows(fakeRunner({ consoleUser: "" }), {
      isolation: "session",
      targetUser: null,
    });
    expect(result.facts.consoleUser).toBeNull();
    expect(result.checks.map((check) => check.code)).not.toContain("A8N-SESSION-003");
  });

  it("reports a missing and an ambiguous After Effects installation", async () => {
    const missing = await probeWindows(fakeRunner({ installs: "" }), {
      isolation: "remote-host",
      targetUser: null,
    });
    expect(missing.checks.map((check) => check.code)).toContain("A8N-ENV-003");

    const twice = await probeWindows(
      fakeRunner({ installs: `${INSTALL}|26.5.0\r\nE:\\Adobe\\After Effects 2025|25.6\r\n` }),
      { isolation: "remote-host", targetUser: null },
    );
    const check = twice.checks.find((entry) => entry.code === "A8N-ENV-004");
    expect(check).toMatchObject({ severity: "warning" });
    expect(check?.detail).toContain("found 2 installation locations");
  });

  it("treats two versions under one Adobe root as one installation", async () => {
    const result = await probeWindows(
      fakeRunner({ installs: `${INSTALL}|26.0\r\n${INSTALL}|26.5\r\n` }),
      { isolation: "remote-host", targetUser: null },
    );
    expect(result.facts.aeInstalls).toHaveLength(2);
    expect(result.checks.map((check) => check.code)).not.toContain("A8N-ENV-004");
  });

  it("reports a target account that does not exist", async () => {
    const result = await probeWindows(fakeRunner({ targetUserExitCode: 2 }), {
      isolation: "remote-host",
      targetUser: "missing",
    });
    expect(result.facts.targetUserExists).toBe(false);
    expect(result.checks.map((check) => check.code)).toContain("A8N-SESSION-001");
  });

  it("treats an unreadable account query as unknown, not as absent", async () => {
    const result = await probeWindows(fakeRunner({ targetUserExitCode: 5 }), {
      isolation: "remote-host",
      targetUser: "tester",
    });
    expect(result.facts.targetUserExists).toBeNull();
    expect(result.checks.map((check) => check.code)).not.toContain("A8N-SESSION-001");
  });

  it("reports unsupported output as an unsupported host", async () => {
    const result = await probeWindows(fakeRunner({ os: "" }), {
      isolation: "remote-host",
      targetUser: null,
    });
    expect(result.facts.osCaption).toBeNull();
    expect(result.checks.map((check) => check.code)).toContain("A8N-ENV-001");
  });

  it("quotes the raw output as evidence for every conclusion", async () => {
    const result = await probeWindows(fakeRunner({ sessionId: "0" }), {
      isolation: "remote-host",
      targetUser: "tester",
    });
    const session = result.checks.find((check) => check.code === "A8N-SESSION-002");
    expect(session?.evidence).toEqual({ sessionId: 0 });
    expect(result.facts.evidence.os).toBe(`${CAPTION}|${VERSION}`);
    expect(result.facts.evidence.sessionId).toBe("0");
    expect(result.facts.evidence.targetUser).toContain("completed successfully");
  });

  it("issues only read-only commands", async () => {
    const runner = fakeRunner();
    await probeWindows(runner, { isolation: "remote-host", targetUser: "tester" });
    const allowed = new Set(["powershell.exe", "tasklist.exe", "net.exe"]);
    const forbidden = [/taskkill/i, /shutdown/i, /stop-process/i, /remove-/i, /start-process/i];
    for (const command of runner.commands) {
      expect(allowed.has(command.program)).toBe(true);
      const line = [command.program, ...command.args].join(" ");
      for (const pattern of forbidden) {
        expect(line).not.toMatch(pattern);
      }
    }
    expect(runner.commands).toHaveLength(7);
  });
});
