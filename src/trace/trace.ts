/**
 * Machine-readable operation history.
 *
 * Every externally meaningful operation — launch, open project, apply effect,
 * set parameter, render — appends one JSONL line. The goal is that a failed run
 * can be replayed and understood without re-reading logs, and later diffed
 * between runs. There is no viewer yet; the file is the contract.
 */

import { appendFileSync } from "node:fs";

export type TraceStatus = "ok" | "error" | "timeout" | "cancelled";

/**
 * The attempt-ledger outcome vocabulary (#434,
 * `specs/release-acceptance/spec.md` §5). Optional on a trace event: when
 * absent the ledger derives it from `status`/`error`.
 */
export type TraceOutcome =
  | "ok"
  | "error"
  | "indeterminate"
  | "refused"
  | "blocked"
  | "environment";

/** One timed step inside an operation, for the attempt ledger's `stepTimings`. */
export type TraceStepTiming = {
  readonly stepId: string;
  readonly startedAt?: string;
  readonly durationMs: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
};

export type TraceEvent = {
  readonly seq: number;
  readonly ts: string;
  readonly op: string;
  readonly status: TraceStatus;
  readonly durationMs: number;
  /** Operation arguments, after redaction. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Compact result summary — enough to diagnose, not a full state dump. */
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly name: string; readonly message: string };
  /**
   * Correlation id for the attempt ledger (#434). Driver calls carry the
   * bridge request id here via `args.requestId`; GUI ops carry the id the
   * caller/telemetry wrapper assigned.
   */
  readonly requestId?: string;
  /** Structured expectation the op was judged against, when one exists. */
  readonly expected?: unknown;
  /** Structured observed outcome, when the op produced one. */
  readonly actual?: unknown;
  /** Ledger outcome override; absent means derive from status/error. */
  readonly outcome?: TraceOutcome;
  /** Per-step timings recorded inside the operation. */
  readonly stepTimings?: readonly TraceStepTiming[];
  /** Evidence artifact references (paths, index ids) the op produced. */
  readonly evidenceRefs?: readonly string[];
  /** Supervision/recovery anomaly classification, when one engaged. */
  readonly anomaly?: string | null;
  /** Recovery-evidence manifest reference, when recovery ran. */
  readonly recoveryRef?: string | null;
  /** Free-text note; never substitutes for a structured field. */
  readonly notes?: string;
};

const REDACTED_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
  "api_key",
]);

const MAX_DEPTH = 4;
const MAX_STRING = 512;

function redact(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})`
      : value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : redact(entry, depth + 1);
    }
    return out;
  }
  // Everything above handled the cases a JSON-ish payload actually contains.
  // What is left (bigint, symbol, function) has no JSON form, so label it
  // rather than emitting Object's default stringification.
  return `[${typeof value}]`;
}

export type TraceSink = (event: TraceEvent) => void;

/**
 * A trace write that throws must not mask the operation result the caller
 * actually asked for, so failures never propagate. They are routed to
 * `onError` instead.
 *
 * With no `onError` configured, a write failure is **discarded**. That is a
 * real gap: the trace is the primary evidence a failed run is diagnosed from,
 * so a full disk or an unwritable path would leave a session that looks fine
 * with an empty trace and no hint why. Pass `onError` unless the trace is
 * known to be optional.
 */
export class TraceRecorder {
  readonly #file: string | undefined;
  readonly #seq = { value: 0 };
  readonly #listeners = new Set<TraceSink>();
  #errorListener: ((error: unknown) => void) | undefined;

  constructor(options: { file?: string; onError?: (error: unknown) => void } = {}) {
    if (options.file !== undefined) {
      this.#file = options.file;
    }
    this.#errorListener = options.onError;
  }

  /** Path the trace is appended to, when one was configured. */
  get file(): string | undefined {
    return this.#file;
  }

  subscribe(sink: TraceSink): () => void {
    this.#listeners.add(sink);
    return () => {
      this.#listeners.delete(sink);
    };
  }

  record(
    op: string,
    status: TraceStatus,
    durationMs: number,
    detail: {
      args?: Readonly<Record<string, unknown>>;
      result?: Readonly<Record<string, unknown>>;
      error?: { name: string; message: string };
      requestId?: string;
      expected?: unknown;
      actual?: unknown;
      outcome?: TraceOutcome;
      stepTimings?: readonly TraceStepTiming[];
      evidenceRefs?: readonly string[];
      anomaly?: string | null;
      recoveryRef?: string | null;
      notes?: string;
    } = {},
  ): TraceEvent {
    const event: TraceEvent = {
      seq: this.#seq.value++,
      ts: new Date().toISOString(),
      op,
      status,
      durationMs: Math.round(durationMs * 1000) / 1000,
      ...(detail.args === undefined
        ? {}
        : { args: redact(detail.args, 0) as Record<string, unknown> }),
      ...(detail.result === undefined
        ? {}
        : { result: redact(detail.result, 0) as Record<string, unknown> }),
      ...(detail.error === undefined ? {} : { error: detail.error }),
      ...(detail.requestId === undefined ? {} : { requestId: detail.requestId }),
      ...(detail.expected === undefined
        ? {}
        : { expected: redact(detail.expected, 0) }),
      ...(detail.actual === undefined
        ? {}
        : { actual: redact(detail.actual, 0) }),
      ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
      ...(detail.stepTimings === undefined
        ? {}
        : { stepTimings: redact(detail.stepTimings, 0) as readonly TraceStepTiming[] }),
      ...(detail.evidenceRefs === undefined
        ? {}
        : { evidenceRefs: [...detail.evidenceRefs] }),
      ...(detail.anomaly === undefined ? {} : { anomaly: detail.anomaly }),
      ...(detail.recoveryRef === undefined
        ? {}
        : { recoveryRef: detail.recoveryRef }),
      ...(detail.notes === undefined ? {} : { notes: detail.notes }),
    };

    if (this.#file !== undefined) {
      try {
        appendFileSync(this.#file, `${JSON.stringify(event)}\n`, "utf-8");
      } catch (error) {
        this.#errorListener?.(error);
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#errorListener?.(error);
      }
    }
    return event;
  }
}
