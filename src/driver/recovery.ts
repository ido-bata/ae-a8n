/**
 * Recovering a host that has stopped answering.
 *
 * The driver calls this when an operation timed out. The recovery looks at
 * the *target session's* screen, closes what is blocking the host, and says
 * what it did. It never repeats the operation that timed out: the request may
 * still be running inside After Effects, and sending it again would run it
 * twice. The driver waits for the original result instead.
 *
 * What the recovery may press is a policy, not a free-for-all. A button that
 * signs out of Adobe, deactivates a device, or confirms a licence change is
 * never pressed: those are a human's decision, and the recovery reports them
 * instead.
 */

import { join } from "node:path";

import { MacGuiRecovery, isBlockingWindow, type GuiWindowInfo } from "./gui-recovery.js";
import type { MacSession } from "./mac-session.js";

export type RecoveryContext = {
  /** The request that timed out. Its result may still arrive. */
  readonly requestId: string;
  readonly method: string;
  readonly timeoutMs: number;
};

export type RecoveryOutcome = {
  /** Whether something was done that may have unblocked the host. */
  readonly recovered: boolean;
  /** What was seen and what was done, for the trace and for a human. */
  readonly evidence: string;
  /** A screenshot of the target session, when one was taken. */
  readonly screenshotPath?: string;
  /** The window that was blocking, when one was found. */
  readonly window?: string;
};

export interface HostRecovery {
  attempt(context: RecoveryContext): Promise<RecoveryOutcome>;
}

/** Buttons a recovery may press: they end a dialog without changing anything. */
export const RECOVERY_BUTTONS: readonly string[] = ["OK", "Cancel", "Close", "Dismiss"];

/**
 * Windows the recovery must not touch.
 *
 * An Adobe sign-in or licence window belongs to a human: pressing its button
 * can sign the account out, deactivate a device, or accept a licence change
 * on the user's behalf. The recovery reports the window instead.
 */
export function isHumanOnlyWindow(window: GuiWindowInfo): boolean {
  const text = `${window.title} ${window.role} ${window.subrole ?? ""}`.toLowerCase();
  return /sign[ -]?in|log[ -]?in|licen[cs]|activat|deactivat|creative ?cloud|adobe ?id/.test(text);
}

/** What a window says, in one line, for evidence. */
export function describeWindow(window: GuiWindowInfo): string {
  const buttons = window.buttons.map((button) => button.title).filter((title) => title.length > 0);
  const subrole = window.subrole === null ? "" : `/${window.subrole}`;
  return `${window.role}${subrole} "${window.title}" [${buttons.join(", ")}]`;
}

export type MacHostRecoveryOptions = {
  /** The session the After Effects instance lives in. */
  readonly session: MacSession;
  /** The pid of the After Effects instance, when it is known. */
  readonly pid: () => number | null;
  /** Where a screenshot of the target session is written. */
  readonly screenshotDir: string;
  /** The buttons that may be pressed. */
  readonly buttons?: readonly string[];
};

/**
 * The GUI fallback for a macOS After Effects.
 *
 * Every action happens inside the host's own session, so a recovery can
 * never reach the console user's desktop.
 */
export class MacHostRecovery implements HostRecovery {
  readonly #session: MacSession;
  readonly #pid: () => number | null;
  readonly #screenshotDir: string;
  readonly #buttons: readonly string[];

  constructor(options: MacHostRecoveryOptions) {
    this.#session = options.session;
    this.#pid = options.pid;
    this.#screenshotDir = options.screenshotDir;
    this.#buttons = options.buttons ?? RECOVERY_BUTTONS;
  }

  attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    // The whole recovery is synchronous: every action is one Accessibility
    // query or one press inside the target session.
    return Promise.resolve(this.#attempt(context));
  }

  #attempt(context: RecoveryContext): RecoveryOutcome {
    const pid = this.#pid();
    if (pid === null) {
      return {
        recovered: false,
        evidence: `no After Effects process to recover: ${context.method} (${context.requestId}) timed out and no host process was found`,
      };
    }
    let gui: MacGuiRecovery;
    try {
      gui = new MacGuiRecovery({ session: this.#session, pid });
    } catch (error) {
      return {
        recovered: false,
        evidence: `no GUI recovery is possible: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let windows: readonly GuiWindowInfo[];
    try {
      windows = gui.listWindows().windows;
    } catch (error) {
      return {
        recovered: false,
        evidence: `the target session could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const blocking = windows.filter(isBlockingWindow);
    if (blocking.length === 0) {
      return {
        recovered: false,
        evidence:
          `After Effects ${pid} has no modal window; ${context.method} (${context.requestId}) timed out for another ` +
          "reason, and nothing was clicked",
      };
    }
    const window = blocking[0] as GuiWindowInfo;
    const screenshotPath = join(this.#screenshotDir, `recovery-${context.requestId}.png`);
    let shot: string | undefined;
    try {
      gui.capture(screenshotPath);
      shot = screenshotPath;
    } catch {
      // A screenshot that cannot be taken does not stop the recovery; the
      // accessibility report is the primary evidence.
    }
    const description = describeWindow(window);
    if (isHumanOnlyWindow(window)) {
      return {
        recovered: false,
        evidence:
          `After Effects ${pid} shows "${description}", which is an Adobe account or licence window. ` +
          "No button was pressed: signing in, signing out or deactivating a device is a human's decision. " +
          "The host stays blocked until it is answered by hand.",
        ...(shot === undefined ? {} : { screenshotPath: shot }),
        window: description,
      };
    }
    for (const title of this.#buttons) {
      const pressed = window.buttons.some((button) => button.title === title)
        ? gui.pressButton(title)
        : gui.pressButtonIn(null, title);
      if (pressed) {
        return {
          recovered: true,
          evidence: `closed "${description}" by pressing "${title}" in ${this.#session.username}'s session`,
          ...(shot === undefined ? {} : { screenshotPath: shot }),
          window: description,
        };
      }
    }
    const escaped = gui.pressEscape();
    return {
      recovered: escaped,
      evidence: escaped
        ? `closed "${description}" with the escape key in ${this.#session.username}'s session`
        : `found "${description}" but pressed nothing: none of ${this.#buttons.join(", ")} was available and the escape key did not close it`,
      ...(shot === undefined ? {} : { screenshotPath: shot }),
      window: description,
    };
  }
}
