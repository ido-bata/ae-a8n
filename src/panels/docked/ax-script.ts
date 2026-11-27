/**
 * The bounded docked-pane AX walk vehicle (#361,
 * `specs/workspace-editing/spec.md` §7 "docked-pane deep walk").
 *
 * `LIST_WINDOWS_SCRIPT` walks windows and dialog-shaped UI elements only —
 * an AXLayoutArea's full subtree is the whole application UI, so walking it
 * there would make every observation enormous. This script is the
 * *targeted* walk the spec asks for: it first identifies ONE window-shaped
 * `UI element` of the target process by the frame the census-attributed
 * `GuiWindowInfo` reported, then walks only that element's subtree, with
 * hard bounds on depth, node count and wall-clock seconds.
 *
 *   argv: pid, expectedFrame "x,y,w,h", maxDepth, maxNodes, maxSeconds
 *
 * Output is line-based and parsed by `parsePaneWalkReport`:
 *
 *   N|path|depth|role|subrole|title|description|value|x,y|w,h
 *   DONE|nodes=N|truncated=0|1
 *
 * Status-only outputs: MISSING (no such pid), BADFRAME (unparseable frame
 * argument), NOROOT (no window-shaped element matches the frame),
 * AMBIGUOUS (more than one does — never guessed).
 *
 * The script is `argv`-driven like every other script this repo sends:
 * nothing from the outside is spliced into AppleScript source. It is
 * read-only observation — it reads attributes and never performs an AX
 * action.
 */

import type { DockedAxNode } from "./ax-node.js";

export const AX_PANE_WALK_SCRIPT = [
  "on run argv",
  "  set targetPid to (item 1 of argv) as integer",
  "  set expectedFrame to item 2 of argv",
  "  set maxDepth to (item 3 of argv) as integer",
  "  set maxNodes to (item 4 of argv) as integer",
  "  set maxSeconds to (item 5 of argv) as integer",
  "  set startStamp to time of (current date)",
  "  tell application \"System Events\"",
  "    set procs to (every application process whose unix id is targetPid)",
  "    if (count of procs) is 0 then return \"MISSING\"",
  "    set p to item 1 of procs",
  // The walk root is identified by frame, the same evidence every other
  // AX↔census reconciliation in this repo uses (#321/#330): title and role
  // alone cannot tell two same-bundle-id instances apart.
  "    set AppleScript's text item delimiters to \",\"",
  "    set ef to text items of expectedFrame",
  "    set AppleScript's text item delimiters to \" \"",
  "    if (count of ef) is not 4 then return \"BADFRAME\"",
  "    set want to {(item 1 of ef) as integer, (item 2 of ef) as integer, (item 3 of ef) as integer, (item 4 of ef) as integer}",
  "    set matches to {}",
  "    repeat with e in UI elements of p",
  "      set erole to \"\"",
  "      try",
  "        set erole to (role of e) as string",
  "      end try",
  "      if erole is \"AXWindow\" or erole is \"AXLayoutArea\" or erole is \"AXSheet\" or erole is \"AXDialog\" or erole is \"AXSystemDialog\" then",
  "        set got to my a8nPaneFrame(e)",
  "        if got is not missing value then",
  "          if my a8nPaneFrameMatch(got, want) then set end of matches to e",
  "        end if",
  "      end if",
  "    end repeat",
  "    if (count of matches) is 0 then return \"NOROOT\"",
  "    if (count of matches) > 1 then return \"AMBIGUOUS\"",
  "    set state to {n:0, trunc:false}",
  "    set walked to my a8nPaneWalk(item 1 of matches, \"0\", 0, maxDepth, maxNodes, maxSeconds, startStamp, state)",
  "    set report to \"\"",
  "    repeat with ln in (rep of walked)",
  "      set report to report & ln & linefeed",
  "    end repeat",
  "    if (trunc of (state of walked)) is true then",
  "      set report to report & \"DONE|nodes=\" & (n of (state of walked)) & \"|truncated=1\"",
  "    else",
  "      set report to report & \"DONE|nodes=\" & (n of (state of walked)) & \"|truncated=0\"",
  "    end if",
  "    return report",
  "  end tell",
  "end run",
  // The recursive walk. `state` is threaded through return values because
  // AppleScript handlers cannot share mutable script state; `rep` is the
  // list of `N|` lines emitted so far, in pre-order.
  "on a8nPaneWalk(e, pathText, depth, maxDepth, maxNodes, maxSeconds, startStamp, state)",
  "  if (trunc of state) is true then return {rep:{}, state:state}",
  "  set nowStamp to time of (current date)",
  "  set elapsed to nowStamp - startStamp",
  "  if elapsed < 0 then set elapsed to elapsed + 86400",
  "  if elapsed > maxSeconds then return {rep:{}, state:{n:(n of state), trunc:true}}",
  "  set nodeCount to (n of state) + 1",
  "  if nodeCount > maxNodes then return {rep:{}, state:{n:(n of state), trunc:true}}",
  "  set state to {n:nodeCount, trunc:false}",
  "  set rep to {my a8nPaneLine(e, pathText, depth)}",
  // Children are only fetched while depth allows descent; a node AT
  // maxDepth is still emitted, its subtree is not.
  "  if depth < maxDepth then",
  "    set kids to {}",
  "    try",
  // `UI elements` is a suite class name, not a generic `of` reference —
  // it only compiles inside a tell block, so the handler re-enters the
  // same target explicitly (the caller's tell would reach it anyway).
  "      tell application \"System Events\"",
  "        set kids to UI elements of e",
  "      end tell",
  "    on error",
  "      set kids to {}",
  "    end try",
  "    set childIndex to 0",
  "    repeat with c in kids",
  "      set childIndex to childIndex + 1",
  "      set sub to my a8nPaneWalk(c, pathText & \".\" & childIndex, depth + 1, maxDepth, maxNodes, maxSeconds, startStamp, state)",
  "      set rep to rep & (rep of sub)",
  "      set state to (state of sub)",
  "      if (trunc of state) is true then exit repeat",
  "    end repeat",
  "  end if",
  "  return {rep:rep, state:state}",
  "end a8nPaneWalk",
  // One `N|path|depth|role|subrole|title|description|value|x,y|w,h` line.
  // Every free-text field goes through a8nPaneClean so a `|` or line break
  // inside a label cannot shift the field layout.
  "on a8nPaneLine(e, pathText, depth)",
  "  set erole to \"\"",
  "  try",
  "    set erole to (role of e) as string",
  "  end try",
  "  set esub to \"\"",
  "  try",
  "    set esub to (subrole of e) as string",
  "  end try",
  "  set etitle to \"\"",
  "  try",
  "    set etitle to (name of e) as string",
  "  end try",
  "  set edesc to \"\"",
  "  try",
  "    set edesc to (description of e) as string",
  "  end try",
  "  set evalue to \"\"",
  "  try",
  "    set evalue to (value of e) as string",
  "  on error",
  "    set evalue to \"\"",
  "  end try",
  // A value can be a whole text area; the row locator needs its first
  // characters, not a megabyte of script.
  "  if (count of evalue) > 120 then set evalue to text 1 thru 120 of evalue",
  "  set epos to \"\"",
  "  set esize to \"\"",
  "  try",
  "    set epos to ((item 1 of (get position of e)) as string) & \",\" & ((item 2 of (get position of e)) as string)",
  "    set esize to ((item 1 of (get size of e)) as string) & \",\" & ((item 2 of (get size of e)) as string)",
  "  end try",
  "  return \"N|\" & pathText & \"|\" & depth & \"|\" & erole & \"|\" & esub & \"|\" & my a8nPaneClean(etitle) & \"|\" & my a8nPaneClean(edesc) & \"|\" & my a8nPaneClean(evalue) & \"|\" & epos & \"|\" & esize",
  "end a8nPaneLine",
  // An element's frame as a four-item list, or missing value when AX
  // cannot read it — frameless nodes stay in the tree (they may still
  // carry identifying text) but can never satisfy a frame locator.
  "on a8nPaneFrame(e)",
  "  try",
  "    set ps to get position of e",
  "    set sz to get size of e",
  "    return {(item 1 of ps) as integer, (item 2 of ps) as integer, (item 1 of sz) as integer, (item 2 of sz) as integer}",
  "  on error",
  "    return missing value",
  "  end try",
  "end a8nPaneFrame",
  // Same 4-point tolerance the AX↔census frame matching uses
  // (AX_FRAME_MATCH_TOLERANCE in gui-recovery.ts).
  "on a8nPaneFrameMatch(got, want)",
  "  repeat with i from 1 to 4",
  "    set d to (item i of got) - (item i of want)",
  "    if d < 0 then set d to -d",
  "    if d > 4 then return false",
  "  end repeat",
  "  return true",
  "end a8nPaneFrameMatch",
  "on a8nPaneClean(s)",
  "  set AppleScript's text item delimiters to {return, linefeed, \"|\"}",
  "  set parts to text items of s",
  "  set AppleScript's text item delimiters to \" \"",
  "  return parts as string",
  "end a8nPaneClean",
];

/** What `parsePaneWalkReport` produced from one script run. */
export type PaneWalkReport =
  /** The pid is not visible to the session's Accessibility API. */
  | { readonly kind: "missing" }
  /** The frame argument itself was malformed — a caller bug, not a host state. */
  | { readonly kind: "bad-frame" }
  /** No window-shaped element of the process occupies the expected frame. */
  | { readonly kind: "no-root" }
  /** More than one does; the walk refuses rather than picking one. */
  | { readonly kind: "ambiguous-root" }
  | {
      readonly kind: "walked";
      /** The bounded tree; path "0" is the matched window element. */
      readonly root: DockedAxNode;
      /** Nodes the script reported emitting before any truncation. */
      readonly nodesReported: number;
      /** The script's own truncation flag (node/time bound hit mid-walk). */
      readonly scriptTruncated: boolean;
    };

function parsePair(text: string | undefined): { x: number; y: number } | null {
  if (text === undefined || text.trim().length === 0) {
    return null;
  }
  const parts = text.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return { x: parts[0] as number, y: parts[1] as number };
}

function nodeFrame(
  pos: string | undefined,
  size: string | undefined,
): DockedAxNode["frame"] {
  const p = parsePair(pos);
  const s = parsePair(size);
  if (p === null || s === null) {
    return null;
  }
  return { x: p.x, y: p.y, width: s.x, height: s.y };
}

/**
 * Parse the script's line report into a `DockedAxNode` tree. Malformed
 * `N|` lines are skipped (partial-tree tolerance: one unreadable record
 * must not sink the walk), and nodes attach to their parent by `axPath`
 * so emission order cannot misplace a subtree.
 */
export function parsePaneWalkReport(text: string): PaneWalkReport {
  const lines = text.split("\n");
  const first = (lines.find((line) => line.trim().length > 0) ?? "").trim();
  if (first === "MISSING") {
    return { kind: "missing" };
  }
  if (first === "BADFRAME") {
    return { kind: "bad-frame" };
  }
  if (first === "NOROOT") {
    return { kind: "no-root" };
  }
  if (first === "AMBIGUOUS") {
    return { kind: "ambiguous-root" };
  }

  const byPath = new Map<string, DockedAxNode & { children: DockedAxNode[] }>();
  let done: { nodes: number; truncated: boolean } | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("DONE|")) {
      const fields = line.split("|");
      const nodesField = fields.find((f) => f.startsWith("nodes="));
      const truncField = fields.find((f) => f.startsWith("truncated="));
      done = {
        nodes: nodesField === undefined ? byPath.size : Number(nodesField.slice(6)),
        truncated: truncField === "truncated=1",
      };
      continue;
    }
    if (!line.startsWith("N|")) {
      continue;
    }
    const parts = line.split("|");
    // N|path|depth|role|subrole|title|description|value|x,y|w,h
    if (parts.length < 10) {
      continue;
    }
    const path = parts[1] ?? "";
    const depth = Number(parts[2]);
    if (path.length === 0 || !Number.isInteger(depth) || depth < 0) {
      continue;
    }
    const node: DockedAxNode & { children: DockedAxNode[] } = {
      path,
      depth,
      role: parts[3] ?? "",
      subrole: parts[4] === "" ? null : (parts[4] ?? null),
      title: parts[5] === "" ? null : (parts[5] ?? null),
      description: parts[6] === "" ? null : (parts[6] ?? null),
      value: parts[7] === "" ? null : (parts[7] ?? null),
      frame: nodeFrame(parts[8], parts[9]),
      children: [],
    };
    byPath.set(path, node);
  }

  const root = byPath.get("0");
  if (root === undefined) {
    // A report with node lines but no root — or no node lines at all — is
    // a partial/corrupt tree. Report it as no usable walk rather than
    // guessing a root.
    return { kind: "no-root" };
  }

  // Link every non-root node to its parent path. Paths are "0", "0.1",
  // "0.1.2", …; the parent of "0.1.2" is "0.1". A node whose parent never
  // arrived (a skipped malformed line) stays detached — its absence is
  // the honest partial tree, not a re-parenting guess.
  for (const [path, node] of byPath) {
    if (path === "0") {
      continue;
    }
    const dot = path.lastIndexOf(".");
    const parentPath = path.slice(0, dot);
    const parent = byPath.get(parentPath);
    if (parent !== undefined) {
      (parent.children as DockedAxNode[]).push(node);
    }
  }

  // Children were pushed in map insertion order, which is emission order —
  // the same order `UI elements` reported. Sort defensively by path so a
  // reordered report cannot silently reshuffle row ordinals.
  const sortChildren = (node: DockedAxNode & { children: DockedAxNode[] }): void => {
    (node.children as DockedAxNode[]).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    for (const child of node.children) {
      sortChildren(child as DockedAxNode & { children: DockedAxNode[] });
    }
  };
  sortChildren(root);

  return {
    kind: "walked",
    root,
    nodesReported: done?.nodes ?? byPath.size,
    scriptTruncated: done?.truncated ?? false,
  };
}
