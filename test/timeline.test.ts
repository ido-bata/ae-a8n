/**
 * Timeline editing contract tests (#364,
 * `specs/workspace-editing/spec.md` §3 W2).
 *
 * Everything here runs against scripted fake AX trees, a fake
 * `DockedPaneOps`, a recording fake mouse and a mutable fake DOM
 * readback: this proves the contract — mutate-gui gating, pane/row
 * re-resolution, `ambiguous-target`/`stale-locator` refusals, bounded
 * postcondition waits with no resend, and the hybrid oracle's
 * requested-vs-observed evidence — at `automated test` level. It does
 * NOT prove a real After Effects honors any of it; `comp.time` tracking
 * a GUI scrub and CGEvent drag fidelity on the custom-drawn timeline are
 * the spec's prime real-host questions (§11).
 */

import { describe, expect, it } from "vitest";

import { axLeaf, DockedPaneObserver } from "../src/panels/docked/index.js";
import type { DockedPaneOps, DockedAxNode } from "../src/panels/docked/index.js";
import type { GuiAppState, GuiFrame, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { TimelineController } from "../src/timeline/controller.js";
import type {
  TimelineMouseOps,
  TimelineReadback,
  TimelineRulerGeometry,
} from "../src/timeline/types.js";
import type {
  CompInfo,
  CompTime,
  LayerInfo,
  PropertyInfo,
} from "../src/api/types.js";
import { timelineCapabilities } from "../src/api/timeline.js";

const PID = 4242;

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const TIMELINE_FRAME: GuiFrame = { x: 0, y: 600, width: 1440, height: 200 };
const RULER: TimelineRulerGeometry = {
  frame: { x: 200, y: 600, width: 1200, height: 40 },
  startFrame: 0,
  endFrame: 300,
};

function mainWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "After Effects",
    role: "AXLayoutArea",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { ...MAIN_FRAME },
    censusAttribution: "owned",
    ...over,
  };
}

function censusRow(over: Partial<WindowServerWindow> = {}): WindowServerWindow {
  return {
    pid: PID,
    owner: "After Effects",
    layer: 0,
    onScreen: true,
    name: "",
    windowNumber: 9001,
    bounds: { ...MAIN_FRAME },
    ...over,
  };
}

function appState(windows: readonly GuiWindowInfo[]): GuiAppState {
  return {
    pid: PID,
    frontmost: true,
    windows,
    windowServer: {
      available: true,
      reason: null,
      windowCount: windows.length,
      onScreenCount: windows.length,
    },
    axSuspect: false,
    axUnaccountedWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
  };
}

const row = (
  path: string,
  depth: number,
  title: string,
  frame: GuiFrame,
): DockedAxNode =>
  axLeaf({ path, depth, role: "AXRow", title, frame: { ...frame } });

/**
 * The scripted Timeline pane subtree:
 *
 *   0.1 AXGroup "Timeline" TIMELINE_FRAME
 *   ├─ 0.1.1 AXRow "Background"   y=620
 *   ├─ 0.1.2 AXRow "Solid 1"      y=640   (layer row)
 *   ├─ 0.1.3 AXRow "Solid 1"      y=660   (same text — ambiguity probe)
 *   ├─ 0.1.4 AXRow "Position"     y=680   (property row)
 *   ├─ 0.1.5 AXRow "Opacity"      y=700   (property row)
 *   ├─ 0.1.6 AXButton "Previous keyframe"  (navigator, not a row)
 *   └─ 0.1.7 AXButton "Next keyframe"      (navigator, not a row)
 */
function timelineTree(): DockedAxNode {
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      axLeaf({
        path: "0.1",
        depth: 1,
        role: "AXGroup",
        title: "Timeline",
        frame: { ...TIMELINE_FRAME },
        children: [
          row("0.1.1", 2, "Background", { x: 0, y: 620, width: 1440, height: 20 }),
          row("0.1.2", 2, "Solid 1", { x: 0, y: 640, width: 1440, height: 20 }),
          row("0.1.3", 2, "Solid 1", { x: 0, y: 660, width: 1440, height: 20 }),
          row("0.1.4", 2, "Position", { x: 0, y: 680, width: 1440, height: 20 }),
          row("0.1.5", 2, "Opacity", { x: 0, y: 700, width: 1440, height: 20 }),
          axLeaf({
            path: "0.1.6",
            depth: 2,
            role: "AXButton",
            title: "Previous keyframe",
            frame: { x: 180, y: 602, width: 24, height: 20 },
          }),
          axLeaf({
            path: "0.1.7",
            depth: 2,
            role: "AXButton",
            title: "Next keyframe",
            frame: { x: 210, y: 602, width: 24, height: 20 },
          }),
        ],
      }),
    ],
  });
}

function serializeReport(root: DockedAxNode): string {
  const lines: string[] = [];
  const visit = (node: DockedAxNode): void => {
    const pos = node.frame === null ? "-|-" : `${node.frame.x},${node.frame.y}`;
    const size = node.frame === null ? "-|-" : `${node.frame.width},${node.frame.height}`;
    lines.push(
      `N|${node.path}|${node.depth}|${node.role}|${node.subrole ?? ""}|` +
        `${node.title ?? ""}|${node.description ?? ""}|${node.value ?? ""}|${pos}|${size}`,
    );
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  lines.push("DONE|nodes=0|truncated=0");
  return `${lines.join("\n")}\n`;
}

function fakePaneOps(over: Partial<DockedPaneOps> = {}): DockedPaneOps {
  return {
    observe: () => appState([mainWindow()]),
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: [censusRow()],
    }),
    walkPane: () => serializeReport(timelineTree()),
    ...over,
  };
}

const LOCATOR = { pane: { title: "Timeline" } } as const;

const COMP: CompInfo = {
  name: "Comp 1",
  width: 1920,
  height: 1080,
  duration: 10,
  frameRate: 30,
  layerCount: 2,
};

function layer(name: string, selected: boolean): LayerInfo {
  return { id: 1, name, index: 1, enabled: true, selected, type: "av" };
}

function positionProperty(over: Partial<PropertyInfo> = {}): PropertyInfo {
  return {
    name: "Position",
    kind: "value",
    valueType: "TwoD",
    value: [0, 0],
    selected: false,
    isTimeVarying: true,
    keyframes: [
      { index: 1, time: 0, value: [0, 0] },
      { index: 2, time: 5, value: [100, 100] },
      { index: 3, time: 10, value: [200, 200] },
    ],
    ...over,
  } as PropertyInfo;
}

/** A mutable fake of the #359 DOM readback surface. */
function fakeReadback(over: Partial<TimelineReadback> = {}) {
  const state = {
    frame: 0,
    layerSelected: "",
    propertySelected: false,
  };
  const readback: TimelineReadback = {
    comp: () => COMP,
    compTime: (): CompTime => ({
      comp: COMP.name,
      time: state.frame / COMP.frameRate,
      frame: state.frame,
    }),
    layers: () => [
      layer("Background", state.layerSelected === "Background"),
      layer("Solid 1", state.layerSelected === "Solid 1"),
    ],
    property: () =>
      positionProperty({ selected: state.propertySelected }),
    ...over,
  };
  return { readback, state };
}

function fakeMouse(over: Partial<TimelineMouseOps> = {}) {
  const clicks: { x: number; y: number }[] = [];
  const drags: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  const mouse: TimelineMouseOps = {
    click: (x, y) => {
      clicks.push({ x, y });
    },
    drag: (from, to) => {
      drags.push({ from, to });
    },
    ...over,
  };
  return { mouse, clicks, drags };
}

/** Build a controller directly — tests inject every seam. */
function build(over: {
  paneOps?: Partial<DockedPaneOps>;
  mouse?: TimelineMouseOps;
  readback?: Partial<TimelineReadback>;
  authorizeMutation?: ConstructorParameters<typeof TimelineController>[0]["authorizeMutation"];
  postcondition?: ConstructorParameters<typeof TimelineController>[0]["postcondition"];
} = {}) {
  const pane = new DockedPaneObserver({
    pid: PID,
    ops: fakePaneOps(over.paneOps ?? {}),
  });
  const { readback, state } = fakeReadback(over.readback ?? {});
  const mouse = over.mouse ?? fakeMouse().mouse;
  const sleep = () => Promise.resolve();
  const controller = new TimelineController({
    pane,
    paneLocator: LOCATOR,
    mouse,
    readback,
    authorizeMutation: over.authorizeMutation ?? (() => ({ allowed: true })),
    postcondition: { timeoutMs: 50, intervalMs: 1, ...over.postcondition },
    sleep,
    newOperationId: () => "op-1",
  });
  return { controller, state, mouse };
}

describe("timelineCapabilities", () => {
  it("reports mutate-gui ops unavailable on macOS and unsupported elsewhere", () => {
    const mac = timelineCapabilities("darwin");
    expect(mac.rows.support).toBe("implemented");
    expect(mac.scrub.support).toBe("unavailable");
    expect(mac.selectRow.support).toBe("unavailable");
    expect(mac.navigateKeyframe.support).toBe("unavailable");
    const win = timelineCapabilities("win32");
    expect(win.scrub.support).toBe("unsupported");
    expect(win.rows.support).toBe("unsupported");
  });
});

describe("scrub", () => {
  it("drags on the ruler and verifies comp.time within tolerance", async () => {
    const { mouse, drags } = fakeMouse();
    const { readback, state } = fakeReadback();
    const wrappedMouse: TimelineMouseOps = {
      ...mouse,
      drag: (from, to) => {
        drags.length = 0;
        void mouse.drag!(from, to);
        // The fake host honours the drag: the indicator lands on frame 150.
        state.frame = 150;
      },
    };
    const { controller } = build({ mouse: wrappedMouse, readback });
    const result = await controller.scrub({ comp: "Comp 1", frame: 150, ruler: RULER });
    expect(result.verdict).toBe("performed");
    expect(result.operationClass).toBe("mutate-gui");
    expect(result.channel).toBe("gui-act+dom-readback");
    expect(result.withinTolerance).toBe(true);
    expect(result.observedFrame).toBe(150);
    expect(result.toleranceFrames).toBe(1);
    // frameToX(150) = 200 + (150/300)*1200 = 800; origin reads comp.time=0 → x=200.
    expect(drags).toHaveLength(1);
    expect(drags[0]?.to.x).toBeCloseTo(800);
    expect(drags[0]?.from.x).toBeCloseTo(200);
    expect(drags[0]?.to.y).toBeCloseTo(620);
  });

  it("reports indeterminate on postcondition timeout and never resends", async () => {
    const { mouse, drags } = fakeMouse(); // drag does not move comp.time
    const { readback, state } = fakeReadback();
    state.frame = 0;
    const { controller } = build({ mouse, readback });
    const result = await controller.scrub({ comp: "Comp 1", frame: 150, ruler: RULER });
    expect(result.verdict).toBe("indeterminate");
    expect(result.withinTolerance).toBe(false);
    expect(drags).toHaveLength(1); // exactly one act — resend prohibited
    expect(result.refusal?.code).toBe("indeterminate");
  });

  it("refuses before posting when the mutation gate denies", async () => {
    const { mouse, drags } = fakeMouse();
    const { readback } = fakeReadback();
    const { controller } = build({
      mouse,
      readback,
      authorizeMutation: () => ({ allowed: false, reason: "gate closed" }),
    });
    await expect(
      controller.scrub({ comp: "Comp 1", frame: 150, ruler: RULER }),
    ).rejects.toMatchObject({ name: "TimelineError", code: "refused" });
    expect(drags).toHaveLength(0);
  });

  it("refuses unsupported when no drag vehicle exists", async () => {
    const { readback } = fakeReadback();
    // A build with click but no drag vehicle — B-IME's pending state.
    const mouse: TimelineMouseOps = { click: () => {} };
    const { controller } = build({ mouse, readback });
    await expect(
      controller.scrub({ comp: "Comp 1", frame: 150, ruler: RULER }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses stale-locator when the ruler left the pane frame", async () => {
    const { mouse, drags } = fakeMouse();
    const { readback } = fakeReadback();
    const { controller } = build({ mouse, readback });
    await expect(
      controller.scrub({
        comp: "Comp 1",
        frame: 150,
        ruler: { ...RULER, frame: { x: 5000, y: 600, width: 1200, height: 40 } },
      }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(drags).toHaveLength(0);
  });
});

describe("selectRow", () => {
  function selectSetup(clickEffect?: (x: number, y: number) => void) {
    const { readback, state } = fakeReadback();
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        clickEffect?.(x, y);
      },
    });
    const { controller } = build({ mouse, readback });
    return { controller, state, clicks };
  }

  it("clicks the resolved row and verifies layer selection", async () => {
    const { controller, state, clicks } = selectSetup(() => {
      state.layerSelected = "Solid 1";
    });
    const result = await controller.selectRow({
      row: { text: "Solid 1", ordinal: 2 },
      verify: { kind: "layer", comp: "Comp 1", layer: "Solid 1" },
    });
    expect(result.verdict).toBe("performed");
    expect(result.observedSelected).toBe(true);
    // Row 0.1.2 frame center: {x:720, y:650}.
    expect(clicks).toEqual([{ x: 720, y: 650 }]);
    expect(result.row.axPath).toBe("0.1.2");
  });

  it("refuses ambiguous-target on repeated row text without an ordinal", async () => {
    const { controller, clicks } = selectSetup();
    await expect(
      controller.selectRow({
        row: { text: "Solid 1" },
        verify: { kind: "layer", comp: "Comp 1", layer: "Solid 1" },
      }),
    ).rejects.toMatchObject({ code: "ambiguous-target" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses stale-locator when the ordinal names different text", async () => {
    const { controller, clicks } = selectSetup();
    await expect(
      controller.selectRow({
        row: { text: "Solid 1", ordinal: 1 }, // ordinal 1 is "Background"
        verify: { kind: "layer", comp: "Comp 1", layer: "Solid 1" },
      }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(clicks).toHaveLength(0);
  });

  it("verifies property selection through Property.selected", async () => {
    const { readback, state } = fakeReadback();
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        state.propertySelected = true;
      },
    });
    const { controller } = build({ mouse, readback });
    const result = await controller.selectRow({
      row: { text: "Opacity" },
      verify: {
        kind: "property",
        comp: "Comp 1",
        layer: "Solid 1",
        path: ["ADBE Transform Group", "ADBE Opacity"],
      },
    });
    expect(result.verdict).toBe("performed");
    // Row 0.1.5 "Opacity" frame center: {x:720, y:710}.
    expect(clicks).toEqual([{ x: 720, y: 710 }]);
    void state;
  });

  it("reports indeterminate when the selection readback never confirms", async () => {
    const { controller, clicks } = selectSetup(); // click changes nothing
    const result = await controller.selectRow({
      row: { text: "Background" },
      verify: { kind: "layer", comp: "Comp 1", layer: "Background" },
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.observedSelected).toBe(false);
    expect(clicks).toHaveLength(1);
  });

  it("refuses unproven when the pane attribution is not owned", async () => {
    const { mouse, clicks } = fakeMouse();
    const { readback } = fakeReadback();
    const { controller } = build({
      mouse,
      readback,
      paneOps: {
        observe: () => appState([mainWindow({ censusAttribution: "foreign" })]),
      },
    });
    await expect(
      controller.selectRow({
        row: { text: "Background" },
        verify: { kind: "layer", comp: "Comp 1", layer: "Background" },
      }),
    ).rejects.toMatchObject({ code: "unproven" });
    expect(clicks).toHaveLength(0);
  });
});

describe("navigateToKeyframe", () => {
  it("clicks the keyframe on the property row and lands on comp.time", async () => {
    const { readback, state } = fakeReadback();
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        state.frame = 150; // key 2 at t=5s * 30fps
      },
    });
    const { controller } = build({ mouse, readback });
    const result = await controller.navigateToKeyframe({
      comp: "Comp 1",
      layer: "Solid 1",
      path: ["ADBE Transform Group", "ADBE Position"],
      key: { index: 2 },
      via: "click",
      ruler: RULER,
      // row omitted → the "Position" row is found by property name
    });
    expect(result.verdict).toBe("performed");
    expect(result.key).toEqual({ index: 2, time: 5 });
    expect(result.expectedFrame).toBe(150);
    expect(result.withinTolerance).toBe(true);
    // keyFrame 150 → x = 200 + (150/300)*1200 = 800; Position row y center = 690.
    expect(clicks).toEqual([{ x: 800, y: 690 }]);
  });

  it("navigator-previous lands on the adjacent key before comp.time", async () => {
    const { readback, state } = fakeReadback();
    state.frame = 240; // t=8s — between key 2 (5s) and key 3 (10s)
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        state.frame = 150; // previous key = index 2 at 5s
      },
    });
    const { controller } = build({ mouse, readback });
    const result = await controller.navigateToKeyframe({
      comp: "Comp 1",
      layer: "Solid 1",
      path: ["ADBE Transform Group", "ADBE Position"],
      key: { index: 2 }, // the requested key is evidence; via navigator the adjacent rule decides
      via: "navigator-previous",
      navigator: { axPath: "0.1.6" },
    });
    expect(result.verdict).toBe("performed");
    expect(result.key.index).toBe(2);
    expect(result.expectedFrame).toBe(150);
    // Navigator node 0.1.6 frame {x:180,y:602,w:24,h:20} → center {192,612}.
    expect(clicks).toEqual([{ x: 192, y: 612 }]);
  });

  it("refuses stale-locator when the navigator axPath drifted", async () => {
    const { readback } = fakeReadback();
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse, readback });
    await expect(
      controller.navigateToKeyframe({
        comp: "Comp 1",
        layer: "Solid 1",
        path: ["ADBE Transform Group", "ADBE Position"],
        key: { index: 2 },
        via: "navigator-next",
        navigator: { axPath: "0.9.9" },
      }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses not-found when the key does not exist", async () => {
    const { readback } = fakeReadback();
    const { mouse } = fakeMouse();
    const { controller } = build({ mouse, readback });
    await expect(
      controller.navigateToKeyframe({
        comp: "Comp 1",
        layer: "Solid 1",
        path: ["ADBE Transform Group", "ADBE Position"],
        key: { index: 9 },
        via: "click",
        ruler: RULER,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses not-found when there is no adjacent navigator key", async () => {
    const { readback, state } = fakeReadback();
    state.frame = 0; // t=0 — no key before it
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse, readback });
    await expect(
      controller.navigateToKeyframe({
        comp: "Comp 1",
        layer: "Solid 1",
        path: ["ADBE Transform Group", "ADBE Position"],
        key: { index: 1 },
        via: "navigator-previous",
        navigator: { axPath: "0.1.6" },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(clicks).toHaveLength(0);
  });
});

describe("rows (observe)", () => {
  it("enumerates the pane's visible row identities", () => {
    const { controller } = build();
    const rows = controller.rows();
    expect(rows.map((r) => r.text)).toEqual([
      "Background",
      "Solid 1",
      "Solid 1",
      "Position",
      "Opacity",
    ]);
    expect(rows[1]?.axPath).toBe("0.1.2");
  });
});
