/**
 * Timeline editing operation contract — B-WORKSPACE slice W2 (#364,
 * `specs/workspace-editing/spec.md` §3 W2, parent #345 / program #337).
 *
 * This module fixes the vocabulary for the comp-editing surface:
 *
 *   - timeline scrub (drag the current-time indicator on the ruler);
 *   - layer/property row selection (click a visible row in the Timeline
 *     pane);
 *   - keyframe navigation (click a keyframe diamond or press the
 *     navigator arrows).
 *
 * Every act is `mutate-gui` (spec §5): real mouse input delivered to a
 * re-verified pane frame, behind the mutation gate — fail-closed until
 * A-SAFETY clears the class (`docs/gui-supervision-safety-gates.md`).
 * Every oracle is the hybrid pattern the spec prefers: GUI act + DOM
 * readback (`comp.time`, `layerInfo.selected`, `Property.selected`,
 * keyframe enumeration — all landed in #359). The read channel is
 * recorded on every result and never blended silently.
 *
 * Scripting equivalents (`comp.time =`, `layer.selected =`, keyframe
 * writes) are setup-only per the spec's boundary rule (§2/§4) and never
 * appear as an asserted act here.
 */

import type {
  CompInfo,
  CompTime,
  LayerInfo,
  PropertyInfo,
} from "../api/types.js";
import type { DockedPaneRow } from "../panels/docked/index.js";
import type { PanelFrame, PanelTarget } from "../panels/types.js";

/** Stable refusal codes a caller may act on (spec §6 vocabulary). */
export type TimelineErrorCode =
  /** No row/pane/keyframe matched the locator. */
  | "not-found"
  /** More than one row matched; nearest-match is prohibited. */
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

export class TimelineError extends Error {
  readonly code: TimelineErrorCode;
  /** Candidate row summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: TimelineErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "TimelineError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** A point in the target session's global screen coordinates (points). */
export type TimelinePoint = {
  readonly x: number;
  readonly y: number;
};

/**
 * How a caller names a visible row inside the Timeline pane. Identity is
 * the spec's "visible row identity" (§6): the row's text plus its
 * 1-based ordinal in the pane's row listing. Two rows matching →
 * `ambiguous-target`; there is no nearest-match fallback.
 */
export type TimelineRowLocator = {
  /** The row's visible text — the layer or property name as shown. */
  readonly text: string;
  /**
   * 1-based row ordinal from `DockedPane.rows()`. Optional, but required
   * to disambiguate repeated text (e.g. two layers named alike).
   */
  readonly ordinal?: number;
};

/**
 * The time-ruler geometry a coordinate-bearing op needs, re-verified on
 * every call: the scrubbable ruler/track rectangle inside the resolved
 * pane frame, plus the comp-frame values shown at its left and right
 * edges. AE's timeline ruler AX fidelity is unverified on a real host
 * (spec §11) — callers obtain this from a measured walk, and a rect that
 * no longer sits inside the pane frame is `stale-locator`, not a guess.
 */
export type TimelineRulerGeometry = {
  /** The ruler/track rect in global points; must sit inside the pane frame. */
  readonly frame: PanelFrame;
  /** Comp-frame value displayed at `frame.x` (left edge). */
  readonly startFrame: number;
  /** Comp-frame value displayed at `frame.x + frame.width` (right edge). */
  readonly endFrame: number;
};

/**
 * The DOM readback oracle (spec §3 W2 "Observe (hybrid oracle)"). Every
 * method is read-only — `comp.time`, `comp.layers[].selected`,
 * `layer.property` (`Property.selected`, `isTimeVarying`, `keyframes`).
 * The production binding maps these to the #359 host readbacks through
 * the session; tests bind fakes.
 */
export type TimelineReadback = {
  /** `comp.info` — frameRate is needed to turn key times into frames. */
  comp(comp: string): Promise<CompInfo> | CompInfo;
  /** `comp.time` — the current-time indicator. */
  compTime(comp: string): Promise<CompTime> | CompTime;
  /** `comp.layers` — `LayerInfo.selected` is the layer-selection oracle. */
  layers(comp: string): Promise<readonly LayerInfo[]> | readonly LayerInfo[];
  /**
   * `layer.property` — `PropertyInfo.selected`/`keyframes` are the
   * property/keyframe oracles. `path` segments are names or match names.
   */
  property(
    comp: string,
    layer: string,
    path: readonly string[],
  ): Promise<PropertyInfo> | PropertyInfo;
};

/**
 * The mouse delivery seam. Both methods are optional so a build without
 * the vehicle refuses `unsupported` at preflight — before anything is
 * gated or posted. Coordinates arrive only from re-verified frames
 * (spec §6 "Coordinate fallback"). Production binds `MacGuiRecovery`'s
 * click vehicle for `click`; `drag` stays absent until the B-IME mouse
 * helpers (#372/#373) land, which is the honest `unsupported` answer.
 */
export type TimelineMouseOps = {
  click?(x: number, y: number): boolean | void | Promise<boolean | void>;
  drag?(
    from: TimelinePoint,
    to: TimelinePoint,
  ): boolean | void | Promise<boolean | void>;
};

/** What `scrub` is asked to do. */
export type ScrubRequest = {
  /** Composition name as AE knows it. */
  readonly comp: string;
  /** Target current-time position, in comp frames (fractional allowed). */
  readonly frame: number;
  /** Re-verified ruler geometry the drag coordinates are computed from. */
  readonly ruler: TimelineRulerGeometry;
};

/** Which DOM readback proves a row click selected the intended thing. */
export type TimelineRowVerify =
  | {
      readonly kind: "layer";
      readonly comp: string;
      /** Layer name whose `LayerInfo.selected` must read true. */
      readonly layer: string;
    }
  | {
      readonly kind: "property";
      readonly comp: string;
      readonly layer: string;
      /** Property path (names or match names) whose `selected` must read true. */
      readonly path: readonly string[];
    };

/** What `selectRow` is asked to do. */
export type SelectRowRequest = {
  readonly row: TimelineRowLocator;
  readonly verify: TimelineRowVerify;
};

/** The keyframe a navigation op should land on. */
export type TimelineKeyTarget =
  /** 1-based keyframe index as AE numbers it. */
  | { readonly index: number }
  /** Keyframe time in comp seconds. */
  | { readonly time: number };

/** How `navigateToKeyframe` delivers the act. */
export type TimelineKeyframeVia =
  /** Click the keyframe diamond on the property's timeline row. */
  | "click"
  /** Press the navigator "previous keyframe" arrow. */
  | "navigator-previous"
  /** Press the navigator "next keyframe" arrow. */
  | "navigator-next";

/** What `navigateToKeyframe` is asked to do. */
export type NavigateKeyframeRequest = {
  readonly comp: string;
  readonly layer: string;
  /** Property path (names or match names) whose keyframes are navigated. */
  readonly path: readonly string[];
  readonly key: TimelineKeyTarget;
  readonly via: TimelineKeyframeVia;
  /** Ruler geometry — required for `via: "click"`. */
  readonly ruler?: TimelineRulerGeometry;
  /**
   * The property row to click on for `via: "click"`. Absent means "the
   * row whose text is the property's display name" — repeated names then
   * refuse `ambiguous-target` unless `ordinal` narrows them.
   */
  readonly row?: TimelineRowLocator;
  /**
   * The navigator arrow's recorded `axPath` inside the pane's walked
   * tree — required for `via: "navigator-*"`. Drift is `stale-locator`.
   */
  readonly navigator?: { readonly axPath: string };
};

/** The final verdict of one timeline operation. */
export type TimelineVerdict = "performed" | "refused" | "indeterminate";

/** Fields every operation record carries (the evidence envelope). */
export type TimelineOpRecord = {
  readonly operationId: string;
  readonly operation:
    | "timeline.scrub"
    | "timeline.select-row"
    | "timeline.navigate-keyframe";
  /** Always `mutate-gui`: every act in this slice is GUI input. */
  readonly operationClass: "mutate-gui";
  readonly target: PanelTarget;
  /** The oracle channel — recorded, never blended (spec §2). */
  readonly channel: "gui-act+dom-readback";
  /** The row/pane identity the act was aimed at, for evidence. */
  readonly aimedAt: {
    readonly paneAxPath: string;
    readonly rowAxPath: string | null;
    readonly points: readonly TimelinePoint[];
  };
  readonly verdict: TimelineVerdict;
  readonly refusal: { readonly code: TimelineErrorCode; readonly reason: string } | null;
  readonly observedAt: string;
};

export type ScrubResult = TimelineOpRecord & {
  readonly requestedFrame: number;
  /** The last `comp.time` frame read back; null when never read. */
  readonly observedFrame: number | null;
  readonly toleranceFrames: number;
  /** True only when a postcondition read proved |observed - requested| <= tolerance. */
  readonly withinTolerance: boolean | null;
};

export type SelectRowResult = TimelineOpRecord & {
  readonly row: {
    readonly text: string;
    readonly ordinal: number;
    readonly axPath: string;
  };
  /** The last observed selection state; null when the readback never answered. */
  readonly observedSelected: boolean | null;
};

export type NavigateKeyframeResult = TimelineOpRecord & {
  readonly key: { readonly index: number; readonly time: number };
  /** The comp-frame position the oracle expected the indicator to reach. */
  readonly expectedFrame: number;
  readonly observedFrame: number | null;
  readonly toleranceFrames: number;
  readonly withinTolerance: boolean | null;
};

/** The matched row plus its resolved click point, internal evidence. */
export type ResolvedTimelineRow = DockedPaneRow & {
  readonly point: TimelinePoint;
};
