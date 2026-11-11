/**
 * Read-only probe of a Windows host.
 *
 * It runs no write, starts no After Effects and opens no connection. Every
 * value comes from a command whose output is recorded in `facts` so a human
 * can check the conclusion. The runner built on top of this must refuse to
 * start a test AE when `A8N-AE-001` is present; this module only reports.
 */

import { diagnostic, type DiagnosticCheck } from "../../doctor/diagnostics.js";
import type { AdapterProbe, TargetSpec } from "../contract.js";
import { windowsCapabilities } from "./capabilities.js";

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type ProbeCommand = {
  readonly program: string;
  readonly args: readonly string[];
};

/** Injected so the probe can be tested without Windows. */
export interface CommandRunner {
  run(command: ProbeCommand): Promise<CommandResult>;
}

export type AeInstall = {
  readonly location: string;
  readonly version: string | null;
};

export type AeProcess = {
  readonly pid: number;
  readonly sessionId: number | null;
};

export type WindowsFacts = {
  readonly osCaption: string | null;
  readonly osVersion: string | null;
  readonly sessionId: number | null;
  readonly currentUser: string | null;
  readonly consoleUser: string | null;
  readonly aeInstalls: readonly AeInstall[];
  readonly aeProcesses: readonly AeProcess[];
  readonly targetUserExists: boolean | null;
  /** The raw outputs the conclusions rest on. */
  readonly evidence: Readonly<Record<string, string>>;
};

export type WindowsProbeOptions = {
  readonly isolation: TargetSpec["isolation"];
  /** The account that runs AE, when one is configured. */
  readonly targetUser: string | null;
};

export type WindowsProbeResult = AdapterProbe & {
  readonly facts: WindowsFacts;
};

const PS = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

const SCRIPTS = {
  os: "$o = Get-CimInstance Win32_OperatingSystem; $o.Caption + '|' + $o.Version",
  sessionId: "[System.Diagnostics.Process]::GetCurrentProcess().SessionId",
  currentUser: "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
  consoleUser: "(Get-CimInstance Win32_ComputerSystem).UserName",
  // Adobe registers a 32-bit uninstaller, so the 64-bit view alone finds
  // nothing. The per-user hive is included for per-user installs; the same
  // entry can appear in more than one place, which the parser collapses.
  installs:
    "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
    "-ErrorAction SilentlyContinue | " +
    "Where-Object { $_.DisplayName -like 'Adobe After Effects*' } | " +
    "ForEach-Object { $_.InstallLocation + '|' + $_.DisplayVersion }",
} as const;

/** Split one CSV line, keeping commas inside quotes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

export function parseTasklistCsv(stdout: string): AeProcess[] {
  const processes: AeProcess[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("INFO:")) {
      continue;
    }
    const fields = parseCsvLine(line);
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const sessionRaw = fields[3];
    const sessionId = sessionRaw === undefined || sessionRaw === "" ? null : Number(sessionRaw);
    processes.push({
      pid,
      sessionId: Number.isInteger(sessionId) ? sessionId : null,
    });
  }
  return processes;
}

/**
 * `InstallLocation` is the Adobe root, not the executable, and the same entry
 * can be registered in both the machine and the per-user hive. Identical
 * location/version pairs are collapsed.
 */
export function parseInstallListing(stdout: string): AeInstall[] {
  const installs: AeInstall[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const separator = line.lastIndexOf("|");
    const location = (separator === -1 ? line : line.slice(0, separator)).trim();
    const version = separator === -1 ? "" : line.slice(separator + 1).trim();
    if (location === "") {
      continue;
    }
    const key = `${location.toLowerCase()}|${version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    installs.push({ location, version: version === "" ? null : version });
  }
  return installs;
}

export function parseNumber(stdout: string): number | null {
  const value = stdout.trim();
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function parseText(stdout: string): string | null {
  const value = stdout.trim();
  return value === "" ? null : value;
}

function powerShell(script: string): ProbeCommand {
  return { program: PS, args: [...PS_ARGS, script] };
}

/** The exact commands the probe is allowed to issue, for the no-write test. */
export const PROBE_COMMANDS = {
  os: powerShell(SCRIPTS.os),
  sessionId: powerShell(SCRIPTS.sessionId),
  currentUser: powerShell(SCRIPTS.currentUser),
  consoleUser: powerShell(SCRIPTS.consoleUser),
  installs: powerShell(SCRIPTS.installs),
  processes: {
    program: "tasklist.exe",
    args: ["/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"],
  },
  targetUser: (user: string): ProbeCommand => ({ program: "net.exe", args: ["user", user] }),
} as const;

function capabilitySet(isolation: TargetSpec["isolation"]): ReturnType<typeof windowsCapabilities> {
  return windowsCapabilities(isolation);
}


function describeProcesses(processes: readonly AeProcess[]): string {
  return processes.map((process) => `pid ${process.pid} (session ${process.sessionId ?? "?"})`).join(", ");
}

/** Run the read-only probes and turn them into diagnostic checks. */
export async function probeWindows(
  runner: CommandRunner,
  options: WindowsProbeOptions,
): Promise<WindowsProbeResult> {
  const [osResult, sessionResult, userResult, consoleResult, installResult, processResult] =
    await Promise.all([
      runner.run(PROBE_COMMANDS.os),
      runner.run(PROBE_COMMANDS.sessionId),
      runner.run(PROBE_COMMANDS.currentUser),
      runner.run(PROBE_COMMANDS.consoleUser),
      runner.run(PROBE_COMMANDS.installs),
      runner.run(PROBE_COMMANDS.processes),
    ]);

  let targetUserExists: boolean | null = null;
  let targetUserEvidence = "";
  if (options.targetUser !== null) {
    const target = await runner.run(PROBE_COMMANDS.targetUser(options.targetUser));
    targetUserEvidence = `${target.stdout}${target.stderr}`.trim();
    // `net user` exits 2 when the account does not exist; anything else that
    // is not 0 (access denied, a missing program) is unreadable, not absent.
    targetUserExists = target.exitCode === 0 ? true : target.exitCode === 2 ? false : null;
  }

  const [captionPart, versionPart] = osResult.stdout.split("|");
  const evidence = {
    os: osResult.stdout.trim(),
    sessionId: sessionResult.stdout.trim(),
    currentUser: userResult.stdout.trim(),
    consoleUser: consoleResult.stdout.trim(),
    installs: installResult.stdout.trim(),
    processes: processResult.stdout.trim(),
    targetUser: targetUserEvidence,
  };

  const facts: WindowsFacts = {
    osCaption: parseText(captionPart ?? ""),
    osVersion: parseText(versionPart ?? ""),
    sessionId: parseNumber(sessionResult.stdout),
    currentUser: parseText(userResult.stdout),
    consoleUser: parseText(consoleResult.stdout),
    aeInstalls: parseInstallListing(installResult.stdout),
    aeProcesses: parseTasklistCsv(processResult.stdout),
    targetUserExists,
    evidence,
  };

  const checks: DiagnosticCheck[] = [];
  const { sessionId, currentUser, consoleUser, aeInstalls, aeProcesses } = facts;

  if (facts.osCaption === null) {
    checks.push(
      diagnostic("A8N-ENV-001", {
        detail: "the host did not report a Windows version",
        remedy: "Run the probe on a supported Windows 11 host.",
        remedyKind: "human",
        evidence: { os: evidence.os },
      }),
    );
  }

  // Several versions under one Adobe root are a normal upgrade, and the
  // existing resolver picks the newest usable one. Only distinct locations
  // make the destination ambiguous.
  const installLocations = [...new Set(aeInstalls.map((install) => install.location.toLowerCase()))];

  if (aeInstalls.length === 0) {
    checks.push(
      diagnostic("A8N-ENV-003", {
        detail: "no After Effects installation was found for this account",
        remedy: "Install After Effects 2026 on the host, or pass installDir to the runner.",
        remedyKind: "human",
        evidence: { installs: evidence.installs },
      }),
    );
  } else if (installLocations.length > 1) {
    checks.push(
      diagnostic("A8N-ENV-004", {
        detail: `found ${installLocations.length} installation locations: ${aeInstalls
          .map((install) => `${install.location} ${install.version ?? "(no version)"}`)
          .join("; ")}`,
        remedy: "Configure the runner's installDir so the selected install is explicit.",
        remedyKind: "human",
        evidence: { installs: evidence.installs },
      }),
    );
  }

  if (sessionId === null || sessionId === 0) {
    checks.push(
      diagnostic("A8N-SESSION-002", {
        detail:
          sessionId === null
            ? "the agent's interactive session id could not be read"
            : "the agent is running in session 0, which has no interactive desktop",
        remedy: "Run the agent from a logged-in interactive session, not a service or SSH session.",
        remedyKind: "human",
        evidence: { sessionId: sessionId ?? "unreadable" },
      }),
    );
  }

  if (
    options.isolation === "session" &&
    currentUser !== null &&
    consoleUser !== null &&
    currentUser.toLowerCase() === consoleUser.toLowerCase()
  ) {
    checks.push(
      diagnostic("A8N-SESSION-003", {
        detail: `the target account ${currentUser} is also the console user`,
        remedy:
          "Use a separate account and session, or the dedicated-host backend, so the person at the console is not disturbed.",
        remedyKind: "human",
        evidence: { currentUser, consoleUser },
      }),
    );
  }

  if (options.targetUser !== null && targetUserExists === false) {
    checks.push(
      diagnostic("A8N-SESSION-001", {
        detail: `the target account "${options.targetUser}" does not exist on this host`,
        remedy: "Create the account in setup, or choose an existing one.",
        remedyKind: "human",
        evidence: { targetUser: options.targetUser },
      }),
    );
  }

  if (aeProcesses.length > 0) {
    checks.push(
      diagnostic("A8N-AE-001", {
        detail: `After Effects is already running: ${describeProcesses(aeProcesses)}`,
        remedy:
          "Quit After Effects on the host yourself. The runner will not quit an instance it did not start, and will not start a second one.",
        remedyKind: "human",
        evidence: { processes: evidence.processes },
      }),
    );
  }

  return {
    checks,
    capabilities: capabilitySet(options.isolation),
    facts,
  };
}
