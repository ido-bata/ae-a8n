/**
 * Panel target resolution (#343, `specs/panel-interaction/spec.md` §6.1).
 *
 * Pure: given one Accessibility listing (`GuiAppState`) and the
 * WindowServer census for the same pid, a `PanelLocator` resolves to a
 * `PanelTarget` — or to a typed refusal. Nothing here mutates anything;
 * the census attribution rules are the same ones `pressButton` enforces
 * (#330/#332): a window the census cannot attribute to the target pid is
 * never usable as mutation evidence.
 */

import {
  framesMatch,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import type { WindowServerWindow } from "../platform/darwin/window-census.js";
import {
  PanelError,
  type PanelAttribution,
  type PanelFrame,
  type PanelLocator,
  type PanelSurface,
  type PanelTarget,
} from "./types.js";

function toPanelFrame(frame: GuiFrame): PanelFrame {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function describeCandidate(window: GuiWindowInfo, index: number): string {
  const frame = window.frame;
  const geometry =
    frame === null || frame === undefined
      ? "no-frame"
      : `${Math.round(frame.x)},${Math.round(frame.y)} ${Math.round(frame.width)}x${Math.round(frame.height)}`;
  return `#${index} "${window.title}" role=${window.role} subrole=${window.subrole ?? "-"} ${geometry}`;
}

/**
 * The census windows whose bounds match an AX frame, split by owner.
 * A frame matched by windows of MORE THAN ONE pid is ambiguous — the same
 * refusal `attributeAxWindow` applies (#332).
 */
function censusMatch(
  frame: GuiFrame,
  pid: number,
  census: readonly WindowServerWindow[],
): {
  readonly owned: readonly WindowServerWindow[];
  readonly foreign: readonly WindowServerWindow[];
} {
  const matches = census.filter(
    (ws) => ws.bounds !== null && framesMatch(frame, ws.bounds),
  );
  return {
    owned: matches.filter((ws) => ws.pid === pid),
    foreign: matches.filter((ws) => ws.pid !== pid),
  };
}

/**
 * Attribute one AX window to the pid through the census, mirroring
 * `attributeAxWindow` in `gui-recovery.ts` but returning the census row
 * too — panels need its `windowNumber` (the `screencapture -l` handle)
 * and `onScreen` flag, which the AX listing does not carry.
 *
 * An empty census means attribution is unproven, not foreign: callers
 * must treat `"unproven"` as "observe-only", never as mutation evidence.
 */
export function attributePanelWindow(
  window: GuiWindowInfo,
  pid: number,
  census: readonly WindowServerWindow[],
): { attribution: PanelAttribution; censusWindow: WindowServerWindow | null } {
  const frame = window.frame;
  if (frame === null || frame === undefined || census.length === 0) {
    return { attribution: "unproven", censusWindow: null };
  }
  const { owned, foreign } = censusMatch(frame, pid, census);
  if (owned.length > 0 && foreign.length === 0) {
    return { attribution: "owned", censusWindow: owned[0] ?? null };
  }
  if (owned.length === 0 && foreign.length > 0) {
    return { attribution: "foreign", censusWindow: null };
  }
  return { attribution: "unmatched", censusWindow: null };
}

/**
 * Honest-degradation hint appended to not-found refusals when the
 * observation itself flagged the AX tree as suspect (#406): an empty or
 * wholly foreign/unmatched AX listing on a pid whose WindowServer census
 * lists real windows is exactly the After Effects non-vending shape, and
 * the caller deserves to hear that the locator may be fine while the AX
 * enumeration is not — plus the one observe path that still works.
 */
function axSuspectHint(state: GuiAppState): string {
  if (!state.axSuspect) {
    return "";
  }
  return (
    ` — note: this pid's AX tree is suspect` +
    (state.axSuspectReason === null ? "" : ` (${state.axSuspectReason})`) +
    "; the AX window enumeration may be empty or untrusted (After " +
    "Effects vends no AXWindows at all, #406) — " +
    "ae.windowOps(locator, { focusedOnly: true }) can still observe the " +
    "focused window through AXFocusedWindow"
  );
}

function locatorMatches(window: GuiWindowInfo, locator: PanelLocator): boolean {
  if (locator.title !== undefined) {
    const title = window.title;
    const ok =
      locator.titleMatch === "contains"
        ? title.includes(locator.title)
        : title === locator.title;
    if (!ok) {
      return false;
    }
  }
  if (locator.role !== undefined && window.role !== locator.role) {
    return false;
  }
  if (locator.subrole !== undefined && window.subrole !== locator.subrole) {
    return false;
  }
  return true;
}

export type PanelResolution = {
  readonly target: PanelTarget;
  /**
   * The Accessibility listing entry the target resolved to — internal
   * evidence for mutation scripts (title/subrole/frame re-verification).
   * Never part of the public `PanelTarget`.
   */
  readonly window: GuiWindowInfo;
};

/**
 * Resolve a locator against one observation. Throws `PanelError`
 * (`not-found` / `ambiguous` / `unproven`) — never guesses.
 */
export function resolvePanelTarget(input: {
  readonly pid: number;
  readonly state: GuiAppState;
  /** The pid's census rows; empty when the census could not run. */
  readonly census: readonly WindowServerWindow[];
  readonly locator: PanelLocator;
  readonly now?: () => Date;
}): PanelResolution {
  const { pid, state, census, locator } = input;
  const now = input.now ?? (() => new Date());

  // Locator by OS window number: the strongest handle. The census row
  // must belong to THIS pid — a number naming another process's window
  // is a wrong-target attempt, refused before any AX matching.
  if (locator.windowNumber !== undefined) {
    const ws = census.find((w) => w.windowNumber === locator.windowNumber);
    if (ws === undefined) {
      throw new PanelError(
        "not-found",
        `no WindowServer window numbered ${locator.windowNumber} is visible to the census ` +
          `(the census ${census.length === 0 ? "did not run" : `lists ${census.length} window(s) for pid ${pid}`})`,
      );
    }
    if (ws.pid !== pid) {
      throw new PanelError(
        "unproven",
        `window ${locator.windowNumber} belongs to pid ${ws.pid} (${ws.owner}), not the target pid ${pid}; ` +
          "refusing to treat it as this After Effects instance's panel",
      );
    }
    const ax = state.windows.find(
      (w) => w.frame != null && ws.bounds !== null && framesMatch(w.frame, ws.bounds),
    );
    if (ax === undefined) {
      throw new PanelError(
        "not-found",
        `window ${locator.windowNumber} exists in the window census but no Accessibility ` +
          "window accounts for its frame — it cannot be addressed for resize; " +
          "this is the docked/AX-invisible shape, reported rather than guessed" +
          axSuspectHint(state),
      );
    }
    return buildTarget(pid, state, census, locator, ax, now());
  }

  // Locator by AX attributes. Candidates must carry a frame: a panel
  // operation needs geometry, and a frameless entry cannot be measured,
  // resized or captured honestly.
  const candidates = state.windows
    .map((window, index) => ({ window, index: index + 1 }))
    .filter(({ window }) => window.frame != null && locatorMatches(window, locator));

  if (candidates.length === 0) {
    throw new PanelError(
      "not-found",
      `no attributed window of pid ${pid} matched the locator ` +
        `${JSON.stringify(locator)} (${state.windows.length} window(s) observed)` +
        axSuspectHint(state),
    );
  }
  if (candidates.length > 1) {
    throw new PanelError(
      "ambiguous",
      `${candidates.length} windows of pid ${pid} matched the locator ` +
        `${JSON.stringify(locator)}; narrow it with title/role/subrole/windowNumber`,
      {
        candidates: candidates.map(({ window, index }) =>
          describeCandidate(window, index),
        ),
      },
    );
  }
  const only = candidates[0];
  if (only === undefined) {
    // Unreachable — candidates.length === 1 was checked — but never guess.
    throw new PanelError("not-found", "panel resolution produced no candidate");
  }
  return buildTarget(pid, state, census, locator, only.window, now(), only.index);
}

function buildTarget(
  pid: number,
  state: GuiAppState,
  census: readonly WindowServerWindow[],
  locator: PanelLocator,
  window: GuiWindowInfo,
  now: Date,
  windowIndex?: number,
): PanelResolution {
  const frame = window.frame;
  if (frame == null) {
    throw new PanelError(
      "not-found",
      "the matched window has no readable frame; it cannot be addressed as a panel",
    );
  }
  const { attribution, censusWindow } = attributePanelWindow(window, pid, census);
  // Prefer the listing's own attribution when the observation already
  // computed one — it used the same census but also saw windows this
  // function's filtered input may not carry. A defined value wins; an
  // absent one (census unavailable at listing time) stays "unproven".
  const resolvedAttribution: PanelAttribution =
    window.censusAttribution === "owned" ||
    window.censusAttribution === "foreign" ||
    window.censusAttribution === "unmatched"
      ? window.censusAttribution
      : attribution;
  const index =
    windowIndex ?? state.windows.findIndex((w) => w === window) + 1;
  const surface: PanelSurface = {
    kind: "window",
    windowIndex: index > 0 ? index : null,
    windowNumber: censusWindow?.windowNumber ?? null,
    locator,
    frame: toPanelFrame(frame),
    state: {
      onScreen: censusWindow?.onScreen ?? null,
      occluded: "unknown",
    },
    attribution: resolvedAttribution,
  };
  return {
    target: { pid, surface, resolvedAt: now.toISOString() },
    window,
  };
}
