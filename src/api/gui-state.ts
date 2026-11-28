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
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chooseRecoveryWindow,
  classifyDialog,
  classifyUnpressable,
  describeWindow,
  isHumanOnlyWindow,
} from "../driver/recovery.js";
import { createTesseractOcr, type OcrRunner } from "../platform/darwin/ocr.js";
import {
  enumerateDialogSurfaces,
  readDialogSurfaces,
  type DialogPerceptionDeps,
} from "../platform/darwin/dialog-perception.js";
import type { DialogReading } from "../platform/dialog-reading.js";
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
  "census" | "censusRun" | "stateRoot" | "ownerId" | "lease" | "runSession" |
  "readTargetSession" | "consoleUid"
> & {
  /**
   * Dialog-perception seams (#462), used only when `readings` is
   * requested: a substitute window capture and/or OCR runner for tests.
   * Production leaves both unset — the real `captureWindowById` and the
   * bounded tesseract runner apply.
   */
  readonly captureWindow?: DialogPerceptionDeps["captureWindow"];
  readonly ocr?: OcrRunner;
  /** Where perception capture PNGs land; defaults under stateRoot/tmpdir. */
  readonly evidenceDir?: string;
  readonly maxPixelReads?: number;
};

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
  dialogReadings?: readonly DialogReading[],
): GuiStateObservation {
  return {
    pid: state.pid,
    session: sessionInfo(target.session),
    frontmost: state.frontmost,
    windows: state.windows.map((window, index) => toWindowReport(window, index + 1)),
    windowServer: state.windowServer,
    axSuspect: state.axSuspect,
    axSuspectReason: state.axSuspectReason,
    axUnaccountedWindows: state.axUnaccountedWindows.map((ws) => ({
      layer: ws.layer,
      onScreen: ws.onScreen,
      name: ws.name,
      bounds: ws.bounds,
    })),
    axUnaccountedCensusWindows: state.axUnaccountedCensusWindows.map((ws) => ({
      layer: ws.layer,
      onScreen: ws.onScreen,
      name: ws.name,
      windowNumber: ws.windowNumber ?? null,
      bounds: ws.bounds,
    })),
    axForeignWindowCount: state.axForeignWindowCount,
    axUnmatchedWindowCount: state.axUnmatchedWindowCount,
    assessment: assessGuiWindows(state.windows),
    ...(dialogReadings === undefined ? {} : { dialogReadings }),
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
  return buildObservationGui(target, seams).listWindows();
}

/**
 * The read-only `MacGuiRecovery` behind `observeGuiAppState`, factored
 * out so the readings path (#462) can reuse the same instance for
 * `captureWindowById` — one session entry, one observation.
 */
function buildObservationGui(
  target: GuiObservationTarget,
  seams: GuiObservationSeams,
): MacGuiRecovery {
  return new MacGuiRecovery({
    session: target.session,
    pid: target.pid,
    // Observation is read-only: the console-session refusal exists to keep
    // *mutations* off the screen the human is using, and nothing here
    // reaches it.
    allowConsoleSession: true,
    ...seams,
  });
}

/**
 * Dialog readings for an already-observed state (#462). The pixel
 * channel binds to the observation's own `MacGuiRecovery` when one is
 * available (the live path); a fixture or a seam-supplied capture is
 * used otherwise, and a surface that cannot be captured records
 * `unreadable` — never a guess.
 */
async function perceiveDialogReadings(
  state: GuiAppState,
  seams: GuiObservationSeams,
  gui: MacGuiRecovery | null,
): Promise<readonly DialogReading[]> {
  const evidenceDir =
    seams.evidenceDir ??
    (seams.stateRoot !== undefined
      ? join(seams.stateRoot, "dialog-readings")
      : join(tmpdir(), "ae-a8n-dialog-perception"));
  const captureWindow =
    seams.captureWindow ??
    (gui === null
      ? undefined
      : (path: string, windowNumber: number) =>
          gui.captureWindowById(path, windowNumber));
  const report = await readDialogSurfaces(state, {
    ...(captureWindow === undefined ? {} : { captureWindow }),
    ocr: seams.ocr ?? createTesseractOcr(),
    evidenceDir,
    ...(seams.maxPixelReads === undefined
      ? {}
      : { maxPixelReads: seams.maxPixelReads }),
  });
  return report.readings;
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
export async function guiStateReport(
  target: GuiObservationTarget | null,
  fixture?: GuiStateFixture,
  seams: GuiObservationSeams = {},
  options: GuiStateOptions = {},
): Promise<GuiStateReport> {
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
    // One observation feeds both halves: the window report and, when
    // requested, the dialog readings (#462) — so `dialogReadings` can
    // never describe a different instant than `windows`.
    const wantReadings = options.readings === true;
    let state: GuiAppState;
    let gui: MacGuiRecovery | null = null;
    if (fixture !== undefined) {
      state = fixture.observed;
    } else {
      gui = buildObservationGui(target, seams);
      state = gui.listWindows();
    }
    let dialogReadings: readonly DialogReading[] | undefined;
    if (wantReadings) {
      try {
        dialogReadings = await perceiveDialogReadings(state, seams, gui);
      } catch (error) {
        // A perception failure must not sink the window observation —
        // every surface still gets an honest `unreadable` reading.
        const reason = `dialog perception failed: ${error instanceof Error ? error.message : String(error)}`;
        dialogReadings = enumerateDialogSurfaces(state).map((surface) => ({
          pid: state.pid,
          surfaceId: surface.surfaceId,
          source: "none" as const,
          buttons: [],
          modality: "unknown" as const,
          confidence: "unreadable" as const,
          unreadableReason: reason,
        }));
      }
    }
    return {
      status: "observed",
      ...guiStateObservation(target, state, observedAt, dialogReadings),
    };
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
