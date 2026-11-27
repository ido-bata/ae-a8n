/**
 * macOS delivery for the window-ops contract (#366,
 * `specs/workspace-editing/spec.md` §9).
 *
 * This module is the darwin half of `src/windowops/`: it turns the
 * `WindowOpsSurfaceOps` port the controller injects into calls to the
 * compiled helpers in `scripts/isolated-session/` — `window-ops` for
 * the window listing and the AX mutations, `input-focus` (#372) for
 * the focus-holder readback — executed inside the target session via
 * `runInSession`, the same boundary `src/input/darwin.ts` uses.
 *
 * SAFETY — read before wiring this anywhere:
 *
 *   - `window-ops act` sets real AX attributes (position/size/
 *     miniaturized/main/focused/raise) on a real window. It is a
 *     delivery vehicle only. Every call must arrive through
 *     `WindowOpsController`, which enforces owned attribution →
 *     `windowOpsMutationGate()` (fail-closed today) → in-session
 *     identity re-verification → bounded postcondition wait. Nothing
 *     in this file checks the gate itself; do not call the ops
 *     directly from a mutation path.
 *   - The helper only ever sees windows of the pid it is given
 *     (`AXUIElementCreateApplication(pid)`), and re-verifies the
 *     expected frame+title+subrole identity immediately before the AX
 *     set — a drifted window is `not-found`/`ambiguous`, provably
 *     untouched.
 *   - `state` and `focus read` are read-only.
 *
 * Verification level reached here: `implemented` + `automated test`
 * (argv construction, JSON parsing against fakes, helper compilation
 * on darwin). Whether the AX sets take effect on a real After Effects
 * window — and whether miniaturized windows keep a readable frame — is
 * `unverified` and stays so until a real-host ticket runs it.
 */

import { join } from "node:path";

import {
  runInSession,
  type MacSession,
  type SessionCommandResult,
} from "../driver/mac-session.js";
import { censusRunnerInSession } from "../driver/gui-recovery.js";
import {
  windowServerCensus,
  type CensusRunner,
  type WindowCensus,
} from "../platform/darwin/window-census.js";
import type { FocusHolder } from "../input/types.js";
import type {
  WindowOpsActRequest,
  WindowOpsActResult,
  WindowOpsActVerdict,
  WindowOpsCensusView,
  WindowOpsListing,
  WindowOpsSurfaceOps,
  WindowOpsWindowInfo,
} from "./types.js";

/** The compiled helper binaries this adapter can invoke. */
export type DarwinWindowOpsHelper = "window-ops" | "input-focus";

export const DARWIN_WINDOW_OPS_HELPERS: readonly DarwinWindowOpsHelper[] = [
  "window-ops",
  "input-focus",
];

/** The exec seam: run one helper with args inside the target session. */
export type DarwinWindowOpsExec = (
  helper: DarwinWindowOpsHelper,
  args: readonly string[],
) => SessionCommandResult;

/** Thrown when a helper exits non-zero; carries its stderr as the reason. */
export class DarwinWindowOpsError extends Error {
  readonly helper: DarwinWindowOpsHelper;
  readonly exitStatus: number;

  constructor(helper: DarwinWindowOpsHelper, exitStatus: number, detail: string) {
    super(`${helper} failed (exit ${exitStatus}): ${detail}`);
    this.name = "DarwinWindowOpsError";
    this.helper = helper;
    this.exitStatus = exitStatus;
  }
}

/**
 * The production exec: `runInSession` against a directory of compiled
 * helpers. The helpers must be built first (`swiftc -O` per
 * `scripts/isolated-session/window-ops.swift` + `input-focus.swift`);
 * this adapter never compiles or downloads anything itself.
 */
export function sessionWindowOpsExec(options: {
  readonly session: MacSession;
  /** Directory containing the compiled helper binaries. */
  readonly helpersDir: string;
  readonly timeoutMs?: number;
}): DarwinWindowOpsExec {
  return (helper, args) =>
    runInSession(options.session, join(options.helpersDir, helper), args, {
      timeoutMs: options.timeoutMs ?? 30_000,
    });
}

function run(
  exec: DarwinWindowOpsExec,
  helper: DarwinWindowOpsHelper,
  args: readonly string[],
): SessionCommandResult {
  const result = exec(helper, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic";
    throw new DarwinWindowOpsError(helper, result.status, detail);
  }
  return result;
}

function parseJson<T>(helper: DarwinWindowOpsHelper, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new DarwinWindowOpsError(
      helper,
      1,
      `unparseable JSON receipt: ${stdout.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------
// JSON → contract parsing (defensive: helper output is untrusted input)
// ---------------------------------------------------------------------

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseFrame(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (value === null || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const x = asFinite(f.x);
  const y = asFinite(f.y);
  const width = asFinite(f.width);
  const height = asFinite(f.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function parseWindowInfo(value: unknown, index: number): WindowOpsWindowInfo | null {
  if (value === null || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  const title = typeof w.title === "string" ? w.title : "";
  const role = typeof w.role === "string" ? w.role : "";
  const subrole = typeof w.subrole === "string" ? w.subrole : null;
  const miniaturized =
    typeof w.miniaturized === "boolean" ? w.miniaturized : null;
  const main = typeof w.main === "boolean" ? w.main : null;
  const focused = typeof w.focused === "boolean" ? w.focused : null;
  return {
    index: asFinite(w.index) ?? index,
    title,
    role,
    subrole,
    frame: parseFrame(w.frame),
    miniaturized,
    main,
    focused,
  };
}

function parseListing(
  pid: number,
  stdout: string,
  observedAt: string,
): WindowOpsListing {
  const parsed = parseJson<{
    pid?: unknown;
    frontmostPid?: unknown;
    focusedWindowIndex?: unknown;
    windows?: unknown;
  }>("window-ops", stdout);
  const windows = Array.isArray(parsed.windows) ? parsed.windows : [];
  return {
    pid,
    frontmostPid: asFinite(parsed.frontmostPid),
    focusedWindowIndex: asFinite(parsed.focusedWindowIndex),
    windows: windows.map((w, i) => parseWindowInfo(w, i + 1)).filter(
      (w): w is WindowOpsWindowInfo => w !== null,
    ),
    observedAt,
  };
}

function parseActResult(stdout: string): WindowOpsActResult {
  const parsed = parseJson<{
    verdict?: unknown;
    window?: unknown;
    displayFrame?: unknown;
    detail?: unknown;
  }>("window-ops", stdout);
  const verdict = parsed.verdict;
  const known: readonly WindowOpsActVerdict[] = [
    "performed",
    "not-found",
    "ambiguous",
    "missing",
    "failed",
  ];
  return {
    verdict: known.includes(verdict as WindowOpsActVerdict)
      ? (verdict as WindowOpsActVerdict)
      : "failed",
    window: parseWindowInfo(parsed.window, 0),
    displayFrame: parseFrame(parsed.displayFrame),
    detail: typeof parsed.detail === "string" ? parsed.detail : null,
  };
}

// ---------------------------------------------------------------------
// The WindowOpsSurfaceOps binding
// ---------------------------------------------------------------------

export type DarwinWindowOpsOptions = {
  readonly pid: number;
  readonly exec: DarwinWindowOpsExec;
  /**
   * The WindowServer census — FULL rows (every pid), because
   * attribution needs the foreign rows to tell "foreign" from
   * "unmatched". Production binds `windowServerCensus` inside the
   * target session; tests inject a stub.
   */
  readonly census?: () => WindowCensus;
  readonly now?: () => Date;
};

/**
 * The production census: the WindowServer probe inside the target
 * session, same scoping `MacGuiRecovery` applies.
 */
export function sessionWindowCensus(options: {
  readonly session: MacSession;
  readonly censusRun?: CensusRunner;
  readonly runSession?: typeof runInSession;
}): () => WindowCensus {
  const run =
    options.censusRun ??
    censusRunnerInSession(options.session, options.runSession ?? runInSession);
  return () => windowServerCensus(run);
}

/** Format one point for the helper's `x,y,w,h` identity argument. */
function fmt(n: number): string {
  // Screen coordinates are points; `String` keeps full precision for the
  // fractional cases AX actually reports (.5 origins on Retina layouts).
  return String(n);
}

/**
 * Bind `WindowOpsSurfaceOps` to the compiled helpers. `act` maps a
 * session-entry failure to the `missing` verdict — the helper provably
 * never ran, so nothing was mutated — while a non-zero helper exit is
 * `failed` (the outcome is unknown, reported as such).
 */
export function darwinWindowOpsOps(
  options: DarwinWindowOpsOptions,
): WindowOpsSurfaceOps {
  const { pid, exec } = options;
  const now = options.now ?? (() => new Date());
  const censusView = (): WindowOpsCensusView => {
    try {
      const census = options.census?.() ?? { available: false as const, reason: "no census configured" };
      if (!census.available) {
        return { available: false, reason: census.reason, windows: [] };
      }
      return { available: true, reason: null, windows: census.windows };
    } catch (error) {
      return {
        available: false,
        reason: `window census failed: ${error instanceof Error ? error.message : String(error)}`,
        windows: [],
      };
    }
  };

  return {
    observeWindows() {
      const result = run(exec, "window-ops", ["state", "--pid", String(pid)]);
      return parseListing(pid, result.stdout, now().toISOString());
    },

    censusWindows: censusView,

    act(request: WindowOpsActRequest): WindowOpsActResult {
      const args = [
        "act",
        "--pid",
        String(pid),
        "--op",
        request.op,
        "--title",
        request.expected.title,
        "--subrole",
        request.expected.subrole ?? "-",
        "--frame",
        [
          fmt(request.expected.frame.x),
          fmt(request.expected.frame.y),
          fmt(request.expected.frame.width),
          fmt(request.expected.frame.height),
        ].join(","),
      ];
      if (request.position !== undefined) {
        args.push("--x", fmt(request.position.x), "--y", fmt(request.position.y));
      }
      if (request.size !== undefined) {
        args.push(
          "--width",
          fmt(request.size.width),
          "--height",
          fmt(request.size.height),
        );
      }
      let result: SessionCommandResult;
      try {
        result = exec("window-ops", args);
      } catch (error) {
        // Session entry failed before the helper ran — provable
        // non-mutation, mapped to the vehicle's `missing` verdict.
        return {
          verdict: "missing",
          window: null,
          displayFrame: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status !== 0) {
        return {
          verdict: "failed",
          window: null,
          displayFrame: null,
          detail:
            result.stderr.trim() ||
            result.stdout.trim() ||
            `exit status ${result.status}`,
        };
      }
      return parseActResult(result.stdout);
    },

    readFocusHolder(): FocusHolder | null {
      try {
        const result = run(exec, "input-focus", ["read"]);
        const parsed = parseJson<{
          pid?: unknown;
          app?: unknown;
          element?: unknown;
          observedAt?: unknown;
        }>("input-focus", result.stdout);
        const holderPid = asFinite(parsed.pid);
        if (holderPid === null || holderPid <= 0) {
          return null;
        }
        return {
          pid: holderPid,
          app: typeof parsed.app === "string" ? parsed.app : null,
          element: typeof parsed.element === "string" ? parsed.element : null,
          observedAt:
            typeof parsed.observedAt === "string"
              ? parsed.observedAt
              : now().toISOString(),
        };
      } catch {
        // A focus read that cannot run is "unproven", never a match.
        return null;
      }
    },
  };
}
