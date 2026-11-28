/**
 * How a host script gets executed.
 *
 * The driver writes a request file, asks the transport to run the entry
 * script, then polls for the result file. Everything above this interface is
 * transport-agnostic, which is what lets the same code path run against a real
 * After Effects process or the in-repo fake.
 */

/**
 * The call was abandoned before it reached the host.
 *
 * A transport that can only send one script at a time (macOS `DoScriptFile`
 * is synchronous) has to wait for the running script to finish before it may
 * send the next one. If the call's deadline passes during that wait, the
 * script was never sent: nothing ran, and nothing may be reported as a
 * timeout of the operation.
 */
export class ScriptNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptNotSentError";
  }
}

/**
 * The host's own scripting preference provably forbids the file writes the
 * bridge needs, established before anything was started or sent. Every
 * request and result travels as a file, so with
 * `Pref_SCRIPTING_FILE_NETWORK_SECURITY = "0"` the host opens the result
 * file, writes nothing, and every call would only ever time out (observed
 * on AE 27.0, issue #188). Thrown instead of launching so no After Effects
 * process is left running for a session that cannot work.
 */
export class ScriptingPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptingPermissionError";
  }
}

/**
 * Why an attach-only session (`AfterEffects.attach`) refused or failed.
 *
 * Every reason is a fail-closed answer: the session was never established,
 * or it was established against a target that later stopped being provable.
 * Nothing here ever means "try launching instead" — attach has no launch
 * path at all.
 */
export type AttachFailureReason =
  /** No After Effects of the selected install is running in scope. */
  | "not-found"
  /** Several candidates and no `target.pid` pin to choose between them. */
  | "ambiguous"
  /**
   * The After Effects that was found belongs to a different login session
   * than the one this process may address (macOS uid scoping).
   */
  | "wrong-session"
  /**
   * The process list or the target's identity could not be read, so which
   * After Effects would answer cannot be proven.
   */
  | "unknown-target"
  /**
   * A target was selected but never answered the readiness probe — busy,
   * showing a modal, or otherwise unresponsive. No resend or retry follows.
   */
  | "unresponsive"
  /**
   * This transport cannot attach without creating a process (Windows
   * script invocation delivers every script through `AfterFX.exe -r`).
   */
  | "unsupported";

/**
 * The typed failure `AfterEffects.attach` throws. `reason` is the stable
 * field callers branch on; the message carries the human-readable detail
 * (pids, sessions, install path) and `cause` keeps the underlying error.
 */
export class AttachTargetError extends Error {
  readonly reason: AttachFailureReason;
  /** The API operation that failed, e.g. `session.attach`. */
  readonly op?: string;

  constructor(
    reason: AttachFailureReason,
    message: string,
    options?: { cause?: unknown; op?: string },
  ) {
    super(message, options);
    this.name = "AttachTargetError";
    this.reason = reason;
    if (options?.op !== undefined) {
      this.op = options.op;
    }
  }
}

export type InvokeOptions = {
  /**
   * Aborted when the call's deadline passes. A transport that waits for the
   * script to finish (macOS `DoScriptFile` is synchronous) must stop waiting
   * and reject. It must not abandon the host mid-script: the script runs on,
   * and the transport is responsible for not sending the next one into it.
   */
  readonly signal?: AbortSignal;
};

/**
 * Whether this session started the host process.
 *
 * "owned": this session launched it and it is still that process.
 * "attached": the host was already running; it belongs to someone else.
 * "unknown": neither could be established. Treated like "attached".
 */
export type HostOwnership = {
  readonly kind: "owned" | "attached" | "unknown";
  /** What the decision rests on, for the trace and for a human. */
  readonly evidence: string;
  /**
   * A stable code for a refusal a caller may act on. `A8N-AE-004`: the
   * After Effects could not be tied to this run, so it was left running.
   */
  readonly code?: string;
};

/**
 * The process a session started but never proved it owns.
 *
 * This is provenance, not ownership: it says which process this session
 * started, and never that this session may quit it. It exists so a launch
 * that fails after the process appeared — a denied Apple Event, a host that
 * never became scriptable — leaves a name a human can act on instead of an
 * anonymous After Effects with nothing tying it to the run.
 */
export type PendingLaunch = {
  readonly pid: number;
  /**
   * The process start time the OS reported, ms since the epoch, pinned the
   * first time the pid was seen. Null when the process list could not be
   * read: a start time is never guessed.
   */
  readonly startedAt: number | null;
  readonly executable: string;
  /**
   * Whether the last process listing still held the process named by `pid`
   * with this start time. False also when the listing could not be read, so
   * a caller must not read it as proof the process exited.
   */
  readonly presentAtLastLookup: boolean;
  /** The login session it was started into, when that can be named. */
  readonly session: {
    readonly uid: number;
    readonly user: string | null;
    readonly asid: number | null;
  } | null;
};

/**
 * What a session explicitly authorizes on a host it does not own (#145).
 *
 * Ownership and authorization are separate authorities: `owned` sessions
 * may do everything; `attached` sessions may do everything except the
 * operations a grant names here; `unknown` sessions may do nothing a grant
 * names — consent cannot substitute for an unproven target. A grant is the
 * caller's recorded consent, a caller-side gate only: the AE host does not
 * authenticate or independently authorize it, and it never changes
 * ownership, never permits quitting the host, and never survives into
 * another session or another target instance.
 *
 * Each key is one operation class:
 *
 * - `extensionMethods`: consumer-declared static extension methods through
 *   `ae.call`. `true` allows every declared method; a list of names allows
 *   only those.
 * - `hostEnvironment`: `app.setEnvironment` inside the host process.
 * - `menuCommands`: AE menu commands (`menuCommand`, `undo`, `redo`).
 */
export type SessionAuthorization = {
  readonly extensionMethods?: boolean | readonly string[];
  readonly hostEnvironment?: boolean;
  readonly menuCommands?: boolean;
};

/** The operation classes a grant can name, in reporting order. */
export const AUTHORIZATION_SCOPES = [
  "extensionMethods",
  "hostEnvironment",
  "menuCommands",
] as const;
export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];

/**
 * Whether the host process is still there, as far as the transport can prove.
 *
 * "alive": the process this session is talking to exists.
 * "gone": it does not — a crash, a quit, or a kill. A timeout against a gone
 * host is a different diagnosis than a timeout against a live one.
 * "unknown": the transport cannot attribute a process to this session, so it
 * cannot say. Never reported as "gone" on a guess: an unproven answer stays
 * "unknown", exactly like ownership.
 */
export type HostState = "alive" | "gone" | "unknown";

/**
 * The process a session proved it owns, with the identity a later process
 * can re-check (pid, start time, Windows creation identity, executable).
 * Provenance only — never authority for ownership or for addressing.
 */
export type OwnedProcess = {
  readonly pid: number;
  readonly startedAt: number;
  readonly identity?: string | undefined;
  readonly executable: string;
};

/**
 * Where the host actually runs, as far as the transport can attest.
 *
 * Every field is evidence or null/"unknown" — a transport that cannot say
 * where its host lives reports nothing, and the capability handshake
 * reports "unknown" rather than borrowing the controller's platform.
 */
export type HostAttestation = {
  /** The host pid, when the transport can name one. Diagnostics only. */
  readonly pid: number | null;
  /** The proven owned process, for launch provenance and identity. */
  readonly ownedProcess: OwnedProcess | null;
  /** Host os/arch, only when the transport attests the host is reachable here. */
  readonly platform: { readonly os: string; readonly arch: string } | null;
  /**
   * ADR-0003 execution mode the transport attests: "local", "remote",
   * "isolated-user", or "unknown" when it cannot say.
   */
  readonly executionMode: string;
  /** The GUI session the host was verified to belong to, when known. */
  readonly sessionUid: number | null;
  readonly sessionAsid: number | null;
  /**
   * The session user's name, when the transport can name it. Evidence for
   * the capability handshake's host/session report (#129); null when the
   * transport cannot say — never guessed from the controller's account.
   */
  readonly sessionUser?: string | null;
  /**
   * Whether dispatch requires delivery into a GUI login session (an Apple
   * Event into the session, `-r` into the interactive instance) rather than
   * a headless channel. `null`/absent = unproven: the capability handshake
   * reports "unknown", never a guess.
   */
  readonly requiresGuiDelivery?: boolean | null;
  /**
   * The dispatcher instance this session is bound to, when the transport
   * identifies its target that way (the in-AE dispatcher reports an
   * `instance` in its heartbeat). Diagnostics/target-identity evidence
   * only — never authority for ownership or for addressing a process.
   * `null`/absent = the transport cannot name an instance.
   */
  readonly targetInstance?: string | null;
  /**
   * Whether the transport proves it refuses to target the console
   * session's After Effects — the `isolated-user` invariant that a start
   * or script meant for another user can never land on the screen the
   * human is looking at. `null`/absent = unproven.
   */
  readonly refusesConsoleTarget?: boolean | null;
};

/**
 * `HostTransport.kind` of the opt-in in-AE dispatcher transport (#127).
 * Lives here, not in the transport module, so capability reporting can name
 * it without importing the transport's filesystem machinery.
 */
export const DISPATCHER_TRANSPORT_KIND = "in-ae-dispatcher" as const;

/**
 * One timed sub-phase of `launch()`, kept by transports that can see inside
 * it (script invocation: process census, spawn, first pid observation).
 * Readiness instrumentation (#444) folds these into the `session.launch`
 * `stepTimings` so a slow or failed readiness wait names the phase that
 * spent the budget instead of reporting one opaque total.
 */
export type LaunchPhaseTiming = {
  /** Stable phase id, e.g. `process-census`. */
  readonly stepId: string;
  /** ISO-8601 phase start. */
  readonly startedAt: string;
  readonly durationMs: number;
};

export interface HostTransport {
  /** Stable identifier recorded in the session manifest and trace. */
  readonly kind: string;

  /** Whether this transport's host is present and usable on this machine. */
  available(): Promise<boolean>;

  /** Start the host if it is not already running. */
  launch(): Promise<void>;

  /**
   * The sub-phases the most recent `launch()` observed, oldest first.
   * Optional: a transport without it is timed only at the driver's phase
   * level. Read-only evidence — callers must not mutate the returned rows.
   */
  launchPhases?(): readonly LaunchPhaseTiming[];

  /**
   * Run an entry script in the host. Resolves once the host has finished with
   * the script — it does **not** imply the operation succeeded; the result
   * file carries that.
   */
  invoke(entryScriptPath: string, options?: InvokeOptions): Promise<void>;

  /**
   * Called once the readiness probe has answered, so the transport can tie
   * the host process to this session. Optional.
   */
  confirmLaunched?(): void;

  /**
   * True when the transport cannot aim a script at one instance (Windows
   * `AfterFX.exe -r` has no way to name a process). The driver then has the
   * probe leave a session marker in the instance that answers it, and has
   * `app.quit` run only where that marker is found, so a quit that reached some
   * other instance quits nothing.
   */
  readonly verifiesDestination?: boolean | undefined;

  /**
   * Who owns the host *now*. The driver quits the host only on "owned".
   * A transport without this is treated as "unknown".
   */
  ownership?(): HostOwnership;

  /**
   * The host process this session started and could not prove, when a launch
   * got that far. Null when this session started nothing (the host was
   * already running) or when ownership was proven.
   *
   * The driver reports this when a launch fails after the process appeared.
   * It is never a licence to quit: the caller is told to recover by hand.
   * Optional.
   */
  pendingLaunch?(): PendingLaunch | null;

  /**
   * Whether the host process still exists, when the transport can prove it.
   * Consulted when an operation times out, so "the host died" is not
   * reported as "the host did not answer". Optional; a transport without it
   * leaves timeouts unclassified.
   */
  hostState?(): HostState;

  /**
   * The pid of the host process this session owns, once known. Diagnostics
   * only — never authority for ownership or for addressing a process.
   * Optional.
   */
  hostPid?(): number | null;

  /**
   * The process this session proved it owns, with the identity a later
   * process can re-check (pid, start time, Windows creation identity,
   * executable). Used to write launch provenance for `resume`; null when
   * nothing is proven. Diagnostics/provenance only — never authority.
   * Optional.
   */
  ownedProcess?(): OwnedProcess | null;

  /**
   * What the transport can attest about where the host runs — pid, proven
   * process, platform, execution mode, GUI session — for capability
   * advertisement (#102). The default implementation reports only what the
   * individual optional hooks already expose; a transport that knows more
   * (a remote worker, an in-AE dispatcher) overrides it. Absent fields stay
   * null/"unknown" — never guessed.
   */
  attestation?(): Partial<HostAttestation>;

  /**
   * Resolves true once the host will accept a script, false if it still would
   * not when `timeoutMs` ran out. Optional; a transport without it is probed
   * straight away. After Effects on Windows needs it: a `-r` sent while AE is
   * still starting is either dropped without a trace or answered with an
   * "Unable to execute script. The Scripting plugin is not installed." dialog
   * that then blocks the start (both observed on 26.5x89).
   */
  awaitScriptable?(timeoutMs: number): Promise<boolean>;

  /**
   * The extension method names the *live target* reports as registered, when
   * the transport can ask (the in-AE dispatcher reports them in its
   * heartbeat). `null` = the transport cannot say right now; the caller
   * must not treat that as "none registered". Optional.
   */
  activeExtensionMethods?(): readonly string[] | null;

  /** Wait for a host this session quit to go away. */
  close(): Promise<void>;
}
