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
 * Buffers nothing and swallows nothing: a trace write that throws would mask
 * the operation result the caller actually cares about, so failures are
 * reported to the sink's own error channel instead of propagating.
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
