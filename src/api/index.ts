/**
 * The public automation API.
 *
 * The one thing this layer guarantees: a caller never sees a method name, an
 * envelope, a host script, or a file path used for IPC. Everything below is
 * `ae-a8n`'s business.
 *
 * ```ts
 * const ae = await AfterEffects.launch();
 * const project = await ae.openProject("fixture.aep");
 * const comp = await project.comp("Main");
 * const layer = await comp.layer("Solid 1");
 * const effect = await layer.effects.apply("Example Plugin");
 * await effect.parameter("Amount").set(50);
 * const frame = await comp.renderFrame(0);
 * await ae.close();
 * ```
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AeDriver } from "../driver/driver.js";
import { readGuiSession, readGuiSessionFailure, type MacSession } from "../driver/mac-session.js";
import { MacHostRecovery } from "../driver/recovery.js";
import {
  readLaunchProvenance,
  type LaunchProvenance,
} from "../driver/launch-provenance.js";
import { ScriptInvocationTransport } from "../driver/script-invocation.js";
import { DispatcherTransport } from "../driver/dispatcher-transport.js";
import { DISPATCHER_TRANSPORT_KIND, type HostTransport } from "../driver/transport.js";
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type SessionAuthorization,
} from "../driver/transport.js";
import { readExtensionHeader } from "../extensions/manifest.js";
import { TraceRecorder, type TraceEvent } from "../trace/trace.js";
import {
  buildCapabilityHandshake,
  newCapabilityHostNonce,
  type HandshakeResponse,
} from "./capabilities.js";
import { guiStateReport } from "./gui-state.js";
import {
  AfterEffectsError,
  EntityNotFoundError,
  ExtensionMethodNotFoundError,
  HostError,
  HostNotOwnedError,
  ParameterValueError,
  PropertyHasNoValueError,
  contextualise,
} from "./errors.js";
import type { StopResult } from "../driver/driver.js";
import type { HostOwnership } from "../driver/transport.js";
import type { TransportSelection } from "./types.js";

/** What `AfterEffects.close` did. */
export type CloseResult = StopResult;
export type { HostOwnership };
import type {
  ApplicationInfo,
  CommandExecution,
  CompInfo,
  CreateCompOptions,
  DiagnosticsOptions,
  LayerTransform,
  SceneSnapshot,
  ShapePath,
  TextLayerInfo,
  TextLayerOptions,
  EffectInfo,
  GuiStateReport,
  LaunchOptions,
  LayerInfo,
  OpenProjectOptions,
  OperationOptions,
  ResumeOptions,
  ParameterValue,
  ProjectInfo,
  PropertyInfo,
  PropertyKind,
  RenderOptions,
  RenderedFrame,
  SessionDiagnostics,
} from "./types.js";

export * from "./errors.js";
export type * from "./types.js";
// The capability-handshake surface is exported once, from the package
// entry point (src/index.ts → ./api/capabilities.js); re-exporting it here
// too would duplicate the list and leak test-only symbols twice.

/** Internal call surface; not exported so callers cannot bypass the API. */
class Session {
  readonly driver: AeDriver;
  readonly trace: TraceRecorder;
  readonly events: TraceEvent[] = [];
  /** The consumer's explicit grant for non-owned operations (#145). */
  readonly authorization: SessionAuthorization;

  constructor(driver: AeDriver, trace: TraceRecorder, authorization: SessionAuthorization = {}) {
    this.driver = driver;
    this.trace = trace;
    this.authorization = authorization;
    trace.subscribe((event) => {
      this.events.push(event);
    });
  }

  async call<T>(
    op: string,
    method: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    const timeoutMs = optionalTimeout(options.timeoutMs);
    try {
      return (await this.driver.call(method, params, {
        opName: op,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
    } catch (error) {
      contextualise(op, error);
    }
  }
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  return value;
}

/**
 * The wait after a GUI recovery, in milliseconds.
 *
 * Zero is meaningful — it stops waiting for the original request as soon as
 * the dialog has been pressed — so the lower bound is 0, not 1.
 */
function requireGrace(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("recoveryGraceMs must be a non-negative number");
  }
  return value;
}

/**
 * The login session of a uid, for the GUI fallback.
 *
 * A user who is not logged in has no session, and a session that is not an
 * Aqua session has no screen. Both are refused here rather than discovered
 * halfway through a recovery.
 */
function requireSession(uid: number): MacSession {
  const session = readGuiSession(uid);
  if (session === null) {
    // A refusal to answer is not an answer. `launchctl print gui/<other uid>`
    // is "Operation not permitted" for a non-root process outside that
    // session, and telling a logged-in user to log in sends the caller in
    // entirely the wrong direction.
    const failure = readGuiSessionFailure(uid);
    if (failure !== null && /operation not permitted|not permitted/i.test(failure)) {
      throw new AfterEffectsError(
        `uid ${uid}'s login session could not be read: macOS refused this process (launchctl: ${failure}). ` +
          "The user may well be logged in; only a process running in that session (or root) can ask about it. " +
          "Nothing was started.",
        "session.launch",
      );
    }
    throw new AfterEffectsError(
      `uid ${uid} has no login session on this Mac, so no After Effects of that user could be reached. ` +
        // The failure text is carried whenever there was one: an unexpected
        // refusal (a transient launchctl error, launchctl missing) must not
        // read as "the user is not logged in", which is the opposite advice.
        (failure === null ? "" : `launchctl said: ${failure}. `) +
        "Log that user in — a fast user switch is enough — and try again. Nothing was started.",
      "session.launch",
    );
  }
  if (session.kind !== "Aqua") {
    throw new AfterEffectsError(
      `uid ${uid} has a ${session.kind} session, not a graphical one, so there is no screen to recover. ` +
        "The GUI fallback is not available for it. Nothing was started.",
      "session.launch",
    );
  }
  return session;
}

/** A finite number, or an array of finite numbers; the host checks the shape. */
function requireParameterValue(value: unknown): asserts value is ParameterValue {
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!(finite(value) || (Array.isArray(value) && value.every(finite)))) {
    throw new TypeError("parameter value must be a finite number or an array of finite numbers");
  }
}

function isNoValueKind(kind: unknown): kind is Exclude<PropertyKind, "value"> {
  return kind === "no-value" || kind === "custom-value" || kind === "group";
}

/**
 * Whether a path is absolute in the host's terms, decided from the text
 * alone so it does not depend on the caller's OS (a transport may run After
 * Effects on another machine). Absolute: POSIX `/…`; Windows `C:\…` or
 * `C:/…`; UNC `\\server\share\…` (and `\\?\…`). Everything else is
 * resolved by After Effects against *its own* working directory, which is
 * not the caller's: `copy.aep`, `./x`, `../x`, `~/x`, drive-relative `C:x`,
 * and rooted-without-drive `\x`.
 */
export function isAbsoluteProjectPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/** Rejects a relative project path before anything is sent; never resolves it. */
function requireAbsoluteProjectPath(value: unknown): string {
  const path = requireString(value, "path");
  if (!isAbsoluteProjectPath(path)) {
    throw new TypeError(
      `project path must be absolute, got ${JSON.stringify(path)}: After Effects would resolve it against its own ` +
        `working directory, not yours. Resolve it first, e.g. path.resolve(${JSON.stringify(path)}).`,
    );
  }
  return path;
}

/** Edit › Undo and Edit › Redo, as AE 26.5x89 numbers them. */
export const UNDO_COMMAND_ID = 16;
export const REDO_COMMAND_ID = 2035;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireEnvironment(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("hostEnvironment must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new TypeError(`hostEnvironment name is not a portable variable name: ${JSON.stringify(name)}`);
    }
    if (typeof entry !== "string") {
      throw new TypeError(`hostEnvironment.${name} must be a string`);
    }
    out[name] = entry;
  }
  return out;
}

function requirePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return value;
}

/**
 * The operation classes a session grant can cover, for validation and for
 * the handshake's `grantedOperations` report (#145).
 */
const GRANT_SCOPES = AUTHORIZATION_SCOPES;

/**
 * Validates `LaunchOptions.authorization`: an object whose keys are grant
 * scopes, `extensionMethods` being `true`, `false`, or a list of declared
 * method names, the rest booleans. Anything else is refused before launch —
 * a grant that cannot be read is not a grant.
 */
function requireAuthorization(value: unknown): SessionAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("authorization must be an object of grant scopes");
  }
  const grant: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(GRANT_SCOPES as readonly string[]).includes(key)) {
      throw new TypeError(
        `authorization.${key} is not a grant scope; known scopes: ${GRANT_SCOPES.join(", ")}`,
      );
    }
    if (key === "extensionMethods") {
      if (entry === true || entry === false) {
        grant[key] = entry;
      } else if (Array.isArray(entry) && entry.every((name) => typeof name === "string")) {
        // Snapshot: the session's grant must not follow later mutation of
        // the caller's array — authorization is fixed when the session opens.
        grant[key] = [...entry];
      } else {
        throw new TypeError("authorization.extensionMethods must be true, false, or a list of method names");
      }
    } else if (typeof entry === "boolean") {
      grant[key] = entry;
    } else {
      throw new TypeError(`authorization.${key} must be a boolean`);
    }
  }
  return grant;
}

/** The scope names this session is actually authorized for, for reporting. */
export function grantedScopes(session: Session): readonly AuthorizationScope[] {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned") {
    // An owned session needs no grant: every scope is allowed. Reporting the
    // full list keeps "what may this session do" answerable in one place.
    return GRANT_SCOPES;
  }
  if (ownership.kind === "unknown") {
    // A grant never authorizes an unproven target, so reporting scopes here
    // would overstate what the session may do.
    return [];
  }
  const grant = session.authorization;
  return GRANT_SCOPES.filter((scope) => {
    const value = grant[scope];
    return value === true || (Array.isArray(value) && value.length > 0);
  });
}

/**
 * Whether the session's grant covers `scope` for `method` (when the scope
 * is method-scoped, as `extensionMethods` is). Owned sessions are always
 * covered; anything else needs the explicit grant (#145).
 */
function grantCovers(session: Session, scope: AuthorizationScope, method?: string): boolean {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned") {
    return true;
  }
  if (ownership.kind === "unknown") {
    // The grant is the caller's consent for a *known attached* target. On a
    // host whose identity cannot be proven, consent alone must not carry an
    // operation — the session has to establish attached/owned first.
    return false;
  }
  const value = session.authorization[scope];
  if (value === true) {
    return true;
  }
  if (Array.isArray(value)) {
    return method !== undefined && value.includes(method);
  }
  return false;
}

/**
 * Refuses an operation the session is not authorized for.
 *
 * Three authorities stay separate (#145): quitting the host is owned-only
 * and is enforced in the driver, never here; operating the connected
 * target is what the session bound at launch; and each privileged
 * operation class needs either ownership or the matching grant. Unknown
 * ownership is never promoted: it is authorized exactly like "attached".
 */
function requireAuthorized(
  session: Session,
  op: string,
  scope: AuthorizationScope,
  method?: string,
): void {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned" || grantCovers(session, scope, method)) {
    return;
  }
  const granted = grantedScopes(session);
  const hint =
    granted.length === 0
      ? `pass authorization: { ${scope}: true } (or the method names) in launch options`
      : `the grant covers ${granted.join(", ")} but not "${scope}"`;
  throw new HostNotOwnedError(
    op,
    ownership.kind,
    `${ownership.evidence}; ${hint}`,
  );
}

/** Layers in `after` and not in `before`, compared by id. */
function layerDifference(
  from: SceneSnapshot["layers"],
  to: SceneSnapshot["layers"],
): SceneSnapshot["layers"] {
  const ids = new Set(from.map((layer) => layer.id));
  return to.filter((layer) => !ids.has(layer.id));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export class AfterEffects {
  readonly #session: Session;
  readonly #probe: ApplicationInfo;
  /** Names the loaded host script declares; empty for the built-in host. */
  readonly #extensionMethods: readonly string[];
  /** Fallback `hostId` when the transport cannot attest a process identity. */
  readonly #hostNonce = newCapabilityHostNonce();
  #closed = false;

  constructor(session: Session, probe: ApplicationInfo, extensionMethods: readonly string[] = []) {
    this.#session = session;
    this.#probe = probe;
    this.#extensionMethods = extensionMethods;
  }

  /**
   * Launches After Effects, or attaches to a running instance, and waits until
   * it answers a readiness probe.
   *
   * On a cold start this is not instant: AE has to become scriptable before the
   * probe succeeds. A failure here means AE did not become usable, and the
   * error names the operation rather than surfacing a raw bridge message.
   */
  static async launch(options: LaunchOptions = {}): Promise<AfterEffects> {
    return AfterEffects.#open(options, null, "session.launch");
  }

  /**
   * Rebinds to the After Effects an earlier `launch()` in the same
   * `sessionRoot` started and proved it owned — for example after the
   * calling process restarted.
   *
   * The launch-provenance record is checked against the live process list:
   * the recorded pid must still be the same process (pid, start time, and
   * the Windows creation identity), running the same install's executable,
   * and the only instance of that install in scope. The readiness probe
   * must then answer before ownership is claimed. Anything less refuses —
   * resume never starts a replacement host and never quits what it cannot
   * prove.
   *
   * A caller-supplied `transport` is used as-is: adoption is then the
   * transport's own contract (the fake host, a remote worker), and the
   * provenance record is not consulted.
   */
  static async resume(options: ResumeOptions): Promise<AfterEffects> {
    const sessionRoot = resolve(options.sessionRoot);
    let provenance: LaunchProvenance | null;
    try {
      provenance = readLaunchProvenance(sessionRoot);
    } catch (error) {
      throw new AfterEffectsError(
        error instanceof Error ? error.message : String(error),
        "session.resume",
      );
    }
    if (provenance === null) {
      throw new AfterEffectsError(
        `no launch provenance in ${sessionRoot}: nothing this tooling owned was recorded there, ` +
          "so there is no host to resume. Use launch() for a new session.",
        "session.resume",
      );
    }
    return AfterEffects.#open({ ...options, sessionRoot }, provenance, "session.resume");
  }

  /**
   * Resolves `LaunchOptions.transport` into a `HostTransport`.
   *
   * Absent, the script-invocation transport is built exactly as before —
   * including adoption of recorded launch provenance. A `HostTransport`
   * instance is used as-is (the fake host, a remote worker). The named
   * `"in-ae-dispatcher"` selection — opt-in only, #127 — builds the
   * file-channel dispatcher transport; it never falls back to script
   * invocation, and launch provenance does not apply to it (the dispatcher
   * cannot prove process ownership, so it records none).
   */
  static #resolveTransport(
    selection: TransportSelection | undefined,
    adopt: LaunchProvenance | null,
    options: LaunchOptions,
    op: string,
  ): HostTransport {
    if (selection === undefined) {
      return new ScriptInvocationTransport({
        ...(adopt === null
          ? {}
          : {
              adopt: {
                pid: adopt.host.pid,
                startedAt: adopt.host.startedAt,
                identity: adopt.host.identity,
                executable: adopt.host.executable,
                recordedAt: adopt.recordedAt,
              },
            }),
        ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
        ...(options.session === undefined ? {} : { sessionUid: options.session.uid }),
      });
    }
    const isInstance =
      typeof selection === "object" &&
      selection !== null &&
      typeof (selection as HostTransport).invoke === "function";
    if (isInstance) {
      return selection as HostTransport;
    }
    const kind = typeof selection === "string" ? selection : (selection as { kind?: unknown }).kind;
    if (kind !== DISPATCHER_TRANSPORT_KIND) {
      throw new AfterEffectsError(
        `unknown transport selection ${JSON.stringify(kind)}; ` +
          `supported selections are a HostTransport instance or "${DISPATCHER_TRANSPORT_KIND}"`,
        op,
      );
    }
    const channelDir =
      typeof selection === "object" && selection !== null
        ? (selection as { channelDir?: unknown }).channelDir
        : undefined;
    if (channelDir !== undefined && typeof channelDir !== "string") {
      throw new AfterEffectsError("transport.channelDir must be a string", op);
    }
    const instance =
      typeof selection === "object" && selection !== null
        ? (selection as { instance?: unknown }).instance
        : undefined;
    if (instance !== undefined && typeof instance !== "string") {
      throw new AfterEffectsError("transport.instance must be a string", op);
    }
    if (options.session !== undefined) {
      // The dispatcher channel is per-OS-user: it can only reach an After
      // Effects running as this user. Silently ignoring a session target
      // would run the call in the wrong session, so refuse instead.
      throw new AfterEffectsError(
        "transport \"in-ae-dispatcher\" cannot address another login session: " +
          "the file channel is private to this OS user, so the dispatcher can only " +
          "reach an After Effects running as the same user",
        op,
      );
    }
    return new DispatcherTransport({
      ...(channelDir === undefined ? {} : { channelDir }),
      ...(instance === undefined ? {} : { expectedInstance: instance }),
      // The effective host script is staged into the channel and its
      // registered set is checked against the heartbeat at launch (#146).
      ...(options.hostScript === undefined
        ? {}
        : { hostScriptPath: resolve(options.hostScript) }),
    });
  }

  static async #open(
    options: LaunchOptions,
    adopt: LaunchProvenance | null,
    op: string,
  ): Promise<AfterEffects> {
    // Absolute, because AE resolves paths in the scripts it is given against
    // its own working directory rather than the caller's.
    const sessionRoot = resolve(options.sessionRoot ?? mkdtempSync(join(tmpdir(), "ae-a8n-")));
    const trace = new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") });
    const transport = AfterEffects.#resolveTransport(options.transport, adopt, options, op);

    // The GUI fallback is only wired when the caller asks for it, and it only
    // ever acts inside the session that owns the After Effects.
    let recovery: MacHostRecovery | undefined;
    if (options.session?.recover === true) {
      // A caller-supplied transport that is not the script transport has no
      // pid to look up, so the fallback would be silently absent from a
      // session the caller asked to be recoverable. A requested safety
      // behaviour that cannot be provided is refused, not dropped.
      if (!(transport instanceof ScriptInvocationTransport)) {
        throw new AfterEffectsError(
          "session.recover needs the built-in script transport; the supplied transport cannot say which " +
            "process to recover. Nothing was started.",
          op,
        );
      }
      const targetSession = requireSession(options.session.uid);
      // The pid comes from the transport, which scopes processes by its own
      // session uid. Pressing keys in a different session than the one the
      // pid lives in would automate somebody else's screen.
      if (transport.targetSession?.uid !== targetSession.uid) {
        throw new AfterEffectsError(
          `session.recover: uid ${targetSession.uid} is not the session the transport talks into ` +
            `(${transport.targetSession?.uid ?? "unknown"}), so the fallback would act in another session. ` +
            "Nothing was started.",
          op,
        );
      }
      recovery = new MacHostRecovery({
        session: targetSession,
        pid: () => transport.recoveryTargetPid(),
        // A pid is not an identity. The same re-check that produced the pid
        // runs again immediately before every GUI action, so a process
        // that exited and had its pid reused is never the one pressed.
        verifyProcess: (pid) => transport.recoveryTargetPid() === pid,
        screenshotDir: join(sessionRoot, "artifacts"),
      });
    }

    // A host script declares extension methods. It is read here, once: the
    // names are what `call` checks against, and the driver stages a copy so
    // the file cannot change under a running session.
    const hostScript = options.hostScript === undefined ? null : resolve(options.hostScript);
    let extensionMethods: readonly string[] = [];
    if (hostScript !== null) {
      let source: string;
      try {
        source = readFileSync(hostScript, "utf-8");
      } catch {
        throw new AfterEffectsError(`host script not found: ${hostScript}`, op);
      }
      const declared = readExtensionHeader(source);
      if (declared === null) {
        throw new AfterEffectsError(
          `${hostScript} was not built by "ae-a8n extension build"; ` +
            "its header names no extension contract, so nothing was started",
          op,
        );
      }
      extensionMethods = declared;
    }

    const driver = new AeDriver({
      transport,
      sessionRoot,
      trace,
      ...(hostScript === null ? {} : { hostScriptPath: hostScript }),
      ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
      ...(options.readinessTimeoutMs === undefined
        ? {}
        : { readinessTimeoutMs: requirePositive(options.readinessTimeoutMs, "readinessTimeoutMs") }),
      ...(recovery === undefined ? {} : { recovery }),
      ...(options.recoveryGraceMs === undefined
        ? {}
        : { recoveryGraceMs: requireGrace(options.recoveryGraceMs) }),
    });

    // The session subscribes before the probe runs, so the live view and the
    // trace file record the same operations. Subscribing afterwards would make
    // `traceEvents` quietly disagree with `tracePath`.
    const authorization =
      options.authorization === undefined ? {} : requireAuthorization(options.authorization);
    const session = new Session(driver, trace, authorization);
    const environment =
      options.hostEnvironment === undefined ? undefined : requireEnvironment(options.hostEnvironment);
    let probe: ApplicationInfo;
    try {
      probe = await driver.start();
    } catch (error) {
      contextualise(op, error);
    }
    if (environment !== undefined) {
      // Never change the environment of an AE someone else is running
      // without the consumer's explicit grant (#145).
      requireAuthorized(session, "session.hostEnvironment", "hostEnvironment");
      await session.call("session.hostEnvironment", "app.setEnvironment", { variables: environment });
    }
    // On the dispatcher transport the exposed set is what the heartbeat
    // reported as actually registered inside After Effects (#146) — which
    // launch() already proved equals the staged manifest. Everywhere else
    // the staged declaration is the effective set.
    if (transport instanceof DispatcherTransport) {
      const bound = transport.boundExtensions();
      if (bound === null) {
        // launch() verified the staged manifest against the heartbeat, so a
        // missing bound set means the verification never ran — fail closed
        // rather than expose the staged declaration as if it were active.
        throw new AfterEffectsError(
          "the dispatcher session bound without a verified extension set; nothing was started",
          op,
        );
      }
      extensionMethods = bound.methods;
    }
    // The grant is evidence, not just enforcement: the trace records which
    // operation classes this session may exercise on a host it does not own.
    session.trace.record("session.authorization", "ok", 0, {
      result: { ownership: session.driver.ownership().kind, granted: [...grantedScopes(session)] },
    });
    return new AfterEffects(session, probe, extensionMethods);
  }

  /**
   * Host version and build, as reported by the launch readiness probe. Free:
   * no round trip, because launch already had to ask.
   */
  info(): ApplicationInfo {
    return this.#probe;
  }

  /**
   * Calls an extension method declared by the loaded host script
   * (`ae-a8n extension build`).
   *
   * The name is checked against what the script declares before anything is
   * sent, so an unknown name is refused here rather than becoming an After
   * Effects error. The call runs inside the session's ownership, timeout and
   * trace, exactly like a built-in method.
   */
  async call<T = unknown>(
    name: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    requireString(name, "name");
    requireAuthorized(this.#session, "extension.call", "extensionMethods", name);
    if (!this.#extensionMethods.includes(name)) {
      throw new ExtensionMethodNotFoundError("extension.call", name, this.#extensionMethods);
    }
    return this.#session.call<T>("extension.call", name, params, options);
  }

  /** The extension method names the loaded host script declares. */
  extensionMethods(): readonly string[] {
    return this.#extensionMethods;
  }

  /** Re-reads the host version, for a caller that wants a live value. */
  async version(): Promise<string> {
    const info = await this.#session.call<ApplicationInfo>("app.info", "app.info");
    return info.version;
  }

  /**
   * What this session can attest about the After Effects it is connected
   * to, in the ae-devtools `ae-devtools.capability-handshake/v1` shape
   * (#102).
   *
   * Read-only discovery: it reports the launch probe's AE version/build,
   * the transport's ownership/platform/execution-mode evidence, and the
   * capabilities ae-a8n can back with evidence — built-in dispatch-table
   * methods as `ae.operation.*` references and declared extension methods
   * as `ae.tool.*`. It dispatches nothing.
   *
   * A compatible advertisement is not authorization to run anything: pair
   * it with `negotiateCapabilities` (version/capability preflight) and
   * `assertDispatchAllowed` (per-dispatch gate) before dispatching by
   * capability ID. The existing typed API and `ae.call` keep their own
   * contracts and are not gated by this handshake.
   */
  capabilities(): Promise<HandshakeResponse> {
    const driver = this.#session.driver;
    return Promise.resolve(
      buildCapabilityHandshake({
        ae: this.#probe,
        transportKind: driver.transportKind,
        attestation: driver.hostAttestation(),
        ownership: driver.ownership(),
        extensionMethods: this.#extensionMethods,
        grantedOperations: grantedScopes(this.#session),
        hostNonce: this.#hostNonce,
        generatedAt: new Date().toISOString(),
      }),
    );
  }

  /**
   * Shows a native modal dialog in After Effects and waits for it to be
   * closed.
   *
   * The dialog is the one thing an ExtendScript call cannot get out of on its
   * own: the script stays blocked until the dialog is closed, so the call
   * times out while the host is perfectly alive.
   *
   * With a session that has `recover` enabled, the timed-out call is
   * followed by the GUI fallback, which closes the dialog *inside that
   * session* and lets the original call finish. The request is never sent
   * again — it is still running inside After Effects.
   *
   * The dialog's text always begins `ae-a8n:` (the host adds it when
   * `message` does not), because that marker is how the fallback recognises
   * the one dialog class it may press. A dialog without it would be
   * classified unknown and left for a human.
   */
  async showModalDialog(message: string, options: OperationOptions = {}): Promise<void> {
    // Validated here like every other public method: a JavaScript caller
    // passing a non-string would otherwise be coerced by the host's
    // `String(...)`, or fail deep inside After Effects.
    const text = requireString(message, "message");
    await this.#session.call("ui.alert", "ui.alert", { message: text }, options);
  }

  /**
   * Opens a project, replacing the open one. Refuses with
   * UnsavedChangesError if that would discard unsaved changes, unless
   * `unsavedChanges` is "discard". `timeoutMs` overrides the session budget
   * for this call only.
   *
   * If this times out, After Effects usually still finishes the open; get a
   * handle with `project()` instead of opening again.
   */
  async openProject(path: string, options: OpenProjectOptions = {}): Promise<Project> {
    const projectPath = requireAbsoluteProjectPath(path);
    await this.#session.call(
      "project.open",
      "project.open",
      { path: projectPath, discardUnsavedChanges: options.unsavedChanges === "discard" },
      options,
    );
    return new Project(this.#session);
  }

  /**
   * A handle to the project open in After Effects now, without opening
   * anything. Asks the host first, so it waits for a script still running
   * from a timed-out call (an `openProject`, say) and fails if no project is
   * reachable. Check `info().file` to see which project it is.
   */
  async project(options: OperationOptions = {}): Promise<Project> {
    await this.#session.call<ProjectInfo>("project.info", "project.info", {}, options);
    return new Project(this.#session);
  }

  /**
   * Whether this session owns the After Effects process: "owned" when it
   * started it and it is still that process. Only an owned host is quit by
   * `close`.
   */
  ownership(): HostOwnership {
    return this.#session.driver.ownership();
  }

  /**
   * Collects host-side evidence for this session — OS crash reports for the
   * After Effects binaries, host logs touched while the session ran, and
   * the session trace — into `<artifactsDir>/diagnostics/` and returns the
   * report with the paths.
   *
   * This is how "AE stopped answering" becomes "AE crashed at 11:10 with
   * SIGTERM from bash" instead of a guess: the report says what was found,
   * and `notes` says what could not be collected. It never moves or deletes
   * the user's files, and nothing is sent anywhere. Callable after a failed
   * `close` too — the evidence is still there.
   *
   * `options` overrides where evidence is looked for: pass a fake `homeDir`
   * or `sources` and collection never touches the real user directories.
   */
  diagnostics(options?: DiagnosticsOptions): SessionDiagnostics {
    return this.#session.driver.diagnostics(options);
  }

  /**
   * The owned After Effects process this session controls, for recovery
   * authorization (ae-devtools #55). Returns the pid and the GUI session
   * the process was verified to belong to — the identity a run marker must
   * record before any GUI mutation is authorized.
   *
   * Returns null unless ownership is "owned" AND the transport can name
   * its target. Callers must treat null as "no attested target", never
   * substitute a pid found by other means: an unattested pid is exactly
   * what recovery authorization exists to refuse.
   */
  recoveryTarget(): { pid: number; session: MacSession } | null {
    if (this.#closed || this.ownership().kind !== "owned") {
      return null;
    }
    return this.#session.driver.recoveryTarget();
  }

  /**
   * What the owned After Effects instance's screen currently shows
   * (ae-a8n #109): its windows, each classified against the measured
   * recovery policy, and the aggregate verdict — without pressing anything.
   *
   * Read-only: the observation is audited but never takes the GUI mutation
   * lease, and no button is ever pressed. It runs inside the session that
   * owns the AE instance; when that session cannot be entered the report is
   * `unavailable` with the reason, never an empty window list.
   *
   * `status: "unavailable"` is also the answer when no owned target is
   * attested — an attached or unknown host has no proven pid/session, so
   * there is no honest window list to report.
   *
   * On macOS the first observation in a session may raise the standard
   * Accessibility consent prompt; that is the OS asking a human, not this
   * API bypassing it.
   */
  guiState(): Promise<GuiStateReport> {
    // The observation itself is synchronous (one Accessibility query inside
    // the target session); `.then` keeps even a synchronous failure a
    // rejection rather than a throw from a Promise-typed method.
    return Promise.resolve().then(() => guiStateReport(this.recoveryTarget()));
  }

  /**
   * A menu command, looked up by its menu text (as AE shows it, so
   * localised for built-in commands; a plugin's own name for one an AEGP
   * plugin registered) or taken by id. A name AE does not know rejects with
   * EntityNotFoundError (`kind: "menu-command"`). Only an id crosses to
   * After Effects: no script text is ever sent.
   */
  async menuCommand(nameOrId: string | number): Promise<MenuCommand> {
    if (typeof nameOrId === "number") {
      if (!Number.isInteger(nameOrId) || nameOrId <= 0) {
        throw new TypeError("menu command id must be a positive integer");
      }
      return new MenuCommand(this.#session, nameOrId);
    }
    const name = requireString(nameOrId, "menu command name");
    try {
      const found = await this.#session.call<{ id: number }>("menu.find", "menu.find", { name });
      return new MenuCommand(this.#session, found.id, name);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError") {
        throw new EntityNotFoundError("menu-command", name, "menu.find");
      }
      throw error;
    }
  }

  /** Edit › Undo: one step of AE's undo history. Owned sessions only. */
  async undo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, UNDO_COMMAND_ID, "Undo").execute(options);
  }

  /** Edit › Redo. Owned sessions only. */
  async redo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, REDO_COMMAND_ID, "Redo").execute(options);
  }

  /** Compositions in the currently open project. */
  async comps(): Promise<CompInfo[]> {
    return this.#session.call<CompInfo[]>("project.comps", "project.comps");
  }

  /** Absolute path of the machine-readable operation history for this session. */
  get tracePath(): string {
    return this.#session.trace.file ?? join(this.#session.driver.sessionRoot, "trace.jsonl");
  }

  /** Live operation history, in order. */
  get traceEvents(): readonly TraceEvent[] {
    return this.#session.events;
  }

  /** Directory renders and other artifacts are written to. */
  get artifactsDir(): string {
    return this.#session.driver.artifactsDir;
  }

  /**
   * Closes the open project and quits After Effects. Safe to call twice.
   */
  /**
   * Ends the session.
   *
   * After Effects is quit only if this session started it and it is still
   * that process; a host that was already running, or whose identity cannot
   * be confirmed, is left running and the result says why. Quitting refuses
   * with UnsavedChangesError rather than discard unsaved changes, unless
   * `unsavedChanges` is "discard" — and the session stays open for the retry.
   */
  async close(options: { unsavedChanges?: "refuse" | "discard" } = {}): Promise<CloseResult> {
    if (this.#closed) {
      return { quit: false, ownership: this.ownership(), reason: "already closed" };
    }
    try {
      const result = await this.#session.driver.stop(options);
      this.#closed = true;
      return result;
    } catch (error) {
      if (!(error instanceof HostError && error.name === "UnsavedChangesError")) {
        this.#closed = true;
      }
      contextualise("session.close", error);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export class Project {
  readonly #session: Session;

  constructor(session: Session) {
    this.#session = session;
  }

  async info(): Promise<ProjectInfo> {
    return this.#session.call<ProjectInfo>("project.info", "project.info");
  }

  async comps(): Promise<CompInfo[]> {
    return this.#session.call<CompInfo[]>("project.comps", "project.comps");
  }

  /**
   * Creates a composition. Comps are addressed by name, so a name any
   * project item already has is refused.
   */
  async createComp(options: CreateCompOptions): Promise<Comp> {
    const params = {
      name: requireString(options.name, "comp name"),
      width: requirePositive(options.width, "width"),
      height: requirePositive(options.height, "height"),
      duration: requirePositive(options.duration, "duration"),
      frameRate: requirePositive(options.frameRate, "frameRate"),
      pixelAspect: requirePositive(options.pixelAspect ?? 1, "pixelAspect"),
    };
    const info = await this.#session.call<CompInfo>("project.createComp", "project.createComp", params);
    return new Comp(this.#session, info.name);
  }

  /**
   * Resolves a composition by name, verifying it exists.
   *
   * Only the host's own "not found" becomes EntityNotFoundError. Translating
   * every failure into "not found" once hid that the host called an API a
   * real AE does not have.
   */
  async comp(name: string): Promise<Comp> {
    const compName = requireString(name, "comp name");
    try {
      await this.#session.call<CompInfo>("comp.info", "comp.info", { name: compName });
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError") {
        throw new EntityNotFoundError("composition", compName, "project.comp");
      }
      throw error;
    }
    return new Comp(this.#session, compName);
  }
}

export class Comp {
  readonly #session: Session;
  readonly name: string;

  constructor(session: Session, name: string) {
    this.#session = session;
    this.name = name;
  }

  async info(): Promise<CompInfo> {
    return this.#session.call<CompInfo>("comp.info", "comp.info", { name: this.name });
  }

  async layers(): Promise<LayerInfo[]> {
    return this.#session.call<LayerInfo[]>("comp.layers", "comp.layers", { name: this.name });
  }

  /** Resolves a layer by name, verifying it exists in this composition. */
  async layer(name: string): Promise<Layer> {
    const layerName = requireString(name, "layer name");
    const layers = await this.layers();
    if (!layers.some((layer) => layer.name === layerName)) {
      throw new EntityNotFoundError("layer", `${layerName} (in "${this.name}")`, "comp.layer");
    }
    return new Layer(this.#session, this.name, layerName);
  }

  /**
   * Opens the composition in a viewer, which makes it the active item: what
   * menu commands that act on "the active composition" act on.
   */
  async openInViewer(): Promise<void> {
    const result = await this.#session.call<{ active: boolean }>("comp.openInViewer", "comp.openInViewer", {
      name: this.name,
    });
    if (!result.active) {
      throw new AfterEffectsError(`"${this.name}" was opened but is not the active item`, "comp.openInViewer");
    }
  }

  /** Adds a text layer on top of the stack and returns it with what AE applied. */
  async addTextLayer(options: TextLayerOptions): Promise<{ layer: Layer; info: TextLayerInfo }> {
    const params: Record<string, unknown> = { comp: this.name, text: requireString(options.text, "text") };
    if (options.name !== undefined) params["name"] = requireString(options.name, "layer name");
    if (options.font !== undefined) params["font"] = requireString(options.font, "font");
    if (options.fontSize !== undefined) params["fontSize"] = requirePositive(options.fontSize, "fontSize");
    if (options.fillColor !== undefined) params["fillColor"] = [...options.fillColor];
    if (options.position !== undefined) params["position"] = [...options.position];
    const info = await this.#session.call<TextLayerInfo>("comp.addTextLayer", "comp.addText", params);
    return { layer: new Layer(this.#session, this.name, info.name), info };
  }

  /**
   * Selects exactly the named layers (and deselects the rest); returns the
   * names now selected, top first.
   */
  async selectLayers(names: readonly string[]): Promise<string[]> {
    const layers = names.map((name) => requireString(name, "layer name"));
    const result = await this.#session.call<{ selected: string[] }>("comp.selectLayers", "comp.selectLayers", {
      comp: this.name,
      layers,
    });
    return result.selected;
  }

  /**
   * Renders a single frame to PNG and returns where it landed.
   *
   * Output goes under the session's artifact directory so a caller can collect
   * everything from one place.
   */
  async renderFrame(frame: number, options: RenderOptions = {}): Promise<RenderedFrame> {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new TypeError("frame must be a non-negative integer");
    }
    const base = this.#session.driver.artifactsDir;
    const outputDir =
      options.subdirectory === undefined ? base : join(base, options.subdirectory);
    return this.#session.call<RenderedFrame>(
      "comp.renderFrame",
      "comp.renderFrame",
      {
        comp: this.name,
        frame,
        outputDir,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      },
      options,
    );
  }
}

export class Layer {
  readonly #session: Session;
  readonly compName: string;
  readonly name: string;
  readonly effects: Effects;

  constructor(session: Session, compName: string, name: string) {
    this.#session = session;
    this.compName = compName;
    this.name = name;
    this.effects = new Effects(session, compName, name);
  }

  async info(): Promise<LayerInfo> {
    return this.#session.call<LayerInfo>("comp.layer", "comp.layer", {
      comp: this.compName,
      layer: this.name,
    });
  }

  /** Turns the layer's video switch on or off; returns the layer afterwards. */
  async setEnabled(enabled: boolean): Promise<LayerInfo> {
    if (typeof enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    return this.#session.call<LayerInfo>("layer.setEnabled", "layer.setEnabled", {
      comp: this.compName,
      layer: this.name,
      enabled,
    });
  }

  async transform(): Promise<LayerTransform> {
    return this.#session.call<LayerTransform>("layer.transform", "layer.transform", {
      comp: this.compName,
      layer: this.name,
    });
  }

  /** Every path of a shape layer, in layer space; rejects for any other layer. */
  async shapePaths(): Promise<ShapePath[]> {
    return this.#session.call<ShapePath[]>("layer.shapePaths", "layer.shapePaths", {
      comp: this.compName,
      layer: this.name,
    });
  }
}

/**
 * A menu command of the running After Effects, by id. Running one is an edit
 * like any other — it can change or discard the user's work — so it is only
 * allowed on a host this session started (`ownership().kind === "owned"`).
 */
export class MenuCommand {
  readonly #session: Session;
  readonly id: number;
  readonly name: string | undefined;

  constructor(session: Session, id: number, name?: string) {
    this.#session = session;
    this.id = id;
    this.name = name;
  }

  /**
   * Runs the command and reports the active composition's layers before and
   * after. Synchronous in AE: when this resolves, the command has finished,
   * including a plugin's command hook. A command that opens a modal dialog
   * blocks AE until a person dismisses it, and this then times out.
   */
  async execute(options: OperationOptions = {}): Promise<CommandExecution> {
    requireAuthorized(this.#session, "menu.execute", "menuCommands");
    const raw = await this.#session.call<Omit<CommandExecution, "added" | "removed" | "name">>(
      "menu.execute",
      "menu.execute",
      { id: this.id },
      options,
    );
    const execution: CommandExecution = {
      ...raw,
      ...(this.name === undefined ? {} : { name: this.name }),
      added: layerDifference(raw.before.layers, raw.after.layers),
      removed: layerDifference(raw.after.layers, raw.before.layers),
    };
    // The call's own record summarises the result to its top level; the
    // scene change is what a reader of the trace needs, so record it too.
    this.#session.trace.record("menu.execute.scene", "ok", 0, {
      args: { id: this.id, ...(this.name === undefined ? {} : { name: this.name }) },
      result: {
        comp: execution.after.comp,
        itemsBefore: execution.before.itemCount,
        itemsAfter: execution.after.itemCount,
        layersBefore: execution.before.layers.map((layer) => `${layer.id} ${layer.name}`),
        layersAfter: execution.after.layers.map((layer) => `${layer.id} ${layer.name}`),
        added: execution.added.map((layer) => layer.id),
        removed: execution.removed.map((layer) => layer.id),
      },
    });
    return execution;
  }
}

export class Effects {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;

  constructor(session: Session, comp: string, layer: string) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
  }

  async all(): Promise<EffectInfo[]> {
    return this.#session.call<EffectInfo[]>("layer.effects", "layer.effects", {
      comp: this.#comp,
      layer: this.#layer,
    });
  }

  /**
   * Applies a plugin effect, or returns the existing one when it is already
   * on the layer. `identifier` is a match name or a display name; match name
   * is tried first because it is locale-independent.
   */
  async apply(identifier: string): Promise<Effect> {
    const effectId = requireString(identifier, "effect identifier");
    const info = await this.#session.call<{ name: string; matchName: string; created: boolean }>(
      "layer.applyEffect",
      "layer.applyEffect",
      { comp: this.#comp, layer: this.#layer, effect: effectId },
    );
    return new Effect(this.#session, this.#comp, this.#layer, info.name);
  }

  /** Looks up an effect already on the layer. */
  async get(identifier: string): Promise<Effect> {
    const effectId = requireString(identifier, "effect identifier");
    const all = await this.all();
    const match = all.find(
      (effect) =>
        effect.name === effectId ||
        (effect.matchName !== undefined && effect.matchName === effectId),
    );
    if (match === undefined) {
      throw new EntityNotFoundError(
        "effect",
        `${effectId} (on layer "${this.#layer}")`,
        "layer.effects.get",
      );
    }
    return new Effect(this.#session, this.#comp, this.#layer, match.name);
  }
}

export class Effect {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;
  readonly name: string;

  constructor(session: Session, comp: string, layer: string, name: string) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
    this.name = name;
  }

  async parameters(): Promise<PropertyInfo[]> {
    return this.#session.call<PropertyInfo[]>("effect.parameters", "effect.parameters", {
      comp: this.#comp,
      layer: this.#layer,
      effect: this.name,
    });
  }

  /**
   * A handle to one parameter. Deliberately lazy: reading a parameter the
   * effect does not have is only a problem at `get`/`set`, and making every
   * access round-trip would cost a request per chain link.
   */
  parameter(name: string): Parameter {
    return new Parameter(this.#session, this.#comp, this.#layer, this.name, requireString(name, "parameter name"));
  }
}

export class Parameter {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;
  readonly #effect: string;
  readonly name: string;

  constructor(
    session: Session,
    comp: string,
    layer: string,
    effect: string,
    name: string,
  ) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
    this.#effect = effect;
    this.name = name;
  }

  /**
   * Reads the value: a number, or an array of numbers for points and colours
   * (see `ValueProperty`). A property without one (`kind` other than
   * `"value"`) rejects with `PropertyHasNoValueError`; use `info()` to
   * describe any property without failing.
   */
  async get(): Promise<ParameterValue> {
    const info = await this.info();
    if (info.kind !== "value") {
      throw new PropertyHasNoValueError(info.kind, this.name, "effect.getParameter");
    }
    return info.value;
  }

  /**
   * Writes the value and returns what the host reports back afterwards
   * (After Effects stores floats in single precision and may fill in a
   * missing z or alpha). The shape must fit the property's `valueType`, or it
   * rejects with `ParameterValueError`; a property without a value rejects
   * with `PropertyHasNoValueError`. Either way the host refuses before
   * writing.
   */
  async set(value: ParameterValue): Promise<ParameterValue> {
    requireParameterValue(value);
    const info = await this.info(value);
    if (info.kind !== "value") {
      throw new PropertyHasNoValueError(info.kind, this.name, "effect.setParameter");
    }
    return info.value;
  }

  /**
   * Describes the property (`kind`, `valueType`, and `value` when it has
   * one). With a `value`, writes it first, as `set` does.
   */
  async info(value?: ParameterValue): Promise<PropertyInfo> {
    const params = {
      comp: this.#comp,
      layer: this.#layer,
      effect: this.#effect,
      parameter: this.name,
      ...(value === undefined ? {} : { value }),
    };
    if (value === undefined) {
      return this.#session.call<PropertyInfo>("effect.getParameter", "effect.getParameter", params);
    }
    requireParameterValue(value);
    try {
      return await this.#session.call<PropertyInfo>("effect.setParameter", "effect.setParameter", params);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NoValueError" && isNoValueKind(cause.kind)) {
        throw new PropertyHasNoValueError(cause.kind, this.name, "effect.setParameter", { cause });
      }
      if (cause instanceof HostError && cause.name === "ValueShapeError") {
        throw new ParameterValueError(cause.kind ?? "unknown", this.name, "effect.setParameter", cause.message, {
          cause,
        });
      }
      throw error;
    }
  }
}
