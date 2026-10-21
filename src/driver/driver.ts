/**
 * The driver: request in, result out, everything else hidden.
 *
 * Callers of the public API never touch this class. It exists so the transport
 * (real After Effects process, fake host, future CEP socket) can change without
 * the API surface moving.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { entryScriptPath, writeBootstrapScript } from "./bootstrap.js";
import { READINESS_TIMEOUT_MS } from "./script-invocation.js";
import type { HostOwnership, HostTransport } from "./transport.js";

export type StopOptions = {
  /** "discard" permits throwing away the open project's unsaved changes. */
  readonly unsavedChanges?: "refuse" | "discard";
};

export type StopResult = {
  /** Whether After Effects was asked to quit, and exited. */
  readonly quit: boolean;
  readonly ownership: HostOwnership;
  /** Why it was not quit. */
  readonly reason?: string;
};
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
  probeResult,
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
  /** Budget for the post-launch readiness probe; a cold AE start is slow. */
  readonly readinessTimeoutMs?: number;
};

export type CallOptions = {
  readonly timeoutMs?: number;
  /** Recorded in the trace but not sent to the host. */
  readonly opName?: string;
  /** Ask the receiving instance to remember this session, or to prove it does. Only on `verifiesDestination` transports. */
  readonly marker?: "adopt" | "require";
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** Least time the probe gets once the host has said it is ready. */
const PROBE_AFTER_READY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export class AeDriver {
  readonly #transport: HostTransport;
  readonly #paths: SessionPaths;
  readonly #hostScriptPath: string;
  readonly #trace: TraceRecorder;
  readonly #defaultTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  #started = false;
  #closed = false;
  /** Random per driver; what the host remembers to tell "my instance" from another. */
  readonly #sessionId = randomUUID();

  constructor(options: DriverOptions) {
    this.#transport = options.transport;
    this.#paths = createSessionPaths(options.sessionRoot);
    this.#hostScriptPath = options.hostScriptPath ?? DEFAULT_HOST_SCRIPT;
    this.#trace = options.trace;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    // A cold After Effects start is slow. Sharing the per-operation budget with
    // the probe would report a healthy-but-slow host as a broken install.
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;

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
      if (this.#transport.awaitScriptable !== undefined) {
        const scriptable = await this.#transport.awaitScriptable(this.#readinessTimeoutMs);
        if (!scriptable) {
          throw new HostUnavailableError(
            `After Effects did not become ready to run scripts within ${this.#readinessTimeoutMs}ms ` +
              `(a dialog may be open in it, such as crash recovery); no script was sent`,
          );
        }
      }
      // The probe and the teardown quit are lifecycle detail, not operations
      // the caller issued; naming them keeps the trace readable without
      // dropping the record.
      const info = (await this.#call("app.info", {}, {
        // Waiting for the host to be ready has used some of the budget, but
        // the probe itself only needs the answer time of one script.
        timeoutMs: this.#transport.awaitScriptable === undefined
          ? this.#readinessTimeoutMs
          : Math.max(Math.min(PROBE_AFTER_READY_MS, this.#readinessTimeoutMs), this.#readinessTimeoutMs - (Date.now() - began)),
        opName: "session.probe",
        ...(this.#transport.verifiesDestination === true ? { marker: "adopt" as const } : {}),
      })) as {
        version: string;
        build?: string;
      };
      this.#started = true;
      this.#transport.confirmLaunched?.();
      this.#trace.record("session.launch", "ok", Date.now() - began, {
        args: { transport: this.#transport.kind },
        result: { ...info, ownership: this.ownership() },
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

  /** Who owns the host process right now; see `HostOwnership`. */
  ownership(): HostOwnership {
    return this.#transport.ownership?.() ?? {
      kind: "unknown",
      evidence: `transport ${this.#transport.kind} reports no ownership`,
    };
  }

  /**
   * Ends the session. Quits After Effects only when this session owns it
   * *now* — started it, and it is still that process. An attached or
   * unidentified host is left running, untouched.
   *
   * Quitting never discards unsaved changes unless `unsavedChanges` is
   * "discard": the host refuses with UnsavedChangesError, and the session
   * stays open so the caller can decide.
   */
  async stop(options: StopOptions = {}): Promise<StopResult> {
    if (this.#closed) {
      return { quit: false, ownership: this.ownership(), reason: "already closed" };
    }
    const began = Date.now();
    const ownership = this.ownership();
    try {
      let result: StopResult;
      if (!this.#started) {
        result = { quit: false, ownership, reason: "never started" };
      } else if (ownership.kind !== "owned") {
        result = { quit: false, ownership, reason: `not quitting a host this session does not own (${ownership.evidence})` };
      } else {
        await this.#call(
          "app.quit",
          { discardUnsavedChanges: options.unsavedChanges === "discard" },
          {
            timeoutMs: 10_000,
            opName: "session.quit",
            ...(this.#transport.verifiesDestination === true ? { marker: "require" as const } : {}),
          },
        );
        await this.#transport.close();
        result = { quit: true, ownership };
      }
      this.#closed = true;
      this.#trace.record("session.close", "ok", Date.now() - began, {
        result: { quit: result.quit, ownership: result.ownership.kind, ...(result.reason === undefined ? {} : { reason: result.reason }) },
      });
      return result;
    } catch (error) {
      // Unsaved changes are a decision for the caller, not a dead session.
      const refused = error instanceof HostError && error.name === "UnsavedChangesError";
      if (error instanceof HostError && error.name === "SessionMismatch") {
        // The quit reached an instance that never answered this session's probe,
        // and did nothing. Not an error in the caller's terms: the AE this
        // session owns is simply still running, and nothing else was touched.
        this.#closed = true;
        const result: StopResult = {
          quit: false,
          ownership: this.ownership(),
          reason: `quit refused: it reached a different After Effects instance than the one that answered this session (${error.message})`,
        };
        this.#trace.record("session.close", "ok", Date.now() - began, {
          result: { quit: false, ownership: result.ownership.kind, reason: result.reason ?? "" },
        });
        return result;
      }
      if (!refused) {
        this.#closed = true;
      }
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
      ...(options.marker === undefined
        ? {}
        : { session: { id: this.#sessionId, ...(options.marker === "adopt" ? { adopt: true } : { require: true }) } }),
    };

    try {
      writeRequest(this.#paths, request);
      const entry = entryScriptPath(this.#paths.root, id);
      writeBootstrapScript({
        entryPath: entry,
        hostScriptPath: this.#hostScriptPath,
        requestPath: `${this.#paths.inbox}/${id}.request.json`,
        resultPath: `${this.#paths.outbox}/${id}.result.json`,
        id,
      });

      // The deadline covers the invocation as well as the wait for a result:
      // on macOS invoke returns only when the script has finished, so a
      // deadline started afterwards never fired for a slow or hung script
      // (observed: a 2 s call answered after 9.9 s on a real AE). Aborting
      // makes the transport stop waiting; the script itself runs on in AE.
      const deadline = Date.now() + timeoutMs;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        await this.#transport.invoke(entry, { signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) {
          throw new TimeoutError(method, timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const outcome = await this.#awaitResult(
        id,
        method,
        params,
        Math.max(0, deadline - Date.now()),
        timeoutMs,
      );
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
    remainingMs: number,
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
    const deadline = Date.now() + remainingMs;
    let interval = REQUEST_POLL_INTERVAL_MS;
    // Kept so a deadline reached with an unparseable file reports the real
    // cause instead of a bare timeout.
    let lastUnreadable: string | undefined;

    for (;;) {
      const probe = probeResult(this.#paths, id);

      if (probe.state === "unreadable") {
        // The result exists but is not yet a whole envelope. The host publishes
        // by rename, and falls back to a direct write when the rename fails;
        // only that fallback can be observed half-written. Keep polling.
        lastUnreadable = probe.reason;
      } else if (probe.state === "read") {
        const parsed = parseResultEnvelope(probe.envelope);
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
        // A file that never became readable is a publication problem, not a
        // slow host. Saying "timed out" here would send the reader looking in
        // the wrong place entirely.
        const cause =
          lastUnreadable === undefined
            ? null
            : new ProtocolError(
                `result file for ${method} (${id}) was never parseable: ${lastUnreadable}`,
              );
        return {
          status: "error",
          error: cause ?? new TimeoutError(method, timeoutMs),
          detail: {
            args: { method, ...params, timeoutMs, ...(cause === null ? {} : { requestId: id }) },
            error:
              cause === null
                ? { name: "TimeoutError", message: `${method} timed out after ${timeoutMs}ms` }
                : { name: "ProtocolError", message: cause.message },
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
