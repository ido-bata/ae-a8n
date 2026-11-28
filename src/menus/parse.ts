/**
 * Parser for the `LIST_MENU_BAR_SCRIPT` line protocol (#360).
 *
 * Pure: text in, `MenuBarSnapshot` out. Malformed lines are skipped —
 * a record that cannot be read is never guessed into a menu item, and
 * the snapshot reports `truncated` when the walk itself said it stopped
 * early.
 */

import type {
  MenuBarItemInfo,
  MenuBarSnapshot,
  MenuItemNode,
} from "./types.js";

function flagField(text: string | undefined): boolean | null {
  if (text === "1") return true;
  if (text === "0") return false;
  return null;
}

function checkField(text: string | undefined): MenuItemNode["check"] {
  if (text === "1") return "checked";
  if (text === "0") return "unchecked";
  return "unknown";
}

function kindField(text: string | undefined): MenuItemNode["kind"] {
  if (text === "submenu") return "submenu";
  if (text === "separator") return "separator";
  return "item";
}

/** A node while the tree is still being assembled (children grow). */
type MutableNode = {
  path: number[];
  title: string;
  kind: MenuItemNode["kind"];
  enabled: boolean | null;
  check: MenuItemNode["check"];
  markChar: string | null;
  shortcut: string | null;
  children: MutableNode[];
};

function freeze(node: MutableNode): MenuItemNode {
  return {
    path: node.path,
    title: node.title,
    kind: node.kind,
    enabled: node.enabled,
    check: node.check,
    markChar: node.markChar,
    shortcut: node.shortcut,
    children: node.children.map(freeze),
  };
}

/**
 * Parse the script's stdout into a snapshot. `MISSING` and `NOMENUBAR`
 * are transport-level answers handled by the caller; anything else is
 * treated as a listing (possibly empty).
 */
export function parseMenuBarListing(
  text: string,
  pid: number,
  observedAt: string,
): MenuBarSnapshot {
  const barItems: {
    index: number;
    title: string;
    role: string | null;
    enabled: boolean | null;
    children: MutableNode[];
  }[] = [];
  const barByIndex = new Map<number, (typeof barItems)[number]>();
  const nodes = new Map<string, MutableNode>();
  let truncated = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const parts = line.split("|");
    if (parts[0] === "MB") {
      const index = Number(parts[1]);
      if (!Number.isInteger(index) || index < 1) {
        continue;
      }
      const item = {
        index,
        title: parts[2] ?? "",
        role: parts[3] === undefined || parts[3] === "" ? null : parts[3],
        enabled: flagField(parts[4]),
        children: [] as MutableNode[],
      };
      barItems.push(item);
      barByIndex.set(index, item);
      continue;
    }
    if (parts[0] === "I") {
      const path = (parts[1] ?? "")
        .split(",")
        .map((p) => Number(p))
        .filter((n) => Number.isInteger(n) && n >= 1);
      // Item paths always start with a menu bar item index and name at
      // least one item inside its menu.
      if (path.length < 2) {
        continue;
      }
      nodes.set(path.join(","), {
        path,
        title: parts[2] ?? "",
        kind: kindField(parts[8]),
        enabled: flagField(parts[4]),
        check: checkField(parts[5]),
        markChar: parts[6] === undefined || parts[6] === "" ? null : parts[6],
        shortcut: parts[7] === undefined || parts[7] === "" ? null : parts[7],
        children: [],
      });
      continue;
    }
    if (parts[0] === "TRUNCATED") {
      truncated = true;
    }
  }

  // Link every node to its parent. Records arrive parents-before-
  // children (the walk is depth-first), but the map lookup does not
  // rely on order: a child whose parent record was malformed or
  // truncated away is dropped rather than re-parented by guesswork.
  for (const node of nodes.values()) {
    const parentPath = node.path.slice(0, -1);
    if (parentPath.length === 1) {
      barByIndex.get(parentPath[0] as number)?.children.push(node);
      continue;
    }
    nodes.get(parentPath.join(","))?.children.push(node);
  }

  const menuBarItems: MenuBarItemInfo[] = barItems.map((item) => ({
    index: item.index,
    title: item.title,
    role: item.role,
    enabled: item.enabled,
    items: item.children.map(freeze),
  }));

  return {
    pid,
    channel: "system-events",
    observedAt,
    available: true,
    reason: null,
    menuBarItems,
    truncated,
  };
}
