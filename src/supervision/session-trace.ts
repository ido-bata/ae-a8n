/**
 * Session-trace recording for supervision (#287,
 * specs/gui-supervision/spec.md §API / CLI surface).
 *
 * The durable `supervision.json` is the state of record; the session trace
 * (`trace.jsonl`) is the *event* record a failed run is diagnosed from. This
 * tracer bridges them without becoming a second state store: it only ever
 * diffs what the monitor published and what readers evaluated, and appends
 * one trace row per *change* — never per heartbeat.
 *
 * What lands in the trace:
 *
 *   - `supervision.transition` — every phase change the monitor publishes
 *     (`running → blocked → recovering → …`), with the state machine's own
 *     recorded reason.
 *   - `supervision.health` — every change of the *evaluated* observation
 *     health a reader sees: `ok`, `degraded`, `monitor-lost`,
 *     `unavailable`. This is the only place monitor loss can be recorded —
 *     a dead monitor cannot write its own obituary, so the signal comes
 *     from the read side re-evaluating the heartbeat against the clock.
 *
 * Recovery actions are not duplicated here: the driver already records
 * `session.recover` for every attempt, and every GUI mutation goes through
 * the lease + `gui-audit.jsonl` path. This tracer adds the supervision
 * context those rows do not carry.
 */

import type { TraceRecorder } from "../trace/trace.js";
import type { SupervisionPhase, SupervisionReport, SupervisionStateDoc } from "./types.js";

/** The slice of `TraceRecorder` this tracer needs (a test seam). */
export type SupervisionTraceSink = Pick<TraceRecorder, "record">;

/** Health as a reader evaluates it; `unavailable` reports have no doc health. */
type HealthKey =
  | "ok"
  | "degraded"
  | "monitor-lost"
  | "unavailable"
  | `unavailable:${"absent" | "corrupt"}`;

function healthKeyOf(report: SupervisionReport): HealthKey {
  if (report.status === "unavailable") {
    return `unavailable:${report.source}`;
  }
  return report.health;
}

function healthDetailOf(report: SupervisionReport): string | null {
  if (report.status === "unavailable") {
    return report.reason;
  }
  return report.healthDetail;
}

export class SupervisionSessionTracer {
  readonly #trace: SupervisionTraceSink;
  /** Last phase the monitor published; "init" until the first publish. */
  #phase: SupervisionPhase | "init" = "init";
  /** Last evaluated health a reader saw; null until the first report read. */
  #health: HealthKey | null = null;

  constructor(trace: SupervisionTraceSink) {
    this.#trace = trace;
  }

  /**
   * Feed one published document (the monitor's `onPublish` hook). Records
   * a `supervision.transition` row whenever the phase changes — including
   * the first publish, which marks supervision starting in the trace.
   */
  notePublished(doc: SupervisionStateDoc): void {
    if (doc.phase === this.#phase) {
      return;
    }
    const from = this.#phase;
    this.#phase = doc.phase;
    const reason = doc.history[doc.history.length - 1]?.reason ?? null;
    this.#record("supervision.transition", {
      from,
      to: doc.phase,
      reason,
      enteredAt: doc.enteredAt,
      ...(doc.deadline === null ? {} : { deadline: doc.deadline }),
    });
  }

  /**
   * Feed one read-side report (`SessionSupervision.report()`). Records a
   * `supervision.health` row whenever the evaluated health changes —
   * including the transition into `monitor-lost`, which only a reader can
   * observe because the monitor is already gone.
   */
  noteReport(report: SupervisionReport): void {
    const health = healthKeyOf(report);
    if (health === this.#health) {
      return;
    }
    const from = this.#health;
    this.#health = health;
    const detail = healthDetailOf(report);
    this.#record("supervision.health", {
      from: from ?? "unobserved",
      to: health,
      ...(detail === null ? {} : { detail }),
      phase: report.status === "observed" ? report.doc.phase : null,
    });
  }

  #record(op: string, result: Record<string, unknown>): void {
    // Trace writes are best-effort by contract (TraceRecorder swallows I/O
    // failures into onError); a throwing sink must not break supervision.
    try {
      this.#trace.record(op, "ok", 0, { result });
    } catch {
      // Evidence must never take down the thing it describes.
    }
  }
}
