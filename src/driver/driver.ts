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

import { entryScriptPath, stageHostScript, writeBootstrapScript } from "./bootstrap.js";
import type { MacSession } from "./mac-session.js";
import type { HostRecovery } from "./recovery.js";
import {
  collectSessionDiagnostics,
  type DiagnosticsOptions,
  type SessionDiagnostics,
} from "./session-diagnostics.js";
import { errorMessage } from "../errors.js";
import {
  clearLaunchProvenance,
  recordLaunchProvenance,
} from "./launch-provenance.js";
import { READINESS_TIMEOUT_MS, ScriptInvocationTransport } from "./script-invocation.js";
import type {
  HostAttestation,
  HostOwnership,
  HostTransport,
  OwnedProcess,
  PendingLaunch,
} from "./transport.js";
import { ScriptNotSentError } from "./transport.js";

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
import type { PendingRequest, SupervisionPhase, SupervisionReport } from "../supervision/types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_HOST_SCRIPT = resolve(PACKAGE_ROOT, "host", "a8n-host.js");

/**
 * What the host looked like when an operation timed out. A timeout alone
 * cannot tell "the process died" from "the process is alive but blocked" —
 * the driver asks the transport and the recovery outcome, and records the
 * answer here so a caller never has to guess (and never retries blind).
 *
 * - `gone`: the host process is proven absent.
 * - `unresponsive`: the host process exists but did not answer.
 * - `modal`: a blocking window was observed during recovery.
 * - `unknown`: neither could be determined. Never upgraded to a guess.
 */
export type HostCondition = "gone" | "unresponsive" | "modal" | "unknown";

const HOST_CONDITION_NOTES: Record<HostCondition, string> = {
  gone: "; the After Effects process is gone",
  unresponsive: "; the After Effects process is still running but did not answer",
  modal: "; a modal window may be blocking After Effects",
  unknown: "; whether the After Effects process is still running could not be determined",
};

/**
 * Appended when the unreadable result file is empty. An empty file means the
 * host opened it but not one byte was ever written — the signature of
 * After Effects refusing script file writes
 * (`Pref_SCRIPTING_FILE_NETWORK_SECURITY = "0"`, issue #188). It is a hint,
 * not a verdict: a host that died mid-write leaves the same file.
 */
const EMPTY_RESULT_HINT =
  " The file is empty: the host opened it but wrote nothing, which is what " +
  "After Effects produces when script file/network access is disabled " +
  '(Settings > Scripting & Expressions > "Allow Scripts to Write Files and Access Network").';

export class TimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  /** What the host looked like at the deadline, when the driver could classify it. */
  readonly hostCondition?: HostCondition;

  constructor(method: string, timeoutMs: number, hostCondition?: HostCondition) {
    super(
      `After Effects did not answer ${method} within ${timeoutMs}ms` +
        (hostCondition === undefined ? "" : HOST_CONDITION_NOTES[hostCondition]),
    );
    this.name = "TimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    if (hostCondition !== undefined) {
      this.hostCondition = hostCondition;
    }
  }
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

/**
 * The host was left in a state the recovery quarantined: a blocking window it
 * could not classify, which it did not touch.
 *
 * This is *not* a timeout: the operation was not abandoned by us and must not
 * be sent again. Reporting it as one would invite exactly the retry the
 * recovery policy exists to prevent. The code is the diagnostic the run
 * reports it under.
 */
export class HostQuarantinedError extends Error {
  readonly code = "A8N-SEC-001" as const;

  constructor(evidence: string) {
    super(evidence);
    this.name = "HostQuarantinedError";
  }
}

/**
 * After Effects was started, then the launch failed before ownership was
 * proven — the readiness probe was denied (`-1743`), timed out, or the host
 * never became scriptable.
 *
 * The process is still this run's doing, but it is not this run's to quit:
 * quitting needs the probe's proof. So the identity the transport kept is
 * reported instead, and the outcome is indeterminate. This is deliberately
 * not a timeout: nothing timed out at the caller's request, and re-sending
 * the probe would make the same denied Apple Event again.
 */
export class HostLeftRunningError extends Error {
  readonly code = "A8N-AE-005" as const;
  /** The process this session started and could not prove. */
  readonly launch: PendingLaunch;

  constructor(launch: PendingLaunch, cause: unknown) {
    const session = launch.session;
    const where =
      session === null
        ? ""
        : ` in the session of ${session.user ?? `uid ${String(session.uid)}`}` +
          ` (uid ${String(session.uid)}${session.asid === null ? "" : `, asid ${String(session.asid)}`})`;
    const started =
      launch.startedAt === null
        ? ""
        : `, started ${new Date(launch.startedAt).toISOString()}`;
    const aftermath = launch.presentAtLastLookup
      ? "It is still running, and this session cannot prove it may quit it, so it was left running: " +
        "quit it by hand before running again."
      : "It was not found when the process list was last read, so whether it survived is " +
        "unknown; check before running again.";
    super(
      `After Effects was started (pid ${String(launch.pid)}${started}, ${launch.executable}${where}) ` +
        `but did not answer the readiness probe: ${errorMessage(cause)}. ${aftermath}`,
      { cause },
    );
    this.name = "HostLeftRunningError";
    this.launch = launch;
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
  /**
   * What to do when an operation times out and the host may be blocked by a
   * dialog. Optional; a driver without one reports the timeout as it is.
   */
  readonly recovery?: HostRecovery;
  /**
   * How long to wait for the timed-out request's own result after a recovery.
   * The request may still be running inside After Effects, so the driver
   * waits for it instead of sending it again.
   */
  readonly recoveryGraceMs?: number;
  /**
   * Live supervision report, when a monitor is running for this session
   * (#285). Consulted while a request waits for its result: a blocking
   * phase observed *before* the deadline triggers the same recovery the
   * timeout path would run, so a dialog does not have to burn the whole
   * budget first. The hook only reads; it never presses anything itself.
   */
  readonly supervision?: { report(): SupervisionReport | null };
};

export type CallOptions = {
  readonly timeoutMs?: number;
  /** Recorded in the trace but not sent to the host. */
  readonly opName?: string;
  /** Ask the receiving instance to remember this session, or to prove it does. Only on `verifiesDestination` transports. */
  readonly marker?: "adopt" | "require";
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Supervision phases where the host is known-or-suspected blocked. While a
 * request waits for its result, observing one of these triggers the same
 * recovery the post-timeout path runs — detection must not wait for the
 * deadline (#285).
 */
const SUPERVISION_WAIT_PHASES: ReadonlySet<SupervisionPhase> = new Set([
  "blocked",
  "recovering",
  "needs-human",
  "quarantined",
]);

/** Minimum interval between supervision report reads inside a result wait. */
const SUPERVISION_POLL_MS = 1_000;
/** Least time the probe gets once the host has said it is ready. */
const PROBE_AFTER_READY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** What waiting for the original request after a recovery found. */
type RecoveryWait =
  | { kind: "resolved"; value: unknown }
  | {
      kind: "answered";
      error: Error;
      detail: { args: Record<string, unknown>; error: { name: string; message: string } };
    }
  | { kind: "unresolved"; sawWindow: boolean };

/**
 * The settled outcome of one call: the value to return or the error to
 * throw, with the trace detail already chosen. `#call` writes the single
 * trace row from this, so every path — success, host error, transport
 * error, timeout, recovery — records exactly once.
 */
type SettledCall =
  | { readonly status: "ok"; readonly value: unknown; readonly detail: Record<string, unknown> }
  | {
      readonly status: "error" | "timeout";
      readonly error: unknown;
      readonly detail: Record<string, unknown>;
    };

export class AeDriver {
  readonly #transport: HostTransport;
  readonly #paths: SessionPaths;
  readonly #hostScriptPath: string;
  /** The copy of the host script that AE is pointed at; see bootstrap.stageHostScript. */
  readonly #stagedHostScriptPath: string;
  readonly #trace: TraceRecorder;
  readonly #defaultTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #recovery: HostRecovery | undefined;
  readonly #recoveryGraceMs: number;
  readonly #supervision: { report(): SupervisionReport | null } | undefined;
  /** The request currently inside `#settle`, for supervision's pending list. */
  #inFlight: { readonly id: string; readonly method: string; readonly since: string } | null = null;
  #started = false;
  #closed = false;
  /**
   * A host this driver started but never proved. Kept so a second `start()`
   * on the same driver does not send the probe again: the first one was
   * denied or unanswered, and repeating it would only repeat that.
   */
  #leftRunning: { readonly launch: PendingLaunch; readonly cause: unknown } | null = null;
  /** When the driver was built; host evidence is "during the session" from here. */
  readonly #constructedAt = Date.now();
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
    this.#recovery = options.recovery;
    this.#recoveryGraceMs = options.recoveryGraceMs ?? 60_000;
    this.#supervision = options.supervision;

    if (!existsSync(this.#hostScriptPath)) {
      throw new HostUnavailableError(`host script not found: ${this.#hostScriptPath}`);
    }
    // AE decides whether it may run a script from where the script sits, so
    // every file AE is pointed at lives in one folder of this session, under
    // stable names. A person approves that folder once and every later call
    // runs without another approval.
    this.#stagedHostScriptPath = stageHostScript(this.#paths.staging, this.#hostScriptPath);
    writeSessionManifest(this.#paths, {
      transport: options.transport.kind,
      hostScript: this.#hostScriptPath,
      stagedHostScript: this.#stagedHostScriptPath,
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
   * The owned After Effects process and GUI session this driver's transport
   * attests, for recovery authorization (ae-devtools #55). Only the script
   * transport can name its target; every other transport — and any state
   * where the pid or session cannot be proven — returns null. Callers must
   * treat null as "no attested target", never substitute a pid found by
   * other means.
   */
  recoveryTarget(): { pid: number; session: MacSession } | null {
    const transport = this.#transport;
    if (!(transport instanceof ScriptInvocationTransport)) {
      return null;
    }
    const pid = transport.recoveryTargetPid();
    const session = transport.targetSession;
    if (pid === null || session === null) {
      return null;
    }
    return { pid, session };
  }

  /**
   * The script-invocation transport, when this session uses one — the only
   * transport that can deliver the dispatcher activation script to a host
   * it owns (`AfterFX.exe -r`, issue #276). Null for every other
   * transport; callers must treat null as "this session cannot activate a
   * dispatcher", never substitute another delivery path.
   */
  scriptTransport(): ScriptInvocationTransport | null {
    return this.#transport instanceof ScriptInvocationTransport ? this.#transport : null;
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
    const left = this.#leftRunning;
    if (left !== null) {
      // Nothing is re-sent: the previous launch already started a process
      // that never answered, and the same Apple Event would be denied again.
      throw new HostLeftRunningError(left.launch, left.cause);
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
      // Provenance is written only for a host this session proved it owns —
      // owned by launch or by adoption alike. It is evidence for a later
      // `resume`, never authority: the record is re-checked live on use.
      // A write failure must not fail a session that is already usable.
      const ownedProcess = this.#transport.ownedProcess?.() ?? null;
      if (this.ownership().kind === "owned" && ownedProcess !== null) {
        try {
          recordLaunchProvenance(this.#paths.root, {
            transport: this.#transport.kind,
            host: ownedProcess,
          });
        } catch (error) {
          this.#trace.record("session.provenance", "error", 0, {
            error: { name: nameOf(error), message: errorMessage(error) },
          });
        }
      }
      this.#trace.record("session.launch", "ok", Date.now() - began, {
        args: { transport: this.#transport.kind },
        result: { ...info, ownership: this.ownership() },
      });
      return info;
    } catch (error) {
      // A launch can fail after the host process appeared: the Apple Event
      // that carries the probe is denied, or the host never becomes
      // scriptable. The process is then this run's doing but unowned — it is
      // never quit on the strength of provenance, and the run must not drop
      // the one thing that names it.
      const pending = this.#transport.pendingLaunch?.() ?? null;
      const detail = {
        args: { transport: this.#transport.kind },
        error: { name: nameOf(error), message: errorMessage(error) },
      };
      if (pending === null) {
        this.#trace.record("session.launch", "error", Date.now() - began, detail);
        throw error;
      }
      this.#leftRunning = { launch: pending, cause: error };
      const leftRunning = new HostLeftRunningError(pending, error);
      this.#trace.record("session.launch", "error", Date.now() - began, {
        ...detail,
        result: {
          pendingLaunch: {
            pid: pending.pid,
            startedAt: pending.startedAt,
            executable: pending.executable,
            presentAtLastLookup: pending.presentAtLastLookup,
            sessionUid: pending.session?.uid ?? null,
            sessionUser: pending.session?.user ?? null,
            sessionAsid: pending.session?.asid ?? null,
          },
          ownership: this.ownership(),
        },
      });
      throw leftRunning;
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
   * What the transport can attest about where the host runs, merged over
   * the individual optional hooks so a transport that only implements
   * `hostPid()`/`ownedProcess()` still reports them. Every field is
   * evidence or null/"unknown" — the capability handshake (#102) must
   * never have to guess.
   */
  hostAttestation(): HostAttestation {
    const attested = this.#transport.attestation?.() ?? {};
    const ownedProcess: OwnedProcess | null =
      attested.ownedProcess !== undefined
        ? attested.ownedProcess
        : (this.#transport.ownedProcess?.() ?? null);
    return {
      pid: attested.pid !== undefined ? attested.pid : (this.#transport.hostPid?.() ?? null),
      ownedProcess,
      platform: attested.platform ?? null,
      executionMode: attested.executionMode ?? "unknown",
      sessionUid: attested.sessionUid ?? null,
      sessionAsid: attested.sessionAsid ?? null,
      sessionUser: attested.sessionUser ?? null,
      requiresGuiDelivery: attested.requiresGuiDelivery ?? null,
      refusesConsoleTarget: attested.refusesConsoleTarget ?? null,
      targetInstance: attested.targetInstance ?? null,
    };
  }

  /**
   * Collects host-side evidence for this session — crash reports, host logs
   * touched while it ran, and the trace — into `<artifactsDir>/diagnostics/`
   * and returns the report. Read-only with respect to After Effects: files
   * are copied, never moved, and nothing leaves the machine.
   *
   * Safe to call at any time, including after `stop` failed: it reports what
   * it could find and says in `notes` what it could not.
   *
   * `options` overrides where evidence is looked for — tests and tooling
   * pass a fake `homeDir` or `sources` so the real user directories are
   * never scanned.
   */
  diagnostics(options: DiagnosticsOptions = {}): SessionDiagnostics {
    return collectSessionDiagnostics({
      sessionRoot: this.#paths.root,
      artifactsDir: this.#paths.artifacts,
      tracePath: this.#paths.trace,
      host: {
        state: this.#transport.hostState?.() ?? "unknown",
        ownership: this.ownership(),
        pid: this.#transport.hostPid?.() ?? null,
        transport: this.#transport.kind,
      },
      since: this.#constructedAt,
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
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
      const left = this.#leftRunning;
      if (!this.#started) {
        // A failed launch is not "never started": a process this session
        // started may still be running, and it is named so a human can find
        // it. Nothing is quit — ownership was never proven.
        result =
          left === null
            ? { quit: false, ownership, reason: "never started" }
            : {
                quit: false,
                ownership,
                reason:
                  `the After Effects this session started (pid ${String(left.launch.pid)}) never answered ` +
                  "the readiness probe, so it is not this session's to quit; it was left running",
              };
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
        // The recorded host is gone; leaving the provenance file would only
        // ever read as a stale record. Best-effort: the quit already happened.
        try {
          clearLaunchProvenance(this.#paths.root);
        } catch {
          // Provenance is advisory; a leftover file fails closed on resume.
        }
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
      // The trace row lands first so the diagnostics bundle collected below
      // contains the close failure that triggered it.
      this.#trace.record("session.close", "error", Date.now() - began, {
        error: { name: nameOf(error), message: errorMessage(error) },
      });
      if (!refused) {
        this.#closed = true;
        // An end that is not a clean quit is exactly when host-side evidence
        // matters. Collection is best-effort: it writes only inside this
        // session's artifact directory and must never mask the real error.
        try {
          this.diagnostics();
        } catch {
          // The report is a convenience; the close error is the answer.
        }
      }
      throw error;
    }
  }

  /**
   * The request this driver is currently waiting on, for supervision's
   * pending-request list (#285). `null` when nothing is in flight. The
   * record is evidence only: it never authorizes a resend.
   */
  pendingRequest(): PendingRequest | null {
    const inFlight = this.#inFlight;
    if (inFlight === null) {
      return null;
    }
    return { id: inFlight.id, method: inFlight.method, since: inFlight.since, state: "in-flight" };
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
      // On a transport that cannot aim a delivery at one instance, every
      // call after the probe must prove it lands in the instance that
      // answered it: `require` makes the host refuse before running anything
      // when the marker is absent (T096). Before this, only `app.quit`
      // carried the check, so an ordinary call could reach — and mutate —
      // an After Effects this session never proved. A transport that can aim
      // its deliveries sends no session field at all.
      ...(options.marker !== undefined
        ? {
            session: {
              id: this.#sessionId,
              ...(options.marker === "adopt" ? { adopt: true } : { require: true }),
            },
          }
        : this.#transport.verifiesDestination === true && this.#started
          ? { session: { id: this.#sessionId, require: true } }
          : {}),
    };

    // #settle decides the outcome — including the timeout recovery — and
    // this is the one place its trace row is written, so no path can record
    // twice or forget to record.
    const settled = await this.#settle(id, method, params, request, timeoutMs);
    this.#trace.record(op, settled.status, Date.now() - began, settled.detail);
    if (settled.status === "ok") {
      return settled.value;
    }
    throw settled.error;
  }

  /**
   * Runs one request to its settled outcome: invoke, wait for the result,
   * and — on a timeout — the recovery wait for the *original* request.
   * Returns what `#call` records and returns or throws; it never records
   * itself, so the trace row is written exactly once by the caller.
   */
  async #settle(
    id: string,
    method: string,
    params: Record<string, unknown>,
    request: RequestEnvelope,
    timeoutMs: number,
  ): Promise<SettledCall> {
    // When #awaitResult produced an error outcome, its detail is kept for
    // the trace record: it carries the method, request id and timeout the
    // generic failure path cannot rebuild.
    let outcomeDetail:
      | { args: Record<string, unknown>; error: { name: string; message: string } }
      | undefined;

    this.#inFlight = { id, method, since: new Date().toISOString() };
    try {
      writeRequest(this.#paths, request);
      const entry = entryScriptPath(this.#paths.root, id);
      writeBootstrapScript({
        entryPath: entry,
        hostScriptPath: this.#stagedHostScriptPath,
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
      // One timer drives both the abort signal and the race's deadline leg:
      // a transport that honours the signal rejects `invoke`; one that
      // ignores it must still not hold the caller past the budget (#296).
      let fireDeadline: () => void = () => {};
      const deadlineReached = new Promise<"deadline">((resolve) => {
        fireDeadline = () => resolve("deadline");
      });
      const timer = setTimeout(() => {
        abort.abort();
        fireDeadline();
      }, timeoutMs);
      // Supervision during the invoke wait (#296): transports differ in
      // when invoke returns — the script lane only returns once AE finished
      // the script, the dispatcher returns at enqueue. A proven blocking
      // phase means the wait is already lost either way, so abort early and
      // let the result wait below run recovery and late-result
      // reconciliation inside the same deadline. Aborting stops *our* wait
      // only; whatever AE is doing continues, and the result file — never a
      // resend — remains the answer.
      let invokeError: unknown = null;
      let invokeRejected = false;
      const invokeSettled = this.#transport
        .invoke(entry, { signal: abort.signal })
        .then(
          () => undefined,
          (error: unknown) => {
            invokeRejected = true;
            invokeError = error;
          },
        );
      const watch = this.#invokeBlockWatch(abort);
      try {
        const winner = await Promise.race([
          invokeSettled.then(() => "invoke" as const),
          watch.fired,
          deadlineReached,
        ]);
        if (winner === "blocked") {
          // A transport that honours the abort rejects shortly; one that
          // ignores it must not hold the caller. `invokeSettled` already
          // absorbs the late rejection, and the result wait below takes
          // over with whatever time the deadline still owes.
          if (invokeError instanceof ScriptNotSentError) {
            throw invokeError;
          }
        } else if (winner === "deadline") {
          // The budget is spent whether or not the transport noticed the
          // abort. A real invoke failure that landed first still wins.
          if (invokeRejected) {
            throw invokeError;
          }
          throw new TimeoutError(method, timeoutMs);
        } else if (invokeRejected) {
          throw invokeError;
        }
        // winner === "invoke" and no rejection: the transport returned and
        // the result wait runs exactly as before.
      } catch (error) {
        // A call that never reached the host is not a timeout of the
        // operation: nothing ran, so there is nothing to recover from and
        // nothing to wait for. It is reported as what it is.
        if (error instanceof ScriptNotSentError) {
          throw error;
        }
        if (abort.signal.aborted) {
          throw new TimeoutError(method, timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        watch.cancel();
      }

      const outcome = await this.#awaitResult(
        id,
        method,
        params,
        Math.max(0, deadline - Date.now()),
        timeoutMs,
      );
      if (outcome.status === "ok") {
        return { status: "ok", value: outcome.value, detail: outcome.detail };
      }
      outcomeDetail = outcome.detail;
      throw outcome.error;
    } catch (error) {
      let failure = error;
      if (error instanceof TimeoutError) {
        let sawWindow = false;
        if (this.#recovery !== undefined) {
          let waited: RecoveryWait;
          try {
            waited = await this.#recoverAndWait(id, method, params, timeoutMs);
          } catch (recoveryError) {
            // A quarantined host is an answer about the session, recorded on
            // session.recover; the operation still leaves its one record.
            return {
              status: "error",
              error: recoveryError,
              detail: {
                ...(outcomeDetail ?? { args: { ...params } }),
                error: { name: nameOf(recoveryError), message: errorMessage(recoveryError) },
              },
            };
          }
          if (waited.kind === "resolved") {
            return {
              status: "ok",
              value: waited.value,
              detail: { result: { recovered: true, ...summariseResult(waited.value) } },
            };
          }
          if (waited.kind === "answered") {
            return { status: "error", error: waited.error, detail: waited.detail };
          }
          sawWindow = waited.sawWindow;
        }
        // A timeout is not a diagnosis. Before reporting it, ask what the
        // host looked like: a dead process, a live-but-blocked one, a modal
        // window the recovery saw, or honestly unknown.
        failure = new TimeoutError(error.method, error.timeoutMs, this.#timeoutHostCondition(sawWindow));
      }
      const status: TraceStatus = failure instanceof TimeoutError ? "timeout" : "error";
      return {
        status,
        error: failure,
        detail: {
          ...(outcomeDetail ?? { args: { ...params } }),
          error: { name: nameOf(failure), message: errorMessage(failure) },
          ...(failure instanceof TimeoutError && failure.hostCondition !== undefined
            ? { result: { hostCondition: failure.hostCondition } }
            : {}),
        },
      };
    } finally {
      this.#inFlight = null;
    }
  }

  /**
   * Classifies a timed-out call from what is actually known: a blocking
   * window the recovery observed beats a process probe, and a probe that
   * cannot attribute a process stays "unknown" rather than guessing.
   */
  #timeoutHostCondition(sawWindow: boolean): HostCondition {
    if (sawWindow) {
      return "modal";
    }
    // Supervision may have seen the block the recovery never reached: a
    // blocking phase or a blocking window in the durable report is the same
    // evidence `sawWindow` carries, read from the shared state (#285).
    const report = this.#supervision?.report() ?? null;
    if (report?.status === "observed") {
      const doc = report.doc;
      if (
        SUPERVISION_WAIT_PHASES.has(doc.phase) ||
        (doc.blocking?.windows.some((window) => window.blocking) ?? false)
      ) {
        return "modal";
      }
    }
    const state = this.#transport.hostState?.();
    if (state === "gone") {
      return "gone";
    }
    if (state === "alive") {
      return "unresponsive";
    }
    return "unknown";
  }

  /**
   * One recovery attempt, traced once. Shared by the post-timeout path and
   * the supervision early trigger (#285) so both record `session.recover`
   * identically. "quarantined" carries the error the caller must surface;
   * it is never retried and never re-sent.
   */
  async #tryRecovery(
    id: string,
    method: string,
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "recovered"; readonly sawWindow: boolean }
    | { readonly kind: "unresolved"; readonly sawWindow: boolean }
    | { readonly kind: "quarantined"; readonly error: HostQuarantinedError }
  > {
    const recovery = this.#recovery;
    if (recovery === undefined) {
      return { kind: "unresolved", sawWindow: false };
    }
    let outcome: Awaited<ReturnType<HostRecovery["attempt"]>>;
    try {
      outcome = await recovery.attempt({ requestId: id, method, timeoutMs });
    } catch (error) {
      this.#trace.record("session.recover", "error", 0, {
        error: { name: nameOf(error), message: errorMessage(error) },
      });
      return { kind: "unresolved", sawWindow: false };
    }
    const sawWindow = outcome.window !== undefined;
    this.#trace.record("session.recover", outcome.recovered ? "ok" : "error", 0, {
      result: {
        recovered: outcome.recovered,
        evidence: outcome.evidence,
        ...(outcome.outcome === undefined ? {} : { outcome: outcome.outcome }),
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.window === undefined ? {} : { window: outcome.window }),
        ...(outcome.screenshotPath === undefined ? {} : { screenshot: outcome.screenshotPath }),
      },
    });
    if (!outcome.recovered) {
      if (outcome.code !== undefined) {
        return { kind: "quarantined", error: new HostQuarantinedError(outcome.evidence) };
      }
      return { kind: "unresolved", sawWindow };
    }
    return { kind: "recovered", sawWindow };
  }

  /**
   * Tries to unblock the host, then waits for the *original* request.
   *
   * The request that timed out may still be running inside After Effects: a
   * timeout says the answer did not arrive in time, not that the work was
   * abandoned. Sending it again would run it twice — a render, a project
   * open, an export. So after a recovery the driver waits for the result of
   * the request it already sent, and only reports a failure when that result
   * does not arrive either.
   *
   * Returns the recovered result. "Unresolved" means no result arrived
   * either (the caller then reports the original timeout), with `sawWindow`
   * recording whether the recovery observed a blocking window — what lets
   * the timeout be classified "modal". It throws the host's error when the
   * original request finished with one — the recovery unblocked it, so its
   * answer is the real outcome.
   */
  async #recoverAndWait(
    id: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<RecoveryWait> {
    const recovery = this.#recovery;
    if (recovery === undefined) {
      return { kind: "unresolved", sawWindow: false };
    }
    const attempt = await this.#tryRecovery(id, method, timeoutMs);
    if (attempt.kind === "quarantined") {
      // A quarantined state is an answer, not a timeout: the blocking window
      // is a human's decision and the operation must not be retried. Throwing
      // here keeps the caller from reading a licence dialog as "try again".
      throw attempt.error;
    }
    if (attempt.kind === "unresolved") {
      return { kind: "unresolved", sawWindow: attempt.sawWindow };
    }
    const result = await this.#awaitResult(id, method, params, this.#recoveryGraceMs, timeoutMs, false);
    if (result.status === "ok") {
      return { kind: "resolved", value: result.value };
    }
    // An error the host itself sent is the answer to the request that timed
    // out: the recovery unblocked it and the operation it had already started
    // failed. Reporting the earlier timeout would hide the host's error and
    // invite the caller to send the operation again. A result that never
    // became readable is not an answer — the caller keeps the timeout.
    if (result.error instanceof HostError) {
      return { kind: "answered", error: result.error, detail: result.detail };
    }
    return { kind: "unresolved", sawWindow: attempt.sawWindow };
  }

  /**
   * Watches the supervision report while `invoke` is awaited (#296).
   * `fired` resolves `"blocked"` — after aborting the invoke wait — when the
   * durable state proves a blocking phase, and stays pending otherwise:
   * `cancel()` or a missing hook simply lets the invoke wait run to its own
   * deadline. An absent or `unavailable` report never fires, so a dead
   * monitor cannot fake a block or a clean screen.
   */
  #invokeBlockWatch(abort: AbortController): {
    readonly fired: Promise<"blocked">;
    readonly cancel: () => void;
  } {
    let cancelled = false;
    const never = new Promise<"blocked">(() => {});
    const fired = (async (): Promise<"blocked"> => {
      const supervision = this.#supervision;
      if (supervision === undefined) {
        return never;
      }
      while (!cancelled && !abort.signal.aborted) {
        await sleep(SUPERVISION_POLL_MS);
        if (cancelled || abort.signal.aborted) {
          return never;
        }
        const report = supervision.report();
        if (
          report?.status === "observed" &&
          SUPERVISION_WAIT_PHASES.has(report.doc.phase)
        ) {
          abort.abort();
          return "blocked";
        }
      }
      return never;
    })();
    return { fired, cancel: () => { cancelled = true; } };
  }

  async #awaitResult(
    id: string,
    method: string,
    params: Record<string, unknown>,
    remainingMs: number,
    timeoutMs: number,
    allowEarlyRecovery = true,
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
    let lastUnreadableBytes: number | undefined;
    // Supervision early trigger (#285): at most one attempt per wait, at
    // most one report read per second. The original request is never
    // resent — a recovered block simply lets its already-running script
    // finish inside the same deadline.
    let lastSupervisionCheck = 0;
    let supervisionRecoveryTried = false;

    for (;;) {
      const probe = probeResult(this.#paths, id);

      if (probe.state === "unreadable") {
        // The result exists but is not yet a whole envelope. The host publishes
        // by rename, and falls back to a direct write when the rename fails;
        // only that fallback can be observed half-written. Keep polling.
        lastUnreadable = probe.reason;
        lastUnreadableBytes = probe.bytes;
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
      if (
        allowEarlyRecovery &&
        !supervisionRecoveryTried &&
        this.#recovery !== undefined &&
        this.#supervision !== undefined &&
        Date.now() - lastSupervisionCheck >= SUPERVISION_POLL_MS
      ) {
        lastSupervisionCheck = Date.now();
        const report = this.#supervision.report();
        if (
          report?.status === "observed" &&
          SUPERVISION_WAIT_PHASES.has(report.doc.phase)
        ) {
          supervisionRecoveryTried = true;
          const attempt = await this.#tryRecovery(id, method, timeoutMs);
          if (attempt.kind === "quarantined") {
            return {
              status: "error",
              error: attempt.error,
              detail: {
                args: { method, ...params },
                error: { name: attempt.error.name, message: attempt.error.message },
              },
            };
          }
          // "recovered" and "unresolved" both keep polling: the request may
          // still finish inside the same deadline, and the timeout path
          // remains the fallback if it does not.
        }
      }
      if (Date.now() >= deadline) {
        // A file that never became readable is a publication problem, not a
        // slow host. Saying "timed out" here would send the reader looking in
        // the wrong place entirely.
        const cause =
          lastUnreadable === undefined
            ? null
            : new ProtocolError(
                `result file for ${method} (${id}) was never parseable: ${lastUnreadable}` +
                  (lastUnreadableBytes === 0 ? EMPTY_RESULT_HINT : ""),
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
