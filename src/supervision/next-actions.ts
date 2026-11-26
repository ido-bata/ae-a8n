/**
 * The machine-readable next-action contract (#341, parent program #337
 * US-A4).
 *
 * Every runtime surface that can stop automation — the CLI envelope, a
 * typed API error, the durable supervision report — answers "what may the
 * caller do next" with the same shape, so an agent that never read the
 * supervision Skill can still decide from the response alone.
 *
 * Contract rules, fixed here and tested in `test/runtime-guidance.test.ts`:
 *
 *   - `kind` says WHO the action is for (`automatic` | `human`); it is the
 *     existing envelope axis, unchanged for compatibility.
 *   - `allowed` says whether an AUTOMATED actor may perform it now. It is
 *     never `true` for an action that needs a permission grant, a human
 *     decision, or a state automation must not touch — those are reported
 *     with `allowed: false` (or as `kind: "human"`), never recommended.
 *   - `reason.code` is a stable machine code from
 *     `NEXT_ACTION_REASON_CODES`. `reason.detail` is optional prose and is
 *     never required for a judgement.
 *   - `action` is human-readable prose for display. A consumer MUST NOT
 *     parse it: the judgement fields are `kind`, `allowed`, `code` and
 *     `reason.code`. Prose may describe a step ("re-run supervise
 *     status"); it is never an instruction to run arbitrary shell, OCR
 *     text, or an out-of-permission operation.
 *   - A request whose outcome is unproven (`unknown`, `timed-out`) never
 *     produces an allowed `retry`-class action: resend is forbidden, so no
 *     builder here emits one.
 */

/**
 * The stable vocabulary for `NextAction.reason.code`. Append-only like the
 * diagnostic codes: a code's meaning does not change; new situations get
 * new codes.
 */
export const NEXT_ACTION_REASON_CODES = [
  /** An automated actor may perform the action now. */
  "permitted",
  /** A human decision or action is required; automation must stop here. */
  "requires-human",
  /** An OS or application permission grant is required first. */
  "requires-permission",
  /** Wait within the phase/request deadline; the state may clear itself. */
  "bounded-wait",
  /** The request outcome cannot be proven; resending is forbidden. */
  "unknown-outcome",
  /** The request provably never reached the host; retrying is safe. */
  "not-sent",
  /** Measured or unclassified state automation must not act on. */
  "unsafe-to-automate",
  /** The evidence needed to decide is missing, unreadable, or corrupt. */
  "evidence-unavailable",
  /** The observer stopped; the target's current state is unknown. */
  "monitor-lost",
  /** The session ownership/grant contract refuses the operation. */
  "session-policy",
] as const;

export type NextActionReasonCode = (typeof NEXT_ACTION_REASON_CODES)[number];

export type NextActionReason = {
  /** Stable machine code — the field a consumer branches on. */
  readonly code: NextActionReasonCode;
  /** Optional short elaboration. Never required for a judgement. */
  readonly detail?: string;
};

/**
 * One machine-readable next action. `code` identifies the action/condition
 * (a diagnostic code like `A8N-PERM-004` or a dotted supervision code like
 * `supervision.needs-human`); `reason` says why it is offered or withheld.
 */
export type NextAction = {
  /** Who performs the action: an automated caller or a human. */
  readonly kind: "automatic" | "human";
  /**
   * Whether an automated actor may perform it now. `false` on a
   * `kind: "automatic"` entry means the path exists but is not permitted
   * in the current state (e.g. rebuild before process loss is proven);
   * `kind: "human"` entries are always `false` — they are for a person.
   */
  readonly allowed: boolean;
  /** Stable identifier of the action or the condition behind it. */
  readonly code: string;
  /** Why this action is offered or withheld, with a stable code. */
  readonly reason: NextActionReason;
  /** Human-readable description for display; never the contract. */
  readonly action: string;
};

export type NextActionInput = {
  readonly kind: "automatic" | "human";
  readonly allowed: boolean;
  readonly code: string;
  readonly reason: NextActionReasonCode | NextActionReason;
  readonly action: string;
};

/**
 * Build one next action. This is the only constructor: every surface
 * (envelope, errors, supervision report) goes through it so the contract
 * cannot drift per call site.
 */
export function nextAction(input: NextActionInput): NextAction {
  const reason: NextActionReason =
    typeof input.reason === "string" ? { code: input.reason } : input.reason;
  return {
    kind: input.kind,
    allowed: input.allowed,
    code: input.code,
    reason,
    action: input.action,
  };
}

/* ------------------------------------------------------------------ */
/* Named builders for the recurring situations.                        */
/* ------------------------------------------------------------------ */

/**
 * Read the evidence (state document, report, trace). Always permitted:
 * observation mutates nothing.
 */
export function inspectAction(
  code: string,
  action: string,
  reasonCode: NextActionReasonCode = "permitted",
  detail?: string,
): NextAction {
  return nextAction({
    kind: "automatic",
    allowed: true,
    code,
    reason: { code: reasonCode, ...(detail === undefined ? {} : { detail }) },
    action,
  });
}

/**
 * Wait for the bounded phase/request deadline. Permitted only while a
 * deadline exists — callers must not emit this for unbounded waits.
 */
export function waitAction(
  code: string,
  action: string,
  reasonCode: NextActionReasonCode = "bounded-wait",
  detail?: string,
): NextAction {
  return nextAction({
    kind: "automatic",
    allowed: true,
    code,
    reason: { code: reasonCode, ...(detail === undefined ? {} : { detail }) },
    action,
  });
}

/**
 * A human must decide or act. `allowed` is always `false`: this entry
 * exists so the consumer knows automation stopped on purpose, not so
 * automation performs it.
 */
export function humanAction(
  code: string,
  reasonCode: NextActionReasonCode,
  action: string,
  detail?: string,
): NextAction {
  return nextAction({
    kind: "human",
    allowed: false,
    code,
    reason: { code: reasonCode, ...(detail === undefined ? {} : { detail }) },
    action,
  });
}

/**
 * Retry the same request. Only for provably-unsent requests (`not-sent`):
 * an unknown or timed-out outcome must never produce this.
 */
export function retryAction(code: string, action: string): NextAction {
  return nextAction({
    kind: "automatic",
    allowed: true,
    code,
    reason: { code: "not-sent" },
    action,
  });
}
