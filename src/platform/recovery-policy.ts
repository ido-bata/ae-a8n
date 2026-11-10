/**
 * The platform-neutral recovery and consent policy.
 *
 * A recovery may only act on a window whose class the project has measured.
 * Everything else is unknown, and unknown state is quarantined: nothing is
 * pressed anywhere and the run reports `A8N-SEC-001`. A licence, sign-in or
 * permission window is a human's decision and is never pressed.
 *
 * This module holds the policy only. It does not import macOS or Windows code,
 * so the macOS recovery that lands through PR #50 can adopt it without moving
 * behaviour in this branch. The Windows backend uses it to decide whether an
 * observed blocking state is known, human-only or unknown; Windows has no GUI
 * automation, so it reports the decision and never presses.
 */

import type { DiagnosticCode } from "../doctor/diagnostics.js";

/** Buttons a recovery may press: they end a dialog without changing anything. */
export const RECOVERY_BUTTONS = ["OK", "Cancel", "Close", "Dismiss"] as const;
export type RecoveryButton = (typeof RECOVERY_BUTTONS)[number];

/**
 * What a window observation must carry, independent of the OS that produced
 * it. `blocking` is the caller's measured answer to "does this window hold the
 * host at a modal state?"; it is not inferred here.
 */
export type DialogWindow = {
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  readonly texts: readonly string[];
  readonly buttons: readonly string[];
  readonly blocking: boolean;
};

/**
 * A dialog class the project has measured.
 *
 * Membership is evidence, not a guess: the shape and wording in `matches` must
 * come from a recorded run. A class that has not been measured is not added
 * "to be helpful" — an unknown blocking window is quarantined instead.
 */
export type DialogClass = {
  /** What the evidence calls this class. */
  readonly name: string;
  /** True only when a button in `RECOVERY_BUTTONS` was measured to close it safely. */
  readonly presses: boolean;
  /** The exact button to press; null when `presses` is false. */
  readonly button: RecoveryButton | null;
  /** The code reported when this class is present; null when it is pressable. */
  readonly code: DiagnosticCode | null;
  /** Where the evidence comes from, so a later reader can check it. */
  readonly evidence: string;
  readonly matches: (window: DialogWindow) => boolean;
};

function windowText(window: DialogWindow): string {
  return [window.title, window.role, window.subrole ?? "", ...window.texts]
    .join(" ")
    .toLowerCase();
}

/**
 * Dialog classes the project has measured.
 *
 * Only `ae-a8n ui.alert` is pressable: its shape and `OK` button were observed
 * on a real After Effects. The other entries are measured shapes that must
 * never be pressed. In particular, crash repair was seen on Windows but no
 * button on it was ever measured as safe, and a sign-in or licence prompt is
 * always a human decision.
 */
export const MEASURED_DIALOG_CLASSES: readonly DialogClass[] = [
  {
    name: "ae-a8n ui.alert",
    presses: true,
    button: "OK",
    code: null,
    evidence:
      "macOS 26.5x89, 2026-11-03: AXWindow/AXDialog with an empty title, an " +
      "`ae-a8n:` static text, and an OK button; pressing OK closed it and the " +
      "original call completed.",
    matches: (window) =>
      (window.subrole ?? "").toLowerCase() === "axdialog" &&
      window.title.trim() === "" &&
      window.texts.some((text) => /^\s*ae-a8n:/u.test(text)),
  },
  {
    name: "after-effects-crash-repair",
    presses: false,
    button: null,
    code: "A8N-SEC-001",
    evidence:
      "Observed on Windows AE 26.5x89 (docs/windows-verification.md: an unclean " +
      "exit makes the next start show Crash Repair Options). No button on it " +
      "was measured as safe, so it is reported and never pressed.",
    matches: (window) =>
      /crash[ -]?repair|crash[ -]?recovery|recover unsaved/u.test(windowText(window)),
  },
  {
    name: "after-effects-second-script",
    presses: false,
    button: null,
    code: "A8N-AE-004",
    evidence:
      "Windows AE 26.5x89, 2026-10-16: the full dialog text was read and is " +
      "recorded in docs/windows-verification.md. A script may still be running, " +
      "so it is reported and never pressed.",
    matches: (window) =>
      /second script while another script|another script was already running/u.test(
        windowText(window),
      ),
  },
  {
    name: "adobe-sign-in",
    presses: false,
    button: null,
    code: "A8N-PERM-004",
    evidence:
      "Policy requirement: an Adobe sign-in or account window is always a human " +
      "decision, in every UI language.",
    matches: (window) =>
      /sign[ -]?in|sign[ -]?out|log[ -]?in|adobe ?id|creative ?cloud|サインイン|サインアウト|ログイン/u.test(
        windowText(window),
      ),
  },
  {
    name: "adobe-licence",
    presses: false,
    button: null,
    code: "A8N-SEC-001",
    evidence: "Policy requirement: a licence or activation window is always a human decision.",
    matches: (window) =>
      /licen[cs]|activat|deactivat|ライセンス|認証|アクティベーション/u.test(windowText(window)),
  },
  {
    name: "script-file-network-permission",
    presses: false,
    button: null,
    code: "A8N-PERM-003",
    evidence:
      "Policy requirement: an AE scripting file/network permission prompt changes " +
      "a security setting and is never pressed by the runner.",
    matches: (window) =>
      /allow scripts to write|script.*(file|network)|file and network access/u.test(
        windowText(window),
      ),
  },
];

/**
 * Windows the recovery must not touch.
 *
 * This is a second, independent refusal. The allow list decides what may be
 * acted on; this check exists so a sign-in or licence window is named for what
 * it is even when it would otherwise be unknown, and so a measured class can
 * never be widened into an account prompt.
 */
const HUMAN_ONLY_WORDS: readonly RegExp[] = [
  /sign[ -]?in|sign[ -]?out|log[ -]?in|licen[cs]|activat|deactivat|creative ?cloud|adobe ?id/u,
  /allow scripts to write|script.*(file|network)|file and network access/u,
  /サインイン|サインアウト|ログイン|ライセンス|認証|アクティベーション/u,
];

export function isHumanOnlyWindow(window: DialogWindow): boolean {
  const text = windowText(window);
  return HUMAN_ONLY_WORDS.some((pattern) => pattern.test(text));
}

export type DialogClassification =
  | { readonly kind: "known"; readonly dialogClass: DialogClass }
  | { readonly kind: "unknown"; readonly code: "A8N-SEC-001" };

/** The measured class a window belongs to, or `unknown` with the quarantine code. */
export function classifyDialog(window: DialogWindow): DialogClassification {
  const dialogClass = MEASURED_DIALOG_CLASSES.find((candidate) => candidate.matches(window));
  return dialogClass === undefined
    ? { kind: "unknown", code: "A8N-SEC-001" }
    : { kind: "known", dialogClass };
}

export type DialogPress = {
  readonly window: DialogWindow;
  readonly dialogClass: string;
  readonly button: RecoveryButton;
};

/**
 * What a recovery may do after looking at every blocking window.
 *
 * `none` means nothing was blocking. `known` means every blocking window is a
 * measured, pressable class. `human-only` means a blocking window belongs to a
 * human; `quarantine` means a blocking window is unknown. In both of the last
 * two cases `presses` is empty: nothing is pressed anywhere.
 */
export type RecoveryDecision =
  | {
      readonly action: "none";
      readonly code: null;
      readonly presses: readonly [];
      readonly detail: string;
    }
  | {
      readonly action: "known";
      readonly code: null;
      readonly presses: readonly DialogPress[];
      readonly detail: string;
    }
  | {
      readonly action: "human-only";
      readonly code: DiagnosticCode;
      readonly presses: readonly [];
      readonly window: DialogWindow;
      readonly dialogClass: string;
      readonly detail: string;
    }
  | {
      readonly action: "quarantine";
      readonly code: "A8N-SEC-001";
      readonly presses: readonly [];
      readonly window: DialogWindow;
      readonly detail: string;
    };

function humanOnlyDecision(
  window: DialogWindow,
  dialogClass: string,
  code: DiagnosticCode | null,
): RecoveryDecision {
  return {
    action: "human-only",
    code: code ?? "A8N-SEC-001",
    presses: [],
    window,
    dialogClass,
    detail: `${dialogClass} belongs to a human; nothing was pressed anywhere`,
  };
}

/**
 * Decide what a recovery may do.
 *
 * The first blocking window that is human-only or a measured non-pressable
 * class stops every press. If no such window exists, an unknown blocking
 * window quarantines the run with `A8N-SEC-001`. Only when every blocking
 * window is a measured pressable class does the result contain presses.
 */
export function chooseAction(windows: readonly DialogWindow[]): RecoveryDecision {
  const blocking = windows.filter((window) => window.blocking);
  if (blocking.length === 0) {
    return {
      action: "none",
      code: null,
      presses: [],
      detail: "no blocking window was observed",
    };
  }

  const humanOnly = blocking.find((window) => isHumanOnlyWindow(window));
  if (humanOnly !== undefined) {
    const classified = classifyDialog(humanOnly);
    return humanOnlyDecision(
      humanOnly,
      classified.kind === "known" ? classified.dialogClass.name : "human-only window",
      classified.kind === "known" ? classified.dialogClass.code : null,
    );
  }

  const nonPressable = blocking.find((window) => {
    const classified = classifyDialog(window);
    return classified.kind === "known" && !classified.dialogClass.presses;
  });
  if (nonPressable !== undefined) {
    const classified = classifyDialog(nonPressable);
    if (classified.kind === "known") {
      return humanOnlyDecision(nonPressable, classified.dialogClass.name, classified.dialogClass.code);
    }
  }

  const unknown = blocking.find((window) => classifyDialog(window).kind === "unknown");
  if (unknown !== undefined) {
    return {
      action: "quarantine",
      code: "A8N-SEC-001",
      presses: [],
      window: unknown,
      detail:
        "a blocking window is not a measured dialog class; the run is quarantined " +
        "with A8N-SEC-001 and nothing was pressed",
    };
  }

  const presses: DialogPress[] = [];
  for (const window of blocking) {
    const classified = classifyDialog(window);
    if (classified.kind === "known" && classified.dialogClass.presses) {
      presses.push({
        window,
        dialogClass: classified.dialogClass.name,
        button: classified.dialogClass.button ?? "OK",
      });
    }
  }
  return {
    action: "known",
    code: null,
    presses,
    detail: `every blocking window is a measured class; ${presses.length} press(es) are allowed`,
  };
}
