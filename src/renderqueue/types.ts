/**
 * Render Queue observation contract (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3).
 *
 * The classic ExtendScript DOM exposes no render queue — `app.project`
 * has no queue readback (`unverified` whether a newer DOM or
 * `app.executeCommand` state helps; recorded, never assumed). The only
 * honest channel is the Render Queue panel's own AX subtree, reached
 * through the `docked-region` deep walk (#361). That makes every fact
 * this module reports a **limited oracle**: it proves what the AX tree
 * showed inside the pane's bounded walk, nothing more. A row count is
 * evidence about visible text rows — whether AE exposes one row per
 * queue item, and whether chrome text masquerades as rows, is a
 * real-host question this contract does not answer.
 *
 * Honesty rules carried from `src/panels/docked/`:
 *
 *   - Every observation re-walks; nothing caches a pane or a row.
 *   - `stale-locator` means the recorded `axPath` drifted — re-walk,
 *     never remap by guesswork.
 *   - Adding a comp to the queue goes through the gated menu invoke
 *     (#360); the bounded postcondition wait never resends (spec §10).
 */

import type { DockedPaneRow } from "../panels/docked/index.js";
import type { PanelTarget } from "../panels/types.js";

/**
 * The oracle level every Render Queue claim carries. `"limited"` is the
 * strongest honest answer today: AX-observed pane rows plus, when the
 * caller wires one, a capture artifact — never a DOM readback, because
 * none exists.
 */
export const RENDER_QUEUE_ORACLE = "limited" as const;
export type RenderQueueOracle = typeof RENDER_QUEUE_ORACLE;

/**
 * One visible row inside the Render Queue pane subtree. Structurally a
 * `DockedPaneRow` — the row's `axPath` is the re-resolution locator W3
 * records as evidence.
 */
export type RenderQueueItem = DockedPaneRow;

/** The walk evidence a snapshot rests on. */
export type RenderQueueWalkInfo = {
  readonly nodesKept: number;
  readonly truncated: boolean;
  readonly stopReason: "complete" | "depth" | "nodes" | "deadline";
  readonly scriptTruncated: boolean;
};

/**
 * One observation of the Render Queue pane: the resolved pane's visible
 * rows plus the bounded-walk evidence they came from.
 */
export type RenderQueueSnapshot = {
  readonly pid: number;
  /** The `docked-region` `PanelTarget` the pane resolved to. */
  readonly pane: PanelTarget;
  /** The pane node's recorded `axPath` — evidence, re-resolved per call. */
  readonly paneAxPath: string;
  readonly observedAt: string;
  readonly oracle: RenderQueueOracle;
  readonly items: readonly RenderQueueItem[];
  readonly walk: RenderQueueWalkInfo;
};

/** What `addViaMenu` proved about one menu-driven add attempt. */
export type RenderQueueAddResult = {
  /** The item count before the invoke and after the postcondition wait. */
  readonly before: number;
  readonly after: number;
  /** Rows that appeared between the two snapshots, in walk order. */
  readonly added: readonly RenderQueueItem[];
  readonly beforeSnapshot: RenderQueueSnapshot;
  readonly afterSnapshot: RenderQueueSnapshot;
  readonly oracle: RenderQueueOracle;
};

/** Stable refusal codes a caller may act on. */
export type RenderQueueErrorCode =
  /** The pane could not be resolved or the walk failed. */
  | "unavailable"
  /** No pane matched the locator. */
  | "not-found"
  /** More than one pane matched. */
  | "ambiguous"
  /** The pane exists but pid attribution is not "owned". */
  | "unproven"
  /** This platform/kind has no implementation. */
  | "unsupported"
  /** A recorded locator drifted; re-resolve before retrying. */
  | "stale-locator"
  /** A safety gate or policy refuses the operation now. */
  | "refused"
  /** The menu invoke or a postcondition wait ended unknown. */
  | "indeterminate";

export class RenderQueueError extends Error {
  readonly code: RenderQueueErrorCode;
  readonly candidates: readonly string[];

  constructor(
    code: RenderQueueErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "RenderQueueError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
