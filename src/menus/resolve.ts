/**
 * Menu item resolution (#360, `specs/workspace-editing/spec.md` §6).
 *
 * Pure: a `MenuItemLocator` resolves against one `MenuBarSnapshot` —
 * or to a typed refusal. Titles are matched exactly against what the
 * Accessibility API observed, which is localized: when the expected
 * menu path is absent the answer is `unsupported-locale`, and there is
 * deliberately no coordinate or fuzzy fallback.
 */

import {
  MenuError,
  type MenuBarItemInfo,
  type MenuBarSnapshot,
  type MenuItemLocator,
  type MenuItemNode,
  type ResolvedMenuItem,
} from "./types.js";

function describeNode(node: MenuItemNode): string {
  return `"${node.title === "" ? "<separator>" : node.title}" at ${node.path.join(",")}`;
}

/**
 * Resolve `locator` against `snapshot`. Throws `MenuError`:
 *
 *   - `invalid-locator` — empty `menuPath` or empty `itemTitle`.
 *   - `unsupported-locale` — no menu bar item, submenu or leaf matched
 *     the expected titles. This is the spec §6 refusal: the observed
 *     tree is reported so the caller can see what AE actually showed.
 *   - `ambiguous-target` — more than one candidate matched at some
 *     level; the candidates are named.
 */
export function resolveMenuItem(
  snapshot: MenuBarSnapshot,
  locator: MenuItemLocator,
): ResolvedMenuItem {
  if (locator.menuPath.length === 0 || locator.itemTitle.length === 0) {
    throw new MenuError(
      "invalid-locator",
      "a menu locator needs at least one menuPath title and a non-empty itemTitle",
    );
  }
  if (!snapshot.available) {
    throw new MenuError(
      "unavailable",
      `the menu bar observation is unavailable: ${snapshot.reason ?? "no reason given"}`,
    );
  }

  // Level 0: the menu bar item. Its absence is the locale signal — a
  // Japanese AE does not show "Window", and guessing is prohibited.
  const barCandidates = snapshot.menuBarItems.filter(
    (item) => item.title === locator.menuPath[0],
  );
  if (barCandidates.length === 0) {
    throw new MenuError(
      "unsupported-locale",
      `no menu bar item titled "${locator.menuPath[0]}" was observed on pid ${snapshot.pid} ` +
        `(menu titles are localized; observed: ${snapshot.menuBarItems
          .map((item) => `"${item.title}"`)
          .join(", ") || "none"}). ` +
        "Refusing rather than falling back to coordinates (spec §6).",
    );
  }
  if (barCandidates.length > 1) {
    throw new MenuError(
      "ambiguous-target",
      `${barCandidates.length} menu bar items are titled "${locator.menuPath[0]}"`,
      { candidates: barCandidates.map((item) => `#${item.index} "${item.title}"`) },
    );
  }
  const barItem = barCandidates[0] as MenuBarItemInfo;

  // Levels 1..menuPath.length-1: submenu titles. Each must name an item
  // with children inside the current menu.
  let menuItems: readonly MenuItemNode[] = barItem.items;
  const titles: string[] = [barItem.title];
  for (let depth = 1; depth < locator.menuPath.length; depth += 1) {
    const wanted = locator.menuPath[depth] as string;
    const candidates = menuItems.filter(
      (node) => node.kind === "submenu" && node.title === wanted,
    );
    if (candidates.length === 0) {
      throw new MenuError(
        "unsupported-locale",
        `no submenu titled "${wanted}" under "${locator.menuPath
          .slice(0, depth)
          .join(" > ")}" was observed on pid ${snapshot.pid}`,
      );
    }
    if (candidates.length > 1) {
      throw new MenuError(
        "ambiguous-target",
        `${candidates.length} submenu items are titled "${wanted}"`,
        { candidates: candidates.map(describeNode) },
      );
    }
    const node = candidates[0] as MenuItemNode;
    titles.push(node.title);
    menuItems = node.children;
  }

  // The leaf: a direct item of the resolved menu. Separators and
  // submenu parents are not invocable leaves — a locator naming one is
  // a caller bug, refused rather than clicked.
  const leafCandidates = menuItems.filter(
    (node) => node.title === locator.itemTitle && node.kind === "item",
  );
  if (leafCandidates.length === 0) {
    const present = menuItems
      .filter((node) => node.kind !== "separator")
      .map((node) => `"${node.title}"`)
      .join(", ");
    throw new MenuError(
      "unsupported-locale",
      `no menu item titled "${locator.itemTitle}" was observed in ` +
        `"${locator.menuPath.join(" > ")}" on pid ${snapshot.pid} ` +
        `(observed items: ${present || "none"})`,
    );
  }
  if (leafCandidates.length > 1) {
    throw new MenuError(
      "ambiguous-target",
      `${leafCandidates.length} items titled "${locator.itemTitle}" in ` +
        `"${locator.menuPath.join(" > ")}"`,
      { candidates: leafCandidates.map(describeNode) },
    );
  }
  const node = leafCandidates[0] as MenuItemNode;
  titles.push(node.title);

  return {
    locator,
    node,
    menuBarItem: barItem,
    titles,
  };
}
