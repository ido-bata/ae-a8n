/**
 * Session-scoped attempt ledger (#434,
 * `specs/release-acceptance/spec.md` §5).
 *
 * Append-only JSONL, one record per traced operation attempt — successes,
 * refusals, indeterminate outcomes and errors are all first-class entries;
 * nothing is dropped or rewritten (spec §11 honesty rule 2). The ledger is
 * a *projection of the session trace*: `OpTelemetry` subscribes the ledger
 * to the `TraceRecorder`, so every op that lands a `trace.jsonl` row —
 * bridge calls, GUI surface ops, supervision transitions — lands a ledger
 * attempt with the same `seq`-derived `attemptId` for correlation.
 *
 * The file lives next to `trace.jsonl` at `<sessionRoot>/attempt-ledger.jsonl`.
 * Line 1 is a versioned envelope; every later line is one attempt record.
 * `schemaVersion` is additive-only within a major version; readers must
 * reject unknown versions rather than guess (spec §3/§5.1).
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type {
  TraceEvent,
  TraceOutcome,
  TraceStepTiming,
} from "../trace/trace.js";

export const ATTEMPT_LEDGER_SCHEMA_VERSION = 1;
export const ATTEMPT_LEDGER_KIND = "ae-a8n.attempt-ledger/v1";

/** Default ledger file name inside the session root (next to trace.jsonl). */
export const ATTEMPT_LEDGER_FILE = "attempt-ledger.jsonl";

export type AttemptOutcome = TraceOutcome;
export type AttemptStepTiming = TraceStepTiming;

/**
 * One attempt record (spec §5.2 fields adapted to op granularity; the
 * scenario-level fields — `scenarioId`, `verdict`, `cleanup` — belong to
 * the RC harness layer that groups these attempts, not to this ledger).
 */
export type AttemptRecord = {
  readonly schemaVersion: typeof ATTEMPT_LEDGER_SCHEMA_VERSION;
  readonly type: "attempt";
  /** Unique within the ledger: `att-<trace seq>`. */
  readonly attemptId: string;
  /** The traced operation name (`panel.resize`, `project.open`, …). */
  readonly feature: string;
  /** Correlation id: bridge requestId for calls, op requestId for GUI ops. */
  readonly requestId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly outcome: AttemptOutcome;
  readonly anomaly?: string | null;
  readonly recoveryRef?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly stepTimings?: readonly AttemptStepTiming[];
  readonly notes?: string;
  /** Session identity echoed on every entry (spec §5.1: entries cannot be re-attributed). */
  readonly sessionId: string;
  readonly sessionRoot: string;
  /** Compact trace result summary, for readers that want more than actual. */
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly name: string; readonly message: string };
};

/** The ledger envelope — always the first line of the file. */
export type AttemptLedgerEnvelope = {
  readonly schemaVersion: typeof ATTEMPT_LEDGER_SCHEMA_VERSION;
  readonly kind: typeof ATTEMPT_LEDGER_KIND;
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly platform: string;
  readonly startedAt: string;
};

const OUTCOMES = new Set<TraceOutcome>([
  "ok",
  "error",
  "indeterminate",
  "refused",
  "blocked",
  "environment",
]);

/**
 * Derive the ledger outcome when the trace event does not carry an
 * explicit `outcome`. `timeout` means the op's outcome is unproven —
 * `indeterminate`, never a silent pass or fail (spec §11.1).
 */
export function outcomeForEvent(event: TraceEvent): AttemptOutcome {
  if (event.outcome !== undefined && OUTCOMES.has(event.outcome)) {
    return event.outcome;
  }
  switch (event.status) {
    case "ok":
      return "ok";
    case "timeout":
      return "indeterminate";
    case "cancelled":
      return "error";
    case "error":
    default:
      return "error";
  }
}

/**
 * Project one trace event into an attempt record. `requestId` prefers the
 * event's own field, then `args.requestId` (where driver calls put the
 * bridge request id), then `result.requestId`.
 */
export function attemptFromEvent(
  event: TraceEvent,
  envelope: Pick<AttemptLedgerEnvelope, "sessionId" | "sessionRoot">,
): AttemptRecord {
  const requestId =
    event.requestId ??
    (typeof event.args?.["requestId"] === "string"
      ? event.args["requestId"]
      : typeof event.result?.["requestId"] === "string"
        ? event.result["requestId"]
        : undefined);
  const endedMs = Date.parse(event.ts);
  const startedMs = Number.isNaN(endedMs)
    ? endedMs
    : endedMs - event.durationMs;
  return {
    schemaVersion: ATTEMPT_LEDGER_SCHEMA_VERSION,
    type: "attempt",
    attemptId: `att-${event.seq}`,
    feature: event.op,
    ...(requestId === undefined ? {} : { requestId }),
    startedAt: new Date(startedMs).toISOString(),
    endedAt: event.ts,
    durationMs: event.durationMs,
    ...(event.expected === undefined ? {} : { expected: event.expected }),
    // `actual` defaults to the compact result summary: the observed
    // outcome is the result, and callsites override with oracle-shaped
    // values (requested/observed) where one exists.
    ...(event.actual !== undefined
      ? { actual: event.actual }
      : event.result !== undefined
        ? { actual: event.result }
        : {}),
    outcome: outcomeForEvent(event),
    ...(event.anomaly === undefined ? {} : { anomaly: event.anomaly }),
    ...(event.recoveryRef === undefined
      ? {}
      : { recoveryRef: event.recoveryRef }),
    ...(event.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: event.evidenceRefs }),
    ...(event.stepTimings === undefined
      ? {}
      : { stepTimings: event.stepTimings }),
    ...(event.notes === undefined ? {} : { notes: event.notes }),
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.error === undefined ? {} : { error: event.error }),
    sessionId: envelope.sessionId,
    sessionRoot: envelope.sessionRoot,
  };
}

export type AttemptLedgerOptions = {
  /** Ledger file path; defaults to `<sessionRoot>/attempt-ledger.jsonl`. */
  readonly file?: string;
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly platform?: string;
  readonly now?: () => Date;
  /** Write failures are reported here, never thrown into the op path. */
  readonly onError?: (error: unknown) => void;
};

/**
 * The append-only ledger. One instance per session; `append` is
 * synchronous and best-effort — a ledger write failure must never mask
 * or alter the operation it records (same contract as `TraceRecorder`).
 */
export class AttemptLedger {
  readonly #file: string;
  readonly #envelope: AttemptLedgerEnvelope;
  readonly #onError: ((error: unknown) => void) | undefined;
  #appended = 0;
  #writeErrors = 0;

  constructor(options: AttemptLedgerOptions) {
    this.#file = options.file ?? `${options.sessionRoot}/${ATTEMPT_LEDGER_FILE}`;
    this.#onError = options.onError;
    const now = options.now ?? (() => new Date());
    this.#envelope = {
      schemaVersion: ATTEMPT_LEDGER_SCHEMA_VERSION,
      kind: ATTEMPT_LEDGER_KIND,
      sessionId: options.sessionId,
      sessionRoot: options.sessionRoot,
      platform: options.platform ?? process.platform,
      startedAt: now().toISOString(),
    };
    this.#ensureEnvelope();
  }

  get file(): string {
    return this.#file;
  }

  /** Records written so far — evidence the ledger is alive, not decorative. */
  get appended(): number {
    return this.#appended;
  }

  /** Write failures observed; surfaced for honest reporting, never thrown. */
  get writeErrors(): number {
    return this.#writeErrors;
  }

  #ensureEnvelope(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      if (!existsSync(this.#file) || statSync(this.#file).size === 0) {
        appendFileSync(this.#file, `${JSON.stringify(this.#envelope)}\n`, "utf-8");
      }
    } catch (error) {
      this.#writeErrors += 1;
      this.#onError?.(error);
    }
  }

  /** Append one attempt record projected from a trace event. */
  append(event: TraceEvent): AttemptRecord {
    const record = attemptFromEvent(event, this.#envelope);
    try {
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`, "utf-8");
      this.#appended += 1;
    } catch (error) {
      this.#writeErrors += 1;
      this.#onError?.(error);
    }
    return record;
  }
}
