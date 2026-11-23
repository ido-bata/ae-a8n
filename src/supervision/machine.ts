/**
 * The supervision state machine (specs/gui-supervision/spec.md §Supervision
 * state machine, #280).
 *
 * Pure transition logic: an event plus the current document produces the
 * next document, or a refusal. No I/O, no clocks beyond the `now` the
 * caller passes — every rule is unit-testable without a host.
 *
 * Invariants enforced here, not by convention:
 *
 *   - Every phase that owes a wait (`blocked`, `recovering`,
 *     `needs-human`, `quarantined`) carries a deadline. A transition that
 *     would leave one without is refused.
 *   - `resumed` is only reachable from `recovering` via `recovery-succeeded`;
 *     it means blocking cleared AND the request outcome was reconciled.
 *   - Health events never change the phase. A `monitor-lost` heartbeat does
 *     not make a `blocked` session "running" — it makes the *observation*
 *     untrustworthy, which `evaluateObservationHealth` reports separately.
 *   - Terminal-for-now states (`needs-human`, `quarantined`) leave only via
 *     an explicit human-resolution event, never implicitly.
 */

import type {
  BlockingInfo,
  MonitorRecord,
  ObservationHealth,
  PendingRequest,
  SupervisionPhase,
  SupervisionStateDoc,
  SupervisionTransition,
} from "./types.js";
import { SUPERVISION_SCHEMA_VERSION } from "./types.js";

/** Bound on recorded transitions; oldest are dropped first. */
export const MAX_HISTORY = 50;

/** Default bounded wait per non-running phase, when the event omits one. */
export const DEFAULT_PHASE_DEADLINE_MS = 15 * 60 * 1000;

export type SupervisionEvent =
  /** Observation saw a blocking window or host-level block. */
  | {
      readonly kind: "blocking-observed";
      readonly blocking: BlockingInfo;
      readonly pendingRequests?: readonly PendingRequest[];
      readonly deadlineMs?: number;
      readonly reason: string;
    }
  /** Observation sees no blocking state. */
  | { readonly kind: "observe-clear"; readonly reason: string }
  /** An automated recovery attempt began. */
  | { readonly kind: "recovery-started"; readonly reason: string }
  /** Recovery cleared the block and the request outcome was reconciled. */
  | { readonly kind: "recovery-succeeded"; readonly reason: string }
  /**
   * Recovery ended without clearing the block. `to` selects the next phase:
   * still blocked (retryable), needs-human, or quarantined.
   */
  | {
      readonly kind: "recovery-failed";
      readonly to: "blocked" | "needs-human" | "quarantined";
      readonly reason: string;
      readonly blocking?: BlockingInfo;
      readonly deadlineMs?: number;
    }
  /** Automation cannot proceed; a structured human decision is required. */
  | {
      readonly kind: "needs-human";
      readonly reason: string;
      readonly blocking?: BlockingInfo;
      readonly deadlineMs?: number;
    }
  /** State is unclassifiable; nothing may be pressed. */
  | {
      readonly kind: "quarantine";
      readonly reason: string;
      readonly blocking?: BlockingInfo;
      readonly deadlineMs?: number;
    }
  /** A human resolved the blocker; supervision may retry recovery. */
  | { readonly kind: "human-resolved"; readonly reason: string }
  /** The monitor wrote a heartbeat: it is alive and observing. */
  | { readonly kind: "monitor-heartbeat"; readonly monitor: MonitorRecord }
  /** The monitor's heartbeat went stale. */
  | { readonly kind: "monitor-lost"; readonly reason: string }
  /** A probe reported degraded observation (still answering partially). */
  | { readonly kind: "probe-degraded"; readonly reason: string }
  /** Probes are answering again. */
  | { readonly kind: "probe-ok"; readonly reason: string }
  /** Track a request's execution state for reconciliation. */
  | {
      readonly kind: "request-outcome";
      readonly requestId: string;
      readonly outcome: PendingRequest["state"];
    };

export type TransitionResult =
  | { readonly ok: true; readonly doc: SupervisionStateDoc }
  | { readonly ok: false; readonly reason: string };

function deadlineFrom(now: Date, deadlineMs: number | undefined): string {
  return new Date(now.getTime() + (deadlineMs ?? DEFAULT_PHASE_DEADLINE_MS)).toISOString();
}

function pushHistory(
  doc: SupervisionStateDoc,
  from: SupervisionPhase | "init",
  to: SupervisionPhase,
  at: string,
  reason: string,
): SupervisionTransition[] {
  const entry: SupervisionTransition = { from, to, at, reason };
  const history = [...doc.history, entry];
  return history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
}

function base(doc: SupervisionStateDoc, now: Date): SupervisionStateDoc {
  return { ...doc, updatedAt: now.toISOString() };
}

function enter(
  doc: SupervisionStateDoc,
  to: SupervisionPhase,
  now: Date,
  fields: Partial<SupervisionStateDoc>,
  reason: string,
): SupervisionStateDoc {
  // The bounded-wait invariant is enforced on the result, not trusted to
  // callers: a blocking phase without a deadline is a contract violation.
  const owesWait =
    to === "blocked" || to === "recovering" || to === "needs-human" || to === "quarantined";
  const waits = to === "running" || to === "resumed";
  const { deadline: requestedDeadline, ...rest } = fields;
  const deadline = owesWait
    ? (requestedDeadline ?? deadlineFrom(now, undefined))
    : waits
      ? null
      : (requestedDeadline ?? doc.deadline);
  return {
    ...base(doc, now),
    phase: to,
    enteredAt: now.toISOString(),
    history: pushHistory(doc, doc.phase, to, now.toISOString(), reason),
    ...rest,
    deadline,
  };
}

function samePending(
  doc: SupervisionStateDoc,
  pending: readonly PendingRequest[] | undefined,
): readonly PendingRequest[] {
  return pending ?? doc.pendingRequests;
}

/**
 * Apply one event. Refusals return `{ ok: false }` with the reason — the
 * caller decides whether that is a bug or an expected race; the machine
 * never silently picks a different transition.
 */
export function applySupervisionEvent(
  doc: SupervisionStateDoc,
  event: SupervisionEvent,
  now: Date,
): TransitionResult {
  switch (event.kind) {
    case "blocking-observed": {
      if (doc.phase === "quarantined") {
        // A quarantined session stays quarantined until a human resolves it;
        // new observations are evidence, not a transition.
        return {
          ok: true,
          doc: base(
            {
              ...doc,
              blocking: event.blocking,
              pendingRequests: samePending(doc, event.pendingRequests),
            },
            now,
          ),
        };
      }
      if (doc.phase === "needs-human") {
        // Still waiting on the human; refresh evidence only.
        return {
          ok: true,
          doc: base(
            {
              ...doc,
              blocking: event.blocking ?? doc.blocking,
              pendingRequests: samePending(doc, event.pendingRequests),
            },
            now,
          ),
        };
      }
      return {
        ok: true,
        doc: enter(
          doc,
          "blocked",
          now,
          {
            blocking: event.blocking,
            pendingRequests: samePending(doc, event.pendingRequests),
            deadline: deadlineFrom(now, event.deadlineMs),
          },
          event.reason,
        ),
      };
    }

    case "observe-clear": {
      if (doc.phase === "blocked" || doc.phase === "recovering") {
        // Clearing the window is not reconciliation: go to `recovering`
        // (awaiting outcome check) rather than claiming `resumed`.
        if (doc.phase === "blocked") {
          return {
            ok: true,
            doc: enter(doc, "recovering", now, { blocking: null }, event.reason),
          };
        }
        return { ok: true, doc: base({ ...doc, blocking: null }, now) };
      }
      if (doc.phase === "resumed") {
        return { ok: true, doc: enter(doc, "running", now, {}, event.reason) };
      }
      return { ok: true, doc: base(doc, now) };
    }

    case "recovery-started": {
      if (doc.phase !== "blocked" && doc.phase !== "needs-human" && doc.phase !== "quarantined") {
        return { ok: false, reason: `cannot start recovery from phase "${doc.phase}"` };
      }
      return {
        ok: true,
        doc: enter(doc, "recovering", now, { deadline: deadlineFrom(now, undefined) }, event.reason),
      };
    }

    case "recovery-succeeded": {
      if (doc.phase !== "recovering") {
        return { ok: false, reason: `cannot mark recovery succeeded from phase "${doc.phase}"` };
      }
      return {
        ok: true,
        doc: enter(doc, "resumed", now, { blocking: null }, event.reason),
      };
    }

    case "recovery-failed": {
      if (doc.phase !== "recovering") {
        return { ok: false, reason: `cannot fail recovery from phase "${doc.phase}"` };
      }
      return {
        ok: true,
        doc: enter(
          doc,
          event.to,
          now,
          {
            blocking: event.blocking ?? doc.blocking,
            deadline: deadlineFrom(now, event.deadlineMs),
          },
          event.reason,
        ),
      };
    }

    case "needs-human": {
      if (doc.phase === "quarantined") {
        return { ok: false, reason: "a quarantined session cannot downgrade to needs-human" };
      }
      return {
        ok: true,
        doc: enter(
          doc,
          "needs-human",
          now,
          {
            blocking: event.blocking ?? doc.blocking,
            deadline: deadlineFrom(now, event.deadlineMs),
          },
          event.reason,
        ),
      };
    }

    case "quarantine": {
      return {
        ok: true,
        doc: enter(
          doc,
          "quarantined",
          now,
          {
            blocking: event.blocking ?? doc.blocking,
            deadline: deadlineFrom(now, event.deadlineMs),
          },
          event.reason,
        ),
      };
    }

    case "human-resolved": {
      if (doc.phase !== "needs-human" && doc.phase !== "quarantined") {
        return { ok: false, reason: `no human decision is pending in phase "${doc.phase}"` };
      }
      return {
        ok: true,
        doc: enter(doc, "recovering", now, { deadline: deadlineFrom(now, undefined) }, event.reason),
      };
    }

    case "monitor-heartbeat": {
      const health: ObservationHealth =
        doc.observationHealth === "monitor-lost" ? "ok" : doc.observationHealth;
      return {
        ok: true,
        doc: base(
          {
            ...doc,
            monitor: event.monitor,
            observationHealth: health,
          },
          now,
        ),
      };
    }

    case "monitor-lost": {
      return {
        ok: true,
        doc: base({ ...doc, observationHealth: "monitor-lost" }, now),
      };
    }

    case "probe-degraded": {
      if (doc.observationHealth === "monitor-lost") {
        // A dead monitor outranks probe degradation: we cannot tell a
        // degraded probe from a lost one, so the worse answer stands.
        return { ok: true, doc: base(doc, now) };
      }
      // The reason is the evidence: "degraded" without it cannot be
      // diagnosed by any consumer reading the durable document. Repeat
      // ticks with the same reason do not append — evidence is a log of
      // changes, not a heartbeat.
      const entry = `probe-degraded: ${event.reason}`;
      const evidence =
        doc.evidence[doc.evidence.length - 1] === entry
          ? doc.evidence
          : [...doc.evidence, entry];
      return {
        ok: true,
        doc: base(
          {
            ...doc,
            observationHealth: "degraded",
            evidence: evidence.slice(-MAX_HISTORY),
          },
          now,
        ),
      };
    }

    case "probe-ok": {
      // "unavailable" is promoted too: a document initialised before its
      // first heartbeat starts there, and a live monitor whose probe now
      // answers cleanly must not stay unavailable forever.
      if (doc.observationHealth !== "degraded" && doc.observationHealth !== "unavailable") {
        return { ok: true, doc: base(doc, now) };
      }
      return { ok: true, doc: base({ ...doc, observationHealth: "ok" }, now) };
    }

    case "request-outcome": {
      const pendingRequests = doc.pendingRequests.map((request) =>
        request.id === event.requestId ? { ...request, state: event.outcome } : request,
      );
      return { ok: true, doc: base({ ...doc, pendingRequests }, now) };
    }
  }
}

/** A fresh document for a session whose monitor just started. */
export function initialSupervisionDoc(options: {
  readonly sessionId?: string | null;
  readonly monitor?: MonitorRecord | null;
  readonly now: Date;
}): SupervisionStateDoc {
  const at = options.now.toISOString();
  return {
    schemaVersion: SUPERVISION_SCHEMA_VERSION,
    sessionId: options.sessionId ?? null,
    phase: "running",
    observationHealth: options.monitor === undefined || options.monitor === null ? "unavailable" : "ok",
    blocking: null,
    pendingRequests: [],
    enteredAt: at,
    deadline: null,
    evidence: [],
    monitor: options.monitor ?? null,
    history: [{ from: "init", to: "running", at, reason: "supervision started" }],
    updatedAt: at,
  };
}
