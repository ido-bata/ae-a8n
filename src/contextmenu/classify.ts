/**
 * Context-menu classification (#368,
 * `specs/workspace-editing/spec.md` §7 "Context menus").
 *
 * A context menu is recognised by *new-window diff plus declared
 * titles*:
 *
 *   - shape: a pid-attributed window WITH a frame that was not in the
 *     pre-click listing — the same `isPidAttributedWindow` evidence
 *     every GUI surface uses (#330 attribution rules apply unchanged),
 *     plus the diff the controller computes from `baselineKeys`;
 *   - titles: the window's observed button titles and static texts must
 *     include at least one declared item title. The caller declares the
 *     localized titles it expects; the matcher never guesses a locale
 *     and never falls back to coordinates.
 *
 * A new attributed window that fails the title match AND reads as a
 * blocking dialog is `unrecognized-dialog` — the right-click may have
 * raised a modal instead of a menu, and pressing its items is exactly
 * what the no-blind-press rule exists to prevent. A new attributed
 * window that is neither a dialog nor title-matched is `not-a-menu`:
 * ordinary new windows (a panel floating up, a tooltip window) are
 * ignored, not refused — they are evidence the wait keeps polling past.
 *
 * Whether AE's real context menus expose item titles through the AX
 * window listing at all is `unverified` on a real host; the contract
 * tests pin the decision logic against scripted windows.
 */

import {
  isBlockingWindow,
  isPidAttributedWindow,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { isHumanOnlyWindow } from "../driver/recovery.js";
import type { ContextMenuItem, ContextMenuTitles } from "./types.js";

export type ContextMenuMatch =
  | {
      readonly kind: "context-menu";
      readonly matchedTitles: readonly string[];
    }
  /** New blocking dialog whose titles prove nothing — refuse, never press. */
  | { readonly kind: "unrecognized-dialog" }
  /** A human-only window (sign-in/licence) — never interacted with. */
  | { readonly kind: "human-only" }
  /** Attributed but neither dialog-shaped nor title-matched. */
  | { readonly kind: "not-a-menu" }
  /** Not pid-attributed or frameless — unusable as menu evidence. */
  | { readonly kind: "not-a-window" };

/**
 * The deduplicated identity key the pre/post-click diff uses: two
 * windows with the same title, role, subrole and rounded frame are the
 * same surface for "did a new window appear" purposes.
 */
export function contextMenuWindowKey(window: GuiWindowInfo): string {
  const frame = window.frame;
  const frameKey =
    frame == null
      ? "noframe"
      : [frame.x, frame.y, frame.width, frame.height].map((v) => String(Math.round(v))).join(",");
  return [window.title, window.role, window.subrole ?? "", frameKey].join("|");
}

/**
 * The titles a window exposes through the listing's pressable/text
 * channels, deduplicated — the pool `matchContextMenu` and `items`
 * both read so they can never disagree about what the menu shows.
 */
export function contextMenuExposedTitles(window: GuiWindowInfo): readonly string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const button of window.buttons) {
    if (!seen.has(button.title)) {
      seen.add(button.title);
      titles.push(button.title);
    }
  }
  for (const text of window.texts) {
    if (!seen.has(text)) {
      seen.add(text);
      titles.push(text);
    }
  }
  return titles;
}

/** The item candidates `items()` reports — buttons first, then texts. */
export function contextMenuItems(window: GuiWindowInfo): readonly ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const seen = new Set<string>();
  for (const button of window.buttons) {
    if (seen.has(button.title)) continue;
    seen.add(button.title);
    items.push({
      title: button.title,
      via: "button",
      position: button.position,
      size: button.size,
    });
  }
  for (const text of window.texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    items.push({ title: text, via: "text", position: null, size: null });
  }
  return items;
}

/**
 * Classify one NEW observed window against the declared context-menu
 * titles. Pure — the caller supplies the window listing entry; the
 * new-window proof is the controller's diff, not this function's.
 */
export function matchContextMenu(
  window: GuiWindowInfo,
  titles: ContextMenuTitles,
): ContextMenuMatch {
  if (!isPidAttributedWindow(window) || window.frame == null) {
    return { kind: "not-a-window" };
  }
  if (isHumanOnlyWindow(window)) {
    return { kind: "human-only" };
  }
  const exposed = contextMenuExposedTitles(window);
  const matched = titles.items.filter((title) => exposed.includes(title));
  if (matched.length > 0) {
    return { kind: "context-menu", matchedTitles: matched };
  }
  if (isBlockingWindow(window)) {
    return { kind: "unrecognized-dialog" };
  }
  return { kind: "not-a-menu" };
}
