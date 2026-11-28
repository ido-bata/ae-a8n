/**
 * Docked-pane AX node model and bounded tree operations (#361,
 * `specs/workspace-editing/spec.md` §6/§7).
 *
 * A docked panel has no window of its own — it is a subtree inside the
 * main window's Accessibility tree, which the shallow `LIST_WINDOWS_SCRIPT`
 * deliberately does not walk (`gui-recovery.ts`: an AXLayoutArea's full
 * subtree is the whole application UI). This module is the pure half of
 * the deep walk: the node shape the bounded walk produces, the path
 * arithmetic `axPath` locators are built on, the depth/node/deadline
 * bounds that keep one pane's subtree from becoming a whole-tree walk,
 * and the visible-row enumeration W2/W3 build on.
 *
 * Everything here is platform-neutral and side-effect free: the same
 * functions run on a scripted fake tree in tests and on the parsed
 * output of `AX_PANE_WALK_SCRIPT` on a real host.
 */

import type { GuiFrame } from "../../driver/gui-recovery.js";

/**
 * One node of a bounded AX walk. `path` is the `axPath` locator
 * vocabulary: `"0"` is the walk root (the parent window element) and each
 * descendant appends its 1-based `UI elements` index — `"0.2.1"` is UI
 * element 1 of UI element 2 of the root. Paths are re-resolution hints
 * recorded as evidence, never durable identity: a dock move or a panel
 * re-dock changes them, which is exactly the `stale-locator` signal.
 */
export type DockedAxNode = {
  readonly path: string;
  /** 0 for the walk root; children are parent depth + 1. */
  readonly depth: number;
  readonly role: string;
  readonly subrole: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly value: string | null;
  /** Global screen frame in points when AX exposed one; `null` otherwise. */
  readonly frame: GuiFrame | null;
  readonly children: readonly DockedAxNode[];
};

/** A node with no children, for tests and partial-tree fixtures. */
export function axLeaf(over: Partial<DockedAxNode> = {}): DockedAxNode {
  return {
    path: "0",
    depth: 0,
    role: "AXGroup",
    subrole: null,
    title: null,
    description: null,
    value: null,
    frame: null,
    children: [],
    ...over,
  };
}

/** The child `axPath` of `parent` at 1-based UI-element `index`. */
export function axChildPath(parent: string, index: number): string {
  return `${parent}.${index}`;
}

/** The parent `axPath` of `path`, or `null` for the root `"0"`. */
export function axParentPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : path.slice(0, dot);
}

const AX_PATH_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Resolve an `axPath` against a walked tree. Returns `null` for a
 * malformed path, an out-of-range index, or a path that no longer exists
 * — the caller turns that into `stale-locator`, never a guess.
 */
export function resolveAxPath(root: DockedAxNode, path: string): DockedAxNode | null {
  if (!AX_PATH_PATTERN.test(path)) {
    return null;
  }
  const segments = path.split(".").map((segment) => Number(segment));
  if (segments.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }
  if (segments.length === 1 && segments[0] === 0) {
    return root.path === "0" ? root : null;
  }
  // Every segment after the root is a 1-based `UI elements` index.
  if (segments.slice(1).some((segment) => segment < 1)) {
    return null;
  }
  let node: DockedAxNode | undefined = root;
  for (const segment of segments.slice(1)) {
    node = node?.children[segment - 1];
    if (node === undefined) {
      return null;
    }
  }
  return node ?? null;
}

/** Every node under `root`, depth-first in emission order, root excluded. */
export function collectDescendants(root: DockedAxNode): DockedAxNode[] {
  const out: DockedAxNode[] = [];
  const visit = (node: DockedAxNode): void => {
    for (const child of node.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/**
 * Bounds a walked tree to one pane's worth of evidence. The production
 * walk script enforces the same limits while it runs; this pass is the
 * enforced contract on the TypeScript side — a scripted or future
 * vehicle that returns more than was asked for is pruned here, and the
 * result says so rather than silently keeping the overflow.
 *
 * Bounds:
 *
 *   - `maxDepth` — nodes deeper than this are dropped with their subtree;
 *     siblings at legal depth still resolve (depth is a per-branch prune,
 *     not a walk stop).
 *   - `maxNodes` — the walk stops emitting after this many kept nodes.
 *   - `deadlineMs`/`now` — a wall-clock budget checked between nodes; the
 *     seam exists so tests can prove the deadline without waiting.
 */
export type AxWalkBounds = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly deadlineMs?: number;
  /** Millisecond clock seam; defaults to `Date.now`. */
  readonly now?: () => number;
};

export type BoundedAxTree = {
  /** The pruned tree; identical in shape to the input when nothing was cut. */
  readonly root: DockedAxNode;
  /** Nodes actually kept. */
  readonly nodesKept: number;
  /** True when any input node was dropped — by depth, nodes or deadline. */
  readonly truncated: boolean;
  /**
   * Why the kept tree is incomplete: `"complete"` kept everything;
   * `"depth"` only depth-pruned branches (the walk itself finished);
   * `"nodes"`/`"deadline"` the walk stopped early globally.
   */
  readonly stopReason: "complete" | "depth" | "nodes" | "deadline";
};

export function boundAxTree(root: DockedAxNode, bounds: AxWalkBounds): BoundedAxTree {
  const now = bounds.now ?? (() => Date.now());
  const startedAt = now();
  let kept = 0;
  let depthPruned = false;
  let stopReason: "complete" | "nodes" | "deadline" = "complete";

  const deadlineHit = (): boolean => {
    if (bounds.deadlineMs === undefined) {
      return false;
    }
    return now() - startedAt > bounds.deadlineMs;
  };

  const copy = (node: DockedAxNode, depth: number): DockedAxNode | null => {
    if (stopReason !== "complete") {
      return null;
    }
    if (deadlineHit()) {
      stopReason = "deadline";
      return null;
    }
    if (kept >= bounds.maxNodes) {
      stopReason = "nodes";
      return null;
    }
    if (depth > bounds.maxDepth) {
      // Over-depth nodes are dropped whole — a pane walk reports the
      // subtree it could see, not a silently flattened version of it.
      // This is a per-branch prune: siblings at legal depth still resolve.
      depthPruned = true;
      return null;
    }
    kept += 1;
    const children: DockedAxNode[] = [];
    for (const child of node.children) {
      const bounded = copy(child, depth + 1);
      if (bounded === null) {
        if (stopReason !== "complete") {
          break;
        }
        // Depth-pruned child: skip it, keep walking the siblings.
        continue;
      }
      children.push(bounded);
    }
    return { ...node, children };
  };

  const boundedRoot = copy(root, root.depth);
  if (boundedRoot === null) {
    // The root itself was cut — only possible when maxNodes is 0, the
    // deadline already passed, or the root sits deeper than maxDepth.
    // Report an empty root rather than failing: resolution then finds no
    // pane, which is the honest not-found.
    const reason = stopReason !== "complete" ? stopReason : depthPruned ? "depth" : "nodes";
    return {
      root: { ...root, children: [] },
      nodesKept: 0,
      truncated: true,
      stopReason: reason,
    };
  }
  const reason =
    stopReason !== "complete" ? stopReason : depthPruned ? "depth" : "complete";
  return {
    root: boundedRoot,
    nodesKept: kept,
    truncated: reason !== "complete",
    stopReason: reason,
  };
}

/** The first non-empty human-readable text an AX node carries. */
export function nodeText(node: DockedAxNode): string | null {
  for (const candidate of [node.title, node.description, node.value]) {
    if (candidate !== null && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Roles counted as "rows" by default — the containers a timeline or
 * Render Queue list its entries in, plus the text leaf a row label
 * usually is. Callers (W2/W3) pass their own set when the measured AE
 * tree says otherwise; this default is deliberately narrow so unrelated
 * chrome text does not masquerade as rows.
 */
export const DEFAULT_ROW_ROLES: readonly string[] = [
  "AXRow",
  "AXCell",
  "AXStaticText",
  "AXTextField",
];

/** One visible row identity inside a pane subtree. */
export type DockedPaneRow = {
  /** 1-based ordinal in document (walk) order — the "row ordinal" half of row identity. */
  readonly ordinal: number;
  /** The node's `axPath`; combined with `text` this is the locator W2 re-resolves. */
  readonly axPath: string;
  readonly role: string;
  readonly subrole: string | null;
  /** The row's visible text (title, else description, else value). */
  readonly text: string;
  readonly frame: GuiFrame | null;
  readonly depth: number;
};

/**
 * Enumerate the visible row identities inside `root`'s subtree, in walk
 * order. A "row" is a node whose role is in `rowRoles` AND that carries
 * non-empty text — geometry alone cannot prove visibility (an off-screen
 * or clipped row still has a frame), so `frame` is evidence for the
 * caller, not a filter applied here.
 */
export function enumeratePaneRows(
  root: DockedAxNode,
  options: { readonly rowRoles?: readonly string[] } = {},
): DockedPaneRow[] {
  const roles = options.rowRoles ?? DEFAULT_ROW_ROLES;
  const rows: DockedPaneRow[] = [];
  const visit = (node: DockedAxNode): void => {
    const text = nodeText(node);
    if (text !== null && roles.includes(node.role)) {
      rows.push({
        ordinal: rows.length + 1,
        axPath: node.path,
        role: node.role,
        subrole: node.subrole,
        text,
        frame: node.frame,
        depth: node.depth,
      });
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return rows;
}
