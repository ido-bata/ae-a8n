/**
 * Docked-pane observer (#361, `specs/workspace-editing/spec.md` §5/§7).
 *
 * The `observe`-class orchestration half: resolve the parent window,
 * run the bounded AX walk inside its subtree, bound the result again on
 * this side, and resolve the pane — or refuse with a `PanelError` code.
 * Every public method re-observes; a `DockedPaneObserver` is a locator,
 * not a handle, matching the panel contract's re-resolution rule.
 *
 * Safety shape, mirroring `PanelController`:
 *
 *   - Observation failures become `PanelError("unavailable")`; a census
 *     that cannot run degrades attribution honestly instead of crashing.
 *   - The walk vehicle is injected (`DockedPaneOps.walkPane`), so tests
 *     run against scripted fake AX trees and production binds the
 *     `AX_PANE_WALK_SCRIPT` AppleScript — no After Effects required.
 *   - Bounds are enforced twice: the script caps depth/nodes/seconds
 *     while it runs, and `boundAxTree` re-applies them to whatever the
 *     vehicle returned, so a scripted tree cannot smuggle an unbounded
 *     walk past the contract.
 */

import type { GuiAppState, GuiFrame } from "../../driver/gui-recovery.js";
import type { WindowServerWindow } from "../../platform/darwin/window-census.js";
import { PanelError } from "../types.js";
import {
  boundAxTree,
  enumeratePaneRows,
  type BoundedAxTree,
  type DockedPaneRow,
} from "./ax-node.js";
import { parsePaneWalkReport, type PaneWalkReport } from "./ax-script.js";
import {
  pickDockedPaneParent,
  resolveDockedPane,
  type DockedPaneLocator,
  type DockedPaneParent,
  type DockedPaneResolution,
  type DockedPaneWalkInfo,
} from "./resolve.js";

/** The census view the resolver needs; mirrors `PanelCensusView`. */
export type DockedPaneCensusView = {
  readonly available: boolean;
  readonly reason: string | null;
  readonly windows: readonly WindowServerWindow[];
};

/** One bounded walk request handed to the platform vehicle. */
export type DockedPaneWalkRequest = {
  /** The parent window's frame — how the script finds the walk root. */
  readonly parentFrame: GuiFrame;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxSeconds: number;
};

/**
 * Every OS touch the observer needs, injected. The production adapter
 * (`src/api/docked-pane.ts`) binds these to `MacGuiRecovery`; tests bind
 * fakes. `walkPane` returns the script's raw line report.
 */
export type DockedPaneOps = {
  /** One Accessibility+WindowServer observation of the target pid. */
  observe(): GuiAppState;
  /** The pid's census rows; `available:false` when the census cannot run. */
  censusWindows(): DockedPaneCensusView;
  /**
   * The bounded pane walk for the window occupying `parentFrame`, inside
   * the target session. Observe-class: read-only AX attribute reads.
   */
  walkPane(request: DockedPaneWalkRequest): string;
};

/** The walk bounds, shared by the script args and the TS re-bound. */
export type DockedPaneBounds = {
  /** Deepest emitted node level; the window root is depth 0. Default 14. */
  readonly maxDepth?: number;
  /** Node cap for one pane subtree. Default 800. */
  readonly maxNodes?: number;
  /** Wall-clock cap inside the script, seconds. Default 20. */
  readonly maxSeconds?: number;
};

export const DEFAULT_DOCKED_PANE_BOUNDS = {
  maxDepth: 14,
  maxNodes: 800,
  maxSeconds: 20,
} as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPanelError(error: unknown): PanelError {
  if (error instanceof PanelError) {
    return error;
  }
  return new PanelError("unavailable", errorText(error), { cause: error });
}

export type DockedPaneObserverOptions = {
  readonly pid: number;
  readonly ops: DockedPaneOps;
  readonly bounds?: DockedPaneBounds;
  readonly now?: () => Date;
  /** Millisecond clock seam forwarded to `boundAxTree`'s deadline. */
  readonly clock?: () => number;
};

/** What `tree()` returns: the resolution plus the bounded walk evidence. */
export type DockedPaneTree = DockedPaneResolution & {
  readonly bounded: BoundedAxTree;
};

export class DockedPaneObserver {
  readonly #pid: number;
  readonly #ops: DockedPaneOps;
  readonly #bounds: { maxDepth: number; maxNodes: number; maxSeconds: number };
  readonly #now: () => Date;
  readonly #clock: () => number;

  constructor(options: DockedPaneObserverOptions) {
    this.#pid = options.pid;
    this.#ops = options.ops;
    this.#bounds = {
      maxDepth: options.bounds?.maxDepth ?? DEFAULT_DOCKED_PANE_BOUNDS.maxDepth,
      maxNodes: options.bounds?.maxNodes ?? DEFAULT_DOCKED_PANE_BOUNDS.maxNodes,
      maxSeconds: options.bounds?.maxSeconds ?? DEFAULT_DOCKED_PANE_BOUNDS.maxSeconds,
    };
    this.#now = options.now ?? (() => new Date());
    this.#clock = options.clock ?? (() => Date.now());
  }

  /**
   * One full observe pass: AX state + census + bounded walk + pane
   * resolution. Throws `PanelError` — `unavailable` when observation
   * itself fails, `not-found`/`ambiguous`/`unproven`/`stale-locator` for
   * the resolution outcomes.
   */
  #observe(locator: DockedPaneLocator): DockedPaneTree {
    let state: GuiAppState;
    try {
      state = this.#ops.observe();
    } catch (error) {
      throw asPanelError(error);
    }
    let census: DockedPaneCensusView;
    try {
      census = this.#ops.censusWindows();
    } catch (error) {
      census = {
        available: false,
        reason: `window census failed: ${errorText(error)}`,
        windows: [],
      };
    }
    const parent: DockedPaneParent = pickDockedPaneParent({
      pid: this.#pid,
      state,
      census: census.available ? census.windows : [],
      ...(locator.parent === undefined ? {} : { locator: locator.parent }),
    });
    const parentFrame = parent.window.frame;
    if (parentFrame == null) {
      // pickDockedPaneParent only returns framed windows; this is a
      // defensive re-check, never a path that guesses geometry.
      throw new PanelError("not-found", "the resolved parent window lost its frame");
    }

    let reportText: string;
    try {
      reportText = this.#ops.walkPane({
        parentFrame,
        maxDepth: this.#bounds.maxDepth,
        maxNodes: this.#bounds.maxNodes,
        maxSeconds: this.#bounds.maxSeconds,
      });
    } catch (error) {
      throw asPanelError(error);
    }
    const report: PaneWalkReport = parsePaneWalkReport(reportText);
    if (report.kind !== "walked") {
      throw new PanelError(
        report.kind === "missing"
          ? "unavailable"
          : report.kind === "ambiguous-root"
            ? "ambiguous"
            : "not-found",
        `the docked-pane walk of pid ${this.#pid} reported "${report.kind}"` +
          (report.kind === "ambiguous-root"
            ? ": more than one window-shaped element occupies the parent's frame"
            : report.kind === "no-root"
              ? ": no window-shaped AX element matches the parent frame"
              : report.kind === "bad-frame"
                ? ": the walk request itself was malformed"
                : ""),
      );
    }

    // Re-apply the bounds on this side: the script caps while it runs,
    // but the contract is enforced here too so a scripted or future
    // vehicle cannot return more than was asked for.
    const bounded = boundAxTree(report.root, {
      maxDepth: this.#bounds.maxDepth,
      maxNodes: this.#bounds.maxNodes,
      deadlineMs: this.#bounds.maxSeconds * 1000,
      now: this.#clock,
    });
    const walk: DockedPaneWalkInfo = {
      nodesKept: bounded.nodesKept,
      truncated: bounded.truncated || report.scriptTruncated,
      stopReason: bounded.stopReason,
      scriptTruncated: report.scriptTruncated,
    };

    const resolution = resolveDockedPane({
      pid: this.#pid,
      parent,
      tree: bounded.root,
      walk,
      locator,
      now: this.#now,
    });
    return { ...resolution, bounded };
  }

  /** Resolve the pane; returns the target plus walk evidence. Observe-class. */
  identify(locator: DockedPaneLocator): DockedPaneResolution {
    const { bounded: _bounded, ...resolution } = this.#observe(locator);
    return resolution;
  }

  /** The bounded subtree the pane was resolved in — evidence for callers. */
  tree(locator: DockedPaneLocator): DockedPaneTree {
    return this.#observe(locator);
  }

  /**
   * The visible row identities inside the resolved pane — the read
   * surface W2 (timeline rows) and W3 (RQ items) build locators on:
   * layer-name text plus walk-order ordinal, each with its `axPath`.
   */
  rows(locator: DockedPaneLocator): DockedPaneRow[] {
    const resolution = this.#observe(locator);
    return enumeratePaneRows(resolution.pane);
  }
}
