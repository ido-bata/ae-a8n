/**
 * WindowServer census + degraded AX observation.
 *
 * Regression coverage for the 2026-11-15 real-host finding: After Effects
 * owned six WindowServer windows (including a dialog) while the
 * Accessibility API answered `windows of process` with an empty tree. AX
 * alone reported "no windows" for a screen that had a crash-repair dialog
 * on it. These tests pin the contract that AX-empty is never "clean" when
 * the WindowServer disagrees.
 */

import { describe, expect, it } from "vitest";

import {
  assessGuiObservation,
  framesMatch,
  isBlockingWindow,
  isPidAttributedWindow,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import {
  censusForPid,
  parseWindowCensus,
  windowServerCensus,
  WINDOW_CENSUS_PYTHON,
  type WindowServerWindow,
} from "../src/platform/darwin/window-census.js";

const CENSUS_FIXTURE = [
  "63300|After Effects|0|0||0|0|1710|38",
  "63300|After Effects|0|0||592|367|525|377",
  "63300|After Effects|0|1||0|612|500|500",
  "91653|Discord|0|1|#general|100|100|800|600",
  "611|Window Server|24|1|Menubar|0|0|1710|38",
].join("\n");

function win(partial: Partial<WindowServerWindow>): WindowServerWindow {
  return {
    pid: 63300,
    owner: "After Effects",
    layer: 0,
    onScreen: false,
    name: "",
    bounds: null,
    ...partial,
  };
}

describe("parseWindowCensus", () => {
  it("parses pid|owner|layer|onscreen|name|bounds lines", () => {
    const windows = parseWindowCensus(CENSUS_FIXTURE);
    expect(windows).toHaveLength(5);
    expect(windows[1]).toMatchObject({
      pid: 63300,
      owner: "After Effects",
      onScreen: false,
      bounds: { x: 592, y: 367, width: 525, height: 377 },
    });
    expect(windows[2]?.onScreen).toBe(true);
    expect(windows[3]?.owner).toBe("Discord");
    expect(windows[4]?.pid).toBe(611);
  });

  it("skips malformed lines instead of guessing", () => {
    const windows = parseWindowCensus("garbage\n1|2\n63300|After Effects|0|0||0|0|1710|38\n");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.pid).toBe(63300);
  });
});

describe("censusForPid", () => {
  it("counts all windows for the pid across Spaces plus on-screen ones", () => {
    const census = { available: true as const, windows: parseWindowCensus(CENSUS_FIXTURE) };
    expect(censusForPid(census, 63300)).toEqual({ windowCount: 3, onScreenCount: 1 });
    expect(censusForPid(census, 99999)).toEqual({ windowCount: 0, onScreenCount: 0 });
  });

  it("reports zeros for an unavailable census — callers check available first", () => {
    expect(censusForPid({ available: false, reason: "x" }, 63300)).toEqual({
      windowCount: 0,
      onScreenCount: 0,
    });
  });
});

describe("windowServerCensus", () => {
  it("returns available:false when the probe cannot run — never guesses", () => {
    const census = windowServerCensus(() => {
      throw new Error("spawn ENOENT");
    });
    expect(census.available).toBe(false);
    if (!census.available) expect(census.reason).toMatch(/ENOENT/);
  });

  it("parses real probe output through the injected runner", () => {
    const census = windowServerCensus(() => CENSUS_FIXTURE);
    expect(census.available).toBe(true);
    if (census.available) expect(census.windows.length).toBeGreaterThan(0);
  });

  it("uses the CLT python, not the /usr/bin stub that can raise an installer dialog", () => {
    expect(WINDOW_CENSUS_PYTHON).toBe("/Library/Developer/CommandLineTools/usr/bin/python3");
  });
});

describe("assessGuiObservation — the AX-empty regression", () => {
  const dialogWindow: GuiWindowInfo = {
    title: "",
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [],
    texts: ["クラッシュ修復オプション"],
  };

  it("AX-empty + WindowServer windows => axSuspect, windows stays empty (never invented)", () => {
    // The exact observed failure: AX says nothing, WindowServer says the
    // process owns windows. The state must flag suspicion, not cleanliness.
    const census = { available: true as const, windows: parseWindowCensus(CENSUS_FIXTURE) };
    const state = assessGuiObservation(63300, false, [], census);
    expect(state.windows).toHaveLength(0);
    expect(state.axSuspect).toBe(true);
    expect(state.windowServer.windowCount).toBe(3);
    expect(state.windowServer.onScreenCount).toBe(1);
  });

  it("AX-empty + WindowServer empty => genuinely no windows observed", () => {
    const census = { available: true as const, windows: [win({ pid: 1 })] };
    const state = assessGuiObservation(63300, false, [], census);
    expect(state.axSuspect).toBe(false);
    expect(state.windowServer.windowCount).toBe(0);
  });

  it("census unavailable => degraded flag data, axSuspect stays false but reason is carried", () => {
    const state = assessGuiObservation(63300, false, [], {
      available: false,
      reason: "probe missing",
    });
    expect(state.axSuspect).toBe(false);
    expect(state.windowServer.available).toBe(false);
    expect(state.windowServer.reason).toBe("probe missing");
  });

  it("AE layout-area windows count as observed => healthy AE is not axSuspect (#304)", () => {
    // Real AE 2026 vends its windows as UI-element AXLayoutArea records, not
    // through the `windows` class. Once the listing includes them, a healthy
    // instance must not look AX-unobservable. The frame matches a census
    // window of the same pid, so the census attributes it (#330).
    const aeWindow: GuiWindowInfo = {
      title: "Adobe After Effects 2026 - untitled *",
      role: "AXLayoutArea",
      subrole: "AXFloatingWindow",
      buttons: [],
      texts: [],
      frame: { x: 592, y: 367, width: 525, height: 377 },
    };
    const census = { available: true as const, windows: parseWindowCensus(CENSUS_FIXTURE) };
    const state = assessGuiObservation(63300, false, [aeWindow], census);
    expect(state.axSuspect).toBe(false);
    expect(state.windows).toHaveLength(1);
    expect(isBlockingWindow(aeWindow)).toBe(false);
  });

  it("AX windows present => axSuspect false regardless of census", () => {
    // The dialog's frame matches a census window of the same pid, so it is
    // pid-attributed (#330); without that the listing would be unproven.
    const attributed: GuiWindowInfo = {
      ...dialogWindow,
      frame: { x: 592, y: 367, width: 525, height: 377 },
    };
    const census = { available: true as const, windows: parseWindowCensus(CENSUS_FIXTURE) };
    const state = assessGuiObservation(63300, true, [attributed], census);
    expect(state.axSuspect).toBe(false);
    expect(state.windows).toHaveLength(1);
  });
});

describe("assessGuiObservation — AX-invisible on-screen windows (#321)", () => {
  // The measured AE 2027 shape: AX lists only the main window while the
  // census also shows the modal dialog — layer 8, on-screen, 410x342.
  const mainAx: GuiWindowInfo = {
    title: "Adobe After Effects 2027 - untitled",
    role: "AXLayoutArea",
    subrole: "AXFloatingWindow",
    buttons: [],
    texts: [],
    frame: { x: 0, y: 39, width: 1710, height: 1073 },
  };
  const modalWs = win({
    layer: 8,
    onScreen: true,
    bounds: { x: 650, y: 185, width: 410, height: 342 },
  });
  const mainWs = win({
    onScreen: true,
    name: "untitled",
    bounds: { x: 0, y: 38, width: 1710, height: 1074 },
  });

  it("an on-screen census window no AX frame accounts for is reported", () => {
    const census = { available: true as const, windows: [mainWs, modalWs] };
    const state = assessGuiObservation(63300, true, [mainAx], census);
    expect(state.axSuspect).toBe(false);
    expect(state.axUnaccountedWindows).toHaveLength(1);
    expect(state.axUnaccountedWindows[0]).toMatchObject({ layer: 8 });
  });

  it("a matching frame accounts for the census window — healthy AE stays clean", () => {
    // AX {0,39,1710,1073} vs census {0,38,1710,1074}: the 1px rounding
    // difference measured on a real host must still match.
    const census = { available: true as const, windows: [mainWs] };
    const state = assessGuiObservation(63300, true, [mainAx], census);
    expect(state.axUnaccountedWindows).toHaveLength(0);
  });

  it("off-screen census windows are not evidence about the visible screen", () => {
    // A healthy AE owns several off-screen/other-Space windows AX never
    // lists; they must not read as unaccounted.
    const parked = win({ bounds: { x: 612, y: 500, width: 500, height: 500 } });
    const strip = win({ bounds: { x: 0, y: 0, width: 1710, height: 38 } });
    const census = { available: true as const, windows: [mainWs, parked, strip] };
    const state = assessGuiObservation(63300, true, [mainAx], census);
    expect(state.axUnaccountedWindows).toHaveLength(0);
  });

  it("an AX window without a frame cannot account for anything", () => {
    const { frame: _frame, ...noFrame } = mainAx;
    const census = { available: true as const, windows: [mainWs] };
    const state = assessGuiObservation(63300, true, [noFrame], census);
    expect(state.axUnaccountedWindows).toHaveLength(1);
  });

  it("an unavailable census reports nothing unaccounted — it is already degraded", () => {
    const state = assessGuiObservation(63300, true, [mainAx], {
      available: false,
      reason: "probe missing",
    });
    expect(state.axUnaccountedWindows).toHaveLength(0);
  });
});

describe("assessGuiObservation — pid attribution of AX windows (#330)", () => {
  // The measured failure: two AE versions share one bundle id, and System
  // Events answers `windows of process` with the OTHER instance's windows.
  // The census is pid-accurate, so a frame match against another pid's
  // census window is positive proof of foreignness.
  const OWN_PID = 63300;
  const FOREIGN_PID = 77777;
  const ownMain: GuiWindowInfo = {
    title: "Adobe After Effects 2027 - untitled",
    role: "AXLayoutArea",
    subrole: "AXFloatingWindow",
    buttons: [],
    texts: [],
    frame: { x: 0, y: 39, width: 1710, height: 1073 },
  };
  const foreignDialog: GuiWindowInfo = {
    title: "Script",
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [{ title: "OK", description: "", position: null, size: null }],
    texts: ["the other instance's dialog"],
    frame: { x: 650, y: 185, width: 410, height: 342 },
  };
  const ownCensus = win({
    onScreen: true,
    name: "untitled",
    bounds: { x: 0, y: 38, width: 1710, height: 1074 },
  });
  const foreignCensus = win({
    pid: FOREIGN_PID,
    owner: "After Effects",
    layer: 8,
    onScreen: true,
    name: "Script",
    bounds: { x: 650, y: 185, width: 410, height: 342 },
  });

  it("marks a window owned when its frame matches a target-pid census window", () => {
    const census = { available: true as const, windows: [ownCensus] };
    const state = assessGuiObservation(OWN_PID, true, [ownMain], census);
    expect(state.windows[0]?.censusAttribution).toBe("owned");
    expect(isPidAttributedWindow(state.windows[0]!)).toBe(true);
    expect(state.axForeignWindowCount).toBe(0);
    expect(state.axUnmatchedWindowCount).toBe(0);
    expect(state.axSuspect).toBe(false);
  });

  it("marks a window foreign when its frame matches only another pid's census window", () => {
    const census = { available: true as const, windows: [ownCensus, foreignCensus] };
    const state = assessGuiObservation(OWN_PID, true, [ownMain, foreignDialog], census);
    expect(state.windows[0]?.censusAttribution).toBe("owned");
    expect(state.windows[1]?.censusAttribution).toBe("foreign");
    expect(isPidAttributedWindow(state.windows[1]!)).toBe(false);
    expect(state.axForeignWindowCount).toBe(1);
    // The owned window keeps the listing trustworthy: not axSuspect.
    expect(state.axSuspect).toBe(false);
  });

  it("a wholly foreign AX listing raises axSuspect — the pid's windows are AX-invisible", () => {
    // Both pids received the identical foreign listing on the real host:
    // for the target, every AX window belongs to somebody else, so the
    // observation must degrade exactly like an empty AX tree.
    const census = { available: true as const, windows: [ownCensus, foreignCensus] };
    const state = assessGuiObservation(OWN_PID, true, [foreignDialog], census);
    expect(state.axSuspect).toBe(true);
    expect(state.axForeignWindowCount).toBe(1);
    // The foreign dialog's frame does not account for the target's own
    // on-screen census window either (#321 path intact).
    expect(state.axUnaccountedWindows).toHaveLength(1);
  });

  it("marks a window unmatched when no census window of any pid has its frame", () => {
    const ghost: GuiWindowInfo = { ...ownMain, frame: { x: 10, y: 10, width: 100, height: 100 } };
    const census = { available: true as const, windows: [ownCensus] };
    const state = assessGuiObservation(OWN_PID, true, [ownMain, ghost], census);
    expect(state.windows[0]?.censusAttribution).toBe("owned");
    expect(state.windows[1]?.censusAttribution).toBe("unmatched");
    expect(isPidAttributedWindow(state.windows[1]!)).toBe(false);
    expect(state.axUnmatchedWindowCount).toBe(1);
  });

  it("marks a frameless window unmatched — it can never be attributed", () => {
    const { frame: _frame, ...noFrame } = ownMain;
    const census = { available: true as const, windows: [ownCensus] };
    const state = assessGuiObservation(OWN_PID, true, [noFrame], census);
    expect(state.windows[0]?.censusAttribution).toBe("unmatched");
    expect(state.axSuspect).toBe(true);
  });

  it("leaves attribution unset when the census is unavailable — legacy trust, still degraded", () => {
    const state = assessGuiObservation(OWN_PID, true, [ownMain], {
      available: false,
      reason: "probe missing",
    });
    expect(state.windows[0]?.censusAttribution).toBeUndefined();
    expect(isPidAttributedWindow(state.windows[0]!)).toBe(true);
    expect(state.axForeignWindowCount).toBe(0);
    expect(state.axUnmatchedWindowCount).toBe(0);
    expect(state.axSuspect).toBe(false);
  });
});

describe("framesMatch", () => {
  it("matches within the measured rounding tolerance and rejects real differences", () => {
    const ws = { x: 0, y: 38, width: 1710, height: 1074 };
    expect(framesMatch({ x: 0, y: 39, width: 1710, height: 1073 }, ws)).toBe(true);
    expect(framesMatch({ x: 650, y: 185, width: 410, height: 342 }, ws)).toBe(false);
    expect(framesMatch({ x: 5, y: 38, width: 1710, height: 1074 }, ws)).toBe(false);
  });
});
