/**
 * Native file-dialog contract (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3, §5).
 *
 * Open/Save/Import run through After Effects' *native* file pickers —
 * dialogs that belong to the OS panel, not to the ExtendScript DOM.
 * This module fixes the contract every later real-host ticket (#372/#373
 * input posters, real-dialog measurement) must satisfy:
 *
 *   - The picker is verified as a **dialog class** through the existing
 *     window listing (`classifyDialog`/`chooseRecoveryWindow` machinery
 *     shapes the observation; the file-picker matcher below is this
 *     slice's own, because no file-picker class has been measured into
 *     `DIALOG_TAXONOMY` yet — recorded `unverified`, never guessed).
 *   - The wait is **bounded**: deadline expiry is `indeterminate`, and
 *     nothing is ever resent — the invoking click is not repeated.
 *   - The dialog is the target, not the main window: presses re-resolve
 *     the dialog window (index + title + subrole + frame) immediately
 *     before acting, and `stale-locator` means re-observe.
 *   - **No blind auto-confirm**: a blocking window that does not match
 *     the declared file-dialog titles refuses the flow — it may be a
 *     different modal, and pressing its buttons is exactly what the
 *     quarantine policy exists to prevent.
 *   - Filename entry is `mutate-gui` **shared-state** (spec §5): it runs
 *     under the prior-state save/restore contract of the B-IME input
 *     path. No OS text-input channel exists on any platform yet
 *     (#372/#373), so production reports `unsupported` — the contract
 *     and its gates are what this slice delivers.
 */

import type { GuiWindowInfo } from "../driver/gui-recovery.js";

/** The button titles a file dialog is expected to show, caller-declared. */
export type FileDialogTitles = {
  /**
   * Localized titles that confirm the dialog (e.g. "Open", "Choose",
   * "Save"). Matched verbatim against the observed button titles —
   * an empty list can never classify a window as a file dialog.
   */
  readonly confirm: readonly string[];
  /** Localized titles that cancel it (e.g. "Cancel"). Same rule. */
  readonly cancel: readonly string[];
};

/** What the bounded wait resolved the picker to. */
export type FileDialogResolution = {
  /** 1-based position in the `listWindows()` listing the press addresses. */
  readonly index: number;
  /** The dialog window as observed — the press's `expected` identity. */
  readonly window: GuiWindowInfo;
  /** Which declared title families the window's buttons matched. */
  readonly matchedConfirmTitles: readonly string[];
  readonly matchedCancelTitles: readonly string[];
  readonly observedAt: string;
};

/** The verdict an act (confirm/cancel/enter-filename) reports. */
export type FileDialogActResult = {
  readonly action: "confirm" | "cancel" | "enter-filename";
  /** The button title pressed, or the text-entry channel verdict. */
  readonly detail: string;
  readonly actedAt: string;
};

/** Stable refusal codes a caller may act on. */
export type FileDialogErrorCode =
  /** The target session or window listing could not be produced. */
  | "unavailable"
  /** No file dialog matched at act time. */
  | "not-found"
  /** More than one file dialog matched the expectations. */
  | "ambiguous"
  /** The dialog exists but pid attribution is not "owned". */
  | "unproven"
  /** The resolved dialog moved or changed before the act. */
  | "stale-locator"
  /** A safety gate or policy refuses the operation now — including the
   *  "a different blocking dialog is on screen" refusal. */
  | "refused"
  /** The bounded wait expired or an act's outcome is unknown. */
  | "indeterminate"
  /** This platform/kind has no implementation (e.g. filename entry
   *  before the B-IME OS input posters land). */
  | "unsupported";

export class FileDialogError extends Error {
  readonly code: FileDialogErrorCode;
  readonly candidates: readonly string[];

  constructor(
    code: FileDialogErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "FileDialogError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
