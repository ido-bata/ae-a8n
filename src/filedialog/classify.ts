/**
 * File-dialog classification (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3).
 *
 * A native file picker is recognised by *shape plus declared titles*:
 *
 *   - shape: a blocking, pid-attributed, dialog-class window — the same
 *     `isBlockingWindow`/`isPidAttributedWindow` evidence every GUI
 *     surface uses (#330 attribution rules apply unchanged);
 *   - titles: the window's observed button titles must include at least
 *     one declared confirm title AND one declared cancel title. The
 *     caller declares the localized titles it expects; the matcher
 *     never guesses a locale and never falls back to coordinates.
 *
 * A dialog-shaped window that fails the title match is `unrecognized` —
 * reported so the flow refuses rather than pressing an unknown modal's
 * buttons. Whether AE's real pickers expose confirm/cancel as AX
 * buttons with stable titles is `unverified` on a real host; the
 * contract tests pin the decision logic against scripted windows.
 */

import {
  isBlockingWindow,
  isPidAttributedWindow,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { isHumanOnlyWindow } from "../driver/recovery.js";
import type { FileDialogTitles } from "./types.js";

export type FileDialogMatch =
  | {
      readonly kind: "file-dialog";
      readonly matchedConfirmTitles: readonly string[];
      readonly matchedCancelTitles: readonly string[];
    }
  /** Blocking and attributed, but the titles do not prove a file picker. */
  | { readonly kind: "unrecognized-dialog" }
  /** A human-only window (sign-in/licence) — never interacted with. */
  | { readonly kind: "human-only" }
  /** Not a blocking dialog at all — ordinary windows land here. */
  | { readonly kind: "not-a-dialog" };

/**
 * Classify one observed window against the declared file-dialog titles.
 * Pure — the caller supplies the window listing entry and the expected
 * localized titles.
 */
export function matchFileDialog(
  window: GuiWindowInfo,
  titles: FileDialogTitles,
): FileDialogMatch {
  if (!isBlockingWindow(window) || !isPidAttributedWindow(window)) {
    return { kind: "not-a-dialog" };
  }
  if (isHumanOnlyWindow(window)) {
    return { kind: "human-only" };
  }
  const buttons = window.buttons.map((button) => button.title);
  const matchedConfirm = titles.confirm.filter((title) => buttons.includes(title));
  const matchedCancel = titles.cancel.filter((title) => buttons.includes(title));
  if (matchedConfirm.length > 0 && matchedCancel.length > 0) {
    return { kind: "file-dialog", matchedConfirmTitles: matchedConfirm, matchedCancelTitles: matchedCancel };
  }
  return { kind: "unrecognized-dialog" };
}

/** The button titles a resolution should press for `action`. */
export function fileDialogButtonTitle(
  resolution: {
    readonly matchedConfirmTitles: readonly string[];
    readonly matchedCancelTitles: readonly string[];
  },
  titles: FileDialogTitles,
  action: "confirm" | "cancel",
): string | null {
  const matched = action === "confirm"
    ? resolution.matchedConfirmTitles
    : resolution.matchedCancelTitles;
  if (matched.length === 0) {
    return null;
  }
  // Prefer the first *declared* title that matched — declaration order
  // is the caller's priority (e.g. "Open" over "Choose").
  const declared = action === "confirm" ? titles.confirm : titles.cancel;
  for (const title of declared) {
    if (matched.includes(title)) {
      return title;
    }
  }
  return matched[0] ?? null;
}
