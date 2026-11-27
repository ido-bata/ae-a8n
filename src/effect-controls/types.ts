/**
 * Effect Controls operation contract — B-WORKSPACE W4+ slice (#367,
 * `specs/workspace-editing/spec.md` §12 deferred list "effect
 * controls", §3 W2 boundary rule, parent #345 / program #337).
 *
 * This module fixes the vocabulary for the Effect Controls docked
 * pane:
 *
 *   - fold/unfold an effect's parameter section;
 *   - edit a parameter control's value through the GUI.
 *
 * The boundary rule (spec §2/§4) is load-bearing here: DOM mutation
 * (`layer.applyEffect`, `effect.setParameter`) is **setup-only** — the
 * asserted path is GUI. Parameter readback is the hybrid oracle the
 * spec prefers: GUI act + DOM `effect.getParameter` value. Fold state
 * has no DOM readback, so its oracle is the pane's visible-row delta —
 * recorded as evidence, never claimed from one channel alone.
 *
 * Every act is `mutate-gui` (spec §5): a click inside a re-verified
 * pane frame, plus — for value entry — a session-stream type+commit
 * chord that carries `requiresGlobalInputAuthorization` (B-IME §5.4)
 * because keystrokes land on whatever holds focus. All of it stays
 * behind the mutation gate — fail-closed until A-SAFETY clears the
 * class (`docs/gui-supervision-safety-gates.md`, `src/effect-controls/
 * gate.ts`).
 */

import type { PanelTarget } from "../panels/types.js";
import type { PropertyInfo, ParameterValue } from "../api/types.js";
import type { GlobalInputAuthorization } from "../input/types.js";

/** Stable refusal codes a caller may act on (spec §6 vocabulary).
 * The set intentionally mirrors `CompViewErrorCode`/`TimelineErrorCode`
 * so callers see one refusal vocabulary across the workspace slices. */
export type EffectControlsErrorCode =
   /** No row/pane/control matched the locator. */
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

export class EffectControlsError extends Error {
  readonly code: EffectControlsErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: EffectControlsErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "EffectControlsError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * How a caller names a visible row/control inside the Effect Controls
 * pane. Identity is the spec's "visible row identity" (§6): the row's
 * text plus its 1-based ordinal among text-matching candidates. Two
 * rows matching → `ambiguous-target`; there is no nearest-match
 * fallback.
 */
export type EffectControlsRowLocator = {
  /** The row's visible text — the effect or parameter name as shown. */
  readonly text: string;
  /**
   * 1-based ordinal among the text-matching candidates, in walk order.
   * Optional, but required to disambiguate repeated text.
   */
  readonly ordinal?: number;
};

/**
 * The click delivery seam. Optional so a build without the vehicle
 * refuses `unsupported` at preflight — before anything is gated or
 * posted. Coordinates arrive only from re-verified frames (spec §6).
 * Production binds `MacGuiRecovery`'s click vehicle.
 */
export type EffectControlsMouseOps = {
  click?(x: number, y: number): boolean | void | Promise<boolean | void>;
};

/**
 * The DOM readback oracle (spec §3 W2 "hybrid oracle" applied to
 * effect controls): `effect.getParameter` — read-only. The production
 * binding maps this to the host readback through the session; tests
 * bind fakes. `setParameter` (the mutation) is deliberately absent —
 * it is setup-only per the spec boundary rule and never an asserted
 * act here.
 */
export type EffectControlsReadback = {
  /**
   * `effect.getParameter` — the parameter's current `PropertyInfo`.
   * `effect`/`parameter` are names or match names, as the host
   * resolves them.
   */
  parameter(
    comp: string,
    layer: string,
    effect: string,
    parameter: string,
  ): Promise<PropertyInfo> | PropertyInfo;
};

/** What `setFolded` is asked to do. */
export type SetFoldedRequest = {
  /** The effect's display name as shown in the Effect Controls pane. */
  readonly effect: string;
  /** Target fold state: `true` collapses the parameter section. */
  readonly folded: boolean;
  /**
   * Optional ordinal among same-named effect headers. Required when
   * two effects share a display name — otherwise `ambiguous-target`.
   */
  readonly ordinal?: number;
};

/** What `setParameter` is asked to do. */
export type SetParameterRequest = {
  readonly comp: string;
  readonly layer: string;
  /** Effect name or match name, as `layer.effects`/`effect.*` resolve it. */
  readonly effect: string;
  /** Parameter name or match name on that effect. */
  readonly parameter: string;
  /** The value to enter — same shape `effect.getParameter` reports. */
  readonly value: ParameterValue;
  /**
   * Absolute tolerance for the DOM readback match. Default 1e-6 —
   * GUI entry is decimal text, so callers editing float parameters may
   * widen it.
   */
  readonly valueTolerance?: number;
  /**
   * The parameter row's visible identity. Absent means "the row whose
   * text is the parameter's display name" — repeated names then refuse
   * `ambiguous-target` unless `ordinal` narrows them.
   */
  readonly row?: EffectControlsRowLocator;
  /**
   * Optional recorded `axPath` of the value control inside the walked
   * tree (e.g. the slider/text field node). Re-resolved with drift
   * checks; absent means the op clicks the row frame's value gutter —
   * the right edge inset — which is the documented, unverified
   * real-host assumption (spec §11).
   */
  readonly control?: {
    readonly axPath: string;
    readonly title?: string;
  };
  /**
   * Session-stream authorization for the type+commit leg. Value entry
   * is keystroke delivery — it has no address and lands on whatever
   * holds focus — so it requires a `GlobalInputAuthorization` grant
   * evaluated through `inputAuthorizationVerdict` before anything
   * posts, plus a wired `sessionStream` poster.
   */
  readonly authorization?: GlobalInputAuthorization | null;
  /** Session kind the act would run in (default `"unknown"`). */
  readonly sessionKind?: "shared" | "dedicated" | "unknown";
  readonly sessionId?: string | undefined;
};

/** The final verdict of one Effect Controls operation. */
export type EffectControlsVerdict = "performed" | "refused" | "indeterminate";

/** Fields every operation record carries (the evidence envelope). */
export type EffectControlsOpRecord = {
  readonly operationId: string;
  readonly operation: "effect-controls.set-folded" | "effect-controls.set-parameter";
  /** Always `mutate-gui`: every act in this slice is GUI input. */
  readonly operationClass: "mutate-gui";
  readonly target: PanelTarget;
  /**
   * The oracle channel — recorded, never blended (spec §2). Fold
   * verifies through the pane's row delta; parameter edit verifies
   * through the DOM `effect.getParameter` readback.
   */
  readonly channel: "gui-act+row-delta" | "gui-act+dom-readback";
  /** The row/control the act was aimed at, for evidence. */
  readonly aimedAt: {
    readonly paneAxPath: string;
    readonly rowAxPath: string | null;
    readonly control: "disclosure-node" | "header-gutter" | "value-control" | "value-gutter" | null;
    readonly points: readonly { readonly x: number; readonly y: number }[];
  };
  readonly verdict: EffectControlsVerdict;
  readonly refusal: { readonly code: EffectControlsErrorCode; readonly reason: string } | null;
  readonly observedAt: string;
};

export type SetFoldedResult = EffectControlsOpRecord & {
  readonly effect: string;
  readonly folded: boolean;
  /** Visible-row count before/after the act; `null` when unreadable. */
  readonly rowsBefore: number | null;
  readonly rowsAfter: number | null;
  /**
   * True when the row delta has the sign the fold direction predicts
   * (fewer rows folded, more unfolded); `null` when either count was
   * unreadable. This is evidence, not proof — recorded honestly.
   */
  readonly rowDeltaMatches: boolean | null;
};

export type SetParameterResult = EffectControlsOpRecord & {
  readonly comp: string;
  readonly layer: string;
  readonly effect: string;
  readonly parameter: string;
  /** The formatted text the session-stream leg was asked to enter. */
  readonly enteredText: string;
  /** The last `effect.getParameter` value observed; `null` when never read. */
  readonly observedValue: ParameterValue | null;
  readonly valueTolerance: number;
  /** True only when a postcondition read proved |observed - requested| <= tolerance. */
  readonly withinTolerance: boolean | null;
  /** The session-stream leg's verdict; `null` when it never ran. */
  readonly sessionStream: {
    readonly verdict: string;
    readonly code: string | null;
    readonly reason: string | null;
  } | null;
};
