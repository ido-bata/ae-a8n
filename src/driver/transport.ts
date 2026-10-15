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
   * script to finish (macOS `DoScriptFile` is synchronous) must stop waiting;
   * the script itself may run on inside the host.
   */
  readonly signal?: AbortSignal;
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

  /** Stop the host, if this transport started it. */
  close(): Promise<void>;
}
