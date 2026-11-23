/**
 * Supervision contract types (specs/gui-supervision/spec.md, ADR-0005, #280).
 *
 * These are the platform-neutral shapes every supervision component —
 * probes, the state machine, the durable store, consumers — shares. Nothing
 * here imports macOS or Windows code, so the contract is testable on any
 * host and identical for CLI, MCP and editor consumers.
 *
 * Honesty rules baked into the shape:
 *
 *   - `observationHealth` is reported separately from `phase`. A dead
 *     monitor or a degraded probe is never folded into "running".
 *   - Every non-`running` phase carries a deadline: supervision waits are
 *     bounded by contract, not by convention.
 *   - `unknown` is a first-class answer. Missing, corrupt or future-version
 *     state is `unavailable`, never an empty healthy report.
 */

import type { DialogWindow } from "../platform/recovery-policy.js";
import type {
  DialogTier,
  StructuredDialogContent,
} from "../platform/dialog-taxonomy.js";

// The tier vocabulary is owned by the dialog taxonomy registry (#284);
// re-exported here so supervision consumers keep one import site.
export type { DialogTier } from "../platform/dialog-taxonomy.js";

export const SUPERVISION_SCHEMA_VERSION = "ae-a8n.supervision/v1";

/**
 * The lifecycle of a supervised session.
 *
 * `running → blocked → recovering → resumed`, with `needs-human` and
 * `quarantined` as structured stops. `resumed` means the blocking state
 * cleared AND the affected request's outcome was reconciled — never merely
 * "the dialog closed".
 */
export type SupervisionPhase =
  | "running"
  | "blocked"
  | "recovering"
  | "resumed"
  | "needs-human"
  | "quarantined";

export const SUPERVISION_PHASES: readonly SupervisionPhase[] = [
  "running",
  "blocked",
  "recovering",
  "resumed",
  "needs-human",
  "quarantined",
];

/**
 * Whether the observation pipeline itself can be trusted right now.
 * Orthogonal to `phase`: a `blocked` phase with `monitor-lost` health means
 * "we saw a block once, then lost sight of it" — both facts are reported.
 */
export type ObservationHealth =
  /** Fresh monitor heartbeat; probes are answering. */
  | "ok"
  /** The monitor or a probe is degraded but still reporting something. */
  | "degraded"
  /** The monitor's heartbeat is stale: it stopped or died. Never healthy. */
  | "monitor-lost"
  /** Observation cannot run at all on this host/session right now. */
  | "unavailable";

/** Host-level conditions that are not windows (spec §Blocking taxonomy). */
export type HostLevelState =
  | "none"
  /** The AE process is proven gone (pid + start-time/creation identity). */
  | "process-gone"
  /** The OS reports the process as not responding. */
  | "not-responding"
  /** Alive, no blocking window, not answering — render/startup/quit etc. */
  | "busy-suspected"
  /** The GUI session the target lives in was locked or disconnected. */
  | "gui-session-lost"
  /** The host state could not be determined; never guessed. */
  | "unknown";

/** One blocking window plus its policy classification. */
export type SupervisionWindow = DialogWindow & {
  readonly tier: DialogTier;
  /** The measured class name, when one matched. */
  readonly dialogClass: string | null;
  /** The diagnostic code a human/consumer should see, when applicable. */
  readonly code: string | null;
  /**
   * Structured content extracted from the window's accessible text (#284):
   * class-specific fields (script error line/message) plus a one-line
   * summary. Absent on documents written before taxonomy v2 — readers must
   * treat it as optional, never as "no content".
   */
  readonly content?: StructuredDialogContent;
};

/** What is blocking the host, at window and host level. */
export type BlockingInfo = {
  readonly host: HostLevelState;
  readonly windows: readonly SupervisionWindow[];
  /** One-line human-readable summary for reports and traces. */
  readonly detail: string;
};

/** A request whose execution state matters to supervision. */
export type PendingRequest = {
  readonly id: string;
  readonly method: string;
  /** ISO-8601; when the request was sent. */
  readonly since: string;
  /**
   * `in-flight`: sent, no result yet. `timed-out`: deadline passed, result
   * may still arrive — never resend. `unknown`: outcome cannot be proven.
   */
  readonly state: "in-flight" | "timed-out" | "unknown";
  /**
   * The transport kind the request went through (e.g. "script-invocation",
   * "in-ae-dispatcher"), when the driver can name it. Evidence for the
   * multi-script contention class (#41): the dialog is a symptom of a
   * dispatch-level conflict, so reports carry which transport was in
   * flight. Optional — older documents and transports may omit it.
   */
  readonly transport?: string;
};

/** The monitor lease holder recorded in the state document. */
export type MonitorRecord = {
  readonly ownerId: string;
  readonly pid: number;
  /** Process start stamp for PID-reuse detection; null when unreadable. */
  readonly pidStart: string | null;
  /** ISO-8601; when the lease was acquired. */
  readonly acquiredAt: string;
  /** ISO-8601; last heartbeat the monitor wrote. */
  readonly heartbeatAt: string;
};

/** One recorded phase transition, kept bounded for audit. */
export type SupervisionTransition = {
  readonly from: SupervisionPhase | "init";
  readonly to: SupervisionPhase;
  readonly at: string;
  readonly reason: string;
};

/** The durable supervision document (`ae-a8n.supervision/v1`). */
export type SupervisionStateDoc = {
  readonly schemaVersion: typeof SUPERVISION_SCHEMA_VERSION;
  /** Correlates to the session/launch identity when known. */
  readonly sessionId: string | null;
  readonly phase: SupervisionPhase;
  readonly observationHealth: ObservationHealth;
  readonly blocking: BlockingInfo | null;
  readonly pendingRequests: readonly PendingRequest[];
  /** ISO-8601; when the current phase was entered. */
  readonly enteredAt: string;
  /**
   * ISO-8601 deadline for the current phase's bounded wait, or null for
   * `running`/`resumed` where no wait is owed. Non-running phases MUST set
   * one — the state machine refuses transitions that would leave a
   * blocking phase without a deadline.
   */
  readonly deadline: string | null;
  /** Evidence references: dialog class names, trace ids, artifact paths. */
  readonly evidence: readonly string[];
  /** The monitor currently holding the write lease, when known. */
  readonly monitor: MonitorRecord | null;
  /** Bounded transition history (newest last, capped). */
  readonly history: readonly SupervisionTransition[];
  /** ISO-8601; when this document was last written. */
  readonly updatedAt: string;
};

/** How a supervision report was obtained — the honesty axis. */
export type SupervisionReadSource =
  /** A valid state document was read. */
  | "state"
  /** No state file exists: supervision never ran for this session dir. */
  | "absent"
  /** The file exists but cannot be parsed or is a future schema. */
  | "corrupt";

/**
 * What `ae.supervision()` / the CLI returns. `status: "unavailable"` is an
 * honest answer — the report never fabricates a healthy state.
 */
export type SupervisionReport =
  | {
      readonly status: "observed";
      readonly source: "state";
      readonly doc: SupervisionStateDoc;
      /** Health re-evaluated at read time (heartbeat may have gone stale). */
      readonly health: ObservationHealth;
      readonly healthDetail: string | null;
      readonly readAt: string;
    }
  | {
      readonly status: "unavailable";
      readonly source: Exclude<SupervisionReadSource, "state">;
      readonly reason: string;
      readonly readAt: string;
    };
