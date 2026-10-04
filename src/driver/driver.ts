/**
 * The driver: request in, result out, everything else hidden.
 *
 * Callers of the public API never touch this class. It exists so the transport
 * (real After Effects process, fake host, future CEP socket) can change without
 * the API surface moving.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { entryScriptPath, writeBootstrapScript } from "./bootstrap.js";
import type { HostTransport } from "./transport.js";
import {
  HostError,
  ProtocolError,
  parseRequestEnvelope,
  parseResultEnvelope,
  type RequestEnvelope,
} from "../protocol/envelope.js";
import {
  REQUEST_POLL_INTERVAL_MS,
  REQUEST_POLL_MAX_INTERVAL_MS,
  createSessionPaths,
  nextRequestId,
  readResultIfPresent,
  writeRequest,
  writeSessionManifest,
  type SessionPaths,
} from "../protocol/workspace.js";
import type { TraceRecorder, TraceStatus } from "../trace/trace.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_HOST_SCRIPT = resolve(PACKAGE_ROOT, "host", "a8n-host.js");

export class TimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`After Effects did not answer ${method} within ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export type DriverOptions = {
  readonly transport: HostTransport;
  /** Directory for request/result files, artifacts, and the trace. */
  readonly sessionRoot: string;
  readonly hostScriptPath?: string;
  readonly trace: TraceRecorder;
  readonly defaultTimeoutMs?: number;
};

export type CallOptions = {
  readonly timeoutMs?: number;
  /** Recorded in the trace but not sent to the host. */
  readonly opName?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export class AeDriver {
  readonly #transport: HostTransport;
  readonly #paths: SessionPaths;
  readonly #hostScriptPath: string;
  readonly #trace: TraceRecorder;
  readonly #defaultTimeoutMs: number;
  #started = false;
  #closed = false;

  constructor(options: DriverOptions) {
    this.#transport = options.transport;
    this.#paths = createSessionPaths(options.sessionRoot);
    this.#hostScriptPath = options.hostScriptPath ?? DEFAULT_HOST_SCRIPT;
    this.#trace = options.trace;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!existsSync(this.#hostScriptPath)) {
      throw new HostUnavailableError(`host script not found: ${this.#hostScriptPath}`);
    }
    writeSessionManifest(this.#paths, {
      transport: options.transport.kind,
      hostScript: this.#hostScriptPath,
      pid: process.pid,
    });
  }

  get sessionRoot(): string {
    return this.#paths.root;
  }

  get artifactsDir(): string {
    return this.#paths.artifacts;
  }

  get transportKind(): string {
    return this.#transport.kind;
  }

  /**
   * Launch the host and prove it answers before returning. Without the probe,
   * every later call fails identically and the trace cannot tell "AE never
   * started" from "AE rejected this operation".
   */
  async start(): Promise<{ version: string; build?: string }> {
    if (this.#started) {
      throw new Error("driver already started");
    }
    const began = Date.now();
    try {
      await this.#transport.launch();
      // The probe and the teardown quit are lifecycle detail, not operations
      // the caller issued; naming them keeps the trace readable without
      // dropping the record.
      const info = (await this.#call("app.info", {}, { timeoutMs: 15_000, opName: "session.probe" })) as {
        version: string;
        build?: string;
      };
      this.#started = true;
      this.#trace.record("session.launch", "ok", Date.now() - began, {
        args: { transport: this.#transport.kind },
        result: info,
      });
      return info;
    } catch (error) {
      this.#trace.record("session.launch", "error", Date.now() - began, {
        args: { transport: this.#transport.kind },
        error: { name: nameOf(error), message: messageOf(error) },
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const began = Date.now();
    try {
      // `app.quit` still has to reach the host, so the closed flag is only set
      // once teardown has actually run.
      if (this.#started) {
        await this.#call("app.quit", {}, { timeoutMs: 10_000, opName: "session.quit" });
      }
      await this.#transport.close();
      this.#closed = true;
      this.#trace.record("session.close", "ok", Date.now() - began);
    } catch (error) {
      this.#closed = true;
      this.#trace.record("session.close", "error", Date.now() - began, {
        error: { name: nameOf(error), message: messageOf(error) },
      });
      throw error;
    }
  }

  /** Invoke a host method and return its result, unwrapped. */
  async call<T>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    return (await this.#call(method, params, options)) as T;
  }

  async #call(method: string, params: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    if (this.#closed) {
      throw new Error("driver is closed");
    }
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const op = options.opName ?? method;
    const began = Date.now();
    const id = nextRequestId();

    const request: RequestEnvelope = {
      v: 1,
      id,
      method,
      params,
      timeoutMs,
    };

    try {
      writeRequest(this.#paths, request);
      const entry = entryScriptPath(this.#paths.root, id);
      writeBootstrapScript({
        entryPath: entry,
        hostScriptPath: this.#hostScriptPath,
        requestPath: `${this.#paths.inbox}/${id}.request.json`,
        resultPath: `${this.#paths.outbox}/${id}.result.json`,
      });

      await this.#transport.invoke(entry);

      const outcome = await this.#awaitResult(id, method, params, timeoutMs);
      this.#trace.record(op, outcome.status, Date.now() - began, outcome.detail);
      if (outcome.status === "error") {
        throw outcome.error;
      }
      return outcome.value;
    } catch (error) {
      const status: TraceStatus = error instanceof TimeoutError ? "timeout" : "error";
      this.#trace.record(op, status, Date.now() - began, {
        args: { ...params },
        error: { name: nameOf(error), message: messageOf(error) },
      });
      throw error;
    }
  }

  async #awaitResult(
    id: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<
    | {
        status: "ok";
        value: unknown;
        detail: { args: Record<string, unknown>; result: Record<string, unknown> };
      }
    | {
        status: "error";
        error: Error;
        detail: { args: Record<string, unknown>; error: { name: string; message: string } };
      }
  > {
    const deadline = Date.now() + timeoutMs;
    let interval = REQUEST_POLL_INTERVAL_MS;

    for (;;) {
      const envelope = readResultIfPresent(this.#paths, id);
      if (envelope !== null) {
        const parsed = parseResultEnvelope(envelope);
        if (parsed.ok) {
          const value = parsed.result;
          return {
            status: "ok",
            value,
            detail: { args: { method, ...params }, result: summariseResult(value) },
          };
        }
        return {
          status: "error",
          error: new HostError(parsed.error),
          detail: {
            args: { method, ...params },
            error: { name: parsed.error.name, message: parsed.error.message },
          },
        };
      }
      if (Date.now() >= deadline) {
        return {
          status: "error",
          error: new TimeoutError(method, timeoutMs),
          detail: {
            args: { method, ...params, timeoutMs },
            error: { name: "TimeoutError", message: `${method} timed out after ${timeoutMs}ms` },
          },
        };
      }
      await sleep(interval);
      interval = Math.min(interval * 1.5, REQUEST_POLL_MAX_INTERVAL_MS);
    }
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summariseResult(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return { value };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      out[key] = `[array(${entry.length})]`;
    } else if (entry !== null && typeof entry === "object") {
      out[key] = "{...}";
    } else {
      out[key] = entry;
    }
  }
  return out;
}

export { parseRequestEnvelope, ProtocolError };
