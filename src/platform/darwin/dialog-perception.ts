/**
 * Dialog perception on macOS (#462, specs/dialog-perception/spec.md).
 *
 * Two pure-ish stages over an already-honest `GuiAppState`:
 *
 *   1. `enumerateDialogSurfaces` — the AX∪census union: every pid-attributed
 *      AX window plus every `axUnaccountedCensusWindows` row (#451). Pure;
 *      no I/O, no judgement.
 *   2. `readDialogSurfaces` — one `DialogReading` per surface. AX surfaces
 *      read from the AX tree; census-only surfaces go through the pixel
 *      channel (`captureWindowById`) and then the bounded OCR runner.
 *      Async by contract: OCR is a killed-on-timeout subprocess and must
 *      never run inside the monitor tick or `MacGuiProbe.observe()`.
 *
 * Safety boundary (spec §4): this module captures pixels and extracts
 * text. It presses nothing, takes no lease, and its output is evidence —
 * never an input to `chooseAction`/`chooseRecoveryWindow`.
 */

import {
  isBlockingWindow,
  isPidAttributedWindow,
  type GuiAppState,
  type GuiWindowInfo,
} from "../../driver/gui-recovery.js";
import type { WindowServerWindow } from "./window-census.js";
import type {
  DialogButtonReading,
  DialogReadingsReport,
  DialogReading,
  DialogRect,
  DialogSurface,
  OcrSummary,
} from "../dialog-reading.js";
import type { OcrRunner, OcrResult } from "./ocr.js";

/** Default cap on pixel reads per `readDialogSurfaces` call (spec §3). */
export const DEFAULT_MAX_PIXEL_READS = 8;
/** Body text is evidence, not a dump: cap what a reading carries inline. */
export const MAX_BODY_TEXT = 4_000;

function toRect(frame: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): DialogRect {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function axButtons(window: GuiWindowInfo): DialogButtonReading[] {
  return window.buttons.map((button) => ({
    label: button.title === "" ? null : button.title,
    bounds:
      button.position !== null && button.size !== null
        ? {
            x: button.position.x,
            y: button.position.y,
            width: button.size.width,
            height: button.size.height,
          }
        : null,
    axRef: null,
  }));
}

function axSurface(
  state: GuiAppState,
  window: GuiWindowInfo,
  listingIndex: number,
): DialogSurface {
  return {
    surfaceId: `ax:${listingIndex}`,
    pid: state.pid,
    kind: "ax-window",
    title: window.title === "" ? null : window.title,
    role: window.role,
    subrole: window.subrole,
    texts: window.texts,
    buttons: axButtons(window),
    frame: window.frame != null ? toRect(window.frame) : null,
    census: null,
    axAccounted: true,
  };
}

function censusSurface(
  state: GuiAppState,
  ws: WindowServerWindow,
  order: number,
): DialogSurface {
  return {
    surfaceId:
      ws.windowNumber != null ? `census:${ws.windowNumber}` : `census:~${order}`,
    pid: state.pid,
    kind: "census-window",
    title: ws.name === "" ? null : ws.name,
    role: null,
    subrole: null,
    texts: [],
    buttons: [],
    frame: ws.bounds !== null ? toRect(ws.bounds) : null,
    census: {
      windowNumber: ws.windowNumber ?? null,
      onScreen: ws.onScreen,
      layer: ws.layer,
      name: ws.name,
      bounds: ws.bounds !== null ? toRect(ws.bounds) : null,
    },
    axAccounted: false,
  };
}

/**
 * The AX∪census union for one observed state (spec §1). AX surfaces keep
 * their raw listing index so `ax:<n>` correlates with the press path's
 * `windows of p` addressing — a correlation id here, never a press
 * handle. Census surfaces follow, on-screen first then parked, so a
 * bounded reader spends its budget where the screen actually shows
 * something.
 */
export function enumerateDialogSurfaces(state: GuiAppState): DialogSurface[] {
  const surfaces: DialogSurface[] = [];
  state.windows.forEach((window, index) => {
    if (isPidAttributedWindow(window)) {
      surfaces.push(axSurface(state, window, index + 1));
    }
  });
  const unaccounted = [...state.axUnaccountedCensusWindows].sort(
    (a, b) => Number(b.onScreen) - Number(a.onScreen),
  );
  unaccounted.forEach((ws, order) => {
    surfaces.push(censusSurface(state, ws, order + 1));
  });
  return surfaces;
}

function truncate(text: string): string {
  return text.length <= MAX_BODY_TEXT ? text : text.slice(0, MAX_BODY_TEXT);
}

function ocrSummary(result: OcrResult): OcrSummary {
  return {
    engine: result.engine,
    languages: result.languages,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    ok: result.ok,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

function axReading(
  state: GuiAppState,
  surface: DialogSurface,
  window: GuiWindowInfo,
): DialogReading {
  const hasContent =
    surface.texts.some((text) => text.trim().length > 0) ||
    surface.buttons.length > 0;
  return {
    pid: state.pid,
    surfaceId: surface.surfaceId,
    source: "ax",
    ...(surface.title === null ? {} : { title: surface.title }),
    ...(hasContent ? { bodyText: truncate(surface.texts.join("\n")) } : {}),
    buttons: surface.buttons,
    modality: isBlockingWindow(window) ? "modal" : "non-modal",
    confidence: hasContent ? "high" : "partial",
    ...(hasContent
      ? {}
      : { unreadableReason: "the AX tree listed the window but carried no text or buttons" }),
  };
}

export type DialogPerceptionDeps = {
  /**
   * Single-window capture (`screencapture -l`), session-scoped like
   * `MacGuiRecovery.captureWindowById`. Absent means census surfaces
   * cannot be pixel-read and record `unreadable` honestly.
   */
  readonly captureWindow?: (path: string, windowNumber: number) => string | Promise<string>;
  /** Bounded OCR runner (`createTesseractOcr`); absent means no OCR. */
  readonly ocr?: OcrRunner;
  /** Directory the capture PNGs are written to (created by the caller). */
  readonly evidenceDir: string;
  /** Pixel reads per call before the rest defer (spec §3 budget). */
  readonly maxPixelReads?: number;
};

/**
 * One `DialogReading` per enumerated surface. AX surfaces never touch the
 * pixel channel — AX already carries their content. Census surfaces are
 * read on-screen first (the enumeration order already sorted them), each
 * bounded by the OCR timeout; surfaces past `maxPixelReads` and every
 * failure mode land as `unreadable` with the measured reason.
 */
export async function readDialogSurfaces(
  state: GuiAppState,
  deps: DialogPerceptionDeps,
): Promise<DialogReadingsReport> {
  const surfaces = enumerateDialogSurfaces(state);
  const axByIndex = new Map<number, GuiWindowInfo>();
  state.windows.forEach((window, index) => {
    if (isPidAttributedWindow(window)) {
      axByIndex.set(index + 1, window);
    }
  });
  const maxPixelReads = deps.maxPixelReads ?? DEFAULT_MAX_PIXEL_READS;
  let pixelReads = 0;

  const readings: DialogReading[] = [];
  for (const surface of surfaces) {
    if (surface.kind === "ax-window") {
      const listingIndex = Number(surface.surfaceId.slice(3));
      const window = axByIndex.get(listingIndex);
      readings.push(
        window === undefined
          ? {
              pid: state.pid,
              surfaceId: surface.surfaceId,
              source: "none",
              buttons: [],
              modality: "unknown",
              confidence: "unreadable",
              unreadableReason: "the AX window vanished between enumeration and reading",
            }
          : axReading(state, surface, window),
      );
      continue;
    }

    // Census-only surface: pixel channel, then bounded OCR.
    const windowNumber = surface.census?.windowNumber ?? null;
    if (windowNumber === null) {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "none",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason: "the census row carries no window number to capture",
      });
      continue;
    }
    if (deps.captureWindow === undefined || deps.ocr === undefined) {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "none",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason:
          deps.captureWindow === undefined
            ? "no window-capture seam is configured for this observation"
            : "no OCR engine is configured for this observation",
      });
      continue;
    }
    if (pixelReads >= maxPixelReads) {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "none",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason: `deferred: the ${maxPixelReads}-surface pixel-read budget for this call is spent`,
      });
      continue;
    }
    pixelReads += 1;

    const capturePath = `${deps.evidenceDir}/dialog-${surface.surfaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.png`;
    let capturedPath: string | undefined;
    try {
      capturedPath = await deps.captureWindow(capturePath, windowNumber);
    } catch (error) {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "none",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason: `window capture failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const ocr = await deps.ocr(capturedPath);
    const summary = ocrSummary(ocr);
    const text = ocr.text?.trim() ?? "";
    if (!ocr.ok) {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "pixels",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason: ocr.timedOut
          ? `OCR timed out: ${ocr.reason ?? "killed at the timeout"}`
          : `OCR failed: ${ocr.reason ?? "unknown engine error"}`,
        evidence: { capturePath: capturedPath, ocr: summary },
      });
      continue;
    }
    if (text === "") {
      readings.push({
        pid: state.pid,
        surfaceId: surface.surfaceId,
        source: "pixels",
        buttons: [],
        modality: "unknown",
        confidence: "unreadable",
        unreadableReason: "OCR ran but the capture held no recognizable text (blank or fully transparent surface)",
        evidence: { capturePath: capturedPath, ocr: summary },
      });
      continue;
    }
    readings.push({
      pid: state.pid,
      surfaceId: surface.surfaceId,
      source: "pixels",
      bodyText: truncate(text),
      buttons: [],
      modality: "unknown",
      confidence: "partial",
      evidence: { capturePath: capturedPath, ocr: summary },
    });
  }

  return {
    pid: state.pid,
    observedAt: new Date().toISOString(),
    surfaces,
    readings,
  };
}
