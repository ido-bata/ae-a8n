/**
 * Platform selection for the driver's GUI fallback (#283 wiring).
 *
 * `HostRecovery` is the driver's contract; this module is the one place
 * that picks the implementation for the platform the target session
 * lives on — the same role `selectAdapter` plays for the runner backends,
 * one layer down where the session shape is already proven:
 *
 *   - `darwin` → `MacHostRecovery` over `MacGuiRecovery` (AX +
 *     WindowServer, `launchctl asuser` session delivery).
 *   - `win32` → `WindowsHostRecovery` over `WindowsGuiRecovery`
 *     (Win32 census + UIA, PowerShell children of this process).
 *
 * The dispatch is on the *target's* platform, which the caller declares
 * from the session it proved — never guessed from `process.platform`.
 * Each implementation still refuses what its host cannot honestly do
 * (`WindowsGuiRecovery` requires win32; the macOS path requires a real
 * GUI session), so a mismatched pair fails closed rather than acting on
 * the wrong desktop.
 */

import type { MacSession } from "./mac-session.js";
import { MacHostRecovery, type HostRecovery } from "./recovery.js";
import { WindowsHostRecovery, type WindowsHostRecoveryOptions } from "./windows-host-recovery.js";
import type { WindowsGuiSession } from "./windows-gui-recovery.js";

export type { HostRecovery } from "./recovery.js";

/**
 * The proven GUI session a recovery may act in, in the shape its
 * platform's recovery understands. `platform` is part of the target
 * because the two session shapes share no fields: a `MacSession` names a
 * login session by uid/asid, a `WindowsGuiSession` names an interactive
 * session by id.
 */
export type HostRecoveryTarget =
  | { readonly platform: "darwin"; readonly session: MacSession }
  | { readonly platform: "win32"; readonly session: WindowsGuiSession };

export type CreateHostRecoveryOptions = {
  readonly target: HostRecoveryTarget;
  /** The pid of the After Effects instance, when it is known. */
  readonly pid: () => number | null;
  /** Process-identity re-check before every GUI action; see `MacHostRecoveryOptions`. */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /** Where a screenshot of the target session is written (macOS only). */
  readonly screenshotDir: string;
  /** The buttons that may be pressed. */
  readonly buttons?: readonly string[];
  /**
   * Seams forwarded to `WindowsGuiRecovery` only — the command runner,
   * the session re-proof readers, the console-session reader, the
   * attached marker and the lease/audit controller. Ignored for a darwin
   * target, whose option set is `MacHostRecoveryOptions`'s.
   */
  readonly windows?: Omit<
    WindowsHostRecoveryOptions,
    "session" | "pid" | "verifyProcess" | "buttons"
  >;
};

/**
 * Build the `HostRecovery` for a proven target session. The driver takes
 * the result as its `recovery` option; a platform with no implementation
 * is a type error here, not a runtime surprise.
 */
export function createHostRecovery(options: CreateHostRecoveryOptions): HostRecovery {
  const { target } = options;
  if (target.platform === "darwin") {
    return new MacHostRecovery({
      session: target.session,
      pid: options.pid,
      ...(options.verifyProcess === undefined ? {} : { verifyProcess: options.verifyProcess }),
      screenshotDir: options.screenshotDir,
      ...(options.buttons === undefined ? {} : { buttons: options.buttons }),
    });
  }
  return new WindowsHostRecovery({
    session: target.session,
    pid: options.pid,
    ...(options.verifyProcess === undefined ? {} : { verifyProcess: options.verifyProcess }),
    ...(options.buttons === undefined ? {} : { buttons: options.buttons }),
    ...(options.windows ?? {}),
  });
}
