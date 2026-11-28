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
 *     cannot mistake an unserviceable AX tree for a clean screen. The one
 *     exception is launch-transient emptiness (#322): AE 2027's first
 *     launch answered AX with zero windows for ~3 minutes while the census
 *     listed 6-8 windows, then populated without any activation. While the
 *     target process is younger than `AX_SUSPECT_STARTUP_GRACE_MS` the
 *     suspect is reported as degraded evidence only — never as a blocking
 *     window — so supervision stays `running` (degraded) instead of
 *     pinning `blocked`. Once the process ages past the grace, or its age
 *     cannot be proven, `axSuspect` emits the synthetic window exactly as
 *     before: a persistently unobservable surface still reaches `blocked`
 *     in finite time.
 *   - AX reporting *some* windows is not proof the rest are visible
 *     either: AE 2027 modal dialogs stay completely AX-invisible while
 *     the ordinary windows list normally (issue #321). An on-screen
 *     WindowServer window no AX window's frame accounts for is the same
 *     kind of evidence — but only after it persists for
 *     `UNACCOUNTED_CONFIRM_OBSERVATIONS` consecutive observations, so a
 *     single mid-drag/mid-resize skew between the two session commands
 *     cannot flap the phase.
 *   - The AX listing itself is not pid-accurate on multi-install hosts
 *     (issue #330): with two same-bundle-id AE versions running, System
 *     Events can answer `windows of process` with the OTHER instance's
 *     windows. Every AX window is attributed through the pid-accurate
 *     census before it is trusted: `"foreign"` and `"unmatched"` windows
 *     are excluded from the reported window list and named in `degraded`,
 *     and an AX listing with NO attributable window raises `axSuspect`
 *     exactly like an empty one.
 *   - A census that cannot run is degraded evidence, not "no windows".
 *   - A dead pid is `process-gone`; a gone GUI session is
 *     `gui-session-lost`. Both are host-level states, not windows.
 */

import { execFileSync } from "node:child_process";

import type { GuiAppState, GuiWindowInfo } from "../../driver/gui-recovery.js";
import { isBlockingWindow, isPidAttributedWindow } from "../../driver/gui-recovery.js";
import type { WindowServerWindow } from "./window-census.js";
import type { DialogWindow } from "../recovery-policy.js";
import type { GuiProbe, ProbeCensus, ProbeSnapshot } from "../../supervision/probe.js";
import type { HostLevelState } from "../../supervision/types.js";

export type MacGuiProbeDeps = {
  /** Anything that can list the target's windows (MacGuiRecovery works). */
  readonly listWindows: () => GuiAppState;
  /** Process liveness, injectable for tests. Default: kill(pid, 0). */
  readonly pidAlive?: (pid: number) => boolean;
  /** GUI-session liveness, injectable for tests. */
  readonly sessionAlive?: () => boolean;
  /**
   * Target process age in milliseconds, injectable for tests. Default:
   * `ps -o etime=` parsed to elapsed time. Consulted only when `axSuspect`
   * fires, and only to decide whether the suspect is still inside the
   * launch-transient grace (#322). `null` — unreadable age — is NOT
   * grace: an unprovable age fails closed to the blocking evidence.
   */
  readonly processAgeMs?: (pid: number) => number | null;
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

/**
 * How long after process start an `axSuspect` observation is treated as
 * launch-transient rather than proof of a persistently unserviceable AX
 * tree (#322). Measured on AE 2027's first launch (issue #322): AX
 * answered zero windows for ~3 minutes while the WindowServer census
 * listed 6-8 windows, then populated — once on frontmost activation,
 * once spontaneously on a second launch. Five minutes covers that
 * observation with margin; it is deliberately not tied to the monitor's
 * tick, so a restarted probe or monitor gets the same answer — process
 * age is the evidence, not probe uptime.
 *
 * The cost is bounded and honest: a genuinely AX-invisible surface raised
 * during the first five minutes of the process's life (e.g. a launch-time
 * crash-recovery dialog) is reported as degraded evidence, not blocked,
 * until the grace ends — at which point `axSuspect` emits the synthetic
 * blocking window on the next observation.
 */
export const AX_SUSPECT_STARTUP_GRACE_MS = 5 * 60 * 1000;

/**
 * Parse `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into milliseconds.
 * Returns null for anything unrecognised — an unreadable age must never
 * be mistaken for a young process.
 */
export function parseElapsedMs(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const daySplit = trimmed.split("-");
  const hasDays = daySplit.length === 2;
  if (daySplit.length > 2 || (hasDays && daySplit[0] === "")) {
    return null;
  }
  const days = hasDays ? Number(daySplit[0]) : 0;
  const clock = hasDays ? daySplit[1]! : trimmed;
  if (!Number.isInteger(days) || days < 0) {
    return null;
  }
  const fields = clock.split(":").map((part) => Number(part));
  if (fields.length < 2 || fields.length > 3 || fields.some((n) => !Number.isInteger(n) || n < 0)) {
    return null;
  }
  const [a, b, c] = fields.length === 2 ? [0, fields[0]!, fields[1]!] : fields;
  // mm:ss or hh:mm:ss (or dd-hh:mm:ss via `days`).
  const seconds = (days * 24 + (a ?? 0)) * 3600 + (b ?? 0) * 60 + (c ?? 0);
  return seconds * 1000;
}

/** Default process-age probe: elapsed time of `pid` via `ps -o etime=`. */
function defaultProcessAgeMs(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseElapsedMs(out);
  } catch {
    return null;
  }
}

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

  /**
   * Whether an `axSuspect` observation is still inside the launch-transient
   * grace (#322). The age probe runs only here — a `ps` fork per tick would
   * be waste when AX is healthy. An unreadable age (`null`) is not grace:
   * unproven youth fails closed to the blocking evidence.
   */
  #axSuspectInStartupGrace(): boolean {
    const ageMs = (this.#deps.processAgeMs ?? defaultProcessAgeMs)(this.#pid);
    return ageMs !== null && ageMs >= 0 && ageMs < AX_SUSPECT_STARTUP_GRACE_MS;
  }

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
          "for this pid while AX listed none attributable to it",
      );
    }
    if (state.axForeignWindowCount > 0) {
      degraded.push(
        `AX listing included ${state.axForeignWindowCount} window(s) the WindowServer ` +
          "attributes to other processes — the bundle-confused listing of #330; " +
          "excluded as foreign",
      );
    }
    if (state.axUnmatchedWindowCount > 0) {
      degraded.push(
        `AX listing included ${state.axUnmatchedWindowCount} window(s) no census window ` +
          "accounts for — excluded as unattributed",
      );
    }

    // Only pid-attributed AX windows are evidence (#330): a foreign or
    // unproven window is never this instance's blocker.
    const windows = state.windows
      .filter(isPidAttributedWindow)
      .map(toDialogWindow);
    // The census counts behind `degraded[]`, captured before the branches
    // below append synthetic blocking windows: `attributedWindowCount`
    // counts what AX itself listed, not what this probe concluded (#452).
    const attributedWindowCount = windows.length;
    if (state.axSuspect) {
      if (this.#axSuspectInStartupGrace()) {
        // Launch-transient AX emptiness (#322): the process is young enough
        // that an empty AX tree is expected while it initialises — AE 2027
        // measured ~3 minutes of it on first launch. The suspect stays
        // degraded evidence (observationHealth=degraded), never a blocking
        // window, so supervision reports `running` rather than pinning
        // `blocked` on a screen that is merely still coming up. Once the
        // grace ends the same observation emits the synthetic window below.
        degraded.push(
          `AX tree unserviceable but the process is within its ` +
            `${AX_SUSPECT_STARTUP_GRACE_MS / 60_000}min startup grace ` +
            "(launch-transient emptiness, #322); blocking evidence deferred",
        );
      } else {
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

    // The structured census rides the snapshot (#452) so a consumer —
    // launch readiness classification above all — can tell "alive but
    // screen-unusable to AX" from a plain silent host without parsing
    // the degraded strings. `listingSuspect` is evidence, not a verdict:
    // the grace and confirmation rules above already ran.
    const census: ProbeCensus = {
      available: state.windowServer.available,
      windowCount: state.windowServer.windowCount,
      onScreenCount: state.windowServer.onScreenCount,
      unaccountedWindowCount: state.axUnaccountedWindows.length,
      attributedWindowCount,
      listingSuspect: state.axSuspect,
    };

    return {
      ok: true,
      windows,
      host,
      frontmost: state.frontmost,
      census,
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }
}
