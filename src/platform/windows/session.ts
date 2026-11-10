/**
 * Measuring the agent's own window-station session.
 *
 * `--session-id` is a claim made by whoever started the process. A scheduled
 * task in session 0 can claim session 1 and the flag will believe it. The
 * agent therefore reads its own session id from the OS and refuses to poll
 * when the claim and the measurement disagree.
 *
 * The measurement is implemented with PowerShell's
 * `Process.SessionId`, which is the documented user-facing accessor for the
 * current process's session. Whether it runs and answers on a real host is a
 * real-host question; the fake-host tests inject the measurement.
 */

import { execFileSync } from "node:child_process";

const MEASURE_TIMEOUT_MS = 5_000;

const SESSION_SCRIPT = "[System.Diagnostics.Process]::GetCurrentProcess().SessionId";

/**
 * The current process's session id, measured by the OS. Null when it cannot
 * be measured: an unknown session is never treated as interactive.
 */
export function measureWindowsSessionId(): number | null {
  if (process.platform !== "win32") {
    return null;
  }
  let output: string;
  try {
    output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SESSION_SCRIPT],
      { encoding: "utf-8", timeout: MEASURE_TIMEOUT_MS, windowsHide: true },
    );
  } catch {
    return null;
  }
  const text = output.trim();
  if (!/^\d+$/u.test(text)) {
    return null;
  }
  const sessionId = Number(text);
  return Number.isSafeInteger(sessionId) ? sessionId : null;
}

/**
 * Refuses when the claimed session is not the measured one. Returns the
 * measured id, which is what the rest of the agent must use.
 */
export function resolveSessionId(
  claimed: number,
  measure: () => number | null,
): { readonly ok: true; readonly sessionId: number } | { readonly ok: false; readonly detail: string } {
  const measured = measure();
  if (measured === null) {
    return {
      ok: false,
      detail:
        "the agent's own session could not be measured; a claimed session id is not evidence " +
        "of an interactive desktop",
    };
  }
  if (measured !== claimed) {
    return {
      ok: false,
      detail:
        `--session-id ${claimed} does not match the measured session ${measured}; ` +
        "the claim is not trusted",
    };
  }
  return { ok: true, sessionId: measured };
}
