/**
 * Uniform operation observability for the public execution path (#434).
 *
 * `OpTelemetry` is the single wrapper every public GUI mutation/observe
 * entry goes through. It follows the `Session.call` precedent: time the
 * call, write one `trace.jsonl` row (op, status, durationMs, redacted
 * args, result/error), and — because the attempt ledger subscribes to the
 * same recorder — land one attempt-ledger record with `expected`/`actual`,
 * `outcome`, `stepTimings` and `requestId` correlation.
 *
 * The wrapper never changes what the op does: the callee's return value
 * and thrown error pass through untouched (same object, same identity).
 * Recording is best-effort; a trace/ledger write failure is counted, not
 * propagated.
 */

import { randomUUID } from "node:crypto";

import type { TraceRecorder, TraceStatus, TraceStepTiming } from "../trace/trace.js";
import { AttemptLedger } from "./attempt-ledger.js";
import type { AttemptOutcome } from "./attempt-ledger.js";

/**
 * Expected/actual may be a plain value or a function of the settled
 * outcome (`{ result }` on success, `{ error }` on failure). Typed as
 * `unknown` at the option site — `resolveExpectation` discriminates.
 */
export type OpExpectation = unknown;

export type OpTelemetryOptions = {
  readonly trace: TraceRecorder;
  readonly sessionRoot: string;
  readonly sessionId: string;
  /** Ledger file override (tests); defaults to `<sessionRoot>/attempt-ledger.jsonl`. */
  readonly ledgerFile?: string;
};

export type ObserveOpOptions<T> = {
  /**
   * Correlation id recorded on the trace row and ledger attempt. Defaults
   * to a per-call `req-<uuid>` so every GUI op is correlatable even though
   * it never crosses the bridge.
   */
  readonly requestId?: string;
  /** Redacted-free args already safe to record (the trace redacts again). */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Structured expectation (oracle data), value or outcome function. */
  readonly expected?: OpExpectation;
  /** Structured observed value; defaults to the compact result summary. */
  readonly actual?: OpExpectation;
  /**
   * Ledger outcome override — value or function of the settled outcome
   * (`{result}` on success, `{error}` on failure; e.g. map an
   * `InputAuditRecord.verdict` or a `PanelError.code`). When absent the
   * outcome derives from status and the error's `code` (`refused`/
   * `indeterminate`/`blocked`/`environment` pass through; everything else
   * is `error`, `timeout` is `indeterminate`).
   */
  readonly outcome?:
    | AttemptOutcome
    | ((settled: {
        readonly result?: T | undefined;
        readonly error?: unknown;
      }) => AttemptOutcome);
  /** Per-step timings collected inside the op (e.g. controller phases). */
  readonly stepTimings?:
    | readonly TraceStepTiming[]
    | ((settled: {
        readonly result?: T | undefined;
        readonly error?: unknown;
      }) => readonly TraceStepTiming[] | undefined);
  readonly evidenceRefs?: readonly string[];
  readonly anomaly?: string | null;
  readonly recoveryRef?: string | null;
  readonly notes?: string;
  /** Compact result summary for the trace row; defaults to a small projection. */
  readonly summarize?: (result: T) => Readonly<Record<string, unknown>> | undefined;
};

const OUTCOME_CODES = new Set(["refused", "indeterminate", "blocked", "environment"]);

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).then === "function"
  );
}

/**
 * Resolve an `OpExpectation`: functions see the settled outcome, plain
 * values pass through. `undefined` means "no structured value".
 */
function resolveExpectation(
  expectation: unknown,
  outcome: { result?: unknown; error?: unknown },
): unknown {
  if (expectation === undefined) {
    return undefined;
  }
  if (typeof expectation === "function") {
    return (expectation as (o: typeof outcome) => unknown)(outcome);
  }
  return expectation;
}

/**
 * Per-session operation telemetry: the trace recorder plus the attempt
 * ledger projected from it. One instance per `Session`; every public GUI
 * surface handle receives it (or nothing, in tests that do not opt in).
 */
export class OpTelemetry {
  readonly trace: TraceRecorder;
  readonly ledger: AttemptLedger;

  constructor(options: OpTelemetryOptions) {
    this.trace = options.trace;
    this.ledger = new AttemptLedger({
      sessionId: options.sessionId,
      sessionRoot: options.sessionRoot,
      ...(options.ledgerFile === undefined ? {} : { file: options.ledgerFile }),
      // A ledger write failure is counted on the ledger (`writeErrors`);
      // routing it into the trace would re-enter this subscriber.
    });
    options.trace.subscribe((event) => {
      this.ledger.append(event);
    });
  }

  /**
   * Run `fn` as one observed operation: time it, record the trace row,
   * let the ledger subscriber append the attempt. The callee's result or
   * error is returned/thrown unchanged — observation only.
   */
  async run<T>(
    op: string,
    fn: () => T | Promise<T>,
    options: ObserveOpOptions<T> = {},
  ): Promise<T> {
    const began = Date.now();
    const requestId = options.requestId ?? `req-${randomUUID()}`;
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const value = fn();
      result = isPromiseLike(value) ? await value : value;
      return result;
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const durationMs = Date.now() - began;
      const settled: { result?: T | undefined; error?: unknown } = failed
        ? { error: failure }
        : { result };
      const expected = resolveExpectation(options.expected, settled);
      const actual = resolveExpectation(options.actual, settled);
      const status: TraceStatus = failed
        ? typeof failure === "object" &&
          failure !== null &&
          (failure as { name?: unknown }).name === "TimeoutError"
          ? "timeout"
          : "error"
        : "ok";
      const outcome =
        typeof options.outcome === "function"
          ? options.outcome(settled)
          : (options.outcome ??
            (failed
              ? OUTCOME_CODES.has(errorCode(failure) ?? "")
                ? (errorCode(failure) as AttemptOutcome)
                : status === "timeout"
                  ? "indeterminate"
                  : "error"
              : undefined));
      const summary =
        options.summarize !== undefined && !failed && result !== undefined
          ? options.summarize(result)
          : defaultSummary(result);
      const stepTimings =
        typeof options.stepTimings === "function"
          ? options.stepTimings(settled)
          : (options.stepTimings ?? resultStepTimings(result));
      this.trace.record(op, status, durationMs, {
        ...(options.args === undefined ? {} : { args: options.args }),
        requestId,
        ...(summary === undefined ? {} : { result: summary }),
        ...(failed
          ? { error: { name: errorName(failure), message: errorMessage(failure) } }
          : {}),
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(stepTimings === undefined || stepTimings.length === 0
          ? {}
          : { stepTimings }),
        ...(options.evidenceRefs === undefined
          ? {}
          : { evidenceRefs: options.evidenceRefs }),
        ...(options.anomaly === undefined ? {} : { anomaly: options.anomaly }),
        ...(options.recoveryRef === undefined
          ? {}
          : { recoveryRef: options.recoveryRef }),
        ...(options.notes === undefined ? {} : { notes: options.notes }),
      });
    }
  }
}

/**
 * Lift `stepTimings` off a settled result when the operation's result
 * record carries them (controllers record per-phase timings on their
 * result records — additive field, spec §5.2 `steps[]` timing).
 */
function resultStepTimings(result: unknown): readonly TraceStepTiming[] | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const timings = (result as { stepTimings?: unknown }).stepTimings;
  return Array.isArray(timings) ? (timings as readonly TraceStepTiming[]) : undefined;
}

/**
 * Per-step phase timer for controllers (#434): wrap each phase
 * (`resolve`, `gate`, `census`, `lease`, `post`, `oracle`, …) in
 * `timed`/`timedSync`; the collected rows ride the op's result record as
 * `stepTimings` and land on the ledger attempt. Timing never alters the
 * wrapped call — the value or error passes through untouched.
 */
export class StepTimer {
  readonly #now: () => number;
  readonly #rows: {
    stepId: string;
    startedAt: string;
    durationMs: number;
  }[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async timed<T>(stepId: string, fn: () => T | Promise<T>): Promise<T> {
    const started = this.#now();
    const startedAt = new Date(started).toISOString();
    try {
      return await fn();
    } finally {
      this.#rows.push({
        stepId,
        startedAt,
        durationMs: this.#now() - started,
      });
    }
  }

  timedSync<T>(stepId: string, fn: () => T): T {
    const started = this.#now();
    const startedAt = new Date(started).toISOString();
    try {
      return fn();
    } finally {
      this.#rows.push({
        stepId,
        startedAt,
        durationMs: this.#now() - started,
      });
    }
  }

  get timings(): readonly TraceStepTiming[] {
    return this.#rows;
  }
}

/**
 * Default compact result summary: scalars and short arrays/objects only,
 * capped — the trace row is for diagnosis, not a state dump. Returns
 * `undefined` for results with nothing worth recording (undefined, null).
 */
function defaultSummary(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result !== "object") {
    return { value: result };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[key] = typeof value === "string" && value.length > 200
        ? `${value.slice(0, 200)}…`
        : value;
    } else if (Array.isArray(value)) {
      out[key] = `[array(${value.length})]`;
    } else if (typeof value === "object" && value !== null) {
      out[key] = "[object]";
    }
  }
  return out;
}

/**
 * Convenience wrapper for callsites that hold a telemetry optionally:
 * `observeOp(telemetry, "panel.resize", args, fn, opts)` runs `fn`
 * through `telemetry.run` when present and calls it directly otherwise —
 * tests and non-session constructions keep working unchanged.
 */
export async function observeOp<T>(
  telemetry: OpTelemetry | undefined,
  op: string,
  args: Readonly<Record<string, unknown>> | undefined,
  fn: () => T | Promise<T>,
  options: Omit<ObserveOpOptions<T>, "args"> = {},
): Promise<T> {
  if (telemetry === undefined) {
    const value = fn();
    return isPromiseLike(value) ? await value : value;
  }
  return telemetry.run(op, fn, { ...options, ...(args === undefined ? {} : { args }) });
}
