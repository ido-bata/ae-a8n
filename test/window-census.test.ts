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

  it("AX windows present => axSuspect false regardless of census", () => {
    const census = { available: true as const, windows: parseWindowCensus(CENSUS_FIXTURE) };
    const state = assessGuiObservation(63300, true, [dialogWindow], census);
    expect(state.axSuspect).toBe(false);
    expect(state.windows).toHaveLength(1);
  });
});
