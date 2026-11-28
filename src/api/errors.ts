/**
 * Errors the public API throws.
 *
 * Every failure a caller can meaningfully branch on has its own type. A
 * `HostError` bubbling out of the bridge with a raw ExtendScript message is a
 * leak, not an API.
 */

import { HostError, ProtocolError } from "../protocol/envelope.js";
import {
  HostLeftRunningError,
  HostQuarantinedError,
  HostUnavailableError,
  TimeoutError,
} from "../driver/driver.js";
import { errorMessage } from "../errors.js";
import type { HostCondition } from "../driver/driver.js";
import {
  AttachTargetError,
  ScriptNotSentError,
  type AttachFailureReason,
} from "../driver/transport.js";
import { ScriptInvocationError } from "../driver/script-invocation.js";
import { classifyAppleEventError } from "../driver/apple-event-denials.js";
import {
  humanAction,
  inspectAction,
  nextAction,
  retryAction,
  waitAction,
  type NextAction,
} from "../supervision/next-actions.js";
import type { PropertyKind } from "./types.js";

export {
  AttachTargetError,
  HostLeftRunningError,
  HostQuarantinedError,
  HostUnavailableError,
  ProtocolError,
  ScriptNotSentError,
  TimeoutError,
};

export class AfterEffectsError extends Error {
  /** Operation that failed, as it appears in the trace. */
  readonly op: string;
  /** The diagnostic code, when the failure has one the caller may act on. */
  readonly code?: string;
  /**
   * What the host looked like when a call timed out — `gone`,
   * `unresponsive`, `modal` or `unknown`. Present only on timeout failures;
   * the `TimeoutError` that produced it stays available as `cause`.
   */
  readonly hostCondition?: HostCondition;
  /**
   * Machine-readable next actions for this failure (#341): the same
   * `kind`/`allowed`/`code`/`reason.code` contract the CLI envelope and
   * the supervision report use. Present on errors `contextualise`
   * produces; absent on errors thrown directly by validation code.
   */
  readonly nextActions?: readonly NextAction[];

  constructor(
    message: string,
    op: string,
    options?: {
      cause?: unknown;
      code?: string;
      hostCondition?: HostCondition;
      nextActions?: readonly NextAction[];
    },
  ) {
    super(message, options);
    this.name = "AfterEffectsError";
    this.op = op;
    if (options?.code !== undefined) {
      this.code = options.code;
    }
    if (options?.hostCondition !== undefined) {
      this.hostCondition = options.hostCondition;
    }
    if (options?.nextActions !== undefined) {
      this.nextActions = options.nextActions;
    }
  }
}

export class EntityNotFoundError extends AfterEffectsError {
  /** Entity kind, e.g. `composition` or `effect`. */
  readonly kind: string;

  constructor(kind: string, identifier: string, op: string) {
    super(`${kind} not found: ${identifier}`, op, {
      nextActions: [
        nextAction({
          kind: "automatic",
          allowed: true,
          code: "entity.not-found",
          reason: "permitted",
          action:
            "List the session's entities and re-issue with an identifier that exists; nothing was changed.",
        }),
      ],
    });
    this.name = "EntityNotFoundError";
    this.kind = kind;
  }
}

/**
 * The open project has unsaved changes and the operation would discard them.
 * Not a failure of After Effects: a decision the caller has to make, by
 * repeating the call with `unsavedChanges: "discard"`.
 */
export class UnsavedChangesError extends AfterEffectsError {
  constructor(op: string, options?: { cause?: unknown }) {
    super(`${op} refused: the open project has unsaved changes`, op, {
      ...options,
      nextActions: [
        nextAction({
          kind: "automatic",
          allowed: true,
          code: "project.unsaved-changes",
          reason: "permitted",
          action:
            "Decide explicitly: repeat the call with `unsavedChanges: \"discard\"` to drop the changes, or save/close the project first. Automation must not choose silently.",
        }),
      ],
    });
    this.name = "UnsavedChangesError";
  }
}

/**
 * The operation changes After Effects in a way only the session that started
 * it may: running a menu command, or setting the process environment. A host
 * that was already running, or whose identity cannot be confirmed, belongs to
 * someone else. `ownership` is what the session saw.
 */
export class HostNotOwnedError extends AfterEffectsError {
  readonly ownership: string;

  constructor(op: string, ownership: string, evidence: string) {
    super(`${op} refused: this session does not own After Effects (${ownership}: ${evidence})`, op, {
      nextActions: [
        humanAction(
          "session.ownership",
          "session-policy",
          "This session may not perform the operation on a host it does not own. " +
            "Launch a session that owns the target, or pass the matching `authorization` grant at launch for an attached host.",
        ),
      ],
    });
    this.name = "HostNotOwnedError";
    this.ownership = ownership;
  }
}

/**
 * The loaded host script does not declare the method. Nothing was sent: an
 * unknown name is refused before a request is written, so a typo cannot
 * become an After Effects error far from its cause.
 */
export class ExtensionMethodNotFoundError extends AfterEffectsError {
  readonly method: string;
  readonly declared: readonly string[];

  constructor(op: string, method: string, declared: readonly string[]) {
    super(
      `${op} refused: the host script declares no method "${method}"` +
        (declared.length === 0 ? " (it declares none)" : `; declared: ${declared.join(", ")}`),
      op,
      {
        nextActions: [
          nextAction({
            kind: "automatic",
            allowed: true,
            code: "extension.method-not-found",
            reason: "permitted",
            action: `Call one of the declared methods (${declared.join(", ") || "none"}) or rebuild the extension; nothing was sent.`,
          }),
        ],
      },
    );
    this.name = "ExtensionMethodNotFoundError";
    this.method = method;
    this.declared = declared;
  }
}

/**
 * A read or write of a property that has no value a script can use: a
 * NO_VALUE or CUSTOM_VALUE property, or a group. Nothing was written.
 */
export class PropertyHasNoValueError extends AfterEffectsError {
  /** Why there is no value: `no-value`, `custom-value`, or `group`. */
  readonly kind: Exclude<PropertyKind, "value">;
  /** The parameter identifier the caller used. */
  readonly property: string;

  constructor(
    kind: Exclude<PropertyKind, "value">,
    property: string,
    op: string,
    options?: { cause?: unknown },
  ) {
    super(`${op} refused: ${property} has no value to read or write (${kind})`, op, {
      ...options,
      nextActions: [
        nextAction({
          kind: "automatic",
          allowed: true,
          code: "parameter.no-value",
          reason: "permitted",
          action:
            "Pick a property that holds a scriptable value (check `kind` via the property list); nothing was written.",
        }),
      ],
    });
    this.name = "PropertyHasNoValueError";
    this.kind = kind;
    this.property = property;
  }
}

/**
 * A value of the wrong shape for the property's type: a number for a point
 * or colour, an array for a single number, the wrong number of elements, or
 * a non-finite element. The host refuses before writing; nothing changed.
 */
export class ParameterValueError extends AfterEffectsError {
  /** The property's value type, e.g. `COLOR`. */
  readonly valueType: string;
  /** The parameter identifier the caller used. */
  readonly property: string;

  constructor(valueType: string, property: string, op: string, message: string, options?: { cause?: unknown }) {
    super(`${op} refused: ${message}`, op, {
      ...options,
      nextActions: [
        nextAction({
          kind: "automatic",
          allowed: true,
          code: "parameter.bad-value",
          reason: "permitted",
          action:
            "Fix the value's shape for the property's value type and retry; the host refused before writing, so nothing changed.",
        }),
      ],
    });
    this.name = "ParameterValueError";
    this.valueType = valueType;
    this.property = property;
  }
}

export { HostError };
export type { AttachFailureReason };

/** Next actions for a timed-out call, keyed on the classified host state (#341). */
function timeoutNextActions(hostCondition: HostCondition | undefined): readonly NextAction[] {
  switch (hostCondition) {
    case "modal":
      // A blocking window may still be recovered by supervision; the
      // durable report is the authority on whether automation may act.
      return [
        waitAction(
          "runtime.timeout.modal",
          "A modal window may be blocking After Effects. Wait within the supervision phase deadline, then re-check `ae.supervisionState()`; automation never presses unmeasured dialogs.",
        ),
        inspectAction(
          "runtime.timeout.modal",
          "Read the supervision report for the blocking window's tier and classification before deciding anything else.",
        ),
      ];
    case "gone":
      return [
        inspectAction(
          "runtime.timeout.gone",
          "Read `ae.supervisionState()`: only a `blocked`/`process-gone` document on an owned session proves the host is gone.",
        ),
        nextAction({
          kind: "automatic",
          allowed: false,
          code: "session.rebuild",
          reason: "session-policy",
          action:
            "`AfterEffects.rebuild` may relaunch only after supervision proves process loss on an owned session; attached and unknown sessions are never restarted.",
        }),
        humanAction(
          "runtime.timeout.gone",
          "requires-human",
          "If the session cannot prove ownership, a human decides whether to relaunch After Effects.",
        ),
      ];
    case "unresponsive":
      return [
        waitAction(
          "runtime.timeout.unresponsive",
          "The After Effects process is alive but did not answer (busy, render, or startup). Wait and retry the read-only check; do not resend the timed-out request — its outcome is unproven.",
        ),
        inspectAction(
          "runtime.timeout.unresponsive",
          "Check `ae.supervisionState()` and the session trace for what the host was doing at the deadline.",
        ),
      ];
    case "unknown":
      return [
        inspectAction(
          "runtime.timeout.unknown",
          "The host condition could not be classified. Read `ae.supervisionState()` and the session trace before assuming the host is gone or alive.",
        ),
        humanAction(
          "runtime.timeout.unknown",
          "unsafe-to-automate",
          "Do not resend or rebuild on an unclassified timeout; a human confirms the host state first.",
        ),
      ];
    default:
      return [
        inspectAction(
          "runtime.timeout",
          "The call timed out without a host classification. Read `ae.supervisionState()` and the session trace; the timed-out request's outcome is unproven and must not be resent.",
        ),
      ];
  }
}

/** Next actions for an Apple Events denial, keyed on the stable error number. */
function appleEventNextActions(code: number): readonly NextAction[] {
  if (code === -1708 || code === -1743) {
    return [
      humanAction(
        `apple-events.${code}`,
        "requires-permission",
        "macOS refused the Apple Event: grant After Effects automation/trust permission in System Settings (or approve the prompt in After Effects), then retry. ae-a8n never changes OS permission settings itself.",
      ),
      inspectAction(
        `apple-events.${code}`,
        "The session trace records the denied call; nothing ran.",
      ),
    ];
  }
  if (code === -1712) {
    return [
      waitAction(
        `apple-events.${code}`,
        "After Effects showed a modal dialog. Wait within the supervision deadline and re-check `ae.supervisionState()`; the request's outcome is unproven.",
      ),
      inspectAction(`apple-events.${code}`, "Read the supervision report for the blocking window's tier."),
    ];
  }
  if (code === -609) {
    return timeoutNextActions("gone");
  }
  return [
    inspectAction(
      `apple-events.${code}`,
      "Read the session trace and `ae.supervisionState()`; the denial number is recorded there.",
    ),
  ];
}

/**
 * Re-labels a transport error with the operation that produced it, keeping the
 * original as `cause` so nothing is lost. Every produced `AfterEffectsError`
 * also carries machine-readable `nextActions` (#341) so a caller that never
 * read the supervision Skill can still decide the next permitted step.
 */
export function contextualise(op: string, error: unknown): never {
  if (error instanceof EntityNotFoundError) {
    throw error;
  }
  if (error instanceof HostError && error.name === "UnsavedChangesError") {
    throw new UnsavedChangesError(op, { cause: error });
  }
  if (error instanceof HostError) {
    throw new AfterEffectsError(
      `${op} failed in After Effects: ${error.message}` +
        (error.aeError === undefined ? "" : ` (AE error ${error.aeError})`),
      op,
      {
        cause: error,
        nextActions: [
          inspectAction(
            "bridge.host-error",
            "The host reported a script error; the request's outcome is known (it failed). Read the session trace for the AE error, fix the script or inputs, then retry deliberately.",
          ),
        ],
      },
    );
  }
  if (error instanceof TimeoutError) {
    throw new AfterEffectsError(error.message, op, {
      cause: error,
      ...(error.hostCondition !== undefined ? { hostCondition: error.hostCondition } : {}),
      nextActions: timeoutNextActions(error.hostCondition),
    });
  }
  if (error instanceof ScriptInvocationError) {
    // A refused or unanswered Apple Event carries a number with a distinct
    // remedy (-1708 trust, -1743 Automation, -1712 modal, -609 gone). Name
    // it and its next action instead of leaving a raw osascript line.
    const denial = classifyAppleEventError(error.stderr);
    throw new AfterEffectsError(
      denial === null
        ? `${op} failed: ${error.message}`
        : `${op} failed: ${error.message} ` +
            `(Apple Events ${denial.code}: ${denial.meaning}. Next: ${denial.nextAction})`,
      op,
      {
        cause: error,
        nextActions:
          denial === null
            ? [
                inspectAction(
                  "bridge.script-invocation",
                  "The script invocation failed before a classified denial; read the session trace for stderr.",
                ),
              ]
            : appleEventNextActions(denial.code),
      },
    );
  }
  if (error instanceof ScriptNotSentError) {
    // The call never reached the host: it did not fail there, and nothing ran.
    throw new AfterEffectsError(
      `${op} was not sent to After Effects: ${error.message}. Nothing ran.`,
      op,
      {
        cause: error,
        nextActions: [
          retryAction(
            "runtime.not-sent",
            "The request provably never reached After Effects, so retrying the same call is safe — nothing ran.",
          ),
          inspectAction(
            "runtime.not-sent",
            "If retries keep failing, read the session trace for why the request could not be delivered.",
          ),
        ],
      },
    );
  }
  if (error instanceof HostLeftRunningError) {
    // The process this session started is still out there and is not this
    // session's to quit. The code and the identity travel so a caller (and
    // the run report) can tell this from a timeout it may be tempted to retry.
    throw new AfterEffectsError(error.message, op, {
      cause: error,
      code: error.code,
      nextActions: [
        inspectAction(
          error.code,
          "The launched host is still running and is not this session's to quit; its pid and identity are recorded in launch provenance.",
        ),
        humanAction(
          "runtime.host-left-running",
          "requires-human",
          "A human decides whether to keep or quit the leftover After Effects process; automation never quits a host it does not own.",
        ),
      ],
    });
  }
  if (error instanceof HostQuarantinedError) {
    // A licence, sign-in or permission window: the operation is blocked on a
    // person, not late. The code travels so a caller (and the run report) can
    // tell this apart from a timeout it may be tempted to retry.
    throw new AfterEffectsError(error.message, op, {
      cause: error,
      code: error.code,
      nextActions: [
        inspectAction(
          error.code,
          "A licence, sign-in or permission window is blocking After Effects; `ae.supervisionState()` carries the window's classification.",
        ),
        humanAction(
          "runtime.host-quarantined",
          "requires-permission",
          "A human resolves the licence/sign-in/permission prompt inside After Effects; automation never approves consent, licence or OS permission dialogs.",
        ),
      ],
    });
  }
  if (error instanceof ProtocolError) {
    throw new AfterEffectsError(
      `${op} got an unreadable response from the After Effects bridge: ${error.message}`,
      op,
      {
        cause: error,
        nextActions: [
          inspectAction(
            "bridge.protocol",
            "The bridge answered with an unreadable response; the request's outcome is unproven — do not resend. Read the session trace for the raw exchange.",
          ),
        ],
      },
    );
  }
  if (error instanceof AfterEffectsError) {
    throw error;
  }
  throw new AfterEffectsError(
    `${op} failed: ${errorMessage(error)}`,
    op,
    {
      cause: error,
      nextActions: [
        inspectAction(
          "runtime.error",
          "An unclassified failure stopped the operation; read the session trace for the underlying error before retrying.",
        ),
      ],
    },
  );
}
