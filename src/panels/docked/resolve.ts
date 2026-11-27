/**
 * Docked-region pane resolution (#361, `specs/workspace-editing/spec.md`
 * §5/§6).
 *
 * A `docked-region` `PanelTarget` is a pane *inside* the main window's AX
 * tree — the Timeline, Comp or Render Queue area that has no window of its
 * own and is therefore invisible to both CGWindowList and the shallow
 * window listing. Resolution is two-stage and both stages are locator
 * re-resolution, never cached handles:
 *
 *   1. `pickDockedPaneParent` — which `GuiWindowInfo` the pane lives in.
 *      Same rules as `resolvePanelTarget`: the census attributes the
 *      window to the target pid before it can parent anything.
 *   2. `resolveDockedPane` — which node inside the bounded walk is the
 *      pane. The walk root's frame must still match the parent's frame
 *      (the script found the root by that frame), and the pane itself is
 *      found by hints or by a recorded `axPath`. Path drift, hint drift
 *      and frame drift all surface as `stale-locator` — the caller
 *      re-walks; nothing is guessed from coordinates.
 *
 * Fail-closed throughout: no matching pane, no readable frame, an
 * unattributed parent or an unbounded walk all refuse with a `PanelError`
 * code. There is no coordinate-fallback path in this module by design.
 */

import {
  framesMatch,
  type GuiAppState,
  type GuiWindowInfo,
} from "../../driver/gui-recovery.js";
import type { WindowServerWindow } from "../../platform/darwin/window-census.js";
import { attributePanelWindow } from "../resolve.js";
import {
  PanelError,
  type PanelAttribution,
  type PanelFrame,
  type PanelLocator,
  type PanelSurface,
  type PanelTarget,
} from "../types.js";
import {
  collectDescendants,
  resolveAxPath,
  type DockedAxNode,
} from "./ax-node.js";

/**
 * How a caller names the pane inside the parent window. Every field is a
 * re-resolution hint, never identity — the same rule `PanelLocator`
 * carries for windows. At least one of `pane`, `axPath` or `frame` must
 * narrow the search; an empty locator resolves to `ambiguous`, not to
 * "the first pane".
 */
export type DockedPaneLocator = {
  /**
   * Which window the pane lives in. Absent means "the only framed window
   * of the pid"; with several windows to choose from the result is
   * `ambiguous` — the caller names the parent, never a guess.
   */
  readonly parent?: PanelLocator;
  /** Pane identity hints matched against walked nodes. */
  readonly pane?: {
    readonly title?: string;
    readonly titleMatch?: "exact" | "contains";
    readonly role?: string;
    readonly subrole?: string;
  };
  /**
   * A previously recorded `axPath` (from an earlier resolution's
   * `pane.axPath`). Re-resolution verifies the node still carries the
   * recorded identity; drift is `stale-locator`, not a silent remap.
   */
  readonly axPath?: string;
  /**
   * Expected pane frame in global points — the census-frame bound the
   * spec asks the walk to honour. Matched with the same 4-point
   * tolerance the AX↔census reconciliation uses.
   */
  readonly frame?: PanelFrame;
};

/** The walk evidence a resolution rests on. */
export type DockedPaneWalkInfo = {
  readonly nodesKept: number;
  readonly truncated: boolean;
  readonly stopReason: "complete" | "depth" | "nodes" | "deadline";
  readonly scriptTruncated: boolean;
};

/** A resolved docked pane plus the internal evidence ops may need. */
export type DockedPaneResolution = {
  readonly target: PanelTarget;
  /** The resolved pane node — its `path` is the `axPath` to record. */
  readonly pane: DockedAxNode;
  /** The bounded walk the pane was found in (root = parent window element). */
  readonly tree: DockedAxNode;
  readonly parentWindow: GuiWindowInfo;
  /** 1-based index of the parent in the AX window listing. */
  readonly parentWindowIndex: number;
  readonly walk: DockedPaneWalkInfo;
};

/** The parent window a docked pane was found under. */
export type DockedPaneParent = {
  readonly window: GuiWindowInfo;
  readonly index: number;
  readonly attribution: PanelAttribution;
  readonly censusWindow: WindowServerWindow | null;
};

function describeWindowCandidate(window: GuiWindowInfo, index: number): string {
  const frame = window.frame;
  const geometry =
    frame === null || frame === undefined
      ? "no-frame"
      : `${Math.round(frame.x)},${Math.round(frame.y)} ${Math.round(frame.width)}x${Math.round(frame.height)}`;
  return `#${index} "${window.title}" role=${window.role} subrole=${window.subrole ?? "-"} ${geometry}`;
}

function parentLocatorMatches(window: GuiWindowInfo, locator: PanelLocator): boolean {
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
 * Stage 1: pick the window a docked pane lives in. Frameless windows are
 * never candidates — a pane needs geometry to be bounded against the
 * census frame. `windowNumber` locators go through the census first, the
 * same strongest-handle rule `resolvePanelTarget` applies.
 */
export function pickDockedPaneParent(input: {
  readonly pid: number;
  readonly state: GuiAppState;
  readonly census: readonly WindowServerWindow[];
  readonly locator?: PanelLocator;
}): DockedPaneParent {
  const { pid, state, census, locator } = input;

  if (locator?.windowNumber !== undefined) {
    const ws = census.find((w) => w.windowNumber === locator.windowNumber);
    if (ws === undefined) {
      throw new PanelError(
        "not-found",
        `no WindowServer window numbered ${locator.windowNumber} is visible to the census`,
      );
    }
    if (ws.pid !== pid) {
      throw new PanelError(
        "unproven",
        `window ${locator.windowNumber} belongs to pid ${ws.pid} (${ws.owner}), not the target pid ${pid}`,
      );
    }
    const ax = state.windows.find(
      (w) =>
        w.frame != null &&
        ws.bounds !== null &&
        framesMatch(w.frame, ws.bounds) &&
        parentLocatorMatches(w, locator),
    );
    const index = ax === undefined ? -1 : state.windows.indexOf(ax);
    if (ax === undefined || index < 0 || ax.frame == null) {
      throw new PanelError(
        "not-found",
        `window ${locator.windowNumber} exists in the census but no framed Accessibility ` +
          "window both matches its frame and the locator — it cannot parent a docked pane",
      );
    }
    const { attribution, censusWindow } = attributePanelWindow(ax, pid, census);
    const resolvedAttribution: PanelAttribution =
      ax.censusAttribution === "owned" ||
      ax.censusAttribution === "foreign" ||
      ax.censusAttribution === "unmatched"
        ? ax.censusAttribution
        : attribution;
    return { window: ax, index: index + 1, attribution: resolvedAttribution, censusWindow };
  }

  const candidates = state.windows
    .map((window, index) => ({ window, index: index + 1 }))
    .filter(
      ({ window }) =>
        window.frame != null &&
        (locator === undefined || parentLocatorMatches(window, locator)),
    );

  if (candidates.length === 0) {
    throw new PanelError(
      "not-found",
      `no framed window of pid ${pid} can parent a docked pane ` +
        `(locator ${JSON.stringify(locator ?? {})}; ${state.windows.length} window(s) observed)`,
    );
  }
  if (candidates.length > 1) {
    throw new PanelError(
      "ambiguous",
      `${candidates.length} windows of pid ${pid} could parent a docked pane; ` +
        "name the parent with locator.parent (title/role/subrole/windowNumber)",
      {
        candidates: candidates.map(({ window, index }) =>
          describeWindowCandidate(window, index),
        ),
      },
    );
  }
  const only = candidates[0];
  if (only === undefined) {
    throw new PanelError("not-found", "parent resolution produced no candidate");
  }
  const { attribution, censusWindow } = attributePanelWindow(only.window, pid, census);
  const resolvedAttribution: PanelAttribution =
    only.window.censusAttribution === "owned" ||
    only.window.censusAttribution === "foreign" ||
    only.window.censusAttribution === "unmatched"
      ? only.window.censusAttribution
      : attribution;
  return {
    window: only.window,
    index: only.index,
    attribution: resolvedAttribution,
    censusWindow,
  };
}

function paneHintsMatch(node: DockedAxNode, locator: DockedPaneLocator): boolean {
  const pane = locator.pane;
  if (pane === undefined) {
    return locator.axPath === undefined && locator.frame === undefined
      ? false // an empty locator must never match everything
      : true;
  }
  if (pane.title !== undefined) {
    const title = node.title ?? "";
    const ok =
      pane.titleMatch === "contains" ? title.includes(pane.title) : title === pane.title;
    if (!ok) {
      return false;
    }
  }
  if (pane.role !== undefined && node.role !== pane.role) {
    return false;
  }
  if (pane.subrole !== undefined && node.subrole !== pane.subrole) {
    return false;
  }
  return true;
}

function paneFrameMatches(node: DockedAxNode, locator: DockedPaneLocator): boolean {
  if (locator.frame === undefined) {
    return true;
  }
  // A frame locator can only be honoured by a node that exposes geometry;
  // a frameless node cannot prove it still sits where the caller bound it.
  return node.frame !== null && framesMatch(node.frame, locator.frame);
}

function stale(message: string): PanelError {
  return new PanelError("stale-locator", message);
}

/**
 * Stage 2: resolve the pane inside an already-bounded walk. `tree` is the
 * `boundAxTree` output whose root is the parent window element; its root
 * frame must still match the parent's AX frame — a mismatch means the
 * walk describes a different window than the census-attributed one, and
 * the honest answer is `unproven`, not a pane found in the wrong tree.
 */
export function resolveDockedPane(input: {
  readonly pid: number;
  readonly parent: DockedPaneParent;
  readonly tree: DockedAxNode;
  readonly walk: DockedPaneWalkInfo;
  readonly locator: DockedPaneLocator;
  readonly now?: () => Date;
}): DockedPaneResolution {
  const { pid, parent, tree, walk, locator } = input;
  const now = input.now ?? (() => new Date());
  const parentFrame = parent.window.frame;

  if (tree.frame === null || parentFrame == null) {
    throw new PanelError(
      "unproven",
      "the walk root or the parent window has no readable frame; the AX " +
        "subtree cannot be proven to belong to the census-attributed window",
    );
  }
  if (!framesMatch(tree.frame, parentFrame)) {
    throw new PanelError(
      "unproven",
      `the walked AX root frame ${JSON.stringify(tree.frame)} does not match the ` +
        `parent window's frame ${JSON.stringify(parentFrame)}; the subtree may belong ` +
        "to a different surface — refusing to resolve a pane inside it",
    );
  }

  let pane: DockedAxNode | null = null;
  if (locator.axPath !== undefined) {
    const node = resolveAxPath(tree, locator.axPath);
    if (node === null || node.path === tree.path) {
      throw stale(
        `the recorded axPath "${locator.axPath}" no longer resolves inside the ` +
          `walked window subtree (${tree.path === "0" ? "root" : tree.path}); ` +
          "the pane's position in the AX tree drifted — re-walk without axPath",
      );
    }
    // Drift checks: a path that still exists but now names a different
    // element is exactly the stale-locator case the spec calls out.
    if (locator.pane !== undefined && !paneHintsMatch(node, locator)) {
      throw stale(
        `axPath "${locator.axPath}" resolves but its identity drifted ` +
          `(role=${node.role} title=${JSON.stringify(node.title)}); re-walk`,
      );
    }
    if (!paneFrameMatches(node, locator)) {
      throw stale(
        `axPath "${locator.axPath}" resolves but its frame no longer matches ` +
          "the recorded bound; re-walk",
      );
    }
    pane = node;
  } else {
    const candidates = collectDescendants(tree).filter(
      (node) => paneHintsMatch(node, locator) && paneFrameMatches(node, locator),
    );
    if (candidates.length === 0) {
      throw new PanelError(
        "not-found",
        `no node inside the walked window subtree matched the pane locator ` +
          `${JSON.stringify(locator.pane ?? {})}` +
          `${locator.frame !== undefined ? " and frame bound" : ""}` +
          ` (${walk.nodesKept} node(s) walked${walk.truncated ? ", truncated" : ""})`,
      );
    }
    if (candidates.length > 1) {
      throw new PanelError(
        "ambiguous",
        `${candidates.length} nodes inside the walked window subtree matched the ` +
          "pane locator; narrow it with pane.title/role/subrole, frame, or a recorded axPath",
        {
          candidates: candidates.slice(0, 16).map(
            (node) =>
              `${node.path} role=${node.role} title=${JSON.stringify(node.title)}` +
              `${node.frame === null ? " no-frame" : ""}`,
          ),
        },
      );
    }
    const only = candidates[0];
    if (only === undefined) {
      throw new PanelError("not-found", "pane resolution produced no candidate");
    }
    pane = only;
  }

  if (pane.frame === null) {
    throw new PanelError(
      "not-found",
      `the matched pane (axPath "${pane.path}", role=${pane.role}) exposes no ` +
        "AX frame; a docked region without geometry cannot be bounded or " +
        "captured honestly — reported, not guessed",
    );
  }

  const surfaceLocator: PanelLocator = {
    ...(pane.title === null ? {} : { title: pane.title }),
    ...(pane.role === "" ? {} : { role: pane.role }),
    ...(pane.subrole === null ? {} : { subrole: pane.subrole }),
  };
  const surface: PanelSurface = {
    kind: "docked-region",
    // The pane lives inside the parent's AX listing position; it is not a
    // window, so there is no window number to capture by.
    windowIndex: parent.index,
    windowNumber: null,
    locator: surfaceLocator,
    frame: pane.frame,
    state: {
      onScreen: parent.censusWindow?.onScreen ?? null,
      occluded: "unknown",
    },
    attribution: parent.attribution,
  };

  return {
    target: {
      pid,
      surface,
      resolvedAt: now().toISOString(),
    },
    pane,
    tree,
    parentWindow: parent.window,
    parentWindowIndex: parent.index,
    walk,
  };
}
