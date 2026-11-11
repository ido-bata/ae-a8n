/**
 * Windows recovery (T089): detect a blocking state from facts the probe can
 * read, report it with a code and a remedy, and never act.
 *
 * The table covers every observable class: no AE process, a responding
 * process, "Not Responding", an unknown window state, a mixed list, and an
 * unreadable probe. None of these presses a button, sends a key or kills a
 * process.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DirectoryChannel } from "../src/platform/windows/channel.js";
import type { AgentIdentity } from "../src/platform/windows/job.js";
import {
  PROBE_COMMANDS,
  type CommandResult,
  type CommandRunner,
  type ProbeCommand,
} from "../src/platform/windows/probe.js";
import {
  WINDOWS_RECOVERY_COMMAND,
  assessWindowsRecovery,
  interpretWindowsRecoveryResult,
  parseTasklistWindowStates,
} from "../src/platform/windows/recovery.js";
import { WindowsAdapter } from "../src/platform/windows/runner.js";

const AGENT: AgentIdentity = {
  id: "agent-1",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-alpha.1",
};

const RUN_DIR = "runs/20261110T120000Z-abcdef01";
const INSTALL = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files";

const INFO_NONE = "INFO: No tasks are running which match the specified criteria.\r\n";

function row(
  pid: number,
  status: string,
  session = "1",
): string {
  return `"AfterFX.exe","${pid}","Console","${session}","2,182,080 K","${status}","HOST\\a8n","0:00:01","N/A"\r\n`;
}

describe("the tasklist window-state parser", () => {
  it("reads Running as responding and Not Responding as blocking", () => {
    expect(parseTasklistWindowStates(row(8028, "Running") + row(8029, "Not Responding"))).toEqual([
      { pid: 8028, sessionId: 1, state: "responding" },
      { pid: 8029, sessionId: 1, state: "not-responding" },
    ]);
  });

  it("treats any other status as unknown, never as responding", () => {
    expect(parseTasklistWindowStates(row(8028, "Unknown"))).toEqual([
      { pid: 8028, sessionId: 1, state: "unknown" },
    ]);
  });

  it("reads the INFO line as 'none running', which is an answer", () => {
    expect(parseTasklistWindowStates(INFO_NONE)).toEqual([]);
  });

  it.each([
    ["empty output", ""],
    ["a header without /NH", '"Image Name","PID","Session Name","Session#"\r\n'],
    ["a bad pid", row(Number.NaN, "Running")],
    ["a missing status column", '"AfterFX.exe","8028","Console","1","1 K"\r\n'],
    ["a bad session id", row(8028, "Running", "x")],
    ["one good row beside a bad one", row(8028, "Running") + '"AfterFX.exe","x"\r\n'],
  ])("refuses to guess from %s", (_label, text) => {
    expect(parseTasklistWindowStates(text)).toBeNull();
  });
});

describe("the recovery assessment table", () => {
  function assess(text: string, exitCode = 0, stderr = "") {
    return assessWindowsRecovery(
      interpretWindowsRecoveryResult({ stdout: text, stderr, exitCode }),
      { runDir: RUN_DIR },
    );
  }

  it("reports that nothing ran, without claiming to have acted, when no AE is running", () => {
    const findings = assess(INFO_NONE);
    expect(findings).toEqual([
      expect.objectContaining({
        code: "A8N-JOB-002",
        action: "reported",
        remedy: "Nothing to do.",
      }),
    ]);
    expect(findings[0]?.detail).toContain("no AfterFX.exe process was running");
    expect(findings[0]?.detail).toContain("nothing was acted on");
  });

  it("reports a responding AE as no blocking state", () => {
    const findings = assess(row(8028, "Running"));
    expect(findings).toEqual([
      expect.objectContaining({ code: "A8N-JOB-002", action: "reported" }),
    ]);
    expect(findings[0]?.detail).toContain("responded");
    expect(findings[0]?.detail).toContain("nothing was acted on");
  });

  it("quarantines a Not Responding AE with A8N-SEC-001 and a remedy", () => {
    const findings = assess(row(8028, "Not Responding"));
    expect(findings).toEqual([
      expect.objectContaining({
        code: "A8N-SEC-001",
        action: "refused",
      }),
    ]);
    expect(findings[0]?.detail).toContain("quarantined");
    expect(findings[0]?.detail).toContain("nothing was pressed, sent or killed");
    expect(findings[0]?.remedy).toContain("inspect the After Effects window by hand");
  });

  it("quarantines an unknown window state instead of treating it as healthy", () => {
    const findings = assess(row(8028, "Unknown"));
    expect(findings[0]).toMatchObject({ code: "A8N-SEC-001", action: "refused" });
  });

  it("quarantines a mixed list when one process is blocking", () => {
    const findings = assess(row(8028, "Running") + row(8029, "Not Responding"));
    expect(findings[0]).toMatchObject({ code: "A8N-SEC-001", action: "refused" });
    expect(findings[0]?.detail).toContain("pid 8028");
    expect(findings[0]?.detail).toContain("pid 8029");
  });

  it("reports an unreadable probe without claiming a blocking state", () => {
    const findings = assess("", 5, "Access denied");
    expect(findings[0]).toMatchObject({ code: "A8N-JOB-002", action: "reported" });
    expect(findings[0]?.detail).toContain("could not read");
    expect(findings[0]?.detail).toContain("Access denied");
    expect(findings[0]?.detail).toContain("nothing was acted on");
  });

  it("reports readable empty output as unreadable, not as 'no AE'", () => {
    const findings = assess("");
    expect(findings[0]?.detail).toContain("could not read");
  });
});

describe("WindowsAdapter.recover", () => {
  function adapterWith(recovery: CommandResult, seen: ProbeCommand[]): WindowsAdapter {
    const runner: CommandRunner = {
      run(command: ProbeCommand): Promise<CommandResult> {
        if (command.program === "tasklist.exe" && command.args.includes("/V")) {
          seen.push(command);
          return Promise.resolve(recovery);
        }
        return Promise.resolve({
          stdout:
            command.args.at(-1) === PROBE_COMMANDS.installs.args.at(-1)
              ? `${INSTALL}|26.5.0`
              : "",
          stderr: "",
          exitCode: 0,
        });
      },
    };
    return new WindowsAdapter({
      channel: new DirectoryChannel(join(tmpdir(), "a8n-recovery-unused")),
      host: "WIN-AE-01",
      user: "a8n",
      agent: AGENT,
      probe: runner,
      // The injected probe answers for WIN-AE-01: a fake host, not this machine.
      simulatedHostProbe: true,
    });
  }

  it("uses only the passive /V window-state command", async () => {
    const seen: ProbeCommand[] = [];
    const adapter = adapterWith({ stdout: INFO_NONE, stderr: "", exitCode: 0 }, seen);
    await adapter.recover(RUN_DIR);
    expect(seen).toEqual([WINDOWS_RECOVERY_COMMAND]);
    expect(WINDOWS_RECOVERY_COMMAND.args).toEqual([
      "/FI",
      "IMAGENAME eq AfterFX.exe",
      "/V",
      "/FO",
      "CSV",
      "/NH",
    ]);
  });

  it("returns the real observation instead of the old placeholder", async () => {
    const seen: ProbeCommand[] = [];
    const adapter = adapterWith(
      { stdout: row(8028, "Not Responding"), stderr: "", exitCode: 0 },
      seen,
    );
    const findings = await adapter.recover(RUN_DIR);
    expect(findings[0]).toMatchObject({ code: "A8N-SEC-001", action: "refused" });
    expect(findings[0]?.detail).not.toContain("not implemented");
  });

  it("keeps reporting that it acted on nothing when the probe cannot be read", async () => {
    const seen: ProbeCommand[] = [];
    const adapter = adapterWith({ stdout: "", stderr: "denied", exitCode: 5 }, seen);
    const findings = await adapter.recover(RUN_DIR);
    expect(findings[0]).toMatchObject({ code: "A8N-JOB-002", action: "reported" });
    expect(findings[0]?.detail).toContain("nothing was acted on");
  });
});
