/**
 * TCC permission probes for the macOS adapter (`A8N-PERM-001/002`, #57 T025).
 *
 * Screen Recording and Accessibility are the two TCC grants the GUI-side
 * work needs (window census names, AX reads for recovery). The contract in
 * `specs/isolated-ae/contracts/permissions.md` §1 names the probes; this
 * module is the local-intent half of them.
 *
 * The probe is deliberately the *preflight* API, never the request API:
 * `CGPreflightScreenCaptureAccess()` and `AXIsProcessTrusted()` report the
 * grant state without showing a prompt, writing TCC.db, or touching SIP.
 * Asking (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions`
 * with the prompt flag) is the guided grant loop's job (#57 T021), not a
 * read-only probe's.
 *
 * Like every TCC client, the answer is attributed to the *responsible
 * process* — the innermost app bundle, e.g. the terminal or IDE that hosts
 * ae-a8n. That is exactly the grant the caller's own scripts inherit,
 * so probing from this process measures the right thing for the local
 * intent. For the isolated intent the probe must run inside the target
 * user's session instead; until that job exists the state stays `unproven`
 * (`deferred`), never guessed.
 *
 * The mechanism is the same ctypes-over-CLT-python3 seam the window census
 * uses (`window-census.ts`): no compile step, no helper binary, read-only.
 * When the interpreter or a symbol is absent the state is `unproven` —
 * an API that did not answer is not a denial and not a pass.
 */

import { WINDOW_CENSUS_PYTHON } from "./window-census.js";

/** The interpreter the probe needs; the census's CLT python3, never the stub. */
export const TCC_PROBE_PYTHON = WINDOW_CENSUS_PYTHON;

export type TccPermissionState = "granted" | "denied" | "unproven";

export type TccPermissionProbe = {
  readonly state: TccPermissionState;
  /** Why the state is what it is, or what left it unproven. */
  readonly detail: string | null;
};

/**
 * - `preflight`: the ctypes probe ran and the OS answered.
 * - `unavailable`: the local probe could not run (no interpreter, non-zero
 *   exit, unparseable output).
 * - `deferred`: the intent is not local; the grant lives in another user's
 *   session and can only be probed there (#57 T021).
 */
export type TccProbeMechanism = "preflight" | "unavailable" | "deferred";

export type TccProbeResult = {
  readonly screenRecording: TccPermissionProbe;
  readonly accessibility: TccPermissionProbe;
  readonly mechanism: TccProbeMechanism;
};

/** The command shape the probe needs; `DarwinExec` satisfies it. */
export type TccExec = (
  program: string,
  args: readonly string[],
) => {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Prints one `name=value` line per permission: 1 granted, 0 denied,
 * -1 the symbol or framework was absent (unproven, not denied).
 */
export const TCC_PROBE_SCRIPT = String.raw`
import ctypes
def load(framework, name):
    try:
        return ctypes.CDLL("/System/Library/Frameworks/%s.framework/%s" % (framework, name))
    except Exception:
        return None
def trusted(lib, symbol):
    if lib is None or not hasattr(lib, symbol):
        return -1
    try:
        fn = getattr(lib, symbol)
        fn.restype = ctypes.c_bool
        return 1 if fn() else 0
    except Exception:
        return -1
cg = load("CoreGraphics", "CoreGraphics")
ass = load("ApplicationServices", "ApplicationServices")
print("screen=%d" % trusted(cg, "CGPreflightScreenCaptureAccess"))
print("ax=%d" % trusted(ass, "AXIsProcessTrusted"))
`;

function unproven(detail: string): TccPermissionProbe {
  return { state: "unproven", detail };
}

function deferredResult(detail: string): TccProbeResult {
  return {
    screenRecording: unproven(detail),
    accessibility: unproven(detail),
    mechanism: "deferred",
  };
}

/** The result used when the probe is not this intent's to run. */
export function deferredTccProbe(detail: string): TccProbeResult {
  return deferredResult(detail);
}

function stateOf(value: number | null): TccPermissionProbe {
  if (value === 1) {
    return { state: "granted", detail: null };
  }
  if (value === 0) {
    return { state: "denied", detail: null };
  }
  return unproven(
    value === null
      ? "the probe output did not answer for this permission"
      : "the OS did not provide this preflight symbol",
  );
}

/** Parse `screen=N` / `ax=N` lines; null when the line is absent or malformed. */
export function parseTccProbe(text: string): {
  readonly screen: number | null;
  readonly ax: number | null;
} {
  const read = (name: string): number | null => {
    for (const line of text.split("\n")) {
      const match = new RegExp(`^${name}=(-?\\d+)\\s*$`).exec(line.trim());
      if (match !== null) {
        return Number(match[1]);
      }
    }
    return null;
  };
  return { screen: read("screen"), ax: read("ax") };
}

/**
 * Run the preflight probe once and report both permissions. Any failure —
 * missing interpreter, non-zero exit, unparseable output — leaves both
 * `unproven`; nothing is retried and nothing is requested.
 */
export function runTccProbe(exec: TccExec): TccProbeResult {
  let result: ReturnType<TccExec>;
  try {
    result = exec(TCC_PROBE_PYTHON, ["-c", TCC_PROBE_SCRIPT]);
  } catch (error) {
    return {
      screenRecording: unproven(
        `the TCC probe could not run: ${error instanceof Error ? error.message : String(error)}`,
      ),
      accessibility: unproven(
        `the TCC probe could not run: ${error instanceof Error ? error.message : String(error)}`,
      ),
      mechanism: "unavailable",
    };
  }
  if (result.status !== 0) {
    const detail =
      result.stderr.trim().length > 0
        ? result.stderr.trim()
        : `the TCC probe exited with ${result.status}`;
    return {
      screenRecording: unproven(`the TCC probe failed: ${detail}`),
      accessibility: unproven(`the TCC probe failed: ${detail}`),
      mechanism: "unavailable",
    };
  }
  const parsed = parseTccProbe(result.stdout);
  return {
    screenRecording: stateOf(parsed.screen),
    accessibility: stateOf(parsed.ax),
    mechanism: "preflight",
  };
}
