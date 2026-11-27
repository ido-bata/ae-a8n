/**
 * Workspace menu and identity resolution (#363,
 * `specs/workspace-editing/spec.md` §5/§6).
 *
 * Pure functions over one `MenuBarSnapshot` plus the workspace-XML
 * snapshot: navigate to the Workspace submenu, list its leaf entries,
 * and read which entry carries the checkmark — the only honest answer
 * to "which workspace is active" (spec §5: identity is re-read from
 * the menu checkmark, never cached, never guessed from files).
 *
 * The localized-title rule is the menus contract's (#360): an absent
 * expected menu path is `unsupported-locale`, never a coordinate
 * fallback.
 */

import type { MenuBarItemInfo, MenuBarSnapshot, MenuItemNode } from "../menus/types.js";
import type { WorkspaceStoreSnapshot } from "../workspace-xml/types.js";
import {
  WorkspaceError,
  type WorkspaceIdentity,
  type WorkspaceMenuEntry,
  type WorkspaceMenuPath,
  type WorkspaceTarget,
} from "./types.js";

function describeNode(node: MenuItemNode): string {
  return `"${node.title === "" ? "<separator>" : node.title}" at ${node.path.join(",")}`;
}

/**
 * Navigate `menuPath` (`[barTitle, submenuTitle]`) to the submenu node
 * that holds the workspace entries. Mirrors `resolveMenuItem`'s refusal
 * shape: `unavailable` when the listing is absent, `unsupported-locale`
 * when a title is not observed, `ambiguous-target` on duplicates.
 */
export function workspaceSubmenu(
  snapshot: MenuBarSnapshot,
  menuPath: WorkspaceMenuPath,
): { barItem: MenuBarItemInfo; submenu: MenuItemNode; titles: readonly string[] } {
  if (menuPath.barTitle === "" || menuPath.submenuTitle === "") {
    throw new WorkspaceError(
      "not-found",
      "the workspace menu path needs non-empty barTitle and submenuTitle",
    );
  }
  if (!snapshot.available) {
    throw new WorkspaceError(
      "unavailable",
      `the menu bar observation is unavailable: ${snapshot.reason ?? "no reason given"}`,
    );
  }

  const barCandidates = snapshot.menuBarItems.filter(
    (item) => item.title === menuPath.barTitle,
  );
  if (barCandidates.length === 0) {
    throw new WorkspaceError(
      "unsupported-locale",
      `no menu bar item titled "${menuPath.barTitle}" was observed on pid ${snapshot.pid} ` +
        `(menu titles are localized; observed: ${snapshot.menuBarItems
          .map((item) => `"${item.title}"`)
          .join(", ") || "none"}). ` +
        "Refusing rather than falling back to coordinates (spec §6).",
    );
  }
  if (barCandidates.length > 1) {
    throw new WorkspaceError(
      "ambiguous-target",
      `${barCandidates.length} menu bar items are titled "${menuPath.barTitle}"`,
      { candidates: barCandidates.map((item) => `#${item.index} "${item.title}"`) },
    );
  }
  const barItem = barCandidates[0] as MenuBarItemInfo;

  const subCandidates = barItem.items.filter(
    (node) => node.kind === "submenu" && node.title === menuPath.submenuTitle,
  );
  if (subCandidates.length === 0) {
    const present = barItem.items
      .filter((node) => node.kind !== "separator")
      .map((node) => `"${node.title}"`)
      .join(", ");
    throw new WorkspaceError(
      "unsupported-locale",
      `no submenu titled "${menuPath.submenuTitle}" under "${menuPath.barTitle}" ` +
        `was observed on pid ${snapshot.pid} (observed items: ${present || "none"})`,
    );
  }
  if (subCandidates.length > 1) {
    throw new WorkspaceError(
      "ambiguous-target",
      `${subCandidates.length} submenu items are titled "${menuPath.submenuTitle}"`,
      { candidates: subCandidates.map(describeNode) },
    );
  }
  const submenu = subCandidates[0] as MenuItemNode;
  return { barItem, submenu, titles: [barItem.title, submenu.title] };
}

/**
 * name → xmlRef lookup across every inspected workspace file. First
 * match wins (files are sorted deterministically by the reader); a name
 * found in several stores still resolves to one evidence handle —
 * `xmlRef` is corroboration, never identity (spec §5).
 */
export function workspaceXmlLookup(
  xml: WorkspaceStoreSnapshot | null,
): ReadonlyMap<string, { path: string; sha256: string }> {
  const map = new Map<string, { path: string; sha256: string }>();
  if (xml === null) {
    return map;
  }
  for (const file of xml.files) {
    for (const name of file.workspaceNames) {
      if (!map.has(name)) {
        map.set(name, { path: file.path, sha256: file.sha256 });
      }
    }
  }
  return map;
}

/** Every leaf (non-submenu, non-separator) item of the Workspace submenu. */
export function workspaceMenuEntries(
  submenu: MenuItemNode,
  xmlLookup: ReadonlyMap<string, { path: string; sha256: string }>,
): WorkspaceMenuEntry[] {
  return submenu.children
    .filter((node) => node.kind === "item" && node.title !== "")
    .map((node) => {
      const hit = xmlLookup.get(node.title);
      return {
        title: node.title,
        path: node.path,
        enabled: node.enabled,
        check: node.check,
        persisted: hit !== undefined,
        ...(hit === undefined ? {} : { xmlRef: hit }),
      };
    });
}

/**
 * The active-workspace identity from one snapshot: exactly one checked
 * leaf item resolves; zero or several checked items — or marks the
 * attribute could not read — is `unknown`, the honest answer. Command
 * items ("New Workspace…", "Reset …") participate like any other leaf;
 * whichever carries the checkmark is what AE reports as active.
 */
export function workspaceIdentity(
  snapshot: MenuBarSnapshot,
  menuPath: WorkspaceMenuPath,
  xml: WorkspaceStoreSnapshot | null,
  pid: number,
  now: () => Date,
): WorkspaceIdentity {
  const { submenu } = workspaceSubmenu(snapshot, menuPath);
  const lookup = workspaceXmlLookup(xml);
  const entries = workspaceMenuEntries(submenu, lookup);
  const checked = entries.filter((entry) => entry.check === "checked");

  if (checked.length === 0) {
    const anyUnknown = entries.some((entry) => entry.check === "unknown");
    return {
      status: "unknown",
      reason:
        entries.length === 0
          ? `the "${menuPath.submenuTitle}" submenu exposed no items on pid ${pid}`
          : anyUnknown
            ? "no item reported a readable checkmark (AXMenuItemMarkChar " +
              "unavailable or empty for every entry); the active workspace " +
              "cannot be proven from the menu"
            : "no item in the workspace submenu carries a checkmark; " +
              "AE did not report an active workspace",
    };
  }
  if (checked.length > 1) {
    return {
      status: "unknown",
      reason:
        `${checked.length} workspace submenu items report a checkmark ` +
        `(${checked.map((entry) => `"${entry.title}"`).join(", ")}); ` +
        "the active workspace is ambiguous — reported, not guessed",
    };
  }
  const item = checked[0] as WorkspaceMenuEntry;
  const target: WorkspaceTarget = {
    pid,
    workspace: {
      name: item.title,
      persisted: item.persisted,
      ...(item.xmlRef === undefined ? {} : { xmlRef: item.xmlRef }),
    },
    resolvedAt: now().toISOString(),
  };
  return { status: "resolved", target, item };
}
