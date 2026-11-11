/**
 * Recovering a host that has stopped answering.
 *
 * The driver calls this when an operation timed out. The recovery looks at
 * the *target session's* screen, closes what is blocking the host, and says
 * what it did. It never repeats the operation that timed out: the request may
 * still be running inside After Effects, and sending it again would run it
 * twice. The driver waits for the original result instead.
 *
 * What the recovery may press is a policy, not a free-for-all. The recoverable
 * dialog classes are an **allow list**: only a shape the project has actually
 * measured may be dismissed. Everything else is unknown, and unknown state is
 * quarantined — nothing is pressed and the run reports `A8N-SEC-001`. A button
 * that signs out of Adobe, deactivates a device, or confirms a licence change
 * is never pressed: those are a human's decision, and the recovery reports
 * them instead.
 */

import { join } from "node:path";

import { MacGuiRecovery, isBlockingWindow, type GuiWindowInfo } from "./gui-recovery.js";
import type { MacSession } from "./mac-session.js";

export type RecoveryContext = {
  /** The request that timed out. Its result may still arrive. */
  readonly requestId: string;
  readonly method: string;
  readonly timeoutMs: number;
};

export type RecoveryOutcome = {
  /** Whether something was done that may have unblocked the host. */
  readonly recovered: boolean;
  /**
   * How the attempt ended. `"dismissed"` means a measured dialog class was
   * closed; `"quarantined"` means a blocking window could not be classified
   * and the run was left untouched. `"refused"` covers every other ending
   * (no window, no host, a human-only window, or no safe button). Optional so
   * a simple `HostRecovery` implementation need not classify itself.
   */
  readonly outcome?: "dismissed" | "quarantined" | "refused";
  /**
   * The security code, when the recovery quarantined the run because the
   * blocking window was not a measured class. Currently always
   * `"A8N-SEC-001"`.
   */
  readonly code?: "A8N-SEC-001";
  /** What was seen and what was done, for the trace and for a human. */
  readonly evidence: string;
  /** A screenshot of the target session, when one was taken. */
  readonly screenshotPath?: string;
  /** The window that was blocking, when one was found. */
  readonly window?: string;
};

export interface HostRecovery {
  attempt(context: RecoveryContext): Promise<RecoveryOutcome>;
}

/** Buttons a recovery may press: they end a dialog without changing anything. */
export const RECOVERY_BUTTONS: readonly string[] = ["OK", "Cancel", "Close", "Dismiss"];

/**
 * Windows the recovery must not touch.
 *
 * An Adobe sign-in or licence window belongs to a human: pressing its button
 * can sign the account out, deactivate a device, or accept a licence change
 * on the user's behalf. The recovery reports the window instead.
 *
 * This is a second, independent refusal. The policy that decides whether a
 * window may be acted on at all is the allow list below; this one exists so a
 * sign-in or licence window is named for what it is even when it would
 * otherwise be quarantined, and so a measured class can never be widened into
 * an account prompt.
 *
 * The wording is matched in the language the session runs in as well as in
 * English: After Effects shows its dialogs in the UI language of the user,
 * and a Japanese sign-in prompt says nothing an English matcher can find.
 * The window's own text is searched too, because such a window's title is
 * often only "警告" or a product name.
 */
const HUMAN_ONLY_WORDS: readonly RegExp[] = [
  /sign[ -]?in|sign[ -]?out|log[ -]?in|licen[cs]|activat|deactivat|creative ?cloud|adobe ?id/,
  /サインイン|サインアウト|ログイン|ライセンス|認証|アクティベーション/,
];

export function isHumanOnlyWindow(window: GuiWindowInfo): boolean {
  const text = [
    window.title,
    window.role,
    window.subrole ?? "",
    ...window.texts,
  ]
    .join(" ")
    .toLowerCase();
  return HUMAN_ONLY_WORDS.some((pattern) => pattern.test(text));
}

/** What a window says, in one line, for evidence. */
export function describeWindow(window: GuiWindowInfo): string {
  const buttons = window.buttons.map((button) => button.title).filter((title) => title.length > 0);
  const subrole = window.subrole === null ? "" : `/${window.subrole}`;
  const said = window.texts.filter((text) => text.length > 0).join(" / ");
  return `${window.role}${subrole} "${window.title}" [${buttons.join(", ")}]` + (said.length > 0 ? ` says "${said}"` : "");
}

/**
 * A dialog class the project has measured, and may therefore dismiss.
 *
 * Membership is evidence, not a guess: the shape and wording in `matches`
 * must come from a recorded run against a real After Effects. A class that
 * has not been measured is not added "to be helpful" — an unknown blocking
 * window is quarantined instead.
 */
export type KnownDialogClass = {
  /** What the evidence calls this class. */
  readonly name: string;
  readonly matches: (window: GuiWindowInfo) => boolean;
};

/**
 * Dialog classes a recovery may press a button in.
 *
 * This list is deliberately short. The one measured class is the native alert
 * the run itself raises with `ui.alert`: on the real host (2026-11-03,
 * docs/offstage-macos.md §10.14) it was an `AXWindow` / `AXDialog` with an
 * empty title, the run's own `ae-a8n:` message among its static texts, and an
 * `OK` button; pressing `OK` closed it and the original call completed.
 *
 * AE's start-up `警告` dialog is *not* here. Its Axis title is also empty, so
 * matching on shape alone would press it; what it says (a sign-in, licence or
 * script-permission decision) belongs to a human. It is therefore
 * unclassified, and the run is quarantined.
 */
export const KNOWN_DIALOG_CLASSES: readonly KnownDialogClass[] = [
  {
    name: "ae-a8n ui.alert",
    matches: (window) =>
      (window.subrole ?? "").toLowerCase() === "axdialog" &&
      window.title.trim() === "" &&
      window.texts.some((text) => /^\s*ae-a8n:/.test(text)),
  },
];

/** The measured class a window belongs to, or null when it is unknown. */
export function classifyDialog(window: GuiWindowInfo): KnownDialogClass | null {
  return KNOWN_DIALOG_CLASSES.find((dialogClass) => dialogClass.matches(window)) ?? null;
}

export type RecoveryWindowChoice =
  /** No window is blocking the host; nothing to press. */
  | { readonly kind: "none" }
  /** A blocking window belongs to a human; nothing may be pressed anywhere. */
  | { readonly kind: "human-only"; readonly index: number; readonly window: GuiWindowInfo }
  /** The first blocking window is a measured class, and the only one a press may be sent to. */
  | {
      readonly kind: "known";
      readonly index: number;
      readonly window: GuiWindowInfo;
      readonly blockingCount: number;
      /** The measured class that made the window safe to act on. */
      readonly dialogClass: string;
    }
  /**
   * A blocking window is not a measured class. Nothing may be pressed; the
   * run is quarantined and reports `A8N-SEC-001`.
   */
  | {
      readonly kind: "quarantine";
      readonly index: number;
      readonly window: GuiWindowInfo;
      readonly code: "A8N-SEC-001";
    };

/**
 * Which window, if any, a recovery may act on.
 *
 * `index` is the window's 1-based position in the listing from
 * `MacGuiRecovery.listWindows()`: the press is addressed to that window, not
 * to "whatever window of the process happens to have an OK button first".
 *
 * If **any** blocking window is a sign-in or licence window, nothing is
 * pressed at all. Acting on a different window would still leave the human's
 * decision unanswered, and the next press could land on it. The same applies
 * to a window whose class has not been measured: unknown state is quarantine,
 * so an unclassified window anywhere in the list stops every press.
 */
export function chooseRecoveryWindow(windows: readonly GuiWindowInfo[]): RecoveryWindowChoice {
  const blocking = windows
    .map((window, index) => ({ window, index: index + 1 }))
    .filter(({ window }) => isBlockingWindow(window));
  if (blocking.length === 0) {
    return { kind: "none" };
  }
  const humanOnly = blocking.find(({ window }) => isHumanOnlyWindow(window));
  if (humanOnly !== undefined) {
    return { kind: "human-only", index: humanOnly.index, window: humanOnly.window };
  }
  const unknown = blocking.find(({ window }) => classifyDialog(window) === null);
  if (unknown !== undefined) {
    return {
      kind: "quarantine",
      index: unknown.index,
      window: unknown.window,
      code: "A8N-SEC-001",
    };
  }
  const first = blocking[0] as { window: GuiWindowInfo; index: number };
  const dialogClass = classifyDialog(first.window) as KnownDialogClass;
  return {
    kind: "known",
    index: first.index,
    window: first.window,
    blockingCount: blocking.length,
    dialogClass: dialogClass.name,
  };
}

export type MacHostRecoveryOptions = {
  /** The session the After Effects instance lives in. */
  readonly session: MacSession;
  /** The pid of the After Effects instance, when it is known. */
  readonly pid: () => number | null;
  /** Where a screenshot of the target session is written. */
  readonly screenshotDir: string;
  /** The buttons that may be pressed. */
  readonly buttons?: readonly string[];
};

/**
 * The GUI fallback for a macOS After Effects.
 *
 * Every action happens inside the host's own session, so a recovery can
 * never reach the console user's desktop.
 */
export class MacHostRecovery implements HostRecovery {
  readonly #session: MacSession;
  readonly #pid: () => number | null;
  readonly #screenshotDir: string;
  readonly #buttons: readonly string[];

  constructor(options: MacHostRecoveryOptions) {
    this.#session = options.session;
    this.#pid = options.pid;
    this.#screenshotDir = options.screenshotDir;
    this.#buttons = options.buttons ?? RECOVERY_BUTTONS;
  }

  attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    // The whole recovery is synchronous: every action is one Accessibility
    // query or one press inside the target session, each a blocking
    // `osascript`. It is deliberately not made asynchronous — the calls have
    // no interleaving that would be safe (a listing and the press that
    // depends on it must not be split by another action on the same screen),
    // and the cost is that the calling process's event loop is held for the
    // length of the attempt. That is acceptable for a recovery, which happens
    // once, after a timeout, and never as part of ordinary operation; a
    // caller that runs several sessions in one process sees their timers
    // late while it runs.
    return Promise.resolve(this.#attempt(context));
  }

  #attempt(context: RecoveryContext): RecoveryOutcome {
    const pid = this.#pid();
    if (pid === null) {
      return {
        recovered: false,
        outcome: "refused",
        evidence: `no After Effects process to recover: ${context.method} (${context.requestId}) timed out and no host process was found`,
      };
    }
    let gui: MacGuiRecovery;
    try {
      gui = new MacGuiRecovery({ session: this.#session, pid });
    } catch (error) {
      return {
        recovered: false,
        outcome: "refused",
        evidence: `no GUI recovery is possible: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let windows: readonly GuiWindowInfo[];
    try {
      windows = gui.listWindows().windows;
    } catch (error) {
      return {
        recovered: false,
        outcome: "refused",
        evidence: `the target session could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const choice = chooseRecoveryWindow(windows);
    if (choice.kind === "none") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} has no modal window; ${context.method} (${context.requestId}) timed out for another ` +
          "reason, and nothing was clicked",
      };
    }
    const window = choice.window;
    const screenshotPath = join(this.#screenshotDir, `recovery-${context.requestId}.png`);
    let shot: string | undefined;
    try {
      gui.capture(screenshotPath);
      shot = screenshotPath;
    } catch {
      // A screenshot that cannot be taken does not stop the recovery; the
      // accessibility report is the primary evidence.
    }
    const description = describeWindow(window);
    if (choice.kind === "human-only") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} shows "${description}", which is an Adobe account or licence window. ` +
          "No button was pressed: signing in, signing out or deactivating a device is a human's decision. " +
          "The host stays blocked until it is answered by hand.",
        ...(shot === undefined ? {} : { screenshotPath: shot }),
        window: description,
      };
    }
    if (choice.kind === "quarantine") {
      return {
        recovered: false,
        outcome: "quarantined",
        code: choice.code,
        evidence:
          `After Effects ${pid} shows "${description}", which is not a dialog class this project has measured. ` +
          `No button was pressed and no key was sent (${choice.code}). The state is unknown, so the run is ` +
          "quarantined: answer the window by hand and inspect the screenshot before continuing.",
        ...(shot === undefined ? {} : { screenshotPath: shot }),
        window: description,
      };
    }
    // The identity of the window that was chosen. The measured class has an
    // empty title, so its title/subrole cannot tell it from another
    // empty-title dialog; the text it says can, and it is the same text the
    // class was matched on. The press re-checks it inside the target session.
    const marker = window.texts.find((text) => /^\s*ae-a8n:/.test(text)) ?? "";
    for (const title of this.#buttons) {
      // One call for both cases: a button the listing showed and one it did
      // not both get the accessibility press first and the coordinate click
      // second. Reserving the fallback for buttons the listing lacked meant a
      // listed button whose AX press failed got no click, and the refusal
      // then claimed none of the buttons was available.
      if (gui.pressButtonIn(choice.index, title, window, marker)) {
        const others =
          choice.blockingCount > 1
            ? ` (${choice.blockingCount - 1} other modal window(s) were left untouched)`
            : "";
        return {
          recovered: true,
          outcome: "dismissed",
          evidence:
            `closed "${description}" (${choice.dialogClass}) by pressing "${title}" in ` +
            `${this.#session.username}'s session${others}`,
          ...(shot === undefined ? {} : { screenshotPath: shot }),
          window: description,
        };
      }
    }
    // There is deliberately no escape-key fallback. The key only reaches the
    // window that happens to be key, and a listing made a moment earlier
    // cannot prove that window is the one identified above. Pressing nothing
    // and reporting it is the only safe answer.
    return {
      recovered: false,
      outcome: "refused",
      evidence:
        `found "${description}" but pressed nothing: none of ${this.#buttons.join(", ")} was available, ` +
        "and no untargeted key was sent",
      ...(shot === undefined ? {} : { screenshotPath: shot }),
      window: description,
    };
  }
}
