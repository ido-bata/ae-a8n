/**
 * Read-only GUI observation for `ae.guiState()` (#109).
 *
 * This is the observation half of the macOS GUI recovery, exposed without
 * the press path: it lists the owned After Effects instance's windows inside
 * that instance's own session, classifies each blocking window against the
 * platform-neutral recovery policy, and reports the aggregate verdict. It
 * never presses a button, never takes the mutation lease, and never writes
 * to the screen — `MacGuiRecovery.listWindows` is audited as `observe`.
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
  MacGuiRecovery,
  type GuiAppState,
  type GuiRecoveryOptions,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { MacSessionError, type MacSession } from "../driver/mac-session.js";
import {
  chooseAction,
  classifyDialog,
  isHumanOnlyWindow,
  type DialogWindow,
} from "../platform/recovery-policy.js";
import type {
  GuiAssessment,
  GuiSessionInfo,
  GuiStateObservation,
  GuiStateOptions,
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
  "census" | "censusRun" | "stateRoot" | "ownerId" | "lease" | "runSession"
>;

function toDialogWindow(window: GuiWindowInfo): DialogWindow {
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
 * The per-window verdict. Human-only is checked before the measured classes,
 * matching `chooseAction`: a window that is both must still be reported as a
 * human's decision, never as something a recovery could press.
 */
export function classifyGuiWindow(window: GuiWindowInfo): GuiWindowClassification {
  if (!isBlockingWindow(window)) {
    return { kind: "not-blocking" };
  }
  const dialog = toDialogWindow(window);
  const classified = classifyDialog(dialog);
  if (isHumanOnlyWindow(dialog)) {
    return {
      kind: "human-only",
      dialogClass: classified.kind === "known" ? classified.dialogClass.name : null,
      code: classified.kind === "known" ? (classified.dialogClass.code ?? "A8N-SEC-001") : "A8N-SEC-001",
    };
  }
  if (classified.kind === "known") {
    return {
      kind: "measured",
      dialogClass: classified.dialogClass.name,
      presses: classified.dialogClass.presses,
      code: classified.dialogClass.code,
    };
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
    blocking: isBlockingWindow(window),
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

/** The aggregate verdict over the same windows, from the canonical policy. */
export function assessGuiWindows(windows: readonly GuiWindowInfo[]): GuiAssessment {
  const decision = chooseAction(windows.map(toDialogWindow));
  return { action: decision.action, code: decision.code, detail: decision.detail };
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
    windowServer: {
      available: state.windowServer.available,
      reason: state.windowServer.reason,
      windowCount: state.windowServer.windowCount,
      onScreenCount: state.windowServer.onScreenCount,
    },
    axSuspect: state.axSuspect,
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

/**
 * The `ae.guiState()` body: attest the owned target, observe (or use the
 * caller's prepared observation), and shape the report. Observation
 * failures become `unavailable` with the reason — a report that cannot see
 * the screen must never look like a clean one.
 */
export function guiStateReport(
  target: GuiObservationTarget | null,
  options: GuiStateOptions,
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
    const state = options.observed ?? observeGuiAppState(target, seams);
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
