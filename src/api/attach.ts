/**
 * Attach-only session establishment (#269).
 *
 * `AfterEffects.attach` shares `openAfterEffects` with `launch`/`resume` —
 * same transport resolution, driver, probe, and grant rules — but the
 * transport it builds for the default script lane is attach-only: its
 * `launch()` selects a running instance from the process census and has
 * no path to process creation. On Windows that lane refuses (every script
 * delivery there spawns `AfterFX.exe -r`), so attach on Windows goes
 * through the in-AE dispatcher transport or a caller-supplied transport.
 */

import { ScriptInvocationTransport } from "../driver/script-invocation.js";
import type { HostTransport } from "../driver/transport.js";
import { AfterEffectsError } from "./errors.js";
import { openAfterEffects, type OpenedSession } from "./launch.js";
import type { AttachOptions } from "./types.js";

/**
 * Whether `selection` is a transport instance (the fake host, a remote
 * worker, a dispatcher) rather than a named selection. Mirrors the check
 * `resolveTransport` makes.
 */
function isTransportInstance(selection: unknown): selection is HostTransport {
  return (
    typeof selection === "object" &&
    selection !== null &&
    typeof (selection as HostTransport).invoke === "function"
  );
}

/**
 * Validates `AttachOptions` and opens the session. Every refusal here
 * happens before a session root is created or anything is sent: a bad
 * target pin, a GUI-recovery request the attach lane cannot honour, or a
 * launch-capable script transport handed in by mistake.
 */
export async function attachAfterEffects(options: AttachOptions): Promise<OpenedSession> {
  const op = "session.attach";
  const pid = options.target?.pid;
  if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)) {
    throw new TypeError("target.pid must be a positive integer");
  }
  if (options.session?.recover === true) {
    // The GUI fallback presses dialogs in the session of a process it can
    // name and re-prove. An attach target is deliberately not that: it is
    // somebody else's running AE, and "recover" would automate a screen
    // this session does not own. Refuse rather than silently disable it.
    throw new AfterEffectsError(
      "session.recover is not available on attach: the GUI fallback needs a process this " +
        "session started and proved, and an attach target is never owned. " +
        "A modal dialog on the attached AE is reported as an unresponsive attach instead.",
      op,
    );
  }
  if (
    isTransportInstance(options.transport) &&
    options.transport instanceof ScriptInvocationTransport &&
    !options.transport.attachOnly
  ) {
    // A script transport built for launch() would spawn `open`/`AfterFX.exe`
    // when its census finds nothing — exactly the double-launch #99 records.
    // Attach must not accept it: the guarantee has to be structural, not a
    // promise in a document.
    throw new AfterEffectsError(
      "transport must be attach-capable: a ScriptInvocationTransport used with attach " +
        "needs `attach: {}` (or `attach: { targetPid }`) in its options, or use " +
        "\"in-ae-dispatcher\". Nothing was started.",
      op,
    );
  }
  return openAfterEffects(options, null, op, {
    ...(pid === undefined ? {} : { targetPid: pid }),
  });
}
