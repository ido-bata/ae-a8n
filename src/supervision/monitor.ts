/**
 * The supervision monitor loop (#281, spec §Durable shared state).
 *
 * One monitor per session directory, elected by the monitor lease. Each
 * tick it observes through the injected `GuiProbe`, folds the result into
 * the state machine, publishes the durable document, and heartbeats the
 * lease. It never presses anything — recovery actions are a separate,
 * lease+audit-guarded path the driver invokes; the monitor's job is to see
 * and to keep the shared state honest.
 *
 * Failure posture:
 *
 *   - probe failure → `probe-degraded` health, phase unchanged. A monitor
 *     that cannot see does not claim the target is fine.
 *   - lease loss → the monitor stops writing and exits its loop. Readers
 *     then see a stale heartbeat (`monitor-lost`), which is the correct
 *     signal that observation stopped.
 *   - state write failure → the tick is dropped and retried next interval;
 *     a torn write can never replace the last good document (atomic rename).
 */

import type { GuiProbe } from "./probe.js";
import { snapshotToBlocking } from "./probe.js";
import {
  acquireMonitorLease,
  type MonitorLease,
} from "./lease.js";
import { dialogClassByName } from "../platform/dialog-taxonomy.js";
import {
  applySupervisionEvent,
  initialSupervisionDoc,
  MAX_HISTORY,
  type SupervisionEvent,
} from "./machine.js";
import {
  readSupervisionState,
  supervisionReport,
  writeSupervisionState,
} from "./state.js";
import type {
  BlockingInfo,
  HostLevelState,
  MonitorRecord,
  PendingRequest,
  SupervisionPhase,
  SupervisionReport,
  SupervisionStateDoc,
} from "./types.js";

/**
 * Multi-script contention (#41, #284): when a blocking window is the
 * measured `contention` class, the dialog is a symptom of a dispatch-level
 * conflict — a script may still be running behind it. The dispatch layer's
 * one-in-flight serialization is the fix; supervision's job is to record
 * *which* request was in flight and over which transport, in both the
 * blocking detail and the durable evidence log. The dialog itself is
 * classified and reported, never dismissed as a superficial modal.
 */
function contentionEvidence(
  blocking: BlockingInfo,
  pending: readonly PendingRequest[],
): string | null {
  const hit = blocking.windows.some(
    (window) =>
      window.dialogClass !== null &&
      dialogClassByName(window.dialogClass)?.contention === true,
  );
  if (!hit) {
    return null;
  }
  const inFlight =
    pending.length === 0
      ? "no request is currently in flight"
      : pending
          .map(
            (request) =>
              `${request.id} (${request.method}, ${request.state}` +
              `${request.transport === undefined ? "" : `, transport ${request.transport}`})`,
          )
          .join(", ");
  return (
    `dispatch contention: ${inFlight}; the in-flight request's outcome is uncertain and is ` +
    "never resent — the transport's one-in-flight serialization owns the root cause (#41)"
  );
}

function annotateContention(
  blocking: BlockingInfo,
  pending: readonly PendingRequest[],
): BlockingInfo {
  const note = contentionEvidence(blocking, pending);
  if (note === null) {
    return blocking;
  }
  return { ...blocking, detail: `${blocking.detail}; ${note}` };
}

export const DEFAULT_MONITOR_INTERVAL_MS = 2_000;

export type SupervisionMonitorOptions = {
  readonly sessionDir: string;
  readonly probe: GuiProbe;
  readonly ownerId: string;
  readonly pid?: number;
  readonly intervalMs?: number;
  readonly leaseTtlMs?: number;
  /** Extra host-level evidence (e.g. process-gone proof) merged per tick. */
  readonly hostProbe?: () => HostLevelState | undefined;
  /** Pending requests the driver wants reflected in the document. */
  readonly pendingRequests?: () => readonly PendingRequest[];
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called after every published document (trace hook). */
  readonly onPublish?: (doc: SupervisionStateDoc) => void;
};

export type SupervisionMonitorStart =
  | { readonly ok: true; readonly monitor: SupervisionMonitor }
  | { readonly ok: false; readonly reason: string };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A supervision monitor must never be the reason a CLI process stays
    // alive: the loop is fire-and-forget inside the session's lifetime.
    (timer as { unref?: () => void }).unref?.();
  });

function isBlockingPhase(phase: SupervisionPhase): boolean {
  return phase === "blocked" || phase === "recovering" || phase === "needs-human" || phase === "quarantined";
}

export class SupervisionMonitor {
  readonly #options: SupervisionMonitorOptions;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #lease: MonitorLease;
  #doc: SupervisionStateDoc;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  private constructor(options: SupervisionMonitorOptions, lease: MonitorLease, doc: SupervisionStateDoc) {
    this.#options = options;
    this.#lease = lease;
    this.#doc = doc;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Acquire the monitor lease and load (or initialise) the state document.
   * Refuses when another live monitor holds the lease.
   */
  static start(options: SupervisionMonitorOptions): SupervisionMonitorStart {
    const acquired = acquireMonitorLease(options.sessionDir, {
      ownerId: options.ownerId,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.leaseTtlMs === undefined ? {} : { ttlMs: options.leaseTtlMs }),
      now: options.now?.() ?? new Date(),
    });
    if (!acquired.ok) {
      return { ok: false, reason: acquired.detail };
    }
    const now = options.now?.() ?? new Date();
    const existing = readSupervisionState(options.sessionDir);
    let doc: SupervisionStateDoc;
    if (existing.kind === "state") {
      doc = existing.doc;
    } else if (existing.kind === "absent") {
      doc = initialSupervisionDoc({ now });
    } else {
      // Corrupt state: start fresh but preserve the fact in history via the
      // initial document — a corrupt file is never silently continued.
      doc = initialSupervisionDoc({ now });
    }
    const monitor = new SupervisionMonitor(options, acquired.lease, doc);
    monitor.#publish();
    return { ok: true, monitor };
  }

  get phase(): SupervisionPhase {
    return this.#doc.phase;
  }

  /** The current durable report, re-evaluated at read time. */
  report(): SupervisionReport {
    return supervisionReport(this.#options.sessionDir, { now: this.#now() });
  }

  /** Run ticks until `stop()`; resolves when the loop ends. */
  async run(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    const interval = Math.max(50, this.#options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS);
    while (!this.#stopped) {
      try {
        await this.#tick();
      } catch {
        // A tick that throws (probe bug, fs error) must not kill the loop
        // silently nor crash the host process: skip and retry next tick.
        // The heartbeat going stale is the honest signal if it persists.
      }
      if (this.#stopped) {
        break;
      }
      await this.#sleep(interval);
    }
    this.#running = false;
  }

  /** Single step, exposed for tests and for driver-driven ticking. */
  async tick(): Promise<void> {
    await this.#tick();
  }

  /** Stop the loop and release the lease. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      this.#lease.release();
    } catch {
      // Release is best-effort; the lease expires on its own TTL.
    }
  }

  #publish(): void {
    writeSupervisionState(this.#options.sessionDir, this.#doc);
    this.#options.onPublish?.(this.#doc);
  }

  #apply(event: SupervisionEvent): void {
    const result = applySupervisionEvent(this.#doc, event, this.#now());
    if (result.ok) {
      this.#doc = result.doc;
    }
    // Refused transitions are ignored: the machine already records what it
    // can prove; forcing a transition would be guessing.
  }

  async #tick(): Promise<void> {
    // Heartbeat first: if we lost the lease, stop before writing anything.
    let beat: MonitorRecord;
    try {
      const record = this.#lease.heartbeat(this.#now());
      beat = {
        ownerId: record.ownerId,
        pid: record.pid,
        pidStart: record.pidStart,
        acquiredAt: record.acquiredAt,
        heartbeatAt: record.heartbeatAt,
      };
    } catch {
      this.#stopped = true;
      return;
    }

    const pending = this.#options.pendingRequests?.() ?? [];
    if (pending.length > 0 && this.#doc.pendingRequests.length === 0) {
      this.#doc = { ...this.#doc, pendingRequests: pending };
    }

    const snapshot = await this.#options.probe.observe();
    const hostOverride = this.#options.hostProbe?.();

    if (!snapshot.ok) {
      this.#apply({ kind: "probe-degraded", reason: snapshot.reason });
    } else {
      const blocking = snapshotToBlocking(snapshot);
      const host =
        hostOverride === undefined || hostOverride === "none"
          ? blocking.host
          : ((): HostLevelState => {
              const rank: Record<HostLevelState, number> = {
                none: 0,
                "busy-suspected": 1,
                "not-responding": 2,
                "gui-session-lost": 3,
                "process-gone": 4,
                unknown: 0,
              };
              return rank[hostOverride] > rank[blocking.host] ? hostOverride : blocking.host;
            })();
      const effective = annotateContention({ ...blocking, host }, pending);
      // The contention note is also durable evidence: a consumer reading
      // only `evidence[]` (not `blocking.detail`) still sees which request
      // was in flight when the dialog appeared. Bounded like probe-degraded.
      const contentionNote = contentionEvidence(effective, pending);
      if (
        contentionNote !== null &&
        this.#doc.evidence[this.#doc.evidence.length - 1] !== contentionNote
      ) {
        this.#doc = {
          ...this.#doc,
          evidence: [...this.#doc.evidence, contentionNote].slice(-MAX_HISTORY),
        };
      }
      const clear = host === "none" && !effective.windows.some((window) => window.blocking);

      const pendingFields =
        pending.length > 0 ? { pendingRequests: pending } : {};
      if (this.#doc.phase === "running" && !clear) {
        this.#apply({
          kind: "blocking-observed",
          blocking: effective,
          ...pendingFields,
          reason: effective.detail,
        });
      } else if (isBlockingPhase(this.#doc.phase) && clear) {
        this.#apply({ kind: "observe-clear", reason: "no blocking window or host state observed" });
      } else if (this.#doc.phase === "blocked" && !clear) {
        // Still blocked: refresh evidence without changing phase.
        this.#apply({
          kind: "blocking-observed",
          blocking: effective,
          ...pendingFields,
          reason: effective.detail,
        });
      }

      // Observation health is orthogonal to phase: degraded evidence is
      // recorded in every phase, and a clean answer restores "ok". A probe
      // that answers but flags degraded evidence (AX tree unserviceable,
      // census unavailable) is degraded observation, not a clean bill.
      if ((snapshot.degraded ?? []).length > 0) {
        this.#apply({
          kind: "probe-degraded",
          reason: snapshot.degraded!.join("; "),
        });
      } else if (
        this.#doc.observationHealth === "degraded" ||
        this.#doc.observationHealth === "unavailable"
      ) {
        this.#apply({ kind: "probe-ok", reason: "probe answered cleanly" });
      }
    }

    this.#apply({ kind: "monitor-heartbeat", monitor: beat });
    this.#publish();
  }
}
