/**
 * Wire contract between the Node driver and the ExtendScript host.
 *
 * This is `ae-a8n`'s internal boundary. Nothing here is part of the public
 * API: callers interact with typed objects and never see these envelopes.
 *
 * The request travels as a JSON file written by the driver; the result comes
 * back as a JSON file written by the host. File-based transport is the only
 * channel available on Windows, where `AfterFX.exe -r <script>` gives no way
 * to read a return value back out of the launched process.
 */

export const PROTOCOL_VERSION = 1;

export type RequestEnvelope = {
  readonly v: number;
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
};

export type HostErrorPayload = {
  readonly name: string;
  readonly message: string;
  /** 1-based line inside the host script, when the host can attribute one. */
  readonly line?: number;
  /** AE error number, for host errors AE itself raised. */
  readonly aeError?: number;
  /** Detail of the host's own typed errors, e.g. a NoValueError's property kind. */
  readonly kind?: string;
};

export type SuccessEnvelope = {
  readonly v: number;
  readonly id: string;
  readonly ok: true;
  readonly durationMs: number;
  readonly result: unknown;
};

export type FailureEnvelope = {
  readonly v: number;
  readonly id: string;
  readonly ok: false;
  readonly durationMs: number;
  readonly error: HostErrorPayload;
};

export type ResultEnvelope = SuccessEnvelope | FailureEnvelope;

/**
 * Raised when a host result carries `ok: false`. Kept distinct from the
 * transport-level errors (timeout, host unreachable) so callers can tell
 * "AE rejected this" from "AE never answered".
 */
export class HostError extends Error {
  override readonly name: string;
  readonly line: number | undefined;
  readonly aeError: number | undefined;
  readonly kind: string | undefined;

  constructor(payload: HostErrorPayload) {
    super(payload.message);
    this.name = payload.name;
    this.line = payload.line;
    this.aeError = payload.aeError;
    this.kind = payload.kind;
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new ProtocolError(`expected string field "${key}"`);
  }
  return value;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`expected finite number field "${key}"`);
  }
  return value;
}

export function parseRequestEnvelope(raw: unknown): RequestEnvelope {
  if (!isRecord(raw)) {
    throw new ProtocolError("request envelope must be an object");
  }
  const v = readNumber(raw, "v");
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported protocol version ${v}, expected ${PROTOCOL_VERSION}`,
    );
  }
  const params = raw["params"] ?? {};
  if (!isRecord(params)) {
    throw new ProtocolError('field "params" must be an object');
  }
  return {
    v,
    id: readString(raw, "id"),
    method: readString(raw, "method"),
    params,
    timeoutMs: readNumber(raw, "timeoutMs"),
  };
}

export function parseResultEnvelope(raw: unknown): ResultEnvelope {
  if (!isRecord(raw)) {
    throw new ProtocolError("result envelope must be an object");
  }
  const v = readNumber(raw, "v");
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported protocol version ${v}, expected ${PROTOCOL_VERSION}`,
    );
  }
  const id = readString(raw, "id");
  const durationMs = readNumber(raw, "durationMs");

  if (raw["ok"] === true) {
    return { v, id, ok: true, durationMs, result: raw["result"] ?? null };
  }
  if (raw["ok"] === false) {
    const error = raw["error"];
    if (!isRecord(error)) {
      throw new ProtocolError('failure envelope needs an "error" object');
    }
    const payload: {
      name: string;
      message: string;
      line?: number;
      aeError?: number;
      kind?: string;
    } = {
      name: typeof error["name"] === "string" ? error["name"] : "Error",
      message:
        typeof error["message"] === "string" ? error["message"] : "unknown",
    };
    if (typeof error["line"] === "number") {
      payload.line = error["line"];
    }
    if (typeof error["aeError"] === "number") {
      payload.aeError = error["aeError"];
    }
    if (typeof error["kind"] === "string") {
      payload.kind = error["kind"];
    }
    return { v, id, ok: false, durationMs, error: payload };
  }
  throw new ProtocolError('result envelope needs a boolean "ok" field');
}
