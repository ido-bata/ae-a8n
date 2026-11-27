/**
 * Drag-drop contract (#422, `specs/workspace-editing/spec.md` §5, §9
 * "File/element drag-drop", §10, §12 W4+; parent #345 / program #337).
 *
 * This module fixes the vocabulary the drag-drop slice uses:
 *
 *   - Two operation kinds, both `mutate-gui` target-scoped (spec §5):
 *     `"file-drop"` — an NSDraggingSession file payload vended by OUR
 *     helper process and dropped onto a re-verified owned surface
 *     (fixture files only; #411 proved `vend=fileurl` + CGEvent lands
 *     on AE 2027's Project panel); and `"element-drag"` — a plain
 *     CGEvent press→move→release inside the owned window for in-app
 *     element drags (Project/Timeline reorder proved in #411).
 *   - The target is a `DragDropSurfaceLocator`: the window listing
 *     index plus the identity that entry must still carry at act time —
 *     the same "locator, not handle" rule `ContextMenuTargetLocator`
 *     carries.
 *   - Drop verification is a DOM delta (`project.items` readback) plus
 *     the recorded census/attribution evidence — never the drag
 *     receipt alone (spec §2 readback ≠ mutation).
 *
 * Safety shape (spec §10 drag-sequence integrity):
 *
 *   - The drop point must sit inside the re-verified frame AND be
 *     provably topmost-owned in the WindowServer census immediately
 *     before posting — an aux panel or foreign window covering the
 *     point refuses before anything posts (#411's aux-panel coverage
 *     lesson).
 *   - `element-drag` posts in segments: press → interpolated moves →
 *     release. Between segments the controller re-checks the topmost
 *     census window and the surface identity; a change aborts — the
 *     button is released at the last verified point and the op reports
 *     `not-performed`/`indeterminate`, never "finishes the drag".
 *     `file-drop` is atomic inside the helper's NSDraggingSession —
 *     its internal segments cannot be re-checked from outside and the
 *     contract says so.
 *   - No resend anywhere: a drag that may have landed is
 *     `indeterminate`; the only retry is a fresh caller-initiated op.
 *
 * Verification level: contract is `automated test` against fakes.
 * The macOS vehicle and the file-drop oracle are `verified on real
 * host` (#411 PoC + this ticket's e2e evidence) — see
 * `docs/gui-supervision-safety-gates.md` for the class decision.
 */

import type { GuiFrame, GuiWindowInfo } from "../driver/gui-recovery.js";

/** Stable refusal codes a caller may act on. */
export type DragDropErrorCode =
  /** This platform/kind has no implementation (Windows in this slice). */
  | "unsupported"
  /** The locator itself is malformed (bad index, point outside frame). */
  | "invalid-locator"
  /** No candidate matched. */
  | "not-found"
  /** More than one candidate matched; never a guess. */
  | "ambiguous-target"
  /** The surface exists but pid attribution is not "owned". */
  | "unproven"
  /** The resolved surface or drop point moved/vanished before the act. */
  | "stale-locator"
  /** The target session, census or file probe could not be produced. */
  | "unavailable"
  /** A safety gate or policy refuses the operation now. */
  | "refused"
  /** The bounded wait expired or an act's outcome is unknown. */
  | "indeterminate"
  /** The drag sequence aborted mid-flight on a focus/attribution change. */
  | "focus-lost";

export class DragDropError extends Error {
  readonly code: DragDropErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: DragDropErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DragDropError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** A point in global display coordinates (points, top-left origin). */
export type DragDropPoint = {
  readonly x: number;
  readonly y: number;
};

/**
 * How a caller names the drop/drag surface (spec §6): the window
 * listing index plus the identity that entry must still carry at act
 * time — title, subrole and frame, re-verified immediately before the
 * post. Drag endpoints must lie inside `expected.frame`; there is no
 * remembered-position fallback.
 */
export type DragDropSurfaceLocator = {
  /** 1-based position in the `observe()` window listing. */
  readonly windowIndex: number;
  readonly expected: {
    readonly title: string;
    readonly subrole: string | null;
    readonly frame: GuiFrame;
  };
};

/**
 * One project item as the `project.items` DOM readback reports it —
 * panel order, id/name/type. This is the drop oracle (spec §2 hybrid
 * oracle): observation channel, never the mutation channel.
 */
export type DragDropProjectItem = {
  readonly id: number | null;
  readonly name: string;
  readonly type: string | null;
};

/** The oracle snapshot taken before and after a drag. */
export type DragDropSnapshot = {
  /** `project.items` in panel order; `null` when the readback failed. */
  readonly items: readonly DragDropProjectItem[] | null;
  /** `project.state.itemCount` cross-check when available. */
  readonly itemCount: number | null;
  readonly observedAt: string;
};

/** What changed between the before/after oracle snapshots. */
export type DragDropDelta = {
  /** Item names present after but not before (multiset difference). */
  readonly addedNames: readonly string[];
  /** Item names present before but not after. */
  readonly removedNames: readonly string[];
  /** True when the surviving items' relative order changed. */
  readonly orderChanged: boolean;
  /** itemCount(after) - itemCount(before); null when either side lacked it. */
  readonly countDelta: number | null;
};

/** The file payload of a `file-drop` — a fixture file only (spec §5/§13). */
export type DragDropFilePayload = {
  /** Absolute path to the file to vend. Must exist and be a regular file. */
  readonly path: string;
  /**
   * Pasteboard flavors the dragging item advertises. `"fileurl"` is the
   * #411-proven `public.file-url` vend; `"legacy"` additionally
   * advertises `NSFilenamesPboardType` + utf8 text (Finder-like).
   * Default `"fileurl"`.
   */
  readonly vend?: "fileurl" | "legacy";
};

/** A `file-drop` request: vend `file` and drop it at `to`. */
export type DragDropFileRequest = {
  readonly kind: "file-drop";
  readonly surface: DragDropSurfaceLocator;
  readonly file: DragDropFilePayload;
  /**
   * The drop point in global points — must lie inside the re-verified
   * surface frame AND be census-proven topmost-owned at act time.
   */
  readonly to: DragDropPoint;
  /**
   * Where the helper's source window appears (the drag origin). Default:
   * 160pt above `to`, clamped to the screen — the helper window is ours
   * and floats, so this point needs no ownership proof, only screen
   * bounds.
   */
  readonly from?: DragDropPoint;
};

/** An `element-drag` request: press at `from`, release at `to`. */
export type DragDropElementRequest = {
  readonly kind: "element-drag";
  readonly surface: DragDropSurfaceLocator;
  /** Press point — inside the re-verified frame, census-proven owned. */
  readonly from: DragDropPoint;
  /** Release point — inside the re-verified frame. */
  readonly to: DragDropPoint;
  /** Intermediate move count; default 24 (the #411-proven pacing). */
  readonly steps?: number;
  /** Delay between segment moves, ms; default 16. */
  readonly stepDelayMs?: number;
  /** Hover dwell at `to` before release, ms; default 0. */
  readonly dwellMs?: number;
};

export type DragDropRequest = DragDropFileRequest | DragDropElementRequest;

/** The mutation ops the gate distinguishes (spec §5 row). */
export type DragDropMutationOp = "drop-file" | "element-drag";

/** The mutate-gui gate row; fail-closed like every sibling gate. */
export type DragDropMutationGate = (
  op: DragDropMutationOp,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * The raw verdict a drag vehicle reports for one posted sequence.
 * `"performed"` means the press→move→release sequence completed — it
 * says NOTHING about whether the drop landed; that is the oracle's
 * job. `"not-performed"` means the vehicle proved nothing was dragged
 * (session never began, identity lost before the first move).
 * `"failed"` means the outcome is unknown.
 */
export type DragDropVerdict = "performed" | "not-performed" | "failed";

/**
 * One segment's re-check evidence inside an element drag (spec §10:
 * focus/attribution re-checked between segments, abort on change).
 */
export type DragDropSegmentCheck = {
  readonly index: number;
  readonly point: DragDropPoint;
  /** What the topmost census reported at the point. */
  readonly topmostPid: number | null;
  readonly topmostWindowNumber: number | null;
  /** Whether the check passed (topmost still the owned surface's pid). */
  readonly ok: boolean;
};

/** What a completed drag op proved, with before/after evidence. */
export type DragDropResult = {
  readonly kind: DragDropRequest["kind"];
  /** The vehicle verdict — "performed" means posted, not landed. */
  readonly vehicle: DragDropVerdict;
  /** The NSDraggingSession operation when the vehicle reported one. */
  readonly dragOperation: string | null;
  /** The DOM delta the oracle observed across the bounded wait. */
  readonly delta: DragDropDelta;
  /** True when the declared postcondition held within the wait budget. */
  readonly verified: boolean;
  /** File identity evidence for file-drop (name/size/digest). */
  readonly file: {
    readonly path: string;
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  } | null;
  /** Per-segment re-check records for element-drag; empty for file-drop. */
  readonly segments: readonly DragDropSegmentCheck[];
  /** Why the sequence aborted early, when it did. */
  readonly aborted: string | null;
  readonly observedAt: string;
};

/** What the topmost-census pre-flight proved at one point. */
export type DragDropTopmost = {
  readonly pid: number;
  readonly windowNumber: number | null;
  readonly layer: number | null;
  readonly bounds: GuiFrame | null;
};

/** The probed identity of a candidate drop file. */
export type DragDropFileProbe = {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly size: number;
  readonly sha256: string;
};

/**
 * Every OS/DOM touch the controller needs, injected. The production
 * adapter (`src/api/drag-drop.ts`) binds these to `MacGuiRecovery`,
 * the WindowServer census, the compiled `input-drag` helper and the
 * `project.items`/`project.state` host readbacks; tests bind fakes.
 */
export type DragDropOps = {
  /** One Accessibility+WindowServer observation of the target pid. */
  observe(): GuiAppStateLike;
  /**
   * The WindowServer z-order answer at a global point: the topmost
   * on-screen app window (layer >= 0) covering it, or null. Census
   * unavailable must surface as an error/`null` the controller treats
   * as fail-closed — never as "no window".
   */
  topmostAt(point: DragDropPoint): DragDropTopmost | null;
  /**
   * Bring the target app forward (best-effort; the census gates remain
   * the authority). Optional — absent means the platform has no
   * activation channel and the op relies on the gates alone.
   */
  activate?(): void | Promise<void>;
  /**
   * Probe a candidate drop file: existence, regular-file-ness, size and
   * content digest. `null`/`exists:false` refuses before anything posts.
   */
  probeFile?(path: string): DragDropFileProbe | null;
  /**
   * The DOM oracle: `project.items` + `project.state.itemCount` in one
   * snapshot. Optional — absent means the op cannot verify a drop and
   * reports `unavailable` rather than posting unverifiable mutation.
   */
  readback?(): Promise<DragDropSnapshot> | DragDropSnapshot;
  /**
   * Segmented element-drag vehicle (spec §10). `press` posts
   * mouseMoved+leftMouseDown, `move` one leftMouseDragged to the point,
   * `release` leftMouseUp. Each returns the vehicle verdict; a missing
   * channel refuses `unsupported` before anything posts.
   */
  press?(point: DragDropPoint): Promise<DragDropVerdict> | DragDropVerdict;
  move?(point: DragDropPoint): Promise<DragDropVerdict> | DragDropVerdict;
  release?(point: DragDropPoint): Promise<DragDropVerdict> | DragDropVerdict;
  /**
   * The atomic file-drop vehicle: vend `file.path` in an
   * NSDraggingSession from a helper window at `from` and drop at `to`.
   * One call = one complete press→move→release; the internal segments
   * are not externally re-checkable (see module doc). `dragOperation`
   * carries the session's reported NSDragOperation when known.
   */
  fileDrag?(request: {
    readonly file: DragDropFilePayload;
    readonly from: DragDropPoint;
    readonly to: DragDropPoint;
    readonly steps: number;
    readonly stepDelayMs: number;
    readonly dwellMs: number;
  }): Promise<{ readonly verdict: DragDropVerdict; readonly operation: string | null }> | {
    readonly verdict: DragDropVerdict;
    readonly operation: string | null;
  };
};

/** The `GuiAppState` shape the controller consumes (kept loose for fakes). */
export type GuiAppStateLike = {
  readonly pid: number;
  readonly frontmost: boolean;
  readonly windows: readonly GuiWindowInfo[];
};

/** Bounded postcondition polling for the drop oracle (spec §10). */
export type DragDropPollOptions = {
  /** Total wait budget after the act, ms. Default 10_000. */
  readonly timeoutMs?: number;
  /** Delay between oracle reads, ms. Default 250. */
  readonly intervalMs?: number;
};

export const DEFAULT_DRAGDROP_POLL: Required<DragDropPollOptions> = {
  timeoutMs: 10_000,
  intervalMs: 250,
};
