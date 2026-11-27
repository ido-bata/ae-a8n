/**
 * Comp-view pan/zoom operation contract — B-WORKSPACE W4+ slice (#367,
 * `specs/workspace-editing/spec.md` §12 deferred list, parent #345 /
 * program #337).
 *
 * This module fixes the vocabulary for the comp viewer surface:
 *
 *   - pan: a mouse drag inside the re-verified viewer viewport;
 *   - zoom: a dropdown selection inside the comp pane, or a
 *     session-stream shortcut chord.
 *
 * There is no DOM readback for viewer pan/zoom — `comp.*` exposes time
 * and layers, not view state — so the oracle is the spec's §4 answer:
 * a capture artifact diff plus panel-region geometry. The act channel
 * and the evidence channel are recorded on every result and never
 * blended silently.
 *
 * Every act is `mutate-gui` (spec §5): real mouse input or an
 * authorized session-stream chord delivered to a re-verified pane
 * frame, behind the mutation gate — fail-closed until A-SAFETY clears
 * the class (`docs/gui-supervision-safety-gates.md`, `src/comp-view/
 * gate.ts`). Shortcut chords additionally pass the B-IME
 * `GlobalInputAuthorization` check (`inputAuthorizationVerdict`) because
 * session-stream keys have no address — they land on whatever holds
 * focus.
 */

import type { PanelFrame, PanelTarget } from "../panels/types.js";
import type { SessionStreamAuthorization } from "../input/session-stream.js";

/** Stable refusal codes a caller may act on (spec §6 vocabulary). */
export type CompViewErrorCode =
  /** No control/pane matched the locator. */
  | "not-found"
  /** More than one candidate matched; nearest-match is prohibited. */
  | "ambiguous-target"
  /** The surface exists but pid attribution is not "owned". */
  | "unproven"
  /** This platform/kind has no implementation in this slice. */
  | "unsupported"
  /** The capability exists but the mutation gate refuses it now. */
  | "refused"
  /**
   * A recorded locator no longer resolves to the same element — the AX
   * tree or pane geometry drifted. The caller re-resolves; nothing is
   * remapped by guesswork (spec §6).
   */
  | "stale-locator"
  /** Observation or the delivery channel could not run. */
  | "unavailable"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate";

export class CompViewError extends Error {
  readonly code: CompViewErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: CompViewErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CompViewError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * How a caller names a node inside the comp pane's walked AX tree —
 * the same `axPath` vocabulary `ae.dockedPane().tree()` records. The
 * path is a re-resolution hint: drift is `stale-locator`, never a
 * silent remap (spec §6).
 */
export type CompViewAxLocator = {
  readonly axPath: string;
  /**
   * Optional identity check: when present the resolved node's title
   * must match exactly, so a path that now names a different element
   * is `stale-locator` rather than a click on the wrong control.
   */
  readonly title?: string;
};

/**
 * The mouse delivery seam, same shape as `TimelineMouseOps`: both
 * methods are optional so a build without the vehicle refuses
 * `unsupported` at preflight — before anything is gated or posted.
 * Coordinates arrive only from re-verified frames (spec §6
 * "Coordinate fallback"). Production binds `MacGuiRecovery`'s click
 * vehicle for `click`; `drag` stays absent until the B-IME mouse
 * helpers land, which is the honest `unsupported` answer.
 */
export type CompViewMouseOps = {
  click?(x: number, y: number): boolean | void | Promise<boolean | void>;
  drag?(
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
  ): boolean | void | Promise<boolean | void>;
};

/**
 * One capture sample — the evidence half of the pan/zoom oracle. The
 * production binding writes a region capture under the session's
 * artifacts dir and reports path + content hash; tests bind fakes.
 */
export type CompViewCapture = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

/**
 * The capture seam. `frame` is always the re-verified pane frame —
 * the capture is scoped to the comp pane, never the whole screen.
 * Required for every op in this slice: without it the oracle the spec
 * prescribes (capture diff + panel geometry) does not exist, and the
 * controller refuses `unsupported` at preflight.
 */
export type CompViewCaptureOps = {
  capture(frame: PanelFrame): CompViewCapture | Promise<CompViewCapture>;
};

/** What `pan` is asked to do. */
export type CompViewPanRequest = {
  /**
   * The draggable viewer-content rectangle inside the comp pane, in
   * global points. It must still sit inside the resolved pane frame —
   * a rect that drifted out is `stale-locator`, the same rule the
   * timeline ruler follows. Obtain it from a measured walk; there is
   * no remembered-position fallback.
   */
  readonly viewport: PanelFrame;
  /** Drag delta in points; the comp content follows the pointer. */
  readonly delta: { readonly dx: number; readonly dy: number };
  /**
   * When true (default) an unchanged post-act capture is `indeterminate`
   * — a pan that changed no pixel cannot be told apart from a pan that
   * did not happen (uniform content produces the same capture honestly).
   * Pass `false` to accept `"identical"` as the recorded evidence.
   */
  readonly expectCaptureChange?: boolean;
};

/** How `zoom` delivers the act. */
export type CompViewZoomRequest = {
  /**
   * The requested zoom level — evidence of intent only. AE's viewer
   * exposes no DOM zoom readback, so the result is proven by the
   * capture diff and the recorded control identity, never by assuming
   * the percent landed.
   */
  readonly percent: number;
  /**
   * When true (default) an unchanged post-act capture is
   * `indeterminate`. Pass `false` for zoom-to-same-percent cases.
   */
  readonly expectCaptureChange?: boolean;
} & (
  | {
      /**
       * Click the zoom dropdown control, then click the item inside the
       * reopened walk. Both nodes are `axPath` locators re-resolved
       * against fresh walks — the item path is verified in the
       * post-open tree, so a popup that drifted is `stale-locator`.
       */
      readonly via: "dropdown";
      /** The zoom dropdown button/pop-up control inside the pane tree. */
      readonly control: CompViewAxLocator;
      /** The dropdown item to select, resolved after the control opens. */
      readonly item: CompViewAxLocator;
    }
  | {
      /**
       * Post a session-stream key chord (e.g. the comp-view zoom
       * shortcut). Session-stream keys have no address — they land on
       * whatever holds focus — so this leg additionally requires a
       * `GlobalInputAuthorization` grant (`authorization`,
       * `sessionKind`, `sessionId`) evaluated through
       * `inputAuthorizationVerdict` before anything posts.
       */
      readonly via: "shortcut";
      readonly key: string;
      readonly modifiers?: readonly string[];
    } & SessionStreamAuthorization
);

/** The final verdict of one comp-view operation. */
export type CompViewVerdict = "performed" | "refused" | "indeterminate";

/** Fields every operation record carries (the evidence envelope). */
export type CompViewOpRecord = {
  readonly operationId: string;
  readonly operation: "comp-view.pan" | "comp-view.zoom";
  /** Always `mutate-gui`: every act in this slice is GUI input. */
  readonly operationClass: "mutate-gui";
  readonly target: PanelTarget;
  /**
   * The oracle channel — recorded, never blended (spec §2/§4). There
   * is no DOM readback for view state; the honest channels are the
   * capture diff and the re-verified pane geometry.
   */
  readonly channel:
    | "gui-act+capture-diff+geometry"
    | "gui-act+session-stream+capture-diff";
  /** The control/points the act was aimed at, for evidence. */
  readonly aimedAt: {
    readonly paneAxPath: string;
    readonly controlAxPath: string | null;
    readonly points: readonly { readonly x: number; readonly y: number }[];
  };
  readonly verdict: CompViewVerdict;
  readonly refusal: { readonly code: CompViewErrorCode; readonly reason: string } | null;
  readonly observedAt: string;
};

/** The capture-diff half of the oracle. */
export type CompViewCaptureDelta = {
  readonly before: CompViewCapture;
  readonly after: CompViewCapture;
  /** True when the content hashes differ — the capture saw a change. */
  readonly changed: boolean;
};

export type PanResult = CompViewOpRecord & {
  readonly viewport: PanelFrame;
  readonly delta: { readonly dx: number; readonly dy: number };
  /** The pane frame before and after the act; `null` when unread. */
  readonly paneFrameBefore: PanelFrame | null;
  readonly paneFrameAfter: PanelFrame | null;
  /** True when the pane frame stayed put within tolerance; null when unread. */
  readonly geometryStable: boolean | null;
  readonly captureDelta: CompViewCaptureDelta | null;
};

export type ZoomResult = CompViewOpRecord & {
  readonly percent: number;
  readonly via: "dropdown" | "shortcut";
  readonly paneFrameBefore: PanelFrame | null;
  readonly paneFrameAfter: PanelFrame | null;
  readonly geometryStable: boolean | null;
  readonly captureDelta: CompViewCaptureDelta | null;
  /**
   * The session-stream leg's verdict for `via: "shortcut"`; `null`
   * for the dropdown path. Authorization evidence is inside the
   * vehicle's own audit — this records only what the seam reported.
   */
  readonly sessionStream:
    | { readonly verdict: string; readonly code: string | null; readonly reason: string | null }
    | null;
};
