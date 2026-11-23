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
 *   - AX reporting *some* windows is not proof the rest are visible
 *     either: AE 2027 modal dialogs stay completely AX-invisible while
 *     the ordinary windows list normally (issue #321). An on-screen
 *     WindowServer window no AX window's frame accounts for is the same
 *     kind of evidence — but only after it persists for
 *     `UNACCOUNTED_CONFIRM_OBSERVATIONS` consecutive observations, so a
 *     single mid-drag/mid-resize skew between the two session commands
 *     cannot flap the phase.
 *   - A census that cannot run is degraded evidence, not "no windows".
 *   - A dead pid is `process-gone`; a gone GUI session is
 *     `gui-session-lost`. Both are host-level states, not windows.
 */

import type { GuiAppState, GuiWindowInfo } from "../../driver/gui-recovery.js";
import { isBlockingWindow } from "../../driver/gui-recovery.js";
import type { WindowServerWindow } from "./window-census.js";
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

/**
 * Consecutive observations an AX-unaccounted on-screen window must persist
 * before it is reported as blocking. The AX listing and the WindowServer
 * census are two separate session commands; a window being dragged or
 * resized can skew their frames past the match tolerance for a moment.
 * Two observations at the default 2s tick means ~4s of persistent
 * evidence — fast enough for a modal that blocks indefinitely, slow
 * enough to ignore a transient.
 */
export const UNACCOUNTED_CONFIRM_OBSERVATIONS = 2;

function describeUnaccounted(window: WindowServerWindow): string {
  const parts = [`layer ${window.layer}`];
  if (window.bounds !== null) {
    parts.push(
      `${window.bounds.width}x${window.bounds.height} at ` +
        `${window.bounds.x},${window.bounds.y}`,
    );
  }
  if (window.name !== "") {
    parts.push(`name "${window.name}"`);
  }
  return `on-screen window invisible to AX: ${parts.join(", ")}`;
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
  #unaccountedStreak = 0;

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
      this.#unaccountedStreak = 0;
    } else {
      // AX listed windows, but that does not prove it listed all of them:
      // an on-screen WindowServer window no AX frame accounts for is the
      // same unobservable-surface evidence as `axSuspect`, one window at a
      // time. It is confirmed over consecutive observations before it is
      // allowed to block — see UNACCOUNTED_CONFIRM_OBSERVATIONS.
      const unaccounted = state.axUnaccountedWindows;
      if (unaccounted.length === 0) {
        this.#unaccountedStreak = 0;
      } else {
        this.#unaccountedStreak += 1;
        degraded.push(
          `WindowServer reports ${unaccounted.length} on-screen window(s) ` +
            "the Accessibility API cannot account for",
        );
        if (this.#unaccountedStreak >= UNACCOUNTED_CONFIRM_OBSERVATIONS) {
          for (const ws of unaccounted) {
            windows.push({
              title: "<unobservable window>",
              role: "AXWindow",
              subrole: null,
              texts: [`WindowServer ${describeUnaccounted(ws)}`],
              buttons: [],
              blocking: true,
            });
          }
        }
      }
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
