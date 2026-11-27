/**
 * Window ops contract — W4+ slice (#366,
 * `specs/workspace-editing/spec.md` §9 "window ops cycle", §5, §10;
 * parent #345 / program #337).
 *
 * This module fixes the vocabulary the window-ops slice uses:
 *
 *   - `WindowOpsWindowInfo`/`WindowOpsListing` — one observation of the
 *     target pid's AX windows with the attributes window ops need
 *     (frame, `AXMiniaturized`, `AXMain`, `AXFocused`) plus the
 *     frontmost pid and the focused-window index. `null` means "the
 *     attribute could not be read" — never a guessed value.
 *   - `WindowOpsState` — the public observe result: the resolved
 *     window's state plus its census attribution.
 *   - `WindowOpsActRequest`/`WindowOpsActResult` — the mutation
 *     vehicle contract. Acts are addressed by *identity* (expected
 *     frame + title/subrole), re-verified inside the session
 *     immediately before the AX set — the same rule
 *     `RESIZE_PANEL_SCRIPT` follows — never by a remembered index.
 *   - `WindowOpResult` — what every mutation reports: before/after
 *     states, never a bare verdict.
 *
 * Mutation honesty (spec §10, §13): every op is `mutate-gui`,
 * target-scoped, runs behind the injected gate (fail-closed), never
 * auto-resends, and reports `indeterminate` when a bounded
 * postcondition wait expires.
 */

import type { PanelAttribution, PanelFrame } from "../panels/types.js";
import type { FocusHolder } from "../input/types.js";
import type { WindowServerWindow } from "../platform/darwin/window-census.js";

/** The window ops this slice implements (issue #366). */
export type WindowOpsOp =
  /** AX `set position` — move only, size untouched. */
  | "move"
  /** AX `set size` — resize only, position untouched. */
  | "resize"
  /** AX `set miniaturized` true — minimize to the Dock. */
  | "minimize"
  /** AX `set miniaturized` false — un-minimize. */
  | "restore"
  /** Frame = the containing display's bounds (position + size). */
  | "maximize"
  /** AXMain + AXFocused + AXRaise + app activate, focus-proofed. */
  | "focus";

/** One AX window as the window-ops observation reports it. */
export type WindowOpsWindowInfo = {
  /**
   * 1-based position in the observation's own listing — evidence only.
   * `0` means "not a listing row": the focused-window resolution path
   * (#406) synthesizes a row for the app's AXFocusedWindow, which the
   * window enumeration never contained.
   */
  readonly index: number;
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  /** AXPosition+AXSize in global points; null when unreadable. */
  readonly frame: PanelFrame | null;
  /** AXMiniaturized; null when the attribute is absent/unreadable. */
  readonly miniaturized: boolean | null;
  /** AXMain; null when absent/unreadable. */
  readonly main: boolean | null;
  /** AXFocused; null when absent/unreadable. */
  readonly focused: boolean | null;
};

/**
 * The app's `AXFocusedWindow` element as the observation reports it —
 * the same attributes as `WindowOpsWindowInfo` minus the listing
 * `index`, which does not exist for it (#406).
 *
 * Why this exists: After Effects (2026 & 2027, verified on real host —
 * `docs/evidence/realhost-2026-11-27/`)
 * vends ZERO windows through `AXWindows`, `AXChildren`, AppleScript
 * `windows of process` and `UI elements of process`. `AXFocusedWindow`
 * is the only window attribute that still resolves a real window — and
 * only while that window holds focus. Unfocused windows are
 * AX-unreachable; this field can never enumerate them.
 */
export type WindowOpsFocusedWindow = Omit<WindowOpsWindowInfo, "index">;

/** One full window-state observation of the target pid. */
export type WindowOpsListing = {
  readonly pid: number;
  /** The frontmost application's pid, or null when unproven. */
  readonly frontmostPid: number | null;
  /** Index into `windows` of the keyboard-focus holder, or null. */
  readonly focusedWindowIndex: number | null;
  readonly windows: readonly WindowOpsWindowInfo[];
  /**
   * The app's AXFocusedWindow, when the helper could read it — `null`
   * when the attribute is absent or unreadable. On AE this is the only
   * AX-reachable window (#406); on healthy apps it duplicates a
   * `windows` row. It is observation evidence only: the `act` vehicle
   * never addresses it.
   */
  readonly focusedWindow: WindowOpsFocusedWindow | null;
  /**
   * `AXIsProcessTrusted()` for the helper process — false means every
   * AX read above is untrusted-empty rather than a real "no windows".
   * `null` when the helper did not report it (older helper build).
   */
  readonly axTrusted: boolean | null;
  readonly observedAt: string;
};

/** The public observe result for the resolved window. */
export type WindowOpsState = {
  readonly pid: number;
  /**
   * Which resolution path produced `window`:
   *
   *   - `"ax-windows"` — the normal AX window enumeration matched the
   *     locator (every pre-#406 resolution).
   *   - `"focused-window"` — the caller opted into `focusedOnly` and the
   *     window resolved through the app's AXFocusedWindow matched
   *     against the WindowServer census (#406). Only the *focused*
   *     window is reachable this way; unfocused windows are
   *     AX-unreachable on AE and this path can never see them.
   */
  readonly resolution: "ax-windows" | "focused-window";
  /**
   * The resolved window's state row. `frame` is non-null for
   * observe-class `state()` (resolution requires it) but may be null in
   * a mutation's `after` — a minimized window can lose its AX frame, and
   * the honest report keeps the row rather than dropping it.
   */
  readonly window: WindowOpsWindowInfo;
  /** App-level focus evidence alongside the window's own flags. */
  readonly app: {
    /** True when `frontmostPid` names this pid. */
    readonly frontmost: boolean;
    readonly frontmostPid: number | null;
  };
  readonly attribution: PanelAttribution;
  /** CGWindowID from the census, when it matched — capture/identity aid. */
  readonly windowNumber: number | null;
  readonly observedAt: string;
};

/** What one mutation asks the vehicle to do. */
export type WindowOpsActRequest = {
  readonly op: WindowOpsOp;
  /**
   * The identity the vehicle re-verifies inside the session immediately
   * before acting — frame within tolerance plus title/subrole when
   * present. Never an index: listings drift.
   */
  readonly expected: {
    readonly title: string;
    readonly subrole: string | null;
    readonly frame: PanelFrame;
  };
  /** `move` target, global points. */
  readonly position?: { readonly x: number; readonly y: number };
  /** `resize` target, points. */
  readonly size?: { readonly width: number; readonly height: number };
};

/** The vehicle's verdict vocabulary. */
export type WindowOpsActVerdict =
  /** The op was applied; `window` carries the post-act readback. */
  | "performed"
  /** No window matched the expected identity — provable non-mutation. */
  | "not-found"
  /** More than one window matched — provable non-mutation. */
  | "ambiguous"
  /** The target process/session was never entered — non-mutation. */
  | "missing"
  /** The op was attempted and errored — outcome unknown. */
  | "failed";

export type WindowOpsActResult = {
  readonly verdict: WindowOpsActVerdict;
  /** The matched element's post-act state, when the vehicle read it. */
  readonly window: WindowOpsWindowInfo | null;
  /**
   * The display frame `maximize` targeted, when the vehicle reported
   * one — the postcondition `maximize` verifies against.
   */
  readonly displayFrame: PanelFrame | null;
  readonly detail: string | null;
};

/**
 * What every window op reports. `before`/`after` are full observations —
 * the postcondition is proven by `after`, and the pair is the evidence.
 * Reaching this result means the bounded postcondition wait held;
 * expiry throws `WindowOpsError` `indeterminate` instead.
 */
export type WindowOpResult = {
  readonly op: WindowOpsOp;
  readonly before: WindowOpsState;
  /**
   * The post-act observation. `null` only when no post-act window row
   * could be read at all (listing lost AND the vehicle's own readback
   * absent) — the postcondition still held, so the op is proven; the
   * evidence row is what is missing.
   */
  readonly after: WindowOpsState | null;
  /** The vehicle verdict, echoed for evidence. */
  readonly verdict: WindowOpsActVerdict;
  /** Focus-holder evidence across the op (B-IME §5.3 shape). */
  readonly focus: {
    readonly before: FocusHolder | null;
    readonly after: FocusHolder | null;
  };
  readonly observedAt: string;
};

/** Stable refusal codes a caller may act on. */
export type WindowOpsErrorCode =
  /** The expected window identity matched nothing. */
  | "not-found"
  /** More than one window matched the locator/identity. */
  | "ambiguous-target"
  /** The resolved surface's attribution is not "owned". */
  | "unproven"
  /** This platform or vehicle has no implementation in this slice. */
  | "unsupported"
  /** A safety gate refuses the operation now. */
  | "refused"
  /** The resolved identity drifted between resolution and act. */
  | "stale-locator"
  /** The target session/process could not be entered or observed. */
  | "unavailable"
  /** Focus could not be proven on the intended window. */
  | "focus-unproven"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate";

export class WindowOpsError extends Error {
  readonly code: WindowOpsErrorCode;
  readonly candidates: readonly string[];

  constructor(
    code: WindowOpsErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "WindowOpsError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The census view resolution needs; mirrors `PanelCensusView`. */
export type WindowOpsCensusView = {
  readonly available: boolean;
  readonly reason: string | null;
  readonly windows: readonly WindowServerWindow[];
};

/**
 * Every OS touch the window-ops controller needs, injected. The
 * production adapter (`src/api/window-ops.ts`, `src/windowops/darwin.ts`)
 * binds these to the compiled `window-ops` helper inside the target
 * session plus the WindowServer census; tests bind fakes.
 */
export type WindowOpsSurfaceOps = {
  /**
   * One window-state observation of the target pid — the same listing
   * the mutation vehicle re-runs, so frame identity is consistent.
   * Observe-class.
   */
  observeWindows(): WindowOpsListing;
  /** The pid's census rows; `available:false` degrades attribution honestly. */
  censusWindows(): WindowOpsCensusView;
  /**
   * The mutation vehicle. Runs under whatever lease/audit/identity
   * checks the platform requires; re-verifies `expected` inside the
   * session immediately before the AX set. Synchronous in this slice —
   * the helper is a single bounded exec.
   */
  act(request: WindowOpsActRequest): WindowOpsActResult;
  /**
   * Read who holds keyboard focus (B-IME §5.3 readback half). `null`
   * means "could not prove" — treated as unproven, never a match.
   */
  readFocusHolder(): FocusHolder | null;
};

/** The mutate-gui gate row; fail-closed like every sibling gate. */
export type WindowOpsMutationGate = (
  op: WindowOpsOp,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Bounded postcondition polling for mutations (spec §10 wait-vs-resend). */
export type WindowOpsPollOptions = {
  /** Total wait budget after the act, ms. Default 10_000. */
  readonly timeoutMs?: number;
  /** Delay between postcondition reads, ms. Default 250. */
  readonly intervalMs?: number;
  /** Frame comparison tolerance in points. Default 4 (AX_FRAME_MATCH_TOLERANCE). */
  readonly frameTolerance?: number;
};

export const DEFAULT_WINDOW_OPS_POLL: Required<WindowOpsPollOptions> = {
  timeoutMs: 10_000,
  intervalMs: 250,
  frameTolerance: 4,
};
