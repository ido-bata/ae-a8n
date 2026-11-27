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
  type GuiAppState,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { resolvePanelTarget, type PanelResolution } from "../panels/resolve.js";
import type { PanelLocator, PanelTarget } from "../panels/types.js";
import type {
  WindowOpsCensusView,
  WindowOpsListing,
  WindowOpsWindowInfo,
} from "./types.js";

/** The resolved target plus the window-ops state row it maps to. */
export type WindowOpsResolution = {
  readonly target: PanelTarget;
  /**
   * The `WindowOpsWindowInfo` at the resolved listing index — the AX
   * attributes (miniaturized/main/focused) `GuiWindowInfo` does not
   * carry. `null` only when the listings disagree, which cannot happen
   * by construction but is never guessed past.
   */
  readonly info: WindowOpsWindowInfo | null;
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
 * Resolve a `PanelLocator` against one window-ops observation plus the
 * WindowServer census. Throws `PanelError` (`not-found`/`ambiguous`/
 * `unproven`) — the same refusal vocabulary every sibling surface uses.
 */
export function resolveWindowTarget(input: {
  readonly pid: number;
  readonly listing: WindowOpsListing;
  readonly census: WindowOpsCensusView;
  readonly locator: PanelLocator;
  readonly now?: () => Date;
}): WindowOpsResolution {
  const { pid, listing, census, locator } = input;
  const now = input.now ?? (() => new Date());

  // First pass: GuiAppState with no census attribution (the placeholder
  // census above), then resolvePanelTarget against the REAL census —
  // `attributePanelWindow` inside it does the owned/foreign/unmatched
  // verdict the mutation gate depends on.
  const state = windowOpsGuiState(listing, pid);
  const resolution: PanelResolution = resolvePanelTarget({
    pid,
    state,
    census: census.available ? census.windows : [],
    locator,
    now,
  });

  // The resolved surface's 1-based windowIndex addresses this listing —
  // both come from the same enumeration order.
  const index = resolution.target.surface.windowIndex;
  const info =
    index === null ? null : (listing.windows[index - 1] ?? null);
  return { target: resolution.target, info };
}
