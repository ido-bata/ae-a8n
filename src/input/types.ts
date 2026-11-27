/**
 * Input operation contract — B-IME foundation (#371,
 * `specs/ime-input/spec.md` §5–§6, parent #344 / program #337).
 *
 * This module fixes, ahead of any real event posting (#372 macOS,
 * #373 Windows), the vocabulary every later input ticket must use:
 *
 *   - the operation taxonomy and its class/scope/gate mapping (§6, §5.1);
 *   - the gate verdict shape (§5.1–§5.4) — fail-closed like
 *     `src/panels/gate.ts`, never a silent no-op;
 *   - the global-input authorization token/scope contract (§5.4);
 *   - the audit record shape (§5.6) and cleanup records (§5.5);
 *   - honest capability reporting (§7) — nothing here may claim
 *     `verified on real host`.
 *
 * Naming deliberately reuses the panel contract (#343): a `PanelTarget`
 * is the only thing an input op addresses, `attribution === "owned"` is
 * required before anything posts, and verdicts stay
 * `performed`/`refused`/`indeterminate`/`failed`. Input adds the
 * *scope* dimension because keystrokes travel session-wide streams.
 */

import type { PanelTarget } from "../panels/types.js";

/** The OS families the input contract reports capabilities for. */
export type InputPlatform = "darwin" | "win32";

/**
 * The input operation taxonomy (spec §6). Working names — the public
 * `ae.input.*` surface is a later ticket (#374) and may rename, but the
 * class/gate mapping fixed here does not change with it.
 */
export const INPUT_OPERATION_KINDS = [
  /** Request/verify focus on the proven target element. */
  "focus",
  /** Key down/up, named keys, modifiers. */
  "key",
  /** Per-character entry through the IME path (Tier-1b driver). */
  "type-sequential",
  /**
   * Bulk/direct entry (clipboard+paste or unicode post). Never IME
   * evidence by itself (spec §4.2). Its clipboard leg is additionally
   * governed as shared-state; see `INPUT_OPERATION_GATES`.
   */
  "type-direct",
  /** Modifier+key selection (`cmd/ctrl+a`, arrows). */
  "select",
  /** Selection replace via typing over a selection. */
  "replace",
  /** Backspace/delete-style removal. */
  "delete",
  /** Clipboard contents read — observe-adjacent, sensitive evidence. */
  "clipboard-read",
  /** Clipboard contents write — always save+restore. */
  "clipboard-write",
  /** Click on the re-verified target frame/element. */
  "mouse-click",
  /** Drag between re-verified points. */
  "mouse-drag",
  /** Scroll over the re-verified target. */
  "mouse-scroll",
  /** Hover over the re-verified target. */
  "mouse-hover",
  /** Select the OS input method / IME mode (user-global state). */
  "ime-mode-select",
  /** Query the current OS input method / IME mode. */
  "ime-mode-query",
  /**
   * Subscribe/read the fixture's own composition report (Tier-1a).
   * Per-surface `supported`/`unsupported`/`unverified` — see
   * `InputCapabilities.compositionObserve`.
   */
  "composition-observe",
] as const;

export type InputOperationKind = (typeof INPUT_OPERATION_KINDS)[number];

/**
 * The panel spec's operation classes, unchanged. `mutate-session`
 * (input affecting windows outside the target pid) is a declared
 * contract value that is out of this slice entirely.
 */
export type InputOperationClass = "observe" | "mutate-gui" | "mutate-session";

/**
 * Where inside `mutate-gui` an operation delivers. This is the input
 * addition over the panel model (spec §5.1): keystrokes have no
 * address, they land on whatever holds focus.
 *
 * - `"target"`: delivered to a proven element/surface (AX focus set,
 *   verified click, coordinate mouse).
 * - `"session-stream"`: posted through the OS-wide input stream
 *   (CGEvent HID/session tap, SendInput). Reaches *whatever is
 *   focused* — safe only after the three-step focus proof (§5.3) and
 *   `requiresGlobalInputAuthorization`.
 * - `"shared-state"`: mutates user-global state (clipboard, IME mode).
 *   Mandatory save-and-restore plus `requiresGlobalInputAuthorization`
 *   where the state is user-global.
 * - `"session"`: `mutate-session` scope — out of slice.
 */
export type InputOperationScope =
  | "target"
  | "session-stream"
  | "shared-state"
  | "session";

/** The gate row for one operation kind (spec §5.1, §6). */
export type InputOperationGate = {
  readonly class: InputOperationClass;
  readonly scope: InputOperationScope;
  /**
   * True when the op needs an explicit `GlobalInputAuthorization`
   * (spec §5.4): session-stream posting and user-global shared state.
   * `observe` and target-scoped ops do not.
   */
  readonly requiresGlobalInputAuthorization: boolean;
};

const TARGET_SCOPED: InputOperationGate = {
  class: "mutate-gui",
  scope: "target",
  requiresGlobalInputAuthorization: false,
};

const SESSION_STREAM: InputOperationGate = {
  class: "mutate-gui",
  scope: "session-stream",
  requiresGlobalInputAuthorization: true,
};

const SHARED_STATE: InputOperationGate = {
  class: "mutate-gui",
  scope: "shared-state",
  requiresGlobalInputAuthorization: true,
};

/**
 * The kind → class/scope/gate table. This is the single mapping every
 * input surface consults; a kind absent from this table cannot run.
 *
 * `type-direct` is `session-stream` because its paste/keystroke leg
 * needs the focus proof; when its vehicle is clipboard-backed the
 * clipboard leg is separately a `clipboard-write` (shared-state) —
 * callers compose the two rather than the kind implying both.
 */
export const INPUT_OPERATION_GATES: Readonly<
  Record<InputOperationKind, InputOperationGate>
> = {
  focus: TARGET_SCOPED,
  key: SESSION_STREAM,
  "type-sequential": SESSION_STREAM,
  "type-direct": SESSION_STREAM,
  select: SESSION_STREAM,
  replace: SESSION_STREAM,
  delete: SESSION_STREAM,
  "clipboard-read": { class: "observe", scope: "target", requiresGlobalInputAuthorization: false },
  "clipboard-write": SHARED_STATE,
  "mouse-click": TARGET_SCOPED,
  "mouse-drag": TARGET_SCOPED,
  "mouse-scroll": TARGET_SCOPED,
  "mouse-hover": TARGET_SCOPED,
  "ime-mode-select": SHARED_STATE,
  "ime-mode-query": { class: "observe", scope: "target", requiresGlobalInputAuthorization: false },
  "composition-observe": { class: "observe", scope: "target", requiresGlobalInputAuthorization: false },
};

/** Stable refusal codes a caller may act on (panel vocabulary + input additions). */
export type InputErrorCode =
  /** No surface matched the locator. */
  | "not-found"
  /** More than one candidate; never a guess. */
  | "ambiguous-target"
  /** The surface exists but pid attribution is not "owned". */
  | "unproven"
  /** This platform/kind has no implementation in this slice. */
  | "unsupported"
  /** The capability exists but a safety/permission gate refuses it now. */
  | "refused"
  /**
   * The operation needs something that does not exist yet — most
   * importantly a `GlobalInputAuthorization` token/scope (spec §5.4).
   * Reported, never a silent no-op.
   */
  | "unavailable"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate"
  /** Focus could not be proven on the intended element before posting. */
  | "focus-unproven"
  /** Focus moved to a different element mid-sequence; the op aborted. */
  | "focus-lost";

/**
 * The explicit authorization session-stream and user-global
 * shared-state input requires (spec §5.4). Authorization is
 * per-operation-class, recorded in the audit event, and never implied
 * by a prior grant.
 *
 * Two scope shapes, matching the spec:
 *
 * - `"session"`: the caller holds a dedicated/isolated session id —
 *   input there cannot reach a foreign console session.
 * - `"target"`: shared/attached session — the grant names exactly one
 *   `PanelTarget` and the operation classes it covers ("this
 *   PanelTarget only, this operation class").
 *
 * `tokenRef` is an opaque reference recorded in the audit record —
 * never the grant material itself.
 */
export type GlobalInputAuthorization =
  | {
      readonly kind: "session";
      /** The dedicated session id the grant covers. */
      readonly sessionId: string;
      readonly tokenRef: string;
    }
  | {
      readonly kind: "target";
      /** pid + surface identity the grant covers. */
      readonly pid: number;
      readonly surfaceKey: string;
      /** The operation classes this grant covers. */
      readonly classes: readonly InputOperationClass[];
      readonly tokenRef: string;
    };

/** What an authorization check was asked about. */
export type InputAuthorizationRequest = {
  readonly operation: InputOperationKind;
  readonly operationClass: InputOperationClass;
  readonly target: PanelTarget;
  /** The session kind the op would run in. */
  readonly sessionKind: "shared" | "dedicated" | "unknown";
  /** The session id when known (dedicated sessions). */
  readonly sessionId?: string | undefined;
};

/** The authorization verdict — `unavailable` is a first-class answer. */
export type InputAuthorizationVerdict =
  | { readonly status: "granted"; readonly tokenRef: string }
  | {
      readonly status: "unavailable" | "refused";
      readonly code: InputErrorCode;
      readonly reason: string;
    };

/**
 * The public input error (#374). Thrown for failures *outside* a plan —
 * target resolution, lease refusal, missing delivery channels — where no
 * `InputAuditRecord` exists yet. Once `runInputPlan` has run, expected
 * refusals come back as the record's `verdict`/`refusal`, never as a throw.
 */
export class InputError extends Error {
  readonly code: InputErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: InputErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "InputError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Who currently holds keyboard focus, as read back by the OS. */
export type FocusHolder = {
  readonly pid: number;
  /**
   * Stable element identity inside the pid — an AX path, UIA
   * automation id, or equivalent. `null` means only the pid-level
   * holder (e.g. the focused window) could be proven.
   */
  readonly element: string | null;
  /** The holding app's name when the OS exposes it; evidence only. */
  readonly app: string | null;
  readonly observedAt: string;
};

/** The expected focus holder for a session-stream op. */
export type ExpectedFocus = {
  readonly pid: number;
  /**
   * The element identity the op intends to type into. `null` accepts
   * any holder inside `pid` (window-level focus only) — weaker proof,
   * recorded as such in the audit record.
   */
  readonly element: string | null;
};

/** Final verdict of one input operation (spec §5.6). */
export type InputVerdict = "performed" | "refused" | "indeterminate" | "failed";

/** One posted step's evidence. Payloads are digested, never raw secrets. */
export type InputStepRecord = {
  readonly index: number;
  readonly kind: InputStepKind;
  /** Human-readable summary (key names, modifier sets — not text bodies). */
  readonly summary: string;
  /**
   * Present for text-bearing steps: length + digest so evidence exists
   * without storing the payload inline (spec §5.6 "flagged" payloads).
   */
  readonly payload?:
    | {
        readonly kind: "text";
        readonly length: number;
        readonly sha256: string;
        readonly sensitive: true;
      }
    | undefined;
  readonly outcome: "posted" | "skipped" | "refused" | "failed";
  readonly detail: string | null;
};

/**
 * A single unit of work inside an input plan. Steps run in order; a
 * session-stream plan re-proves focus before each step (bounded by
 * `recheckEvery` — default every step).
 */
export type InputStep =
  | {
      readonly kind: "key-press";
      readonly key: string;
      readonly modifiers?: readonly string[];
    }
  | {
      readonly kind: "key-down" | "key-up";
      readonly key: string;
      readonly modifiers?: readonly string[];
    }
  | {
      /** Sequential per-character entry through the IME path. */
      readonly kind: "type-sequential";
      readonly text: string;
    }
  | {
      /**
       * Direct/bulk entry. Requires the poster's non-IME channel
       * (`postText`); labelled `direct-entry`, never IME evidence.
       */
      readonly kind: "type-direct";
      readonly text: string;
    }
  | {
      readonly kind: "clipboard-write";
      readonly text: string;
    }
  | {
      /** Select an OS IME/input-source mode by its platform id/name. */
      readonly kind: "ime-mode-select";
      readonly mode: string;
    }
  | {
      /**
       * Escape hatch for ops whose delivery vehicle lands later
       * (mouse drag/scroll, verified-click focus). `run` receives the
       * poster; `summary` is the audit evidence.
       *
       * `channel` names the `InputPoster` member the step needs; when
       * set, preflight refuses `unsupported` up front if the poster
       * lacks it — the same fail-closed check the typed step kinds get.
       */
      readonly kind: "custom";
      readonly summary: string;
      readonly channel?: "mouse";
      readonly run: (poster: InputPoster) => void;
    };

export type InputStepKind = InputStep["kind"];

/**
 * The delivery port every input op posts through. Implementations are
 * the platform helpers (#372/#373); tests use fakes. Every method is
 * optional except the keyboard core — a missing channel makes the
 * matching step refuse `unsupported` at preflight, before anything
 * posts.
 */
export type InputPoster = {
  keyDown(key: string, modifiers?: readonly string[]): void;
  keyUp(key: string, modifiers?: readonly string[]): void;
  /** Sequential IME-path text entry (per-char key events). */
  typeSequential?(text: string): void;
  /** Direct unicode post that bypasses the IME — never Tier-1b. */
  postText?(text: string): void;
  clipboardWrite?(text: string): void;
  imeSelect?(mode: string): void;
  mouse?(event: InputMouseEvent): void;
};

/** Mouse delivery request; coordinates come from the re-verified frame only. */
export type InputMouseEvent =
  | { readonly type: "click"; readonly x: number; readonly y: number; readonly button?: "left" | "right" }
  | { readonly type: "drag"; readonly from: { x: number; y: number }; readonly to: { x: number; y: number } }
  | { readonly type: "scroll"; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | { readonly type: "hover"; readonly x: number; readonly y: number };

/** What an input plan asks the runner to do. */
export type InputPlan = {
  readonly operation: InputOperationKind;
  readonly steps: readonly InputStep[];
  /**
   * For `composition-observe` and readback ops: what committed-value /
   * observable result to read after posting (spec §5.3 step "Post").
   * The runner records `requested` vs `observed` separately.
   */
  readonly readback?: () => Promise<string | null> | string | null;
};

/**
 * Clipboard prior-state record. Contents are represented by flavor
 * names + digest + size — the snapshot needed to restore, not the
 * payload itself (spec §5.5, §5.6 sensitive-evidence rule).
 */
export type ClipboardSnapshot = {
  readonly flavors: readonly string[];
  readonly sha256: string;
  readonly bytes: number;
};

/** IME/input-source mode record (platform mode id or name). */
export type ImeModeSnapshot = {
  readonly mode: string | null;
};

/** One cleanup action the runner guarantees in `finally` (spec §5.5). */
export type InputCleanupAction =
  | {
      readonly type: "key-up";
      readonly key: string;
      readonly modifiers: readonly string[];
      /** True when this release comes from the residue sweep, not the plan. */
      readonly residue: boolean;
    }
  | { readonly type: "release-modifiers"; readonly modifiers: readonly string[] }
  | { readonly type: "restore-clipboard"; readonly snapshot: ClipboardSnapshot }
  | { readonly type: "restore-ime-mode"; readonly snapshot: ImeModeSnapshot }
  | {
      readonly type: "resolve-composition";
      readonly resolution: "commit" | "cancel";
    }
  | { readonly type: "restore-focus"; readonly holder: FocusHolder };

/** The outcome of one cleanup action — failures are reported, not hidden. */
export type InputCleanupResult = {
  readonly action: InputCleanupAction;
  readonly outcome: "performed" | "skipped" | "failed";
  readonly detail: string | null;
};

/** The cleanup section of the audit record. */
export type InputCleanupReport = {
  readonly actions: readonly InputCleanupResult[];
  /** True when every required restore/release completed or was honestly skipped. */
  readonly allRestored: boolean;
};

/** Focus section of the audit record (spec §5.3, §5.6). */
export type InputFocusEvidence = {
  /** Holder read before the focus request, when one was taken. */
  readonly before: FocusHolder | null;
  /** Holder proven by the pre-post readback. */
  readonly proven: FocusHolder | null;
  /** Holder after the last post/readback. */
  readonly after: FocusHolder | null;
  /** Element-level proof, or null when only pid-level focus was proven. */
  readonly elementProven: boolean;
  /** True when focus moved mid-sequence and the op aborted. */
  readonly changedMidSequence: boolean;
};

/**
 * The audit record every input op emits (spec §5.6). Tier-1a
 * composition events and the Tier-1b OS-IME verdict are separate
 * fields by contract — they are never merged into one "IME works".
 */
export type InputAuditRecord = {
  readonly operationId: string;
  readonly target: PanelTarget;
  readonly operation: InputOperationKind;
  readonly operationClass: InputOperationClass;
  readonly scope: InputOperationScope;
  /** Authorization evidence: token reference + granted scope, or null. */
  readonly authorization: {
    readonly tokenRef: string;
    readonly scope: "session" | "target";
  } | null;
  readonly focus: InputFocusEvidence;
  readonly steps: readonly InputStepRecord[];
  /** Tier-1a: what the fixture's own composition report saw, if wired. */
  readonly tier1a: {
    readonly compositionEvents: number;
    readonly detail: string | null;
  } | null;
  /** Tier-1b: the OS-IME end-to-end verdict, kept distinct from Tier-1a. */
  readonly tier1b: {
    readonly verdict: "unverified" | "observed" | "failed";
    readonly detail: string | null;
  } | null;
  readonly valueReadback: {
    readonly requested: string | null;
    readonly observed: string | null;
  } | null;
  readonly cleanup: InputCleanupReport;
  readonly verdict: InputVerdict;
  readonly refusal: { readonly code: InputErrorCode; readonly reason: string } | null;
  readonly observedAt: string;
};
