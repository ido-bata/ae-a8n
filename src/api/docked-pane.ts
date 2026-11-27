/**
 * Public docked-pane API (#361, `specs/workspace-editing/spec.md` §6/§7).
 *
 * `ae.dockedPane(locator)` resolves a `docked-region` panel — a pane
 * inside the main window's AX tree (Timeline, Comp, Render Queue) that
 * has no window of its own and is invisible to the window census. Every
 * method runs the observe-class contract: fresh AX listing + census +
 * bounded subtree walk + pane re-resolution. Nothing here mutates, takes
 * the GUI lease, or guesses from coordinates.
 *
 * Honesty rules carried from `ae.panel()`/`ae.guiState()`:
 *
 *   - No owned, attested target → every operation reports `unavailable`.
 *   - macOS only: the walk vehicle is the `AX_PANE_WALK_SCRIPT`
 *     AppleScript through System Events; Windows reports `unsupported`.
 *   - A recorded `axPath` that drifted is `stale-locator` — re-resolve
 *     without it; the API never remaps a stale path by guesswork.
 *   - Real-host AX fidelity of docked panes is **unverified** (spec §7):
 *     the implementation is `automated test` against scripted fake AX
 *     trees until a real-host lane measures what AE actually exposes.
 */

import {
  AX_PANE_WALK_SCRIPT,
  DockedPaneObserver,
  type DockedPaneBounds,
  type DockedPaneLocator,
  type DockedPaneOps,
  type DockedPaneResolution,
  type DockedPaneRow,
  type DockedPaneTree,
} from "../panels/docked/index.js";
import { PanelError } from "../panels/types.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";

export type {
  DockedPaneBounds,
  DockedPaneLocator,
  DockedPaneOps,
  DockedPaneResolution,
  DockedPaneRow,
  DockedPaneTree,
} from "../panels/docked/index.js";
export { DockedPaneObserver } from "../panels/docked/index.js";

/** Seams the production adapter needs; mirrors `PanelSeams` minus mutation. */
export type DockedPaneSeams = GuiObservationSeams & {
  readonly bounds?: DockedPaneBounds;
};

/**
 * Bind the platform-neutral observer to the macOS GUI recovery. One
 * `MacGuiRecovery` view serves observation (console session allowed,
 * like `ae.guiState()`): the walk is read-only AX attribute reads inside
 * the target session.
 */
function macDockedPaneOps(
  target: GuiObservationTarget,
  seams: DockedPaneSeams,
): DockedPaneOps {
  const { bounds: _bounds, ...guiSeams } = seams;
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    // Observe-class only: the console-session refusal guards mutations,
    // and a read-only AX walk cannot move the user's cursor or focus.
    allowConsoleSession: true,
    ...guiSeams,
  };
  const observer = new MacGuiRecovery(base);
  const frameArg = (frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): string =>
    [frame.x, frame.y, frame.width, frame.height]
      .map((value) => String(Math.round(value)))
      .join(",");
  return {
    observe: () => observer.listWindows(),
    censusWindows: () => {
      const view = observer.windowServerWindows();
      return {
        available: view.available,
        reason: view.reason,
        windows: view.windows,
      };
    },
    walkPane: (request) =>
      observer.accessibilityQuery(
        AX_PANE_WALK_SCRIPT,
        [
          String(target.pid),
          frameArg(request.parentFrame),
          String(request.maxDepth),
          String(request.maxNodes),
          String(request.maxSeconds),
        ],
        "docked-pane-walk",
      ),
  };
}

/**
 * A resolved docked pane of the session's owned After Effects. Every
 * method re-observes and re-resolves the bound locator — a `DockedPane`
 * is a locator, not a handle, so a re-dock or a rebuilt panel is
 * re-proven or refused (`stale-locator`) rather than silently retargeted.
 */
export class DockedPane {
  readonly #observer: DockedPaneObserver;
  readonly #locator: DockedPaneLocator;

  constructor(observer: DockedPaneObserver, locator: DockedPaneLocator) {
    this.#observer = observer;
    this.#locator = locator;
  }

  /**
   * Resolve the locator against the live screen: parent window, bounded
   * AX walk, pane node. Returns the `PanelTarget` (`kind:
   * "docked-region"`) plus the pane node whose `path` is the `axPath`
   * to record for later re-resolution.
   */
  identify(): Promise<DockedPaneResolution> {
    return Promise.resolve().then(() => this.#observer.identify(this.#locator));
  }

  /** The bounded walked subtree the pane was resolved in — walk evidence. */
  tree(): Promise<DockedPaneTree> {
    return Promise.resolve().then(() => this.#observer.tree(this.#locator));
  }

  /**
   * The visible row identities inside the resolved pane: layer-name text
   * plus walk-order ordinal, each carrying its `axPath` — the read
   * surface W2/W3 build row locators on.
   */
  rows(): Promise<DockedPaneRow[]> {
    return Promise.resolve().then(() => this.#observer.rows(this.#locator));
  }
}

/**
 * The `ae.dockedPane()` body: attest the owned target, refuse unsupported
 * platforms, and bind the observer. `target === null` means no owned
 * pid/session is provable — same fail-closed shape as `panelForTarget`.
 */
export function dockedPaneForTarget(
  target: GuiObservationTarget | null,
  locator: DockedPaneLocator,
  seams: DockedPaneSeams = {},
): DockedPane {
  if (target === null) {
    throw new PanelError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window list to resolve a docked pane against",
    );
  }
  if (process.platform !== "darwin") {
    throw new PanelError(
      "unsupported",
      `docked-pane observation is implemented for macOS only; platform is ${process.platform}`,
    );
  }
  const ops = macDockedPaneOps(target, seams);
  const observer = new DockedPaneObserver({
    pid: target.pid,
    ops,
    ...(seams.bounds === undefined ? {} : { bounds: seams.bounds }),
  });
  return new DockedPane(observer, locator);
}
