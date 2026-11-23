/**
 * Read-only GUI observation for `ae.guiState()` (#109).
 *
 * This is the observation half of the macOS GUI recovery, exposed without
 * the press path: it lists the owned After Effects instance's windows inside
 * that instance's own session, classifies each blocking window with the
 * same classifiers `session.recover` uses (`classifyDialog`,
 * `classifyUnpressable`, `isHumanOnlyWindow`, `chooseRecoveryWindow`), and
 * reports the verdict recovery would reach. It never presses a button,
 * never takes the mutation lease, and never writes to the screen —
 * `MacGuiRecovery.listWindows` is audited as `observe`.
 *
 * The observation runs in the console session too when that is where the
 * owned host lives: reading windows cannot move the user's cursor or take
 * their focus, so the console-session refusal that guards *mutations* does
 * not apply here. The first query in a session may raise the standard
 * macOS Accessibility consent prompt — a human decision, never bypassed.
 */

import {
  GuiRecoveryError,
  isBlockingWindow,
  isPidAttributedWindow,
  MacGuiRecovery,
  type GuiAppState,
  type GuiRecoveryOptions,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { MacSessionError, type MacSession } from "../driver/mac-session.js";
import {
  chooseRecoveryWindow,
  classifyDialog,
  classifyUnpressable,
  describeWindow,
  isHumanOnlyWindow,
} from "../driver/recovery.js";
import type {
  GuiAssessment,
  GuiSessionInfo,
  GuiStateObservation,
  GuiStateReport,
  GuiWindowClassification,
  GuiWindowReport,
} from "./types.js";

/** The attested target `driver.recoveryTarget()` proves for this session. */
export type GuiObservationTarget = {
  readonly pid: number;
  readonly session: MacSession;
};

/** Seams forwarded to `MacGuiRecovery`; mainly for tests. */
export type GuiObservationSeams = Pick<
  GuiRecoveryOptions,
  "census" | "censusRun" | "stateRoot" | "ownerId" | "lease" | "runSession" |
  "readTargetSession" | "consoleUid"
>;

/**
 * The per-window verdict, in the same precedence `chooseRecoveryWindow`
 * applies across the whole list: a human-only window is a human's decision
 * even when it also matches a measured or unpressable class.
 */
export function classifyGuiWindow(window: GuiWindowInfo): GuiWindowClassification {
  // A window the census cannot attribute to this pid is not this
  // instance's blocker (#330): foreign and unmatched AX windows are
  // excluded from every blocking verdict, exactly as
  // `chooseRecoveryWindow` excludes them.
  if (!isBlockingWindow(window) || !isPidAttributedWindow(window)) {
    return { kind: "not-blocking" };
  }
  const unpressable = classifyUnpressable(window);
  const known = classifyDialog(window);
  if (isHumanOnlyWindow(window)) {
    return {
      kind: "human-only",
      dialogClass: unpressable?.name ?? known?.name ?? null,
    };
  }
  if (unpressable !== null) {
    return {
      kind: "unpressable",
      dialogClass: unpressable.name,
      reason: unpressable.reason,
    };
  }
  if (known !== null) {
    return { kind: "pressable", dialogClass: known.name };
  }
  return { kind: "unknown", code: "A8N-SEC-001" };
}

function toWindowReport(window: GuiWindowInfo, index: number): GuiWindowReport {
  return {
    index,
    title: window.title,
    role: window.role,
    subrole: window.subrole,
    texts: window.texts,
    buttons: window.buttons.map((button) => button.title),
    blocking: isBlockingWindow(window) && isPidAttributedWindow(window),
    frame: window.frame ?? null,
    censusAttribution: window.censusAttribution ?? null,
    classification: classifyGuiWindow(window),
  };
}

function sessionInfo(session: MacSession): GuiSessionInfo {
  return {
    uid: session.uid,
    username: session.username,
    asid: session.asid,
    kind: session.kind,
  };
}

/** The aggregate verdict over the same windows `session.recover` would see. */
export function assessGuiWindows(windows: readonly GuiWindowInfo[]): GuiAssessment {
  const choice = chooseRecoveryWindow(windows);
  const window = "window" in choice ? describeWindow(choice.window) : null;
  switch (choice.kind) {
    case "none":
      return { action: "none", code: null, detail: "no blocking window was observed", window: null };
    case "human-only":
      return {
        action: "human-only",
        code: null,
        detail:
          `"${describeWindow(choice.window)}" is an Adobe account or licence window; ` +
          "a human must answer it — a recovery would press nothing",
        window,
      };
    case "unpressable":
      return {
        action: "unpressable",
        code: null,
        detail:
          `"${describeWindow(choice.window)}" is the ${choice.dialogClass.name} dialog; ` +
          `a recovery would press nothing: ${choice.dialogClass.reason}`,
        window,
      };
    case "known":
      return {
        action: "known",
        code: null,
        detail:
          `every blocking window is a measured class (${choice.dialogClass}); ` +
          "a recovery could press the safe button",
        window,
      };
    case "quarantine":
      return {
        action: "quarantine",
        code: choice.code,
        detail:
          `"${describeWindow(choice.window)}" is not a dialog class this project has measured; ` +
          "a recovery would quarantine the run and press nothing",
        window,
      };
  }
}

/**
 * Turn a completed observation into the public report. Pure — the session
 * query lives in `observeGuiAppState`.
 */
export function guiStateObservation(
  target: GuiObservationTarget,
  state: GuiAppState,
  observedAt: string,
): GuiStateObservation {
  return {
    pid: state.pid,
    session: sessionInfo(target.session),
    frontmost: state.frontmost,
    windows: state.windows.map((window, index) => toWindowReport(window, index + 1)),
    windowServer: state.windowServer,
    axSuspect: state.axSuspect,
    axUnaccountedWindows: state.axUnaccountedWindows.map((ws) => ({
      layer: ws.layer,
      onScreen: ws.onScreen,
      name: ws.name,
      bounds: ws.bounds,
    })),
    axForeignWindowCount: state.axForeignWindowCount,
    axUnmatchedWindowCount: state.axUnmatchedWindowCount,
    assessment: assessGuiWindows(state.windows),
    observedAt,
  };
}

/**
 * List the target's windows inside its own session. Throws
 * `GuiRecoveryError`/`MacSessionError` when the session cannot be entered
 * or the listing fails — the caller reports that as `unavailable`, never
 * as an empty window list.
 */
export function observeGuiAppState(
  target: GuiObservationTarget,
  seams: GuiObservationSeams = {},
): GuiAppState {
  const gui = new MacGuiRecovery({
    session: target.session,
    pid: target.pid,
    // Observation is read-only: the console-session refusal exists to keep
    // *mutations* off the screen the human is using, and nothing here
    // reaches it.
    allowConsoleSession: true,
    ...seams,
  });
  return gui.listWindows();
}

/** Test seam: a prepared observation, skipping the session query. */
export type GuiStateFixture = {
  readonly observed: GuiAppState;
};

/**
 * The `ae.guiState()` body: attest the owned target, observe (or use a
 * prepared fixture), and shape the report. Observation failures become
 * `unavailable` with the reason — a report that cannot see the screen must
 * never look like a clean one.
 */
export function guiStateReport(
  target: GuiObservationTarget | null,
  fixture?: GuiStateFixture,
  seams: GuiObservationSeams = {},
): GuiStateReport {
  const observedAt = new Date().toISOString();
  if (target === null) {
    return {
      status: "unavailable",
      reason:
        "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window list to report",
      observedAt,
    };
  }
  try {
    const state = fixture?.observed ?? observeGuiAppState(target, seams);
    return { status: "observed", ...guiStateObservation(target, state, observedAt) };
  } catch (error) {
    if (error instanceof GuiRecoveryError || error instanceof MacSessionError) {
      return {
        status: "unavailable",
        reason: error.message,
        observedAt,
      };
    }
    throw error;
  }
}
