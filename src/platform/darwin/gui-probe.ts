/**
 * macOS GUI probe for supervision (#281).
 *
 * Wraps the existing `MacGuiRecovery.listWindows()` observation — AX tree
 * plus WindowServer census — into the platform-neutral `ProbeSnapshot`.
 * It never mutates: no lease is taken for a press, no button is clicked.
 * Observation is read-only, exactly like `ae.guiState()`.
 *
 * Honesty rules carried over from the recovery path:
 *
 *   - AX reporting zero windows while the WindowServer lists windows is
 *     `axSuspect`: a synthetic blocking window is emitted so supervision
 *     cannot mistake an unserviceable AX tree for a clean screen.
 *   - A census that cannot run is degraded evidence, not "no windows".
 *   - A dead pid is `process-gone`; a gone GUI session is
 *     `gui-session-lost`. Both are host-level states, not windows.
 */

import type { GuiAppState, GuiWindowInfo } from "../../driver/gui-recovery.js";
import { isBlockingWindow } from "../../driver/gui-recovery.js";
import type { DialogWindow } from "../recovery-policy.js";
import type { GuiProbe, ProbeSnapshot } from "../../supervision/probe.js";
import type { HostLevelState } from "../../supervision/types.js";

export type MacGuiProbeDeps = {
  /** Anything that can list the target's windows (MacGuiRecovery works). */
  readonly listWindows: () => GuiAppState;
  /** Process liveness, injectable for tests. Default: kill(pid, 0). */
  readonly pidAlive?: (pid: number) => boolean;
  /** GUI-session liveness, injectable for tests. */
  readonly sessionAlive?: () => boolean;
};

function toDialogWindow(window: GuiWindowInfo): DialogWindow {
  return {
    title: window.title,
    role: window.role,
    subrole: window.subrole,
    texts: [...window.texts],
    buttons: window.buttons.map((button) => button.title),
    blocking: isBlockingWindow(window),
  };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class MacGuiProbe implements GuiProbe {
  readonly #deps: MacGuiProbeDeps;
  readonly #pid: number;

  constructor(pid: number, deps: MacGuiProbeDeps) {
    this.#pid = pid;
    this.#deps = deps;
  }

  observe(): ProbeSnapshot {
    const pidAlive = this.#deps.pidAlive ?? defaultPidAlive;
    if (!pidAlive(this.#pid)) {
      return {
        ok: true,
        windows: [],
        host: "process-gone",
        degraded: ["target pid is not alive"],
      };
    }
    if (this.#deps.sessionAlive !== undefined && !this.#deps.sessionAlive()) {
      return {
        ok: true,
        windows: [],
        host: "gui-session-lost",
        degraded: ["GUI session is gone"],
      };
    }

    let state: GuiAppState;
    try {
      state = this.#deps.listWindows();
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const degraded: string[] = [];
    if (!state.windowServer.available) {
      degraded.push(`WindowServer census unavailable: ${state.windowServer.reason ?? "unknown"}`);
    }
    if (state.axSuspect) {
      degraded.push(
        `AX tree unserviceable: WindowServer reports ${state.windowServer.windowCount} window(s) ` +
          "for this pid while AX listed none",
      );
    }

    const windows = state.windows.map(toDialogWindow);
    if (state.axSuspect) {
      // An unobservable blocking surface still has to be seen: report it as
      // a blocking window of unknown class so supervision enters `blocked`
      // with tier `unknown`, never `running`.
      windows.push({
        title: "<unobservable window>",
        role: "AXWindow",
        subrole: null,
        texts: [`WindowServer reports ${state.windowServer.windowCount} window(s) not visible to AX`],
        buttons: [],
        blocking: true,
      });
    }

    // No windows at all AND no census to corroborate = we cannot claim the
    // screen is clean. Host "unknown" keeps the report honest.
    let host: HostLevelState = "none";
    if (windows.length === 0 && !state.windowServer.available) {
      host = "unknown";
      degraded.push("no AX windows and no WindowServer census: clean state unproven");
    }

    return {
      ok: true,
      windows,
      host,
      frontmost: state.frontmost,
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }
}
