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
   * Whether the transport proves it refuses to target the console
   * session's After Effects — the `isolated-user` invariant that a start
   * or script meant for another user can never land on the screen the
   * human is looking at. `null`/absent = unproven.
   */
  readonly refusesConsoleTarget?: boolean | null;
};

export interface HostTransport {
  /** Stable identifier recorded in the session manifest and trace. */
  readonly kind: string;

  /** Whether this transport's host is present and usable on this machine. */
  available(): Promise<boolean>;

  /** Start the host if it is not already running. */
  launch(): Promise<void>;

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

  /** Wait for a host this session quit to go away. */
  close(): Promise<void>;
}
