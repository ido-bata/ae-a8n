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

import { DIALOG_TAXONOMY, dialogClassByName } from "../platform/dialog-taxonomy.js";
import type { DialogWindow } from "../platform/recovery-policy.js";
import {
  toExpectedModalWindow,
  type ExpectedModalMatch,
  type ExpectedModalRegistry,
} from "./expected-modals.js";
import type { WindowServerWindow } from "../platform/darwin/window-census.js";
import type { DialogReading } from "../platform/dialog-reading.js";
import {
  createTesseractOcr,
  type OcrRunner,
  type TesseractOcrOptions,
} from "../platform/darwin/ocr.js";
import {
  GuiAttributionError,
  GuiMutationError,
  GuiRecoveryError,
  MacGuiRecovery,
  isBlockingWindow,
  isPidAttributedWindow,
  type GuiWindowInfo,
} from "./gui-recovery.js";
import { errorMessage } from "../errors.js";
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
   * blocking window was not a measured class. Currently `"A8N-SEC-001"`,
   * or `"A8N-AE-004"` when the target process could not be re-proven.
   */
  readonly code?: "A8N-SEC-001" | "A8N-AE-004";
  /** What was seen and what was done, for the trace and for a human. */
  readonly evidence: string;
  /** A screenshot of the target session, when one was taken. */
  readonly screenshotPath?: string;
  /**
   * A second screenshot taken after a press was attempted (#342): the
   * before/after pair is the mutation evidence. Present only when a press
   * ran — refused outcomes have nothing to compare against.
   */
  readonly screenshotAfterPath?: string;
  /**
   * Why no screenshot exists when one was wanted (#342): the capture
   * failure is recorded, never silently absent. Absent when no blocking
   * window made a capture applicable.
   */
  readonly screenshotNote?: string;
  /** The window that was blocking, when one was found. */
  readonly window?: string;
  /**
   * The registered expected-modal spec that classified this window
   * (#342), when one matched. Its presence means the outcome was decided
   * by a caller-declared expectation, not by the measured taxonomy — the
   * trace and evidence manifest carry the name so the two are never
   * confused.
   */
  readonly expectedModal?: string;
  /**
   * The blocking window's taxonomy tier when the outcome classified one
   * (#342): feeds `classifyAnomaly` so the timeout report names the same
   * kind the recovery saw. Absent when no window was classified.
   */
  readonly dialogTier?: "auto-safe" | "human-required" | "report-only" | "unknown";
  /**
   * Per-window captures of census windows no AX window accounts for
   * (#451). Present only when the `kind: "none"` path found census
   * windows AX cannot see — the AX-invisible-modal evidence case that
   * used to return before any screenshot existed. Each entry records
   * either the captured image or the reason none exists; nothing here
   * is a mutation.
   */
  readonly censusCaptures?: readonly CensusWindowCapture[];
};

/**
 * One census window's capture attempt (#451). `window` describes the
 * WindowServer row honestly — including "possibly parked/offscreen — not
 * proven blocking" when `onScreen` is false; `path` is set only when the
 * image was actually written.
 */
export type CensusWindowCapture = {
  /** One-line description of the census window (layer/onScreen/name/bounds). */
  readonly window: string;
  /** The WindowServer window number `screencapture -l` addressed, when known. */
  readonly windowNumber: number | null;
  /** The captured image path, when the capture succeeded. */
  readonly path?: string;
  /** Why no image exists, when it does not. */
  readonly note?: string;
  /**
   * The dialog reading of this surface (#462), present only when the
   * recovery was built with `dialogOcr` and the OCR pass ran. Evidence
   * only — a reading never changes the recovery's decision, which was
   * already made before OCR ran.
   */
  readonly reading?: DialogReading;
};

export interface HostRecovery {
  attempt(context: RecoveryContext): Promise<RecoveryOutcome>;
}

/**
 * OCR options for the recovery evidence path (#462): the bounded
 * tesseract contract plus a cap on how many captured surfaces get read
 * per attempt.
 */
export type DialogOcrOptions = TesseractOcrOptions & {
  /** Captured surfaces OCR'd per attempt; default 8. */
  readonly maxReadings?: number;
};

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

/**
 * What a WindowServer census row says, in one line, for evidence (#451).
 * An off-screen row is labelled honestly — "possibly parked/offscreen —
 * not proven blocking" — because `onScreen: false` is exactly the shape
 * the AX-invisible modal took on the real host (issue #451).
 */
export function describeCensusWindow(window: WindowServerWindow): string {
  const parts = [`layer ${window.layer}`];
  parts.push(window.onScreen ? "on-screen" : "possibly parked/offscreen — not proven blocking");
  if (window.name !== "") {
    parts.push(`name "${window.name}"`);
  }
  if (window.bounds !== null) {
    parts.push(
      `${window.bounds.width}x${window.bounds.height} at ${window.bounds.x},${window.bounds.y}`,
    );
  }
  if (window.windowNumber != null) {
    parts.push(`window ${window.windowNumber}`);
  }
  return parts.join(", ");
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
 * Adapt the driver's window shape to the platform-neutral `DialogWindow`
 * the taxonomy matchers are written against. `blocking` is the caller's
 * measured answer (`isBlockingWindow`); the matchers never read it.
 */
function asDialogWindow(window: GuiWindowInfo): DialogWindow {
  return {
    title: window.title,
    role: window.role,
    subrole: window.subrole,
    texts: window.texts,
    buttons: window.buttons.map((button) => button.title),
    blocking: isBlockingWindow(window),
  };
}

/**
 * Dialog classes a recovery may press a button in.
 *
 * This list is deliberately short and is derived from the canonical
 * `DIALOG_TAXONOMY` registry (#284): only `auto-safe` entries appear here.
 * The one measured class is the native alert the run itself raises with
 * `ui.alert`: on the real host (2026-11-03, docs/offstage-macos.md §10.14)
 * it was an `AXWindow` / `AXDialog` with an empty title, the run's own
 * `ae-a8n:` message among its static texts, and an `OK` button; pressing
 * `OK` closed it and the original call completed.
 *
 * AE's start-up `警告` dialog is *not* here. Its Axis title is also empty, so
 * matching on shape alone would press it; what it says (a sign-in, licence or
 * script-permission decision) belongs to a human. It is therefore
 * unclassified, and the run is quarantined.
 */
export const KNOWN_DIALOG_CLASSES: readonly KnownDialogClass[] = DIALOG_TAXONOMY.filter(
  (spec) => spec.tier === "auto-safe",
).map((spec) => ({
  name: spec.name,
  matches: (window: GuiWindowInfo) => spec.matches(asDialogWindow(window)),
}));

/** The measured class a window belongs to, or null when it is unknown. */
export function classifyDialog(window: GuiWindowInfo): KnownDialogClass | null {
  return KNOWN_DIALOG_CLASSES.find((dialogClass) => dialogClass.matches(window)) ?? null;
}

/**
 * Dialog classes that are recognised by name but may never be pressed.
 *
 * Derived from the canonical `DIALOG_TAXONOMY` registry (#284): every
 * non-`auto-safe` entry lands here, so the crash repair options dialog, the
 * AppDirs/Required Dir startup warning, the crash-recovery project window,
 * the script file/network permission prompt, the script-error and
 * unsaved-changes dialogs, the multi-script contention dialog, and the
 * account/licence classes are all named for what they are. Each offers
 * choices — repair method, report submission, settings, a human decision —
 * that automation must not take, and none but the measured `ui.alert` has a
 * verified safe button. Naming them keeps the evidence specific; the
 * outcome is the same refusal an unclassified window gets, minus the
 * "unknown" claim.
 */
export type UnpressableDialogClass = {
  /** What the evidence calls this class. */
  readonly name: string;
  /** Why no button in it may be pressed automatically. */
  readonly reason: string;
  readonly matches: (window: GuiWindowInfo) => boolean;
};

export const UNPRESSABLE_DIALOG_CLASSES: readonly UnpressableDialogClass[] = DIALOG_TAXONOMY.filter(
  (spec) => spec.tier !== "auto-safe",
).map((spec) => ({
  name: spec.name,
  reason: spec.pressPolicy,
  matches: (window: GuiWindowInfo) => spec.matches(asDialogWindow(window)),
}));

/** The recognised-but-never-pressable class a window belongs to, or null. */
export function classifyUnpressable(window: GuiWindowInfo): UnpressableDialogClass | null {
  return UNPRESSABLE_DIALOG_CLASSES.find((dialogClass) => dialogClass.matches(window)) ?? null;
}

export type RecoveryWindowChoice =
  /** No window is blocking the host; nothing to press. */
  | { readonly kind: "none" }
  /** A blocking window belongs to a human; nothing may be pressed anywhere. */
  | { readonly kind: "human-only"; readonly index: number; readonly window: GuiWindowInfo }
  /**
   * A blocking window is a recognised class that may never be pressed
   * (crash repair, startup warning, recovery project). Nothing is pressed;
   * the run is refused with the class named.
   */
  | {
      readonly kind: "unpressable";
      readonly index: number;
      readonly window: GuiWindowInfo;
      readonly dialogClass: UnpressableDialogClass;
    }
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
    // Only pid-attributed windows are evidence (#330): on a multi-install
    // host the AX listing can enumerate ANOTHER same-bundle-id instance's
    // windows, and a foreign dialog must neither read as this instance's
    // blocker nor receive its press. The index is still the raw listing
    // position, so the press stays addressed to the same `windows of p`
    // entry the listing saw.
    .filter(
      ({ window }) => isBlockingWindow(window) && isPidAttributedWindow(window),
    );
  // An unmatched blocking window is not proven foreign — it is unproven,
  // and unproven is not "no blocker" (#332). A frameless or AX-phantom
  // dialog of THIS instance reads exactly like this, so it vetoes every
  // automatic press the way a human-only window does; only a census that
  // attributes ALL blocking windows keeps the measured-alert path open.
  // Positively foreign windows stay excluded above: they are another
  // instance's, not this one's, blocker.
  const unmatchedBlocking = windows.find(
    (window) => isBlockingWindow(window) && window.censusAttribution === "unmatched",
  );
  if (unmatchedBlocking !== undefined) {
    return {
      kind: "human-only",
      index: windows.indexOf(unmatchedBlocking) + 1,
      window: unmatchedBlocking,
    };
  }
  if (blocking.length === 0) {
    return { kind: "none" };
  }
  const humanOnly = blocking.find(({ window }) => isHumanOnlyWindow(window));
  if (humanOnly !== undefined) {
    return { kind: "human-only", index: humanOnly.index, window: humanOnly.window };
  }
  const unpressable = blocking
    .map(({ window, index }) => ({ window, index, dialogClass: classifyUnpressable(window) }))
    .find((entry) => entry.dialogClass !== null);
  if (unpressable !== undefined && unpressable.dialogClass !== null) {
    return {
      kind: "unpressable",
      index: unpressable.index,
      window: unpressable.window,
      dialogClass: unpressable.dialogClass,
    };
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

/**
 * The screenshot fields of a `RecoveryOutcome` (#342). Before/after capture
 * notes are merged into one `screenshotNote` so a double failure keeps both
 * reasons instead of the second overwriting the first.
 */
function screenshotFields(
  shot: string | undefined,
  shotNote: string | undefined,
  afterPath?: string,
  afterNote?: string,
): {
  screenshotPath?: string;
  screenshotAfterPath?: string;
  screenshotNote?: string;
} {
  const notes = [shotNote, afterNote].filter((note): note is string => note !== undefined);
  return {
    ...(shot === undefined ? {} : { screenshotPath: shot }),
    ...(afterPath === undefined ? {} : { screenshotAfterPath: afterPath }),
    ...(notes.length === 0 ? {} : { screenshotNote: notes.join("; ") }),
  };
}

export type MacHostRecoveryOptions = {
  /** The session the After Effects instance lives in. */
  readonly session: MacSession;
  /** The pid of the After Effects instance, when it is known. */
  readonly pid: () => number | null;
  /**
   * Whether that pid still names the process this run started, re-read
   * immediately before every GUI action the recovery takes. A pid alone
   * is not an identity: the process may have exited and the pid been
   * reused, and the Accessibility query matches on pid alone.
   */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /** Where a screenshot of the target session is written. */
  readonly screenshotDir: string;
  /** The buttons that may be pressed. */
  readonly buttons?: readonly string[];
  /**
   * Session-registered expected modals (#342). When a blocking window that
   * is not a measured class matches a registration, the expectation's
   * resolution decides — `press` through the same audited path, `wait`
   * leaving the modal for its owner. Absent means every unmeasured window
   * keeps the quarantine classification.
   */
  readonly expectedModals?: ExpectedModalRegistry | undefined;
  /**
   * Dialog perception for census-window captures (#462,
   * specs/dialog-perception/spec.md §5). When present, each successfully
   * captured `axUnaccountedCensusWindows` image is run through bounded
   * OCR *after* the recovery decision — the reading lands on
   * `CensusWindowCapture.reading` as evidence. Absent (the default)
   * keeps the #451 capture-only behaviour: no OCR cost, no readings.
   * Evidence-only: a reading never changes `chooseRecoveryWindow`'s
   * verdict, which is computed before OCR runs.
   */
  readonly dialogOcr?: DialogOcrOptions | undefined;
  /**
   * Test seam: replaces the `MacGuiRecovery` the attempt builds. The
   * surface is the three calls an attempt makes — list, capture, press —
   * so a fake can drive every classification and fault path without a
   * real Accessibility session.
   */
  readonly gui?: GuiRecoverySurface | undefined;
};

/**
 * The slice of `MacGuiRecovery` a recovery attempt uses. Defined as a
 * structural type so tests can substitute a fake without subclassing.
 */
export type GuiRecoverySurface = Pick<
  MacGuiRecovery,
  "listWindows" | "capture" | "pressButtonIn"
> & {
  /**
   * Optional single-window capture (#451): the AX-invisible evidence path
   * addresses one census window by its WindowServer window number. A
   * surface without it records each row as uncapturable — never guessed.
   */
  readonly captureWindowById?: MacGuiRecovery["captureWindowById"];
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
  readonly #verifyProcess: ((pid: number) => boolean) | undefined;
  readonly #screenshotDir: string;
  readonly #buttons: readonly string[];
  readonly #expectedModals: ExpectedModalRegistry | undefined;
  readonly #dialogOcr: DialogOcrOptions | undefined;
  readonly #gui: GuiRecoverySurface | undefined;
  #ocrRunner: OcrRunner | null = null;

  constructor(options: MacHostRecoveryOptions) {
    this.#session = options.session;
    this.#pid = options.pid;
    this.#verifyProcess = options.verifyProcess;
    this.#screenshotDir = options.screenshotDir;
    this.#buttons = options.buttons ?? RECOVERY_BUTTONS;
    this.#expectedModals = options.expectedModals;
    this.#dialogOcr = options.dialogOcr;
    this.#gui = options.gui;
  }

  attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    // The decision half of the recovery is synchronous: every action is
    // one Accessibility query or one press inside the target session,
    // each a blocking `osascript`. It is deliberately not made
    // asynchronous — the calls have no interleaving that would be safe
    // (a listing and the press that depends on it must not be split by
    // another action on the same screen). The dialog-perception OCR pass
    // (#462) runs *after* the decision as a bounded subprocess, so it
    // adds latency to the evidence, never to the press ordering; a
    // caller that runs several sessions in one process sees their
    // timers late while it runs.
    return Promise.resolve()
      .then(() => this.#attempt(context))
      .then((outcome) => this.#annotateDialogReadings(outcome));
  }

  /**
   * OCR each captured census window and attach its `DialogReading`
   * (#462). Runs only when `dialogOcr` was configured and the outcome
   * carries census captures — the `kind: "none"` path, which has no
   * press to interleave with. Capped so a pathological census cannot
   * turn one recovery into an unbounded OCR queue; unread surfaces past
   * the cap simply carry no `reading`.
   */
  async #annotateDialogReadings(outcome: RecoveryOutcome): Promise<RecoveryOutcome> {
    const captures = outcome.censusCaptures;
    if (this.#dialogOcr === undefined || captures === undefined) {
      return outcome;
    }
    const pid = this.#pid();
    if (pid === null) {
      return outcome;
    }
    this.#ocrRunner ??= createTesseractOcr(this.#dialogOcr);
    const ocr = this.#ocrRunner;
    const maxReadings = this.#dialogOcr.maxReadings ?? 8;
    const annotated: CensusWindowCapture[] = [];
    let reads = 0;
    for (const capture of captures) {
      if (
        reads >= maxReadings ||
        capture.path === undefined ||
        capture.windowNumber === null
      ) {
        annotated.push(capture);
        continue;
      }
      reads += 1;
      annotated.push({
        ...capture,
        reading: await this.#readCapture(
          pid,
          capture.windowNumber ?? 0,
          capture.path,
          ocr,
        ),
      });
    }
    return { ...outcome, censusCaptures: annotated };
  }

  /**
   * One bounded OCR pass over an already-captured window PNG. Every
   * failure mode — engine absent, timeout, empty text — becomes an
   * honest `unreadable`/`partial` reading; nothing throws.
   */
  async #readCapture(
    pid: number,
    windowNumber: number,
    capturePath: string,
    ocr: OcrRunner,
  ): Promise<DialogReading> {
    const surfaceId = `census:${windowNumber}`;
    const result = await ocr(capturePath);
    const summary = {
      engine: result.engine,
      languages: result.languages,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
    const text = result.text?.trim() ?? "";
    const base = {
      pid,
      surfaceId,
      buttons: [],
      modality: "unknown" as const,
      evidence: { capturePath, ocr: summary },
    };
    if (!result.ok) {
      return {
        ...base,
        source: "pixels",
        confidence: "unreadable",
        unreadableReason: result.timedOut
          ? `OCR timed out: ${result.reason ?? "killed at the timeout"}`
          : `OCR failed: ${result.reason ?? "unknown engine error"}`,
      };
    }
    if (text === "") {
      return {
        ...base,
        source: "pixels",
        confidence: "unreadable",
        unreadableReason:
          "OCR ran but the capture held no recognizable text (blank or fully transparent surface)",
      };
    }
    return {
      ...base,
      source: "pixels",
      bodyText: text.slice(0, 4_000),
      confidence: "partial",
    };
  }

  #attempt(context: RecoveryContext): RecoveryOutcome {
    const pid = this.#pid();
    if (pid === null) {
      return {
        recovered: false,
        outcome: "refused",
        code: "A8N-AE-004",
        evidence: `no After Effects process this run started could be tied to it: ${context.method} (${context.requestId}) timed out and no host process was found`,
      };
    }
    let gui: GuiRecoverySurface;
    if (this.#gui !== undefined) {
      gui = this.#gui;
    } else {
      try {
        gui = new MacGuiRecovery({
          session: this.#session,
          pid,
          ...(this.#verifyProcess === undefined ? {} : { verifyProcess: this.#verifyProcess }),
        });
      } catch (error) {
        return {
          recovered: false,
          outcome: "refused",
          ...(error instanceof GuiRecoveryError && error.code !== undefined ? { code: error.code } : {}),
          evidence: `no GUI recovery is possible: ${errorMessage(error)}`,
        };
      }
    }
    let state: ReturnType<MacGuiRecovery["listWindows"]>;
    try {
      state = gui.listWindows();
    } catch (error) {
      return {
        recovered: false,
        outcome: "refused",
        ...(error instanceof GuiRecoveryError && error.code !== undefined ? { code: error.code } : {}),
        evidence: `the target session could not be inspected: ${errorMessage(error)}`,
      };
    }
    const windows = state.windows;
    const choice = chooseRecoveryWindow(windows);
    if (choice.kind === "none") {
      // AX-empty is not proof of a clean screen: when the WindowServer census
      // lists windows for this pid, the AX tree is unserviceable and "no
      // modal window" cannot be concluded. Still refuse and click nothing —
      // the evidence just stops claiming what it cannot know.
      // AX windows the census could not attribute to this pid are not
      // evidence either way (#330): they are named here so "no modal
      // window" never silently hides that part of the listing was
      // untrusted.
      const unattributed =
        state.axForeignWindowCount + state.axUnmatchedWindowCount > 0
          ? ` The AX listing also held ${state.axForeignWindowCount} window(s) belonging to ` +
            `other processes and ${state.axUnmatchedWindowCount} unattributed window(s); ` +
            "those were excluded as untrusted (#330)."
          : "";
      const evidence = state.axSuspect
        ? `After Effects ${pid}: the Accessibility API reported no window attributable to this ` +
          `process, but the window server lists ` +
          `${state.windowServer.windowCount} window(s) for it (${state.windowServer.onScreenCount} on-screen) — ` +
          `the AX tree is not answering, so whether a modal window is up cannot be determined. ` +
          `${context.method} (${context.requestId}) timed out; nothing was clicked${unattributed}`
        : state.windowServer.available === false
          ? `After Effects ${pid}: window observation is degraded (${state.windowServer.reason ?? "census unavailable"}) ` +
            `and the Accessibility API reported no windows; ${context.method} (${context.requestId}) timed out for ` +
            `another reason, and nothing was clicked${unattributed}`
          : `After Effects ${pid} has no modal window; ${context.method} (${context.requestId}) timed out for another ` +
            `reason, and nothing was clicked${unattributed}`;
      // AX-blind but census-positive (#451): this branch used to return
      // before any capture ran, so the case that most needed images — an
      // AX-invisible surface — produced none. Take the session screenshot
      // and one `captureWindowById` per census window AX cannot account
      // for. Read-only observation: no lease, no press, no new mutation
      // authority. Every failure is recorded per window, never dropped.
      const censusTargets = state.axUnaccountedCensusWindows;
      const wantsCapture = state.axSuspect || censusTargets.length > 0;
      let shot: string | undefined;
      let shotNote: string | undefined;
      const censusCaptures: CensusWindowCapture[] = [];
      if (wantsCapture) {
        const screenshotPath = join(
          this.#screenshotDir,
          `recovery-${context.requestId}.png`,
        );
        try {
          gui.capture(screenshotPath);
          shot = screenshotPath;
        } catch (error) {
          shotNote = `screen capture failed: ${errorMessage(error)}`;
        }
        for (const ws of censusTargets) {
          censusCaptures.push(this.#captureCensusWindow(gui, context, ws));
        }
      }
      const captured = censusCaptures.filter((c) => c.path !== undefined).length;
      const captureNote =
        censusCaptures.length === 0
          ? ""
          : ` ${censusCaptures.length} WindowServer window(s) for this pid are invisible to AX ` +
            `(possibly parked/offscreen — not proven blocking); ${captured} window image(s) ` +
            "were captured and the rest are recorded per window with the reason.";
      return {
        recovered: false,
        outcome: "refused",
        evidence: `${evidence}${captureNote}`,
        ...screenshotFields(shot, shotNote),
        ...(censusCaptures.length === 0 ? {} : { censusCaptures }),
      };
    }
    const window = choice.window;
    const screenshotPath = join(this.#screenshotDir, `recovery-${context.requestId}.png`);
    let shot: string | undefined;
    let shotNote: string | undefined;
    try {
      gui.capture(screenshotPath);
      shot = screenshotPath;
    } catch (error) {
      // A screenshot that cannot be taken does not stop the recovery; the
      // accessibility report is the primary evidence. The failure is
      // recorded on the outcome (#342) so "no image" is never silent.
      shotNote = `screen capture failed: ${errorMessage(error)}`;
    }
    const shotFields = () => screenshotFields(shot, shotNote);
    const description = describeWindow(window);
    if (choice.kind === "human-only") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} shows "${description}", which is an Adobe account or licence window. ` +
          "No button was pressed: signing in, signing out or deactivating a device is a human's decision. " +
          "The host stays blocked until it is answered by hand.",
        ...shotFields(),
        dialogTier: "human-required",
        window: description,
      };
    }
    // Expected-modal registration (#342): a window the measured taxonomy
    // would refuse or quarantine may instead be resolved by a
    // caller-declared expectation. `human-only` never reaches this point —
    // an account/licence decision is not pressable through registration.
    if (
      (choice.kind === "unpressable" || choice.kind === "quarantine") &&
      this.#expectedModals !== undefined
    ) {
      const match = this.#expectedModals.match(toExpectedModalWindow(window));
      if (match !== null) {
        return this.#resolveExpected(
          gui,
          context,
          pid,
          choice.index,
          window,
          description,
          match,
          shot,
          shotNote,
        );
      }
    }
    if (choice.kind === "unpressable") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} shows "${description}", which is the ${choice.dialogClass.name} dialog. ` +
          `No button was pressed: ${choice.dialogClass.reason}. ` +
          "The host stays blocked until it is answered by hand.",
        ...shotFields(),
        dialogTier: dialogClassByName(choice.dialogClass.name)?.tier ?? "human-required",
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
        ...shotFields(),
        dialogTier: "unknown",
        window: description,
      };
    }
    // The identity of the window that was chosen. The measured class has an
    // empty title, so its title/subrole cannot tell it from another
    // empty-title dialog; the text it says can, and it is the same text the
    // class was matched on. The press re-checks it inside the target session.
    const marker = window.texts.find((text) => /^\s*ae-a8n:/.test(text)) ?? "";
    return this.#pressButtons({
      gui,
      context,
      pid,
      windowIndex: choice.index,
      window,
      description,
      marker,
      buttons: this.#buttons,
      classLabel: choice.dialogClass,
      dialogTier: "auto-safe",
      blockingCount: choice.blockingCount,
      shot,
      shotNote,
      screenshotDir: this.#screenshotDir,
      requestId: context.requestId,
    });
  }

  /**
   * One census window's capture attempt (#451). The window is addressed
   * by its WindowServer window number — the handle `screencapture -l`
   * takes — which needs no Accessibility at all, so it works exactly
   * where the AX tree does not. A row without a window number, or a
   * surface that cannot capture single windows, is recorded as
   * uncapturable with the reason; a failed capture likewise. Nothing
   * here mutates the host.
   */
  #captureCensusWindow(
    gui: GuiRecoverySurface,
    context: RecoveryContext,
    ws: WindowServerWindow,
  ): CensusWindowCapture {
    const window = describeCensusWindow(ws);
    const windowNumber = ws.windowNumber ?? null;
    if (windowNumber === null) {
      return { window, windowNumber: null, note: "the census row carries no window number" };
    }
    if (gui.captureWindowById === undefined) {
      return {
        window,
        windowNumber,
        note: "this GUI surface cannot capture a single window",
      };
    }
    const path = join(
      this.#screenshotDir,
      `recovery-${context.requestId}-window-${windowNumber}.png`,
    );
    try {
      gui.captureWindowById(path, windowNumber);
      return { window, windowNumber, path };
    } catch (error) {
      return {
        window,
        windowNumber,
        note: `window capture failed: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * Applies a matched expected-modal resolution (#342).
   *
   * `wait` — the default — records the modal as expected and presses
   * nothing: the window belongs to its registered owner, and the original
   * request keeps its bounded wait. `press` sends exactly the declared
   * button through `#pressButtons`, the same lease/audit/attribution path
   * the measured class uses; the evidence names the expectation so a
   * registered press is never mistaken for a measured one.
   */
  #resolveExpected(
    gui: GuiRecoverySurface,
    context: RecoveryContext,
    pid: number,
    windowIndex: number,
    window: GuiWindowInfo,
    description: string,
    match: ExpectedModalMatch,
    shot: string | undefined,
    shotNote: string | undefined,
  ): RecoveryOutcome {
    const name = `expected modal "${match.spec.name}"`;
    if (match.resolution.kind === "wait") {
      return {
        recovered: false,
        outcome: "refused",
        expectedModal: match.spec.name,
        evidence:
          `After Effects ${pid} shows "${description}", which a registered expectation ` +
          `(${name}) declares expected. No button was pressed: the modal is left for its ` +
          "registered owner while the original request keeps its bounded wait. " +
          "Unregister the expectation or resolve the window to let the standard path decide.",
        ...screenshotFields(shot, shotNote),
        window: description,
      };
    }
    const marker = window.texts.find((text) => /^\s*ae-a8n:/.test(text)) ?? "";
    return this.#pressButtons({
      gui,
      context,
      pid,
      windowIndex,
      window,
      description,
      marker,
      buttons: [match.resolution.button],
      classLabel: name,
      blockingCount: 1,
      shot,
      shotNote,
      screenshotDir: this.#screenshotDir,
      requestId: context.requestId,
      expectedModal: match.spec.name,
    });
  }

  /**
   * Presses each candidate button in the chosen window through the audited
   * path and shapes the outcome. Shared by the measured-class path and the
   * expected-modal path (#342) so both record identical evidence: a
   * successful press is `dismissed`, an uncertain mutation is
   * `quarantined`, and every refusal says what stopped it. When a press was
   * attempted, a second screenshot is taken for the before/after pair.
   */
  #pressButtons(input: {
    gui: GuiRecoverySurface;
    context: RecoveryContext;
    pid: number;
    windowIndex: number;
    window: GuiWindowInfo;
    description: string;
    marker: string;
    buttons: readonly string[];
    /** What authorised the press, for evidence: a measured class or `expected modal "…"`. */
    classLabel: string;
    /** The window's taxonomy tier for anomaly classification (#342). */
    dialogTier?: "auto-safe" | "human-required" | "report-only" | "unknown";
    blockingCount: number;
    shot: string | undefined;
    shotNote: string | undefined;
    screenshotDir: string;
    requestId: string;
    expectedModal?: string;
  }): RecoveryOutcome {
    const { gui, pid, window, description } = input;
    const afterShot = join(input.screenshotDir, `recovery-${input.requestId}-after.png`);
    const captureAfter = (): { path?: string; note?: string } => {
      try {
        gui.capture(afterShot);
        return { path: afterShot };
      } catch (error) {
        return { note: `post-press capture failed: ${errorMessage(error)}` };
      }
    };
    const expectedFields = () => ({
      ...(input.expectedModal === undefined ? {} : { expectedModal: input.expectedModal }),
      ...(input.dialogTier === undefined ? {} : { dialogTier: input.dialogTier }),
    });
    let leaseRefusal: string | null = null;
    let attributionRefusal: string | null = null;
    let refusalCode: "A8N-AE-004" | undefined;
    let unknownMutation: string | null = null;
    for (const title of input.buttons) {
      // One call for both cases: a button the listing showed and one it did
      // not both get the accessibility press first and the coordinate click
      // second. Reserving the fallback for buttons the listing lacked meant a
      // listed button whose AX press failed got no click, and the refusal
      // then claimed none of the buttons was available.
      let pressed: boolean;
      try {
        pressed = gui.pressButtonIn(input.windowIndex, title, window, input.marker);
      } catch (error) {
        if (error instanceof GuiMutationError) {
          // The press may already have reached the dialog: the screen state
          // is unknown, so this is quarantine — never "nothing was done",
          // and never a retry.
          unknownMutation = error.message;
        } else if (error instanceof GuiAttributionError) {
          // The window's pid attribution could not be proven (#330): the
          // refusal was raised before the lease and before any session
          // command, so nothing was pressed — but it is NOT a lease
          // problem, and saying so would send the reader the wrong way.
          attributionRefusal = errorMessage(error);
        } else {
          // A refused GUI lease is not "the button was unavailable": another
          // owner holds the session's mutation lease. Report who, and stop —
          // retrying under a held lease is exactly the contention it prevents.
          // Any other pre-mutation GuiRecoveryError (session entry, listing
          // mismatch, a failed process-identity re-check) also means nothing
          // was pressed.
          leaseRefusal = errorMessage(error);
          refusalCode = error instanceof GuiRecoveryError ? error.code : undefined;
        }
        break;
      }
      if (pressed) {
        const after = captureAfter();
        const others =
          input.blockingCount > 1
            ? ` (${input.blockingCount - 1} other modal window(s) were left untouched)`
            : "";
        return {
          recovered: true,
          outcome: "dismissed",
          evidence:
            `closed "${description}" (${input.classLabel}) by pressing "${title}" in ` +
            `${this.#session.username}'s session${others}`,
          ...screenshotFields(input.shot, input.shotNote, after.path, after.note),
          ...expectedFields(),
          window: description,
        };
      }
    }
    if (unknownMutation !== null) {
      const after = captureAfter();
      return {
        recovered: false,
        outcome: "quarantined",
        code: "A8N-SEC-001",
        evidence:
          `After Effects ${pid} shows "${description}", and the press attempt ended with an ` +
          `unknown result: ${unknownMutation}. Whether the button was pressed cannot be ` +
          "determined from here, so the run is quarantined: re-observe the screen before " +
          "retrying anything, and do not assume the dialog is still up or already gone.",
        ...screenshotFields(input.shot, input.shotNote, after.path, after.note),
        ...expectedFields(),
        window: description,
      };
    }
    if (attributionRefusal !== null) {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} shows "${description}", but no GUI mutation was attempted: ` +
          `${attributionRefusal}. The window could not be proven to belong to this ` +
          "After Effects instance, so nothing was pressed — pressing it could have " +
          "clicked another instance's dialog.",
        ...screenshotFields(input.shot, input.shotNote),
        ...expectedFields(),
        window: description,
      };
    }
    if (leaseRefusal !== null) {
      return {
        recovered: false,
        outcome: "refused",
        ...(refusalCode === undefined ? {} : { code: refusalCode }),
        evidence:
          refusalCode === "A8N-AE-004"
            ? `After Effects ${pid} shows "${description}", but no GUI mutation was attempted: ` +
              `${leaseRefusal}. The pid no longer provably names the process this run started, ` +
              "so nothing was pressed and nothing will be until the target can be re-verified."
            : `After Effects ${pid} shows "${description}", but no GUI mutation was attempted: ` +
              `${leaseRefusal}. The dialog stays up until the lease holder finishes or the lease is reaped.`,
        ...screenshotFields(input.shot, input.shotNote),
        ...expectedFields(),
        window: description,
      };
    }
    // There is deliberately no escape-key fallback. The key only reaches the
    // window that happens to be key, and a listing made a moment earlier
    // cannot prove that window is the one identified above. Pressing nothing
    // and reporting it is the only safe answer.
    return {
      recovered: false,
      outcome: "refused",
      evidence:
        `found "${description}" but pressed nothing: none of ${input.buttons.join(", ")} was available, ` +
        "and no untargeted key was sent",
      ...screenshotFields(input.shot, input.shotNote),
      ...expectedFields(),
      window: description,
    };
  }
}
