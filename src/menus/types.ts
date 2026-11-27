/**
 * macOS menu-bar surface contract (#360,
 * `specs/workspace-editing/spec.md` §6/§7).
 *
 * The menu bar tree — `AXMenuBar` → menu bar items → menus → items —
 * is an observation surface the window census never walked. This module
 * is the foundation W1 (workspace checkmark readback) and W3
 * (menu-driven render queue / file dialog) build on: enumerate the bar,
 * read an item's checkmark state, and invoke a menu item — all addressed
 * by the titles After Effects actually shows, which are localized.
 *
 * Honesty rules carried from the panel slice (#343):
 *
 *   - A menu item is addressed by `(menuPath, itemTitle)` — the titles
 *     observed through the Accessibility API at resolution time, never
 *     by coordinate and never by `app.findMenuCommandId` (that lookup is
 *     `scripting-direct` discovery aid only, spec §6).
 *   - When the expected menu path is absent the resolution refuses
 *     `unsupported-locale` — it never falls back to a coordinate click.
 *   - `invoke` is `mutate-gui`: it runs under the GUI lease + audit with
 *     the same fail-closed posture as every other GUI mutation, and in
 *     production it additionally refuses until the A-SAFETY gate clears
 *     a menu-invoke class (`src/menus/gate.ts`).
 */

/** What the checkmark attribute proved about one menu item. */
export type MenuCheckState =
  /** `AXMenuItemMarkChar` was readable and non-empty (e.g. "✓"). */
  | "checked"
  /** The mark attribute was readable and empty. */
  | "unchecked"
  /**
   * The mark attribute could not be read. Apps that omit
   * `AXMenuItemMarkChar` on unchecked items land here too — `"unknown"`
   * is the honest answer, never a guessed "unchecked".
   */
  | "unknown";

/** One node in a menu's item tree. */
export type MenuItemNode = {
  /**
   * The 1-based index path the mutation script addresses: the first
   * element is the menu bar item's position, each following element the
   * item's position inside its parent menu. Stable only within one
   * observation — re-resolution happens on every operation.
   */
  readonly path: readonly number[];
  /** The title After Effects shows (localized), "" for separators. */
  readonly title: string;
  /** `"separator"` for unnamed items, `"submenu"` when children exist. */
  readonly kind: "item" | "separator" | "submenu";
  /** `AXEnabled`; null when the attribute could not be read. */
  readonly enabled: boolean | null;
  readonly check: MenuCheckState;
  /** The raw `AXMenuItemMarkChar` value, when readable (e.g. "✓"). */
  readonly markChar: string | null;
  /** `AXMenuItemCmdChar` + `AXMenuItemCmdModifiers`, raw, "" when absent. */
  readonly shortcut: string | null;
  /** Submenu items; empty unless `kind === "submenu"`. */
  readonly children: readonly MenuItemNode[];
};

/** A top-level menu bar item (e.g. "File", "Window") and its menu tree. */
export type MenuBarItemInfo = {
  /** 1-based position among the process's menu bar items. */
  readonly index: number;
  readonly title: string;
  readonly role: string | null;
  readonly enabled: boolean | null;
  /** The menu this bar item opens; empty when it has none. */
  readonly items: readonly MenuItemNode[];
};

/**
 * One observation of a process's menu bar. `available: false` is the
 * honest "the Accessibility API answered but there is no menu bar (or it
 * refused)" — never an empty-tree guess.
 */
export type MenuBarSnapshot = {
  readonly pid: number;
  /** The transport that produced this listing ("system-events" on macOS). */
  readonly channel: "system-events";
  readonly observedAt: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly menuBarItems: readonly MenuBarItemInfo[];
  /** True when the walk hit its bound and dropped entries. */
  readonly truncated: boolean;
};

/**
 * How a caller names a menu item (spec §6): the menu-bar path is the
 * chain of titles from the menu bar item to the menu holding the item —
 * `["Window", "Workspace"]` addresses the Workspace submenu of Window —
 * and `itemTitle` is the item's own observed title. Titles are matched
 * exactly against what AX reports; there is no fuzzy or coordinate
 * fallback.
 */
export type MenuItemLocator = {
  readonly menuPath: readonly string[];
  readonly itemTitle: string;
};

/** A locator resolved against one snapshot — evidence for invoke. */
export type ResolvedMenuItem = {
  readonly locator: MenuItemLocator;
  readonly node: MenuItemNode;
  readonly menuBarItem: MenuBarItemInfo;
  /**
   * The titles along `node.path`, observed — what the in-session invoke
   * script re-verifies immediately before pressing, so a menu that moved
   * between listing and press is refused, not clicked.
   */
  readonly titles: readonly string[];
};

/** What `readCheckState` reports for a resolved item. */
export type MenuCheckReading = {
  readonly resolved: ResolvedMenuItem;
  readonly check: MenuCheckState;
  readonly markChar: string | null;
};

/** What an invoke attempt proved. */
export type MenuInvokeResult = {
  readonly resolved: ResolvedMenuItem;
  readonly invokedAt: string;
};

/** Per-capability honesty record, same shape as `PanelCapability`. */
export type MenuCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with the menu-bar surface on this platform. */
export type MenuCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly enumerate: MenuCapability;
  readonly checkState: MenuCapability;
  readonly invoke: MenuCapability;
};

/** Stable refusal codes a caller may act on. */
export type MenuErrorCode =
  /** The platform has no implementation (Windows in this slice). */
  | "unsupported"
  /**
   * The expected menu path or item title is absent from the observed
   * tree — the localized-title refusal of spec §6. Never a cue to fall
   * back to coordinates.
   */
  | "unsupported-locale"
  /** More than one candidate matched the locator. */
  | "ambiguous-target"
  /** The locator itself is malformed (empty path, empty title). */
  | "invalid-locator"
  /** The item resolved earlier moved or vanished before the act. */
  | "stale-locator"
  /** The target session or process could not be entered/proven. */
  | "unavailable"
  /** A safety gate refuses the operation now. */
  | "refused"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate";

export class MenuError extends Error {
  readonly code: MenuErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: MenuErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "MenuError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
