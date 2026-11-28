/**
 * Dialog perception substrate (#462, specs/dialog-perception/spec.md).
 *
 * Contract tests for the AX∪census surface union, the honest
 * `DialogReading` schema (`unreadable` is a verdict, not a failure), the
 * bounded OCR subprocess contract, and the pull-based wiring into the
 * supervision probe, `ae.guiState({ readings })`, and the recovery
 * evidence path. Everything runs on fixtures and injected seams — no
 * After Effects, no real Accessibility session, no real tesseract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GuiAppState, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import {
  enumerateDialogSurfaces,
  readDialogSurfaces,
} from "../src/platform/darwin/dialog-perception.js";
import {
  createTesseractOcr,
  parseTesseractLanguages,
  type OcrExec,
} from "../src/platform/darwin/ocr.js";
import { MacGuiProbe } from "../src/platform/darwin/gui-probe.js";
import { guiStateReport } from "../src/api/gui-state.js";
import { MacHostRecovery, type GuiRecoverySurface } from "../src/driver/recovery.js";
import type { MacSession } from "../src/driver/mac-session.js";

const SESSION: MacSession = {
  uid: 502,
  username: "ae-test",
  asid: 100022,
  kind: "Aqua",
};
const TARGET = { pid: 4242, session: SESSION };

const OK_BUTTON = { title: "OK", description: "", position: null, size: null };

function axWindow(partial: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "Main",
    role: "AXWindow",
    subrole: "AXStandardWindow",
    buttons: [],
    texts: [],
    ...partial,
  };
}

function censusWindow(partial: Partial<WindowServerWindow> = {}): WindowServerWindow {
  return {
    pid: TARGET.pid,
    owner: "After Effects",
    layer: 0,
    onScreen: false,
    name: "",
    windowNumber: 777,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
    ...partial,
  };
}

function state(
  windows: readonly GuiWindowInfo[],
  over: Partial<GuiAppState> = {},
): GuiAppState {
  return {
    pid: TARGET.pid,
    frontmost: false,
    windows,
    windowServer: {
      available: true,
      reason: null,
      windowCount: windows.length,
      onScreenCount: windows.length,
    },
    axSuspect: false,
    axSuspectReason: null,
    axUnaccountedWindows: [],
    axUnaccountedCensusWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
    ...over,
  };
}

describe("enumerateDialogSurfaces", () => {
  it("unions pid-attributed AX windows with unaccounted census windows", () => {
    const surfaces = enumerateDialogSurfaces(
      state([axWindow()], {
        axUnaccountedCensusWindows: [
          censusWindow({ windowNumber: 777, onScreen: false }),
          censusWindow({ windowNumber: 778, onScreen: true, layer: 8 }),
        ],
      }),
    );
    expect(surfaces.map((s) => s.surfaceId)).toEqual(["ax:1", "census:778", "census:777"]);
    expect(surfaces[0]).toMatchObject({ kind: "ax-window", axAccounted: true });
    expect(surfaces[1]).toMatchObject({
      kind: "census-window",
      axAccounted: false,
      census: { windowNumber: 778, onScreen: true, layer: 8 },
    });
    // On-screen census surfaces sort before parked ones so a bounded
    // reader spends its budget where the screen shows something.
    expect(surfaces[1]?.census?.onScreen).toBe(true);
    expect(surfaces[2]?.census?.onScreen).toBe(false);
  });

  it("excludes foreign and unmatched AX windows from the union", () => {
    const surfaces = enumerateDialogSurfaces(
      state([
        axWindow({ title: "Mine", censusAttribution: "owned" }),
        axWindow({ title: "Theirs", censusAttribution: "foreign" }),
        axWindow({ title: "Maybe", censusAttribution: "unmatched" }),
      ]),
    );
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.surfaceId).toBe("ax:1");
    expect(surfaces[0]?.title).toBe("Mine");
  });

  it("keeps the raw listing index in ax:<n> so it correlates with the press path", () => {
    const surfaces = enumerateDialogSurfaces(
      state([
        axWindow({ title: "Foreign", censusAttribution: "foreign" }),
        axWindow({ title: "Mine", censusAttribution: "owned" }),
      ]),
    );
    expect(surfaces[0]?.surfaceId).toBe("ax:2");
  });

  it("falls back to census:~<n> when the row carries no window number", () => {
    const surfaces = enumerateDialogSurfaces(
      state([], { axUnaccountedCensusWindows: [censusWindow({ windowNumber: null })] }),
    );
    expect(surfaces[0]?.surfaceId).toBe("census:~1");
  });
});

describe("readDialogSurfaces", () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "a8n-perception-"));
  afterEach(() => rmSync(evidenceDir, { recursive: true, force: true }));

  const fakeOcr =
    (result: { text?: string; ok?: boolean; timedOut?: boolean; reason?: string }) =>
    () =>
      Promise.resolve({
        engine: "tesseract" as const,
        languages: ["jpn", "eng"],
        durationMs: 12,
        timedOut: result.timedOut ?? false,
        ok: result.ok ?? true,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.text === undefined ? {} : { text: result.text }),
      });

  it("reads an AX dialog surface from the AX channel only", async () => {
    const report = await readDialogSurfaces(
      state([
        axWindow({
          title: "",
          subrole: "AXDialog",
          texts: ["ae-a8n: hello"],
          buttons: [OK_BUTTON],
        }),
      ]),
      { evidenceDir },
    );
    expect(report.readings).toHaveLength(1);
    const reading = report.readings[0]!;
    expect(reading).toMatchObject({
      surfaceId: "ax:1",
      source: "ax",
      confidence: "high",
      modality: "modal",
    });
    expect(reading.bodyText).toContain("ae-a8n: hello");
    expect(reading.buttons[0]?.label).toBe("OK");
  });

  it("marks an AX window with an empty tree partial, not unreadable", async () => {
    const report = await readDialogSurfaces(state([axWindow({ texts: [] })]), {
      evidenceDir,
    });
    const reading = report.readings[0]!;
    expect(reading.confidence).toBe("partial");
    expect(reading.modality).toBe("non-modal");
  });

  it("reads a census-only surface through capture + OCR as partial pixels evidence", async () => {
    const captured: Array<{ path: string; windowNumber: number }> = [];
    const report = await readDialogSurfaces(
      state([], {
        axUnaccountedCensusWindows: [censusWindow({ windowNumber: 4242, onScreen: true })],
      }),
      {
        evidenceDir,
        captureWindow: (path, windowNumber) => {
          captured.push({ path, windowNumber });
          return path;
        },
        ocr: fakeOcr({ text: "クラッシュ修復オプション\nセーフモードで開始" }),
      },
    );
    expect(captured).toEqual([{ path: expect.any(String), windowNumber: 4242 }]);
    const reading = report.readings[0]!;
    expect(reading).toMatchObject({
      surfaceId: "census:4242",
      source: "pixels",
      confidence: "partial",
      modality: "unknown",
    });
    expect(reading.bodyText).toContain("クラッシュ修復オプション");
    expect(reading.evidence?.capturePath).toBe(captured[0]?.path);
    expect(reading.evidence?.ocr?.languages).toEqual(["jpn", "eng"]);
  });

  it("returns unreadable with the measured reason when no capture/OCR seam exists", async () => {
    const report = await readDialogSurfaces(
      state([], { axUnaccountedCensusWindows: [censusWindow()] }),
      { evidenceDir },
    );
    const reading = report.readings[0]!;
    expect(reading.confidence).toBe("unreadable");
    expect(reading.unreadableReason).toContain("no window-capture seam");
  });

  it("returns unreadable when the census row has no window number", async () => {
    const report = await readDialogSurfaces(
      state([], {
        axUnaccountedCensusWindows: [censusWindow({ windowNumber: null })],
      }),
      {
        evidenceDir,
        captureWindow: (path) => path,
        ocr: fakeOcr({ text: "x" }),
      },
    );
    expect(report.readings[0]?.confidence).toBe("unreadable");
    expect(report.readings[0]?.unreadableReason).toContain("no window number");
  });

  it("turns capture failure, OCR failure, timeout, blank text and success into honest readings", async () => {
    const census = [1, 2, 3, 4, 5].map((n) =>
      censusWindow({ windowNumber: n, onScreen: true }),
    );
    const ocrs = [
      fakeOcr({ ok: false, reason: "engine missing" }),
      fakeOcr({ timedOut: true, ok: false, reason: "killed at timeout" }),
      fakeOcr({ text: "   " }),
      fakeOcr({ text: "some dialog text" }),
    ];
    let i = 0;
    const report = await readDialogSurfaces(
      state([], { axUnaccountedCensusWindows: census }),
      {
        evidenceDir,
        captureWindow: (path, windowNumber) => {
          if (windowNumber === 1) throw new Error("screencapture denied");
          return path;
        },
        ocr: () => ocrs[i++]!(),
        maxPixelReads: 5,
      },
    );
    const [r1, r2, r3, r4, r5] = report.readings;
    expect(r1?.unreadableReason).toContain("window capture failed");
    expect(r2?.unreadableReason).toContain("OCR failed");
    expect(r3?.unreadableReason).toContain("timed out");
    expect(r4?.confidence).toBe("unreadable");
    expect(r4?.unreadableReason).toContain("no recognizable text");
    expect(r5?.confidence).toBe("partial");
    expect(r5?.bodyText).toBe("some dialog text");
  });

  it("defers surfaces past the pixel-read budget instead of queueing unbounded OCR", async () => {
    const census = Array.from({ length: 3 }, (_, i) =>
      censusWindow({ windowNumber: 100 + i, onScreen: true }),
    );
    const report = await readDialogSurfaces(
      state([], { axUnaccountedCensusWindows: census }),
      {
        evidenceDir,
        captureWindow: (path) => path,
        ocr: fakeOcr({ text: "dialog" }),
        maxPixelReads: 1,
      },
    );
    expect(report.readings.map((r) => r.confidence)).toEqual([
      "partial",
      "unreadable",
      "unreadable",
    ]);
    expect(report.readings[1]?.unreadableReason).toContain("budget");
  });
});

describe("createTesseractOcr", () => {
  it("parses --list-langs output and intersects with the requested set", async () => {
    const calls: string[][] = [];
    const exec: OcrExec = (file, args) => {
      calls.push([file, ...args]);
      return Promise.resolve(
        args[0] === "--list-langs"
          ? { stdout: "List of available languages in \"x\":\neng\nosd\njpn\n", stderr: "" }
          : { stdout: "recognized text", stderr: "" },
      );
    };
    const ocr = createTesseractOcr({ exec, languages: ["jpn", "deu", "eng"] });
    const result = await ocr("/tmp/x.png");
    expect(result.ok).toBe(true);
    expect(result.languages).toEqual(["jpn", "eng"]);
    expect(result.text).toBe("recognized text");
    // The OCR invocation used the resolved set, not the raw request.
    expect(calls[1]).toContain("jpn+eng");
    expect(calls[1]).toContain("--psm");
  });

  it("reports ok:false honestly when no requested language is installed", async () => {
    const exec: OcrExec = () =>
      Promise.resolve({
        stdout: "List of available languages in \"x\":\neng\nosd\n",
        stderr: "",
      });
    const ocr = createTesseractOcr({ exec, languages: ["jpn"] });
    const result = await ocr("/tmp/x.png");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("language data unavailable");
  });

  it("maps a killed subprocess to timedOut, never a hang", async () => {
    const exec: OcrExec = (_file, args) => {
      if (args[0] === "--list-langs") {
        return Promise.resolve({ stdout: "List:\neng\n", stderr: "" });
      }
      const error = new Error("Command failed: tesseract") as Error & {
        killed: boolean;
        signal: string;
      };
      error.killed = true;
      error.signal = "SIGKILL";
      return Promise.reject(error);
    };
    const ocr = createTesseractOcr({ exec, languages: ["eng"], timeoutMs: 25 });
    const result = await ocr("/tmp/x.png");
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toContain("timeout");
  });

  it("reports a missing binary as ok:false, not a throw", async () => {
    const exec: OcrExec = () => Promise.reject(new Error("spawn tesseract ENOENT"));
    const ocr = createTesseractOcr({ exec });
    const result = await ocr("/tmp/x.png");
    expect(result.ok).toBe(false);
  });

  it("parseTesseractLanguages skips headers and non-language data", () => {
    expect(
      parseTesseractLanguages("List of available languages in \"x\":\neng\nosd\njpn\n"),
    ).toEqual(["eng", "jpn"]);
  });
});

describe("MacGuiProbe.readings", () => {
  it("delegates to the injected perception dep and defaults to []", async () => {
    const bare = new MacGuiProbe(42, {
      listWindows: () => state([]),
      pidAlive: () => true,
    });
    expect(await bare.readings()).toEqual([]);

    const reading = {
      pid: 42,
      surfaceId: "ax:1",
      source: "ax" as const,
      buttons: [],
      modality: "non-modal" as const,
      confidence: "high" as const,
    };
    const probe = new MacGuiProbe(42, {
      listWindows: () => state([]),
      pidAlive: () => true,
      readings: () => Promise.resolve([reading]),
    });
    expect(await probe.readings()).toEqual([reading]);
    // observe() stays synchronous and never touches the readings dep.
    const snap = probe.observe();
    expect(snap.ok).toBe(true);
  });
});

describe("guiStateReport readings option", () => {
  it("omits dialogReadings by default and attaches them when requested", async () => {
    const observed = state([axWindow()], {
      axUnaccountedCensusWindows: [censusWindow({ windowNumber: 55, onScreen: true })],
    });
    const plain = await guiStateReport(TARGET, { observed });
    expect(plain.status).toBe("observed");
    if (plain.status === "observed") {
      expect(plain.dialogReadings).toBeUndefined();
    }

    const deep = await guiStateReport(TARGET, { observed }, {
      evidenceDir: mkdtempSync(join(tmpdir(), "a8n-gui-readings-")),
      captureWindow: (path) => path,
      ocr: () =>
        Promise.resolve({
          engine: "tesseract" as const,
          languages: ["eng"],
          durationMs: 1,
          timedOut: false,
          ok: true,
          text: "a dialog",
        }),
    }, { readings: true });
    expect(deep.status).toBe("observed");
    if (deep.status === "observed") {
      expect(deep.dialogReadings).toHaveLength(2);
      expect(deep.dialogReadings?.[0]?.source).toBe("ax");
      expect(deep.dialogReadings?.[1]).toMatchObject({
        surfaceId: "census:55",
        source: "pixels",
        confidence: "partial",
      });
    }
  });
});

describe("MacHostRecovery dialogOcr", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function axBlindState(census: readonly WindowServerWindow[]): GuiAppState {
    return {
      ...state([]),
      axSuspect: true,
      axSuspectReason: "fixture",
      windowServer: {
        available: true,
        reason: null,
        windowCount: census.length,
        onScreenCount: census.filter((w) => w.onScreen).length,
      },
      axUnaccountedCensusWindows: census,
    };
  }

  function fakeOcrExec(text: string): OcrExec {
    return (_file, args) =>
      Promise.resolve(
        args[0] === "--list-langs"
          ? { stdout: "List:\neng\njpn\n", stderr: "" }
          : { stdout: text, stderr: "" },
      );
  }

  it("attaches an OCR reading to each captured census window, evidence-only", async () => {
    root = mkdtempSync(join(tmpdir(), "a8n-recovery-ocr-"));
    const gui: GuiRecoverySurface = {
      listWindows: () =>
        axBlindState([censusWindow({ windowNumber: 9001, onScreen: false })]),
      capture: (path) => path,
      captureWindowById: (path) => path,
      pressButtonIn: () => false,
    };
    const recovery = new MacHostRecovery({
      session: SESSION,
      pid: () => TARGET.pid,
      screenshotDir: join(root, "shots"),
      gui,
      dialogOcr: { exec: fakeOcrExec("クラッシュ修復オプション"), languages: ["jpn"] },
    });
    const outcome = await recovery.attempt({
      requestId: "req-ocr",
      method: "app.info",
      timeoutMs: 1000,
    });
    expect(outcome.outcome).toBe("refused");
    const capture = outcome.censusCaptures?.[0];
    expect(capture?.path).toBeDefined();
    expect(capture?.reading).toMatchObject({
      surfaceId: "census:9001",
      source: "pixels",
      confidence: "partial",
      modality: "unknown",
    });
    expect(capture?.reading?.bodyText).toContain("クラッシュ修復オプション");
    expect(capture?.reading?.evidence?.ocr?.languages).toEqual(["jpn"]);
  });

  it("leaves readings absent when dialogOcr is not configured", async () => {
    root = mkdtempSync(join(tmpdir(), "a8n-recovery-ocr-"));
    const gui: GuiRecoverySurface = {
      listWindows: () =>
        axBlindState([censusWindow({ windowNumber: 9002, onScreen: false })]),
      capture: (path) => path,
      captureWindowById: (path) => path,
      pressButtonIn: () => false,
    };
    const recovery = new MacHostRecovery({
      session: SESSION,
      pid: () => TARGET.pid,
      screenshotDir: join(root, "shots"),
      gui,
    });
    const outcome = await recovery.attempt({
      requestId: "req-ocr-off",
      method: "app.info",
      timeoutMs: 1000,
    });
    expect(outcome.censusCaptures?.[0]?.path).toBeDefined();
    expect(outcome.censusCaptures?.[0]?.reading).toBeUndefined();
  });
});
