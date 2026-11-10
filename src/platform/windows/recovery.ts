/**
 * Windows recovery: what a run can actually observe without GUI automation.
 *
 * The backend can read the After Effects process list and, when Windows
 * supplies it, the process's window-state column from `tasklist /V`. An AE
 * that is not answering is a blocking state the run cannot classify: the
 * neutral policy quarantines it with `A8N-SEC-001` and the finding says what a
 * human must do. No button is pressed, no key is sent, and no process is
 * killed — there is no code here that could do any of those things.
 */

import { parseCsvLine } from "./probe.js";
import type { CommandResult, ProbeCommand } from "./probe.js";
import type { RecoveryFinding } from "../contract.js";
import { chooseAction, type DialogWindow } from "../recovery-policy.js";

/**
 * `tasklist /V` adds the Status column: "Running", "Not Responding" or
 * "Unknown" on the versions that report it. The read is passive.
 */
export const WINDOWS_RECOVERY_COMMAND: ProbeCommand = {
  program: "tasklist.exe",
  args: ["/FI", "IMAGENAME eq AfterFX.exe", "/V", "/FO", "CSV", "/NH"],
};

export type AeProcessState = "responding" | "not-responding" | "unknown";

export type AeProcessObservation = {
  readonly pid: number;
  readonly sessionId: number | null;
  readonly state: AeProcessState;
};

export type WindowsRecoveryObservation =
  /** The state could not be read; no conclusion is drawn. */
  | { readonly kind: "unreadable"; readonly detail: string }
  /** The command answered; the list may be empty. */
  | { readonly kind: "observed"; readonly processes: readonly AeProcessObservation[] };

function parseState(raw: string): AeProcessState {
  const value = raw.trim().toLowerCase();
  if (value === "running") {
    return "responding";
  }
  if (value === "not responding") {
    return "not-responding";
  }
  return "unknown";
}

/**
 * Parse `tasklist /V /FO CSV /NH`. `null` means the output cannot be trusted;
 * an empty array means the command answered and no AfterFX.exe is running.
 */
export function parseTasklistWindowStates(
  stdout: string,
): readonly AeProcessObservation[] | null {
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;
  if (text.trim() === "") {
    return null;
  }
  const processes: AeProcessObservation[] = [];
  let sawInfo = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("INFO:")) {
      sawInfo = true;
      continue;
    }
    const fields = parseCsvLine(line);
    // Image, PID, session name, session #, memory, status, user, CPU, title.
    if (fields.length < 6) {
      return null;
    }
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const sessionRaw = fields[3]?.trim() ?? "";
    const sessionId = sessionRaw === "" ? null : Number(sessionRaw);
    if (sessionId !== null && !Number.isInteger(sessionId)) {
      return null;
    }
    processes.push({
      pid,
      sessionId,
      state: parseState(fields[5] ?? ""),
    });
  }
  if (processes.length === 0) {
    // "INFO: No tasks are running..." is an answer; silence is not.
    return sawInfo ? [] : null;
  }
  return processes;
}

/** Turn one `tasklist` result into an observation, never a guess. */
export function interpretWindowsRecoveryResult(result: CommandResult): WindowsRecoveryObservation {
  if (result.exitCode !== 0) {
    return {
      kind: "unreadable",
      detail: `tasklist exited ${result.exitCode}${
        result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`
      }`,
    };
  }
  const processes = parseTasklistWindowStates(result.stdout);
  if (processes === null) {
    return {
      kind: "unreadable",
      detail:
        result.stderr.trim() === ""
          ? "tasklist produced no readable window-state rows"
          : `tasklist produced no readable rows: ${result.stderr.trim()}`,
    };
  }
  return { kind: "observed", processes };
}

function syntheticWindow(process: AeProcessObservation): DialogWindow {
  const said =
    process.state === "responding"
      ? "running"
      : process.state === "not-responding"
        ? "not responding"
        : "window state unknown";
  return {
    title: `AfterFX.exe pid ${process.pid}`,
    role: "process",
    subrole: null,
    texts: [said],
    buttons: [],
    blocking: process.state !== "responding",
  };
}

function describeProcesses(processes: readonly AeProcessObservation[]): string {
  return processes
    .map(
      (process) =>
        `pid ${process.pid} (session ${process.sessionId ?? "?"}, ${process.state})`,
    )
    .join(", ");
}

export type WindowsRecoveryOptions = {
  /** The run directory the finding is about; used for the human's next step. */
  readonly runDir: string;
};

/**
 * Report what was observed. This function returns findings only; it has no
 * capability to press, send keys or kill, and it never claims it did.
 */
export function assessWindowsRecovery(
  observation: WindowsRecoveryObservation,
  options: WindowsRecoveryOptions,
): readonly RecoveryFinding[] {
  if (observation.kind === "unreadable") {
    return [
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `the Windows recovery probe could not read the After Effects state ` +
          `(${observation.detail}); nothing was acted on in ${options.runDir}`,
        remedy:
          "Inspect the host by hand. The run was left in place; nothing was pressed, sent or killed.",
      },
    ];
  }

  const { processes } = observation;
  if (processes.length === 0) {
    return [
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `no AfterFX.exe process was running; no blocking window was observed and ` +
          `nothing was acted on in ${options.runDir}`,
        remedy: "Nothing to do.",
      },
    ];
  }

  const decision = chooseAction(processes.map(syntheticWindow));
  switch (decision.action) {
    case "none":
      return [
        {
          code: "A8N-JOB-002",
          action: "reported",
          detail:
            `After Effects ${describeProcesses(processes)} responded; no blocking state ` +
            `was observed and nothing was acted on in ${options.runDir}`,
          remedy: "Nothing to do.",
        },
      ];
    case "quarantine":
    case "human-only":
      return [
        {
          code: decision.code,
          action: "refused",
          detail:
            `${decision.detail}; ${describeProcesses(processes)} in ${options.runDir}. ` +
            "The run is quarantined and nothing was pressed, sent or killed.",
          remedy:
            "Open the dedicated session and inspect the After Effects window by hand. " +
            "Close it yourself; the runner will not press a dialog or kill the process.",
        },
      ];
    case "known":
      // Windows has no GUI automation dependency, so even a measured class is
      // reported rather than pressed. This branch keeps that boundary explicit.
      return [
        {
          code: "A8N-JOB-002",
          action: "reported",
          detail:
            `a measured dialog class was classified for ${describeProcesses(processes)}, ` +
            "but Windows recovery has no GUI automation; nothing was pressed",
          remedy:
            "Close the measured dialog by hand in the dedicated session, or wait for T092 to " +
            "add a verified GUI recovery path.",
        },
      ];
  }
}
