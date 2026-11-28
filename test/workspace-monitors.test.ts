/**
 * Multi-monitor / DPI workspace-restore contract tests (#370,
 * `specs/workspace-editing/spec.md` §8, §9 "Multi-monitor / DPI", §12 W4+;
 * parent #345 / program #337).
 *
 * Everything here runs against scripted display-census listings and fake
 * window observations — the "fake geometry" the issue's AC names. This
 * proves the contract: display enumeration parsing, point↔pixel
 * coordinate mapping, display-boundary and mixed-DPI detection, honest
 * single/unknown topology reporting, and monitor evidence attached to
 * restore reports. It does NOT prove After Effects restores a
 * multi-monitor workspace correctly on a real host — that stays
 * `unverified` and is deferred to the real-host lane (spec §11).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GuiAppState, GuiFrame, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import { parseMenuBarListing } from "../src/menus/parse.js";
import type { MenuBarSnapshot } from "../src/menus/types.js";
import type { PanelFrame } from "../src/panels/types.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import type { WorkspaceSurfaceOps } from "../src/workspace/types.js";
import {
  assessFrameMonitors,
  classifyTopology,
  displaysForFrame,
  monitorEvidence,
  toMonitorDisplay,
} from "../src/workspace/monitors/index.js";
import type {
  MonitorCensus,
  MonitorDisplay,
} from "../src/workspace/monitors/types.js";
import {
  displayCensus,
  parseDisplayCensus,
} from "../src/platform/darwin/display-census.js";
import { snapshotWorkspaceStore } from "../src/workspace-xml/index.js";
import { workspaceCapabilities } from "../src/api/workspace.js";

const PID = 4242;
const OBSERVED_AT = "2026-11-30T00:00:00.000Z";

/** A 1440x900@2x built-in plus a 1920x1080@1x external, side by side. */
const RETINA: MonitorDisplay = {
  id: "1",
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  pixelSize: { width: 2880, height: 1800 },
  backingScaleFactor: 2,
  isMain: true,
};
const EXTERNAL: MonitorDisplay = {
  id: "2",
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  pixelSize: { width: 1920, height: 1080 },
  backingScaleFactor: 1,
  isMain: false,
};
/** Same geometry as EXTERNAL but also @2x — the mixed-DPI pair. */
const EXTERNAL_RETINA: MonitorDisplay = { ...EXTERNAL, backingScaleFactor: 2 };

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const PANEL_FRAME: GuiFrame = { x: 100, y: 200, width: 640, height: 504 };
/** Straddles the x=1440 boundary between RETINA and EXTERNAL. */
const STRADDLE_FRAME: PanelFrame = { x: 1400, y: 100, width: 200, height: 200 };

describe("display census probe", () => {
  it("parses census lines and derives isMain from the global origin", () => {
    const text = [
      "1|0|0|1440|900|2880|1800|2",
      "2|1440|-100|1920|1080|1920|1080|1",
      "garbage line",
      "3|notanumber|0|100|100|100|100|1",
    ].join("\n");
    const displays = parseDisplayCensus(text);
    expect(displays).toHaveLength(2);
    expect(displays[0]).toMatchObject({
      id: "1",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      backingScaleFactor: 2,
      isMain: true,
    });
    expect(displays[1]).toMatchObject({
      id: "2",
      isMain: false,
      backingScaleFactor: 1,
    });
    expect(displays[1]?.pixelSize).toEqual({ width: 1920, height: 1080 });
  });

  it("reports unavailable — never an empty 'single display' — when the probe fails", () => {
    const census = displayCensus(() => {
      throw new Error("python3 missing");
    });
    expect(census.available).toBe(false);
    if (census.available) return;
    expect(census.reason).toContain("python3 missing");
  });

  it("reports unavailable on empty or unparseable output", () => {
    expect(displayCensus(() => "").available).toBe(false);
    const bad = displayCensus(() => "1|0|0|10|10|10|10|2\n");
    expect(bad.available).toBe(true);
    if (bad.available) expect(bad.displays).toHaveLength(1);
  });
});

describe("monitor geometry", () => {
  it("classifies single, multi and unknown topology honestly", () => {
    expect(
      classifyTopology({ available: true, displays: [RETINA] }).status,
    ).toBe("single");
    const multi = classifyTopology({
      available: true,
      displays: [RETINA, EXTERNAL],
    });
    expect(multi.status).toBe("multi");
    expect(multi.displayCount).toBe(2);
    const down = classifyTopology({ available: false, reason: "no python" });
    expect(down.status).toBe("unknown");
    expect(down.reason).toBe("no python");
    expect(
      classifyTopology({ available: true, displays: [] }).status,
    ).toBe("unknown");
  });

  it("maps a frame fully inside one display to that display and device pixels", () => {
    const info = assessFrameMonitors(PANEL_FRAME, [RETINA, EXTERNAL]);
    expect(info.displayIds).toEqual(["1"]);
    expect(info.crossesDisplays).toBe(false);
    expect(info.mixedDpi).toBe(false);
    // 640x504 points at backingScale 2 → 1280x1008 device px.
    expect(info.pixelSize).toEqual({ width: 1280, height: 1008 });
    expect(info.backingScaleFactor).toBe(2);
  });

  it("flags a frame straddling a display boundary, with per-side DPI evidence", () => {
    const displays = displaysForFrame(STRADDLE_FRAME, [RETINA, EXTERNAL]);
    expect(displays.map((d) => d.id)).toEqual(["1", "2"]);
    const info = assessFrameMonitors(STRADDLE_FRAME, [RETINA, EXTERNAL]);
    expect(info.crossesDisplays).toBe(true);
    expect(info.mixedDpi).toBe(true);
    // Mixed DPI: no honest single pixel footprint exists.
    expect(info.pixelSize).toBeNull();
    expect(info.backingScaleFactor).toBeNull();
  });

  it("does not flag mixed DPI when straddling displays agree on scale", () => {
    const info = assessFrameMonitors(STRADDLE_FRAME, [RETINA, EXTERNAL_RETINA]);
    expect(info.crossesDisplays).toBe(true);
    expect(info.mixedDpi).toBe(false);
    expect(info.pixelSize).toEqual({ width: 400, height: 400 });
    expect(info.backingScaleFactor).toBe(2);
  });

  it("treats an unproven scale as disagreement, never as 1.0", () => {
    const unknownScale: MonitorDisplay = { ...EXTERNAL, backingScaleFactor: null };
    const info = assessFrameMonitors(STRADDLE_FRAME, [RETINA, unknownScale]);
    expect(info.mixedDpi).toBe(true);
    expect(info.pixelSize).toBeNull();
  });

  it("does not count edge-flush contact as crossing a boundary", () => {
    // A frame ending exactly at x=1440 shares no area with EXTERNAL.
    const flush: PanelFrame = { x: 1040, y: 0, width: 400, height: 100 };
    const info = assessFrameMonitors(flush, [RETINA, EXTERNAL]);
    expect(info.displayIds).toEqual(["1"]);
    expect(info.crossesDisplays).toBe(false);
  });

  it("records a frame matching no display instead of dropping it", () => {
    const off: PanelFrame = { x: -3000, y: -3000, width: 100, height: 100 };
    const info = assessFrameMonitors(off, [RETINA, EXTERNAL]);
    expect(info.displayIds).toEqual([]);
    expect(info.pixelSize).toBeNull();
  });

  it("builds monitor evidence with mixed-DPI frames called out", () => {
    const census: MonitorCensus = {
      available: true,
      displays: [RETINA, EXTERNAL],
    };
    const evidence = monitorEvidence(census, [
      { frame: PANEL_FRAME, title: "Panel" },
      { frame: STRADDLE_FRAME, title: "Straddler" },
    ]);
    expect(evidence.topology.status).toBe("multi");
    expect(evidence.censusAvailable).toBe(true);
    expect(evidence.frames).toHaveLength(2);
    expect(evidence.mixedDpiFrames).toHaveLength(1);
    expect(evidence.mixedDpiFrames[0]?.title).toBe("Straddler");
  });

  it("reports unknown topology and empty memberships when the census is down", () => {
    const evidence = monitorEvidence(
      { available: false, reason: "no interpreter" },
      [{ frame: PANEL_FRAME, title: "Panel" }],
    );
    expect(evidence.topology.status).toBe("unknown");
    expect(evidence.censusAvailable).toBe(false);
    expect(evidence.frames[0]?.monitor.displayIds).toEqual([]);
  });

  it("narrows a platform census row into the contract shape", () => {
    const d = toMonitorDisplay({
      id: 7,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      pixelSize: null,
      backingScaleFactor: null,
      isMain: true,
    });
    expect(d.id).toBe("7");
    expect(d.isMain).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Controller integration — fake ops, scripted census listings
// ---------------------------------------------------------------------

function menuListing(checked: string | null): string {
  const items = ["Standard", "Motion"];
  const lines = [
    "MB|1|AE-A8N|AXMenuBarItem|1",
    "MB|2|Window|AXMenuBarItem|1",
    "I|2,1|Workspace|AXMenuItem|1|-|||submenu",
    ...items.map((title, index) => {
      const isChecked = title === checked;
      return (
        `I|2,1,${index + 1}|${title}|AXMenuItem|1|` +
        `${isChecked ? "1|✓" : "0|"}||item`
      );
    }),
  ];
  return lines.join("\n");
}

function axWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "Main",
    role: "AXWindow",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { ...MAIN_FRAME },
    censusAttribution: "owned",
    ...over,
  };
}

function appState(): GuiAppState {
  return {
    pid: PID,
    frontmost: true,
    windows: [axWindow()],
    windowServer: {
      available: true,
      reason: null,
      windowCount: 1,
      onScreenCount: 1,
    },
    axSuspect: false,
    axSuspectReason: null,
    axUnaccountedWindows: [],
    axUnaccountedCensusWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
  };
}

type FakeState = {
  checked: string | null;
  windows: GuiWindowInfo[];
  census: MonitorCensus;
};

function fakeOps(
  state: FakeState,
  xmlDir: string,
  withCensus = true,
): WorkspaceSurfaceOps {
  return {
    observeMenuBar: (): MenuBarSnapshot =>
      parseMenuBarListing(menuListing(state.checked), PID, OBSERVED_AT),
    invokeMenuItem: () => "clicked" as const,
    observeWindows: () => ({
      ...appState(),
      windows: state.windows,
      windowServer: {
        available: true,
        reason: null,
        windowCount: state.windows.length,
        onScreenCount: state.windows.length,
      },
    }),
    snapshotXml: () => snapshotWorkspaceStore({ preferencesDir: xmlDir }),
    ...(withCensus ? { enumerateDisplays: () => state.census } : {}),
  };
}

describe("workspace monitor evidence (controller)", () => {
  let xmlDir: string;

  beforeEach(() => {
    xmlDir = mkdtempSync(join(tmpdir(), "ae-a8n-workspace-370-"));
    mkdirSync(join(xmlDir, "ModifiedWorkspaces"), { recursive: true });
    mkdirSync(join(xmlDir, "OriginalUserWorkspaces"), { recursive: true });
    writeFileSync(
      join(xmlDir, "ModifiedWorkspaces", "UserWorkspace_10.xml"),
      `<?xml version="1.0"?><WorkspaceSet><Workspace name="Standard"/></WorkspaceSet>`,
    );
  });

  afterEach(() => {
    rmSync(xmlDir, { recursive: true, force: true });
  });

  function controller(state: FakeState) {
    return new WorkspaceController({
      pid: PID,
      ops: fakeOps(state, xmlDir),
      poll: { timeoutMs: 60, intervalMs: 5, frameTolerance: 4 },
      sleep: () => Promise.resolve(),
      now: () => new Date(OBSERVED_AT),
    });
  }

  const baseState = (census: MonitorCensus): FakeState => ({
    checked: "Standard",
    windows: [axWindow()],
    census,
  });

  it("monitorReport reports single-display topology honestly", () => {
    const report = controller(
      baseState({ available: true, displays: [RETINA] }),
    ).monitorReport();
    expect(report.monitors.topology.status).toBe("single");
    expect(report.monitors.topology.displayCount).toBe(1);
    expect(report.monitors.censusAvailable).toBe(true);
    // The main window sits inside the only display at scale 2.
    const frame = report.monitors.frames[0];
    expect(frame?.monitor.displayIds).toEqual(["1"]);
    expect(frame?.monitor.pixelSize).toEqual({ width: 2880, height: 1800 });
    expect(report.observation.identity.status).toBe("resolved");
  });

  it("monitorReport flags a panel straddling a mixed-DPI boundary", () => {
    const state = baseState({
      available: true,
      displays: [RETINA, EXTERNAL],
    });
    state.windows = [
      axWindow(),
      axWindow({
        title: "Panel",
        role: "AXLayoutArea",
        subrole: "AXFloatingWindow",
        frame: { ...STRADDLE_FRAME },
      }),
    ];
    const report = controller(state).monitorReport();
    expect(report.monitors.topology.status).toBe("multi");
    const straddler = report.monitors.frames.find(
      (f) => f.title === "Panel",
    );
    expect(straddler?.monitor.crossesDisplays).toBe(true);
    expect(straddler?.monitor.mixedDpi).toBe(true);
    expect(straddler?.monitor.pixelSize).toBeNull();
    expect(report.monitors.mixedDpiFrames).toHaveLength(1);
  });

  it("monitorReport reports unknown — not single — when the census is unavailable", () => {
    const report = controller(
      baseState({ available: false, reason: "no interpreter" }),
    ).monitorReport();
    expect(report.monitors.topology.status).toBe("unknown");
    expect(report.monitors.topology.reason).toBe("no interpreter");
    expect(report.monitors.censusAvailable).toBe(false);
  });

  it("verifyRestore records monitor evidence alongside the verdict", () => {
    const state = baseState({
      available: true,
      displays: [RETINA, EXTERNAL],
    });
    const c = controller(state);
    const before = c.observe();
    const report = c.verifyRestore(before);
    expect(report.verdict).toBe("restored");
    expect(report.monitors).not.toBeNull();
    expect(report.monitors?.topology.status).toBe("multi");
    expect(report.monitors?.censusAvailable).toBe(true);
  });

  it("verifyRestore leaves monitors null when the surface has no census seam", () => {
    const state = baseState({ available: true, displays: [RETINA] });
    const c = new WorkspaceController({
      pid: PID,
      ops: fakeOps(state, xmlDir, false),
      poll: { timeoutMs: 60, intervalMs: 5, frameTolerance: 4 },
      sleep: () => Promise.resolve(),
      now: () => new Date(OBSERVED_AT),
    });
    const report = c.verifyRestore(c.observe());
    expect(report.monitors).toBeNull();
  });

  it("capabilities report honest monitor support per platform", () => {
    const darwin = workspaceCapabilities("darwin");
    expect(darwin.monitors.support).toBe("implemented");
    expect(darwin.monitors.verification).toBe("automated test");
    const win = workspaceCapabilities("win32");
    expect(win.monitors.support).toBe("unsupported");
  });
});
