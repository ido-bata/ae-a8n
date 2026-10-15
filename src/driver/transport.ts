/**
 * How a host script gets executed.
 *
 * The driver writes a request file, asks the transport to run the entry
 * script, then polls for the result file. Everything above this interface is
 * transport-agnostic, which is what lets the same code path run against a real
 * After Effects process or the in-repo fake.
 */

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
   * Who owns the host *now*. The driver quits the host only on "owned".
   * A transport without this is treated as "unknown".
   */
  ownership?(): HostOwnership;

  /** Wait for a host this session quit to go away. */
  close(): Promise<void>;
}
