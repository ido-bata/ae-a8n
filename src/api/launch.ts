/**
 * Session establishment: transport resolution, launch options validation,
 * recovery wiring, and the driver/session construction `AfterEffects.launch`
 * and `AfterEffects.resume` share.
 *
 * Everything here runs before the first operation: nothing in this file
 * decides what a session may do afterwards — that is `session.ts`'s grant
 * rules and the driver's ownership checks.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AeDriver, HostUnavailableError, TimeoutError } from "../driver/driver.js";
import {
  currentSession,
  readGuiSession,
  readGuiSessionFailure,
  type MacSession,
} from "../driver/mac-session.js";
import { errorMessage } from "../errors.js";
import { createHostRecovery, type HostRecovery } from "../driver/host-recovery.js";
import { ExpectedModalRegistry } from "../driver/expected-modals.js";
import { measureWindowsSessionId } from "../platform/windows/session.js";
import {
  SessionSupervision,
  attributeAeByCensus,
  type SessionSupervisionOptions,
} from "../driver/supervision-session.js";
import type { LaunchProvenance } from "../driver/launch-provenance.js";
import { ScriptInvocationTransport } from "../driver/script-invocation.js";
import {
  aeVersionFromInstallDir,
  aeVersionParts,
  DispatcherTransport,
} from "../driver/dispatcher-transport.js";
import {
  AttachTargetError,
  DISPATCHER_TRANSPORT_KIND,
  type HostTransport,
} from "../driver/transport.js";
import { readExtensionHeader } from "../extensions/manifest.js";
import { TraceRecorder } from "../trace/trace.js";
import type { PendingRequest } from "../supervision/types.js";
import type { SupervisionTraceSink } from "../supervision/session-trace.js";
import { AfterEffectsError, contextualise } from "./errors.js";
import {
  grantedScopes,
  requireAuthorization,
  requireAuthorized,
  requirePositive,
  Session,
} from "./session.js";
import type {
  ApplicationInfo,
  LaunchOptions,
  TransportSelection,
} from "./types.js";

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
 * `LaunchOptions.session`, validated once: a non-object (including `null`)
 * or a `uid` that is not a positive integer is a `TypeError`, and a
 * non-boolean `recover` is refused rather than silently disabling the GUI
 * fallback `showModalDialog` relies on.
 */
function requireSessionOption(
  value: unknown,
): NonNullable<LaunchOptions["session"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("session must be an object with a uid and optional recover flag");
  }
  const { uid, recover } = value as { uid?: unknown; recover?: unknown };
  if (typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0) {
    throw new TypeError("session.uid must be a positive integer");
  }
  if (recover !== undefined && typeof recover !== "boolean") {
    throw new TypeError("session.recover must be a boolean");
  }
  return recover === undefined ? { uid } : { uid, recover };
}

/**
 * The login session of a uid, for the GUI fallback.
 *
 * A user who is not logged in has no session, and a session that is not an
 * Aqua session has no screen. Both are refused here rather than discovered
 * halfway through a recovery.
 */
function requireSession(uid: number): MacSession {
  if (process.platform !== "darwin") {
    // The fallback is macOS GUI automation; on another platform `launchctl`
    // does not exist and its failure would read as "no login session",
    // sending the caller to macOS troubleshooting for a Windows run.
    throw new AfterEffectsError(
      `session.recover is the macOS GUI fallback and is not available on ${process.platform}; nothing was started`,
      "session.launch",
    );
  }
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

function requireEnvironment(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("hostEnvironment must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`hostEnvironment name is not a portable variable name: ${JSON.stringify(name)}`);
    }
    if (typeof entry !== "string") {
      throw new TypeError(`hostEnvironment.${name} must be a string`);
    }
    out[name] = entry;
  }
  return out;
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
function resolveTransport(
  selection: TransportSelection | undefined,
  adopt: LaunchProvenance | null,
  options: LaunchOptions,
  op: string,
  attach?: { readonly targetPid?: number },
): HostTransport {
  if (selection === undefined) {
    return new ScriptInvocationTransport({
      // Attach-only (#269): `attach` is passed only by `AfterEffects.attach`,
      // and it makes `launch()` select a running instance with no path to
      // process creation. `launch`/`resume` never set it.
      ...(attach === undefined ? {} : { attach }),
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
  const installDir =
    typeof selection === "object" && selection !== null
      ? (selection as { installDir?: unknown }).installDir
      : undefined;
  if (installDir !== undefined && typeof installDir !== "string") {
    throw new AfterEffectsError("transport.installDir must be a string", op);
  }
  const aeVersion =
    typeof selection === "object" && selection !== null
      ? (selection as { aeVersion?: unknown }).aeVersion
      : undefined;
  if (aeVersion !== undefined && typeof aeVersion !== "string") {
    throw new AfterEffectsError("transport.aeVersion must be a string", op);
  }
  if (installDir !== undefined && aeVersion !== undefined) {
    throw new AfterEffectsError(
      "transport.installDir and transport.aeVersion are alternative pins; pass one",
      op,
    );
  }
  let expectedAeVersion: string | undefined;
  try {
    if (aeVersion !== undefined) {
      expectedAeVersion = aeVersionParts(aeVersion).join(".");
    } else if (installDir !== undefined) {
      // The install's recorded version keeps its full precision; the
      // transport compares it against the heartbeat at the heartbeat's
      // own precision, so a patch difference is refused whenever
      // app.version reports one.
      expectedAeVersion = aeVersionParts(
        aeVersionFromInstallDir(process.platform, installDir),
      ).join(".");
    }
  } catch (error) {
    throw new AfterEffectsError(
      `transport target pin is not a usable AE version: ${
        errorMessage(error)
      }`,
      op,
    );
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
    ...(expectedAeVersion === undefined ? {} : { expectedAeVersion }),
    // The effective host script is staged into the channel and its
    // registered set is checked against the heartbeat at launch (#146).
    ...(options.hostScript === undefined
      ? {}
      : { hostScriptPath: resolve(options.hostScript) }),
  });
}

export interface OpenedSession {
  readonly session: Session;
  readonly probe: ApplicationInfo;
  readonly extensionMethods: readonly string[];
}

/**
 * What a transport can attest about its After Effects target *before* the
 * first ExtendScript response (#339): the pid its launch census proved and
 * the login session that pid lives in. `ScriptInvocationTransport` answers
 * both once `launch()` has run its process census — exactly the window a
 * startup modal can hold the readiness probe open in.
 */
export type BootSupervisionTransport = HostTransport & {
  recoveryTargetPid(): number | null;
  readonly targetSession: MacSession | null;
};

/**
 * Structural check, not `instanceof`: a caller-supplied transport that can
 * honestly answer "which process, in which session" gets the same boot
 * observation the built transport does. Anything that cannot — including
 * transports whose census only proves a pid after the probe — returns null
 * and the launch proceeds with post-probe supervision unchanged.
 */
export function asBootSupervisionTransport(
  transport: HostTransport,
): BootSupervisionTransport | null {
  const candidate = transport as Partial<BootSupervisionTransport>;
  if (
    typeof candidate.recoveryTargetPid !== "function" ||
    candidate.targetSession === undefined
  ) {
    return null;
  }
  return candidate as BootSupervisionTransport;
}

export type StartBootSupervisionOptions = {
  readonly transport: BootSupervisionTransport;
  readonly sessionRoot: string;
  readonly pendingRequests: () => readonly PendingRequest[];
  readonly trace?: SupervisionTraceSink;
  /** Test seam: replaces `SessionSupervision.start`. */
  readonly start?: (options: SessionSupervisionOptions) => SessionSupervision | null;
};

/**
 * Start observing the pre-probe target, or return null when the transport
 * cannot prove one (#339). The pid/session pair comes from the transport's
 * own census — the spawned pid pinned to its start time, or the single
 * in-scope instance — and `verifyPid` re-runs that census before every
 * observation, the same re-proof the post-probe monitor gets from
 * `recoveryTarget()`. No ExtendScript has answered yet, so this monitor is
 * observation-only: it can report what it sees, but the driver's recovery
 * path still refuses to act until the probe proves ownership.
 */
export function startBootSupervision(
  options: StartBootSupervisionOptions,
): SessionSupervision | null {
  const pid = options.transport.recoveryTargetPid();
  const session = options.transport.targetSession;
  if (pid === null || session === null || session.kind !== "Aqua") {
    return null;
  }
  const begin = options.start ?? ((opts: SessionSupervisionOptions) => SessionSupervision.start(opts));
  return begin({
    sessionRoot: options.sessionRoot,
    pid,
    target: { platform: "darwin", session },
    verifyPid: (target) => options.transport.recoveryTargetPid() === target,
    pendingRequests: options.pendingRequests,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  });
}

/**
 * Builds the session `AfterEffects.launch`/`resume` return: transport,
 * recovery, driver, probe, and the extension method set the host declares.
 */
export async function openAfterEffects(
  options: LaunchOptions,
  adopt: LaunchProvenance | null,
  op: string,
  attach?: { readonly targetPid?: number },
): Promise<OpenedSession> {
  // `session` is the one option every consumer of `options` below reads, so
  // it is validated and normalised once here rather than at each use.
  const sessionOption = requireSessionOption(options.session);
  const opts: LaunchOptions =
    sessionOption === undefined ? options : { ...options, session: sessionOption };
  // Absolute, because AE resolves paths in the scripts it is given against
  // its own working directory rather than the caller's.
  const sessionRoot = resolve(options.sessionRoot ?? mkdtempSync(join(tmpdir(), "ae-a8n-")));
  const trace = new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") });
  const transport = resolveTransport(options.transport, adopt, opts, op, attach);

  // A public `target.pid` is honoured only where the transport can enforce
  // it: the built script transport's own attach pin. A supplied transport —
  // or the named dispatcher, which selects by instance/version pins — keeps
  // its own selection rules, and resolveTransport never rewrites it. A pin
  // the transport cannot enforce must be refused, not silently dropped:
  // attaching to a different After Effects than the caller named is worse
  // than failing.
  if (attach?.targetPid !== undefined) {
    const enforced =
      transport instanceof ScriptInvocationTransport &&
      transport.attachOnly &&
      transport.attachTargetPid === attach.targetPid;
    if (!enforced) {
      throw new AfterEffectsError(
        `target.pid ${attach.targetPid} cannot be enforced by the selected transport: ` +
          "omit transport to use the built-in script lane, or construct a " +
          "ScriptInvocationTransport with attach: { targetPid } matching it. Nothing was started.",
        op,
      );
    }
  }

  // Expected-modal registrations (#342) live for the whole session: the
  // recovery reads them inside every attempt, and `ae.expectModal()` adds
  // or removes entries while the session runs.
  const expectedModals = new ExpectedModalRegistry();
  for (const spec of options.expectedModals ?? []) {
    expectedModals.register(spec);
  }

  // The GUI fallback is part of the standard lifecycle (#342): it is wired
  // whenever the caller has not opted out (`session.recover === false`)
  // and the transport can honestly name its target. An explicit
  // `recover: true` keeps the strict contract — a request that cannot be
  // honoured refuses the launch rather than silently dropping a safety
  // behaviour the caller asked for; a default-on session that cannot be
  // wired launches without recovery and records why on the trace, because
  // the caller never asked for it.
  let recovery: HostRecovery | undefined;
  let expectedModalsActive = false;
  const recoverOption = sessionOption?.recover;
  const recoveryUnavailable = (reason: string): void => {
    if (recoverOption === true) {
      throw new AfterEffectsError(`${reason} Nothing was started.`, op);
    }
    trace.record("session.recovery", "error", 0, {
      error: { name: "RecoveryUnavailable", message: reason },
    });
  };
  if (recoverOption !== false && transport instanceof ScriptInvocationTransport) {
    if (process.platform === "win32") {
      // Windows has no per-user login session to name: `session.uid` is a
      // macOS concept and is not consulted here. The recovery acts in the
      // interactive session this process measured — the same session
      // `AfterFX.exe -r` delivery runs in — and `WindowsGuiRecovery`
      // still refuses the console session unless it was explicitly
      // allowed, re-proves the session before every action, and presses
      // only what the measured-class policy allows (today: nothing).
      const sessionId = measureWindowsSessionId();
      if (sessionId === null) {
        recoveryUnavailable(
          "session.recover: this process's interactive session could not be measured, so " +
            "there is no proven desktop to recover in.",
        );
      } else {
        recovery = createHostRecovery({
          target: { platform: "win32", session: { sessionId } },
          pid: () => transport.recoveryTargetPid(),
          // A pid is not an identity. The same re-check that produced the pid
          // runs again immediately before every GUI action, so a process
          // that exited and had its pid reused is never the one pressed.
          verifyProcess: (pid) => transport.recoveryTargetPid() === pid,
          screenshotDir: join(sessionRoot, "artifacts"),
        });
      }
    } else {
      // The recovery session is the one the transport provably talks into.
      // An explicit `session.uid` is still honoured and cross-checked; with
      // no session option the transport's own measured target session is
      // used — the same attestation supervision and `recoveryTarget()` rely
      // on. A transport that cannot name one gets no recovery, honestly.
      let targetSession: MacSession | null = null;
      try {
        if (sessionOption !== undefined) {
          targetSession = requireSession(sessionOption.uid);
          // The pid comes from the transport, which scopes processes by its own
          // session uid. Pressing keys in a different session than the one the
          // pid lives in would automate somebody else's screen.
          if (transport.targetSession?.uid !== targetSession.uid) {
            throw new AfterEffectsError(
              `session.recover: uid ${targetSession.uid} is not the session the transport talks into ` +
                `(${transport.targetSession?.uid ?? "unknown"}), so the fallback would act in another session.`,
              op,
            );
          }
        } else {
          targetSession = transport.targetSession;
          if (targetSession === null || targetSession.kind !== "Aqua") {
            throw new AfterEffectsError(
              "session.recover: the transport cannot name the login session its After Effects lives in, " +
                "so there is no proven desktop to recover in.",
              op,
            );
          }
        }
      } catch (error) {
        recoveryUnavailable(errorMessage(error));
      }
      if (targetSession !== null) {
        recovery = createHostRecovery({
          target: { platform: "darwin", session: targetSession },
          pid: () => transport.recoveryTargetPid(),
          // A pid is not an identity. The same re-check that produced the pid
          // runs again immediately before every GUI action, so a process
          // that exited and had its pid reused is never the one pressed.
          verifyProcess: (pid) => transport.recoveryTargetPid() === pid,
          screenshotDir: join(sessionRoot, "artifacts"),
          expectedModals,
        });
        expectedModalsActive = true;
      }
    }
  } else if (recoverOption === true) {
    // A caller-supplied transport that is not the script transport has no
    // pid to look up, so the fallback would be silently absent from a
    // session the caller asked to be recoverable. A requested safety
    // behaviour that cannot be provided is refused, not dropped.
    throw new AfterEffectsError(
      "session.recover needs the built-in script transport; the supplied transport cannot say which " +
        "process to recover. Nothing was started.",
      op,
    );
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
    } catch (error) {
      const reason = errorMessage(error);
      throw new AfterEffectsError(
        `host script not readable: ${hostScript} (${reason})`,
        op,
      );
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

  // Supervision (#285) starts only after the probe proves the session is
  // usable; the driver reads it lazily through this closure, so calls made
  // during `driver.start()` itself simply see "no monitor yet".
  //
  // Boot supervision (#339) is the one exception: when the transport can
  // name its target before the probe — the pid its launch census proved
  // and the session it lives in — the driver starts observing between
  // `launch()` and the first ExtendScript response, so a startup modal
  // that blocks the probe is observed rather than silent. That monitor is
  // observation-only; the post-probe attestation below still decides what
  // the session may press, and a boot monitor that could not prove a
  // target simply leaves `bootSupervision` null.
  let supervision: SessionSupervision | null = null;
  let bootSupervision: SessionSupervision | null = null;
  const bootTransport = asBootSupervisionTransport(transport);
  const driver = new AeDriver({
    transport,
    sessionRoot,
    trace,
    supervision: { report: () => supervision?.report() ?? null },
    ...(bootTransport === null
      ? {}
      : {
          bootSupervision: {
            start: () => {
              bootSupervision = startBootSupervision({
                transport: bootTransport,
                sessionRoot,
                pendingRequests: () => {
                  const pending = driver.pendingRequest();
                  return pending === null ? [] : [pending];
                },
                trace,
              });
            },
            stop: () => {
              bootSupervision?.stop();
              bootSupervision = null;
            },
            // Readiness classification (#444): the driver reads the boot
            // monitor's durable report when a launch wait fails, so a
            // startup modal is named (`modal-blocked:<class>`) instead of
            // collapsing into an opaque timeout. Read-only — the monitor
            // itself never presses.
            report: () => bootSupervision?.report() ?? null,
            // One bounded read-only observation (#452): the durable
            // document can be blind while the target sits inside the
            // probe's startup grace, so readiness classification asks for
            // a single probe read and attaches its census/AX evidence to
            // the launch error. Never a restarted monitor.
            observe: () => bootSupervision?.observeOnce() ?? Promise.resolve(null),
          },
        }),
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
    if (attach !== undefined) {
      throw attachStartFailure(op, error);
    }
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
  // A monitor that started before the probe already covers this session;
  // the post-probe attestation below only runs when none exists. A boot
  // monitor that could not prove a target stayed null and every path here
  // applies unchanged.
  supervision = bootSupervision;
  // GUI supervision begins only once the host answered its probe: before
  // that there is no proven pid/session to observe, and a monitor started
  // earlier could only report "unavailable" anyway. `recoveryTarget()` is
  // the same attestation the recovery path uses — an attached or
  // dispatcher session without one simply gets no monitor, and the durable
  // report stays honestly unavailable.
  if (supervision === null) {
    const supervisionTarget = driver.recoveryTarget();
    if (supervisionTarget !== null) {
      supervision = SessionSupervision.start({
        sessionRoot,
        pid: supervisionTarget.pid,
        target: { platform: "darwin", session: supervisionTarget.session },
        verifyPid: (pid) => driver.recoveryTarget()?.pid === pid,
        pendingRequests: () => {
          const pending = driver.pendingRequest();
          return pending === null ? [] : [pending];
        },
        // Supervision transitions and monitor health land in the same
        // trace.jsonl every other session operation does (#287).
        trace,
      });
    } else if (process.platform === "win32" && transport instanceof ScriptInvocationTransport) {
      // Windows supervision (#316) uses the same attestation the win32
      // recovery wiring above proved: `recoveryTargetPid()` re-reads the
      // process census on every call — pid plus the full creation identity,
      // single in-scope instance — so a reused pid, a second AfterFX.exe or
      // an unreadable census yields null and no monitor starts. The session
      // is this process's own measured interactive session: the observer's
      // PowerShell children land on this desktop by construction, and the
      // probe additionally refuses an observation whose target reports a
      // different session id. Observation only — this path holds no press.
      // A non-script transport (the dispatcher channel, a supplied
      // HostTransport) cannot name its pid, so it gets no monitor and the
      // durable report stays honestly unavailable.
      const pid = transport.recoveryTargetPid();
      const sessionId = pid === null ? null : measureWindowsSessionId();
      if (pid !== null && sessionId !== null && sessionId > 0) {
        supervision = SessionSupervision.start({
          sessionRoot,
          pid,
          target: { platform: "win32", session: { sessionId } },
          verifyPid: (target) => transport.recoveryTargetPid() === target,
          pendingRequests: () => {
            const pending = driver.pendingRequest();
            return pending === null ? [] : [pending];
          },
          trace,
        });
      }
    } else if (process.platform === "darwin" && transport instanceof DispatcherTransport) {
      // Recorded activation provenance (#294) is the stronger evidence:
      // an owned `activateDispatcher()` delivery named the exact process
      // the dispatcher activated in — including when several AE instances
      // share the machine, where census correlation below must fail
      // closed. The attested pid is still observation only: the driver's
      // recovery path keeps its own `recoveryTarget()` attestation, so a
      // provenance-backed monitor can report blocks but never press a
      // button. The session is the caller's own — the channel is private
      // to this OS user, so the attested uid/asid must be it.
      const attested = driver.hostAttestation();
      const guiSession = currentSession();
      if (
        attested.pid !== null &&
        attested.sessionUid !== null &&
        attested.sessionAsid !== null &&
        guiSession.kind === "Aqua" &&
        guiSession.uid === attested.sessionUid &&
        guiSession.asid === attested.sessionAsid
      ) {
        supervision = SessionSupervision.start({
          sessionRoot,
          pid: attested.pid,
          target: { platform: "darwin", session: guiSession },
          verifyPid: (pid) => driver.hostAttestation().pid === pid,
          pendingRequests: () => {
            const pending = driver.pendingRequest();
            return pending === null ? [] : [pending];
          },
          trace,
        });
      }
      if (supervision === null) {
        // The dispatcher runs inside an After Effects process owned by this
        // OS user, so OS census correlation (#294) can attribute it — and
        // only it. A caller-supplied HostTransport may be remote or fake;
        // attributing a local AE census to it would watch the wrong process,
        // so the fallback is restricted to the transport that provably
        // executes inside a local AE instance. The driver's own recovery
        // path still requires `recoveryTarget()`, so a census-attributed
        // monitor can report blocks but never press a button. Ambiguity
        // (zero or several AE instances, session mismatch) yields no
        // monitor and an honestly `unavailable` report.
        const attributed = attributeAeByCensus();
        if (attributed !== null) {
          supervision = SessionSupervision.start({
            sessionRoot,
            pid: attributed.pid,
            target: { platform: "darwin", session: attributed.session },
            verifyPid: attributed.verifyPid,
            pendingRequests: () => {
              const pending = driver.pendingRequest();
              return pending === null ? [] : [pending];
            },
            trace,
          });
        }
      }
    }
  }
  session.supervision = supervision;
  // Expected modals are honoured only where a recovery actually reads the
  // registry (the macOS path today). Anywhere else `expectModal` refuses
  // rather than registering into a void — and launch-time specs that can
  // never be consulted are recorded, not silently dropped.
  if (!expectedModalsActive && (options.expectedModals?.length ?? 0) > 0) {
    trace.record("session.expected-modals", "error", 0, {
      error: {
        name: "ExpectedModalsUnavailable",
        message:
          `${options.expectedModals?.length} expected-modal spec(s) were supplied but this ` +
          "platform's recovery path cannot consult them; the windows they describe keep " +
          "their unregistered classification. Nothing was pressed for them.",
      },
    });
  }
  session.modalExpectations = expectedModalsActive ? expectedModals : null;
  return { session, probe, extensionMethods };
}

/**
 * Translates a failed attach `driver.start()` into the typed failure the
 * attach contract promises (#269). The transport's own `AttachTargetError`
 * (not-found / ambiguous / wrong-session / unknown-target / unsupported)
 * passes through untouched; a probe that never answered — timeout or
 * unavailable host, which is how "busy" and "modal" surface — becomes
 * `unresponsive` with the original as `cause`. Anything else takes the
 * same contextualisation `launch` uses, which always throws.
 */
function attachStartFailure(op: string, error: unknown): Error {
  if (error instanceof AttachTargetError) {
    return error;
  }
  if (error instanceof TimeoutError || error instanceof HostUnavailableError) {
    return new AttachTargetError(
      "unresponsive",
      `${op} failed: the selected After Effects did not answer the readiness probe — ` +
        "it is busy, blocked by a dialog, or not the instance the census named. " +
        "Attach never resends or retries; inspect the host and attach again.",
      { cause: error, op },
    );
  }
  contextualise(op, error);
}
