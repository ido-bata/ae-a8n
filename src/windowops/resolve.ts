/**
 * Window-ops target resolution (#366).
 *
 * The window-ops observation (`WindowOpsListing`) and the panel
 * observation (`GuiAppState`) describe the same AX windows through
 * different scripts. This module bridges them honestly: the listing is
 * converted into the `GuiWindowInfo` shape `assessGuiObservation` +
 * `resolvePanelTarget` already arbitrate — census attribution, ambiguity
 * and owned-only mutation evidence are reused verbatim rather than
 * re-implemented here.
 */

import {
  assessGuiObservation,
  framesMatch,
  type GuiAppState,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { attributePanelWindow, resolvePanelTarget, type PanelResolution } from "../panels/resolve.js";
import {
  PanelError,
  type PanelLocator,
  type PanelSurface,
  type PanelTarget,
} from "../panels/types.js";
import type {
  WindowOpsCensusView,
  WindowOpsFocusedWindow,
  WindowOpsListing,
  WindowOpsWindowInfo,
} from "./types.js";

/** Which resolution path produced the target. */
export type WindowOpsResolutionKind = "ax-windows" | "focused-window";

/** The resolved target plus the window-ops state row it maps to. */
export type WindowOpsResolution = {
  readonly target: PanelTarget;
  /**
   * The `WindowOpsWindowInfo` at the resolved listing index — the AX
   * attributes (miniaturized/main/focused) `GuiWindowInfo` does not
   * carry. `null` only when the listings disagree, which cannot happen
   * by construction but is never guessed past. For `"focused-window"`
   * resolutions `index` is `0`: the row is synthesized from
   * AXFocusedWindow, not from the window enumeration.
   */
  readonly info: WindowOpsWindowInfo | null;
  readonly resolution: WindowOpsResolutionKind;
};

/**
 * Convert a `WindowOpsListing` into the `GuiAppState` the panel
 * resolver consumes. `frontmost` is derived from the listing's own
 * `frontmostPid` — the same evidence `assessGuiObservation` receives
 * from the window listing's FRONTMOST record.
 */
export function windowOpsGuiState(
  listing: WindowOpsListing,
  pid: number,
): GuiAppState {
  const windows: GuiWindowInfo[] = listing.windows.map((w) => ({
    title: w.title,
    role: w.role,
    subrole: w.subrole,
    buttons: [],
    texts: [],
    ...(w.frame === null
      ? {}
      : {
          frame: {
            x: w.frame.x,
            y: w.frame.y,
            width: w.frame.width,
            height: w.frame.height,
          },
        }),
  }));
  return assessGuiObservation(
    pid,
    listing.frontmostPid === pid,
    windows,
    // The census the observation itself cannot see is supplied by the
    // caller — `resolveWindowTarget` re-resolves against the real census
    // rows, so this placeholder keeps `assessGuiObservation` honest about
    // what it does NOT know: `available:false` degrades every
    // `censusAttribution` to absent ("unproven" downstream) until the
    // real census joins in.
    {
      available: false,
      reason:
        "attribution is resolved against the real census by the caller",
    },
  );
}

/**
 * Every locator field the focused window must satisfy. `windowNumber`
 * is handled separately (it names a census row, not an AX attribute);
 * the AX-attribute fields are checked against the focused window's own
 * title/role/subrole — a mismatch means the caller's identity evidence
 * describes a different window than the one holding focus, which is a
 * refusal, never a remap.
 */
function focusedLocatorMatches(
  window: WindowOpsFocusedWindow,
  locator: PanelLocator,
): boolean {
  if (locator.title !== undefined) {
    const ok =
      locator.titleMatch === "contains"
        ? window.title.includes(locator.title)
        : window.title === locator.title;
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

/**
 * Resolve through the app's AXFocusedWindow — the only window After
 * Effects vends on hosts where the AX enumeration returns nothing
 * (#406, verified on real host: `docs/evidence/realhost-2026-11-27/`).
 *
 * Observe-class by contract: this path produces a `PanelTarget` for
 * `state()`-style reads only. It is reachable solely through the
 * caller's explicit `focusedOnly` opt-in, and its hard limitation is
 * stated everywhere it surfaces: ONLY the focused window is
 * AX-reachable — unfocused windows cannot be resolved, enumerated or
 * mutated through this path, and a `windowNumber` naming an unfocused
 * window honestly reports not-found (the focused element's frame does
 * not match that census row).
 *
 * Identity chain, fail-closed at every step:
 *
 *   1. `listing.focusedWindow` must exist with a readable frame —
 *      otherwise there is no AX evidence at all.
 *   2. Every provided locator field must match the focused window.
 *   3. `locator.windowNumber`, when given, must name a census row of
 *      THIS pid whose bounds match the focused window's AX frame —
 *      the same census↔AX frame reconciliation every sibling surface
 *      uses (AX points == CGWindowList points, measured on real host).
 *   4. Census attribution is `attributePanelWindow`'s verdict, so a
 *      frame shared with a foreign pid degrades to `"unmatched"`,
 *      never `"owned"`.
 */
function resolveFocusedWindowTarget(input: {
  readonly pid: number;
  readonly listing: WindowOpsListing;
  readonly census: WindowOpsCensusView;
  readonly locator: PanelLocator;
  readonly now: () => Date;
}): WindowOpsResolution {
  const { pid, listing, census, locator, now } = input;
  const focused = listing.focusedWindow;
  if (focused === null || focused.frame === null) {
    throw new PanelError(
      "not-found",
      `pid ${pid} reports no AXFocusedWindow with a readable frame; on After ` +
        "Effects this attribute is the only window the AX tree vends (#406) " +
        "and unfocused windows are AX-unreachable — nothing can be resolved",
    );
  }
  if (!focusedLocatorMatches(focused, locator)) {
    throw new PanelError(
      "not-found",
      `the focused window of pid ${pid} does not match the locator ` +
        `${JSON.stringify(locator)} (focused window: "${focused.title}" ` +
        `role=${focused.role} subrole=${focused.subrole ?? "-"}); ` +
        "only the focused window is AX-reachable — an unfocused window " +
        "cannot be resolved through this path",
    );
  }

  const guiWindow: GuiWindowInfo = {
    title: focused.title,
    role: focused.role,
    subrole: focused.subrole,
    buttons: [],
    texts: [],
    frame: focused.frame,
  };
  const censusRows = census.available ? census.windows : [];
  const { attribution, censusWindow } = attributePanelWindow(
    guiWindow,
    pid,
    censusRows,
  );

  let windowNumber: number | null = censusWindow?.windowNumber ?? null;
  let onScreen: boolean | null = censusWindow?.onScreen ?? null;
  if (locator.windowNumber !== undefined) {
    if (!census.available) {
      throw new PanelError(
        "unproven",
        `window ${locator.windowNumber} cannot be verified: the WindowServer ` +
          `census did not run (${census.reason ?? "unavailable"}); the ` +
          "focused-window path cannot prove the AX element is that window",
      );
    }
    const ws = censusRows.find((w) => w.windowNumber === locator.windowNumber);
    if (ws === undefined) {
      throw new PanelError(
        "not-found",
        `no WindowServer window numbered ${locator.windowNumber} is visible ` +
          "to the census; it cannot be the focused window",
      );
    }
    if (ws.pid !== pid) {
      throw new PanelError(
        "unproven",
        `window ${locator.windowNumber} belongs to pid ${ws.pid} ` +
          `(${ws.owner}), not the target pid ${pid}; refusing to treat the ` +
          "focused window as it",
      );
    }
    if (ws.bounds === null || !framesMatch(focused.frame, ws.bounds)) {
      throw new PanelError(
        "not-found",
        `the focused window's AX frame does not match census window ` +
          `${locator.windowNumber}; either the named window is not focused ` +
          "(unfocused windows are AX-unreachable on AE, #406) or focus moved " +
          "between observation and resolution",
      );
    }
    windowNumber = locator.windowNumber;
    onScreen = ws.onScreen;
  }

  const surface: PanelSurface = {
    kind: "window",
    // No AX-listing index exists for the focused window — it was never
    // enumerated. `null` is the honest answer; nothing may address it
    // by index.
    windowIndex: null,
    windowNumber,
    locator,
    frame: focused.frame,
    state: { onScreen, occluded: "unknown" },
    attribution,
  };
  const info: WindowOpsWindowInfo = { index: 0, ...focused };
  return {
    target: { pid, surface, resolvedAt: now().toISOString() },
    info,
    resolution: "focused-window",
  };
}

/**
 * Resolve a `PanelLocator` against one window-ops observation plus the
 * WindowServer census. Throws `PanelError` (`not-found`/`ambiguous`/
 * `unproven`) — the same refusal vocabulary every sibling surface uses.
 *
 * `focusedOnly: true` selects the AXFocusedWindow path (#406) instead
 * of the window enumeration — the explicit opt-in for hosts where AE
 * vends no AX windows. It is observe-class evidence only; callers must
 * not wire a mutation vehicle through it.
 */
export function resolveWindowTarget(input: {
  readonly pid: number;
  readonly listing: WindowOpsListing;
  readonly census: WindowOpsCensusView;
  readonly locator: PanelLocator;
  readonly now?: () => Date;
  readonly focusedOnly?: boolean;
}): WindowOpsResolution {
  const { pid, listing, census, locator } = input;
  const now = input.now ?? (() => new Date());

  if (input.focusedOnly === true) {
    return resolveFocusedWindowTarget({ pid, listing, census, locator, now });
  }

  // First pass: GuiAppState with no census attribution (the placeholder
  // census above), then resolvePanelTarget against the REAL census —
  // `attributePanelWindow` inside it does the owned/foreign/unmatched
  // verdict the mutation gate depends on.
  const state = windowOpsGuiState(listing, pid);
  let resolution: PanelResolution;
  try {
    resolution = resolvePanelTarget({
      pid,
      state,
      census: census.available ? census.windows : [],
      locator,
      now,
    });
  } catch (error) {
    // Honest degradation (#406): the placeholder census above keeps
    // `assessGuiObservation` from flagging axSuspect, so a not-found on
    // an EMPTY listing gets the same explanation here — the pid's real
    // windows may be AX-invisible (AE vends no AXWindows at all) while
    // the census lists them. Only not-found is annotated; ambiguous/
    // unproven carry their own evidence.
    if (
      error instanceof PanelError &&
      error.code === "not-found" &&
      listing.windows.length === 0 &&
      census.available &&
      census.windows.some((w) => w.pid === pid)
    ) {
      throw new PanelError(
        "not-found",
        `${error.message} — note: the AX window listing is empty while ` +
          "the WindowServer census lists windows for this pid; the app " +
          "may not vend AX windows at all (After Effects, #406) — pass " +
          "focusedOnly to resolve the focused window through " +
          "AXFocusedWindow instead",
        { candidates: error.candidates },
      );
    }
    throw error;
  }

  // The resolved surface's 1-based windowIndex addresses this listing —
  // both come from the same enumeration order.
  const index = resolution.target.surface.windowIndex;
  const info =
    index === null ? null : (listing.windows[index - 1] ?? null);
  return { target: resolution.target, info, resolution: "ax-windows" };
}
