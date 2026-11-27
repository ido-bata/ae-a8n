/**
 * Render Queue pane observer (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3).
 *
 * The observe-class half: resolve the Render Queue `docked-region`
 * pane through the #361 bounded AX walk and enumerate its visible rows
 * as queue-item candidates. There is no DOM readback for the render
 * queue — this AX walk is the only channel, which is why every snapshot
 * is stamped `oracle: "limited"`.
 *
 * The orchestration delegates to `DockedPaneObserver` unchanged: the
 * same fresh listing + census + bounded walk + pane re-resolution runs
 * per call, and its `PanelError` codes map onto `RenderQueueError` so
 * callers see one vocabulary.
 */

import {
  DockedPaneObserver,
  enumeratePaneRows,
  type DockedPaneBounds,
  type DockedPaneLocator,
  type DockedPaneOps,
  type DockedPaneTree,
} from "../panels/docked/index.js";
import { PanelError } from "../panels/types.js";
import {
  RENDER_QUEUE_ORACLE,
  RenderQueueError,
  type RenderQueueSnapshot,
  type RenderQueueWalkInfo,
} from "./types.js";

export type RenderQueueObserverOptions = {
  readonly pid: number;
  /** The bounded-walk seams — production binds `MacGuiRecovery`. */
  readonly ops: DockedPaneOps;
  readonly bounds?: DockedPaneBounds;
  readonly now?: () => Date;
  readonly clock?: () => number;
};

function asRenderQueueError(error: unknown): RenderQueueError {
  if (error instanceof RenderQueueError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code =
      error.code === "not-found" ||
      error.code === "ambiguous" ||
      error.code === "unproven" ||
      error.code === "stale-locator" ||
      error.code === "refused" ||
      error.code === "indeterminate" ||
      error.code === "unsupported"
        ? error.code
        : "unavailable";
    return new RenderQueueError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new RenderQueueError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function walkInfo(tree: DockedPaneTree): RenderQueueWalkInfo {
  return {
    nodesKept: tree.walk.nodesKept,
    truncated: tree.walk.truncated,
    stopReason: tree.walk.stopReason,
    scriptTruncated: tree.walk.scriptTruncated,
  };
}

/**
 * One Render Queue pane's item observations. Every method re-observes;
 * the observer is a locator, not a handle — a re-dock or rebuilt panel
 * is re-proven or refused, matching the panel contract.
 */
export class RenderQueueObserver {
  readonly #observer: DockedPaneObserver;
  readonly #pid: number;
  readonly #now: () => Date;

  constructor(options: RenderQueueObserverOptions) {
    this.#observer = new DockedPaneObserver({
      pid: options.pid,
      ops: options.ops,
      ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.#pid = options.pid;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * One bounded-walk observation of the pane: the resolved `PanelTarget`,
   * the pane's recorded `axPath`, and every visible row as an item
   * candidate. Observe-class; throws `RenderQueueError`.
   */
  snapshot(locator: DockedPaneLocator): RenderQueueSnapshot {
    let tree: DockedPaneTree;
    try {
      tree = this.#observer.tree(locator);
    } catch (error) {
      throw asRenderQueueError(error);
    }
    return {
      pid: this.#pid,
      pane: tree.target,
      paneAxPath: tree.pane.path,
      observedAt: this.#now().toISOString(),
      oracle: RENDER_QUEUE_ORACLE,
      items: enumeratePaneRows(tree.pane),
      walk: walkInfo(tree),
    };
  }
}
