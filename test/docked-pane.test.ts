/**
 * Docked-region pane deep AX walk tests (#361,
 * `specs/workspace-editing/spec.md` §6/§7).
 *
 * Everything here runs against scripted fake AX trees and fake
 * `DockedPaneOps`: this proves the contract — bounded walk, `axPath`
 * re-resolution, `stale-locator` drift detection, census-frame region
 * bounding, fail-closed refusals and row enumeration — at
 * `automated test` level. It does NOT prove a real After Effects exposes
 * docked panes through AX at all; that stays unverified until a real-host
 * run records it (the issue's own verification level).
 */

import { describe, expect, it } from "vitest";

import {
  axLeaf,
  boundAxTree,
  DEFAULT_ROW_ROLES,
  DockedPaneObserver,
  enumeratePaneRows,
  parsePaneWalkReport,
  pickDockedPaneParent,
  resolveAxPath,
  resolveDockedPane,
  type DockedAxNode,
  type DockedPaneOps,
} from "../src/panels/docked/index.js";
import { dockedPaneForTarget } from "../src/api/docked-pane.js";
import type { PanelError } from "../src/panels/types.js";
import {
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { AfterEffects } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PID = 4242;

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const FLOAT_FRAME: GuiFrame = { x: 1600, y: 100, width: 400, height: 300 };
const TIMELINE_FRAME: GuiFrame = { x: 0, y: 600, width: 1440, height: 200 };
const RQ_FRAME: GuiFrame = { x: 100, y: 50, width: 400, height: 300 };

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

function floatWindow(): GuiWindowInfo {
  return mainWindow({
    title: "Floating Panel",
    subrole: "AXFloatingWindow",
    frame: { ...FLOAT_FRAME },
  });
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

function appState(
  windows: readonly GuiWindowInfo[],
  over: Partial<GuiAppState> = {},
): GuiAppState {
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
    ...over,
  };
}

/**
 * A scripted fake of AE's main-window AX subtree: the walk root is the
 * window element itself; children are the docked panes and chrome.
 *
 *   0      AXLayoutArea (the window; frame = MAIN_FRAME)
 *   ├─ 0.1 AXGroup "Toolbar"            (frameless chrome)
 *   ├─ 0.2 AXGroup                      (frameless content split)
 *   │   ├─ 0.2.1 AXGroup "Timeline"     TIMELINE_FRAME
 *   │   │   ├─ 0.2.1.1 AXRow "Background"
 *   │   │   ├─ 0.2.1.2 AXRow "Comp 1"
 *   │   │   └─ 0.2.1.3 AXRow "Adjustment Layer"
 *   │   └─ 0.2.2 AXGroup "Render Queue" RQ_FRAME
 *   │       ├─ 0.2.2.1 AXRow "Comp 1"
 *   │       └─ 0.2.2.2 AXRow "Comp 2"
 *   └─ 0.3 AXStaticText "ready"
 */
function fakeTree(): DockedAxNode {
  const row = (
    path: string,
    depth: number,
    title: string,
    frame: GuiFrame | null = null,
  ): DockedAxNode =>
    axLeaf({
      path,
      depth,
      role: "AXRow",
      title,
      frame: frame === null ? null : { ...frame },
    });
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      axLeaf({ path: "0.1", depth: 1, role: "AXGroup", title: "Toolbar" }),
      axLeaf({
        path: "0.2",
        depth: 1,
        role: "AXGroup",
        children: [
          axLeaf({
            path: "0.2.1",
            depth: 2,
            role: "AXGroup",
            title: "Timeline",
            frame: { ...TIMELINE_FRAME },
            children: [
              row("0.2.1.1", 3, "Background", { x: 0, y: 610, width: 1440, height: 20 }),
              row("0.2.1.2", 3, "Comp 1", { x: 0, y: 630, width: 1440, height: 20 }),
              row("0.2.1.3", 3, "Adjustment Layer", { x: 0, y: 650, width: 1440, height: 20 }),
            ],
          }),
          axLeaf({
            path: "0.2.2",
            depth: 2,
            role: "AXGroup",
            title: "Render Queue",
            frame: { ...RQ_FRAME },
            children: [
              row("0.2.2.1", 3, "Comp 1", { x: 110, y: 60, width: 380, height: 20 }),
              row("0.2.2.2", 3, "Comp 2", { x: 110, y: 80, width: 380, height: 20 }),
            ],
          }),
        ],
      }),
      axLeaf({
        path: "0.3",
        depth: 1,
        role: "AXStaticText",
        value: "ready",
        frame: { x: 0, y: 870, width: 100, height: 20 },
      }),
    ],
  });
}

/** Serialize a `DockedAxNode` tree into the script's `N|` report format. */
function serializeReport(root: DockedAxNode, done = "DONE|nodes=0|truncated=0"): string {
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
  lines.push(done);
  return `${lines.join("\n")}\n`;
}

function fakeOps(over: Partial<DockedPaneOps> = {}) {
  const calls: { observe: number; census: number; walk: unknown[] } = {
    observe: 0,
    census: 0,
    walk: [],
  };
  const ops: DockedPaneOps = {
    observe: () => {
      calls.observe += 1;
      return appState([mainWindow()]);
    },
    censusWindows: () => {
      calls.census += 1;
      return { available: true, reason: null, windows: [censusRow()] };
    },
    walkPane: (request) => {
      calls.walk.push(request);
      return serializeReport(fakeTree());
    },
    ...over,
  };
  return { ops, calls };
}

const LOCATOR = {
  parent: { title: "After Effects" },
  pane: { title: "Timeline" },
} as const;

describe("parsePaneWalkReport", () => {
  it("parses status lines into typed outcomes", () => {
    expect(parsePaneWalkReport("MISSING\n")).toEqual({ kind: "missing" });
    expect(parsePaneWalkReport("BADFRAME\n")).toEqual({ kind: "bad-frame" });
    expect(parsePaneWalkReport("NOROOT\n")).toEqual({ kind: "no-root" });
    expect(parsePaneWalkReport("AMBIGUOUS\n")).toEqual({ kind: "ambiguous-root" });
    expect(parsePaneWalkReport("")).toEqual({ kind: "no-root" });
  });

  it("rebuilds the tree with paths, frames and the DONE trailer", () => {
    const report = parsePaneWalkReport(serializeReport(fakeTree(), "DONE|nodes=12|truncated=1"));
    expect(report.kind).toBe("walked");
    if (report.kind !== "walked") return;
    expect(report.root.path).toBe("0");
    expect(report.root.role).toBe("AXLayoutArea");
    expect(report.root.frame).toEqual(MAIN_FRAME);
    expect(report.root.children).toHaveLength(3);
    const timeline = report.root.children[1]?.children[0];
    expect(timeline?.path).toBe("0.2.1");
    expect(timeline?.title).toBe("Timeline");
    expect(timeline?.children.map((c) => c.title)).toEqual([
      "Background",
      "Comp 1",
      "Adjustment Layer",
    ]);
    expect(report.nodesReported).toBe(12);
    expect(report.scriptTruncated).toBe(true);
  });

  it("tolerates malformed lines and detached partial trees", () => {
    const text = [
      "N|0|0|AXLayoutArea||AE|||0,25|1440,900",
      "garbage line",
      "N|0.1|1|AXGroup|broken", // too few fields — skipped
      "N|0.2|1|AXGroup||Content|||0,25|1440,775",
      "N|0.2.1|2|AXGroup||Timeline|||0,600|1440,200",
      "DONE|nodes=4|truncated=0",
      "",
    ].join("\n");
    const report = parsePaneWalkReport(text);
    expect(report.kind).toBe("walked");
    if (report.kind !== "walked") return;
    expect(report.root.children).toHaveLength(1);
    expect(report.root.children[0]?.path).toBe("0.2");
    expect(report.root.children[0]?.children[0]?.path).toBe("0.2.1");
  });
});

describe("boundAxTree", () => {
  it("prunes over-depth branches but keeps legal siblings", () => {
    const deep = axLeaf({
      path: "0",
      depth: 0,
      children: [
        axLeaf({
          path: "0.1",
          depth: 1,
          children: [axLeaf({ path: "0.1.1", depth: 2, title: "too deep" })],
        }),
        axLeaf({ path: "0.2", depth: 1, title: "kept" }),
      ],
    });
    const bounded = boundAxTree(deep, { maxDepth: 1, maxNodes: 100 });
    expect(bounded.stopReason).toBe("depth");
    expect(bounded.truncated).toBe(true);
    expect(bounded.root.children.map((c) => c.path)).toEqual(["0.1", "0.2"]);
    expect(bounded.root.children[0]?.children).toHaveLength(0);
    expect(bounded.root.children[1]?.title).toBe("kept");
  });

  it("stops at the node cap and reports it", () => {
    const wide = axLeaf({
      path: "0",
      depth: 0,
      children: [1, 2, 3, 4].map((i) => axLeaf({ path: `0.${i}`, depth: 1 })),
    });
    const bounded = boundAxTree(wide, { maxDepth: 10, maxNodes: 3 });
    expect(bounded.stopReason).toBe("nodes");
    expect(bounded.nodesKept).toBe(3);
    expect(bounded.root.children).toHaveLength(2);
  });

  it("honours the deadline through the injected clock", () => {
    let tick = 0;
    const now = () => {
      tick += 100;
      return tick;
    };
    const wide = axLeaf({
      path: "0",
      depth: 0,
      children: [1, 2, 3].map((i) => axLeaf({ path: `0.${i}`, depth: 1 })),
    });
    const bounded = boundAxTree(wide, {
      maxDepth: 10,
      maxNodes: 100,
      deadlineMs: 150,
      now,
    });
    expect(bounded.stopReason).toBe("deadline");
    expect(bounded.truncated).toBe(true);
  });
});

describe("axPath and rows", () => {
  it("resolves axPaths and rejects malformed or missing ones", () => {
    const tree = fakeTree();
    expect(resolveAxPath(tree, "0")?.role).toBe("AXLayoutArea");
    expect(resolveAxPath(tree, "0.2.1")?.title).toBe("Timeline");
    expect(resolveAxPath(tree, "0.2.1.2")?.title).toBe("Comp 1");
    expect(resolveAxPath(tree, "0.9")).toBeNull();
    expect(resolveAxPath(tree, "0.2.9.1")).toBeNull();
    expect(resolveAxPath(tree, "bogus")).toBeNull();
    expect(resolveAxPath(tree, "0.0")).toBeNull();
  });

  it("enumerates row identities with text + ordinal + axPath", () => {
    const timeline = fakeTree().children[1]?.children[0];
    expect(timeline).toBeDefined();
    if (timeline === undefined) return;
    const rows = enumeratePaneRows(timeline);
    expect(rows.map((r) => r.text)).toEqual([
      "Background",
      "Comp 1",
      "Adjustment Layer",
    ]);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.axPath)).toEqual(["0.2.1.1", "0.2.1.2", "0.2.1.3"]);
    expect(rows[0]?.frame).toEqual({ x: 0, y: 610, width: 1440, height: 20 });
  });

  it("honours a custom row-role set", () => {
    const tree = fakeTree();
    const rows = enumeratePaneRows(tree, { rowRoles: ["AXGroup"] });
    // Only titled AXGroups count; the pane roots and toolbar qualify.
    expect(rows.every((r) => r.role === "AXGroup")).toBe(true);
    expect(DEFAULT_ROW_ROLES).toContain("AXRow");
  });
});

describe("pickDockedPaneParent", () => {
  it("resolves the single framed window", () => {
    const parent = pickDockedPaneParent({
      pid: PID,
      state: appState([mainWindow()]),
      census: [censusRow()],
      locator: { title: "After Effects" },
    });
    expect(parent.index).toBe(1);
    expect(parent.attribution).toBe("owned");
    expect(parent.censusWindow?.windowNumber).toBe(9001);
  });

  it("refuses ambiguity when no parent locator narrows the choice", () => {
    try {
      pickDockedPaneParent({
        pid: PID,
        state: appState([mainWindow(), floatWindow()]),
        census: [censusRow()],
      });
      expect.unreachable();
    } catch (error) {
      const panel = error as PanelError;
      expect(panel.code).toBe("ambiguous");
      expect(panel.candidates.length).toBe(2);
    }
  });

  it("excludes frameless windows from parent candidacy", () => {
    const frameless = mainWindow({ frame: null });
    const parent = pickDockedPaneParent({
      pid: PID,
      state: appState([frameless, floatWindow()]),
      census: [censusRow({ bounds: FLOAT_FRAME })],
      locator: { title: "Floating Panel" },
    });
    expect(parent.window.title).toBe("Floating Panel");
  });

  it("refuses a windowNumber owned by another pid", () => {
    try {
      pickDockedPaneParent({
        pid: PID,
        state: appState([mainWindow()]),
        census: [censusRow({ pid: 9999, owner: "Other AE" })],
        locator: { windowNumber: 9001 },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PanelError).code).toBe("unproven");
    }
  });
});

describe("resolveDockedPane", () => {
  function resolve(over: {
    locator?: Parameters<typeof resolveDockedPane>[0]["locator"];
    tree?: DockedAxNode;
    parent?: ReturnType<typeof pickDockedPaneParent>;
  } = {}) {
    const parent =
      over.parent ??
      pickDockedPaneParent({
        pid: PID,
        state: appState([mainWindow()]),
        census: [censusRow()],
        locator: { title: "After Effects" },
      });
    return resolveDockedPane({
      pid: PID,
      parent,
      tree: over.tree ?? fakeTree(),
      walk: { nodesKept: 12, truncated: false, stopReason: "complete", scriptTruncated: false },
      locator: over.locator ?? LOCATOR,
      now: () => new Date("2026-11-26T00:00:00Z"),
    });
  }

  it("resolves a pane to a docked-region PanelTarget", () => {
    const resolution = resolve();
    expect(resolution.target.pid).toBe(PID);
    expect(resolution.target.surface.kind).toBe("docked-region");
    expect(resolution.target.surface.attribution).toBe("owned");
    expect(resolution.target.surface.windowIndex).toBe(1);
    expect(resolution.target.surface.windowNumber).toBeNull();
    expect(resolution.target.surface.frame).toEqual(TIMELINE_FRAME);
    expect(resolution.pane.path).toBe("0.2.1");
    expect(resolution.pane.title).toBe("Timeline");
    expect(resolution.target.resolvedAt).toBe("2026-11-26T00:00:00.000Z");
  });

  it("re-resolves a recorded axPath and reports drift as stale-locator", () => {
    const first = resolve();
    const axPath = first.pane.path;

    // Same tree: the recorded path still resolves to the same pane.
    const again = resolve({ locator: { ...LOCATOR, axPath } });
    expect(again.pane.path).toBe(axPath);

    // A tree where the pane moved to a different index: the path now names
    // a different element — drift is refused, never remapped.
    const moved = structuredClone(fakeTree());
    const content = moved.children[1];
    if (content === undefined) throw new Error("fixture broken");
    // Swap the two panes so "0.2.1" is now the Render Queue.
    const panes = content.children as DockedAxNode[];
    const tmp = panes[0];
    panes[0] = panes[1] as DockedAxNode;
    panes[1] = tmp as DockedAxNode;
    expect(() =>
      resolve({
        locator: {
          parent: { title: "After Effects" },
          axPath,
          pane: { title: "Timeline" },
        },
        tree: moved,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-locator" }) as Error);
  });

  it("reports stale-locator when the recorded path no longer exists", () => {
    const shallow = boundAxTree(fakeTree(), { maxDepth: 1, maxNodes: 100 }).root;
    expect(() =>
      resolve({
        locator: { parent: { title: "After Effects" }, axPath: "0.2.1" },
        tree: shallow,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-locator" }) as Error);
  });

  it("refuses not-found when no pane matches and ambiguous when several do", () => {
    expect(() =>
      resolve({
        locator: { parent: { title: "After Effects" }, pane: { title: "No Such Pane" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "not-found" }) as Error);

    // Two panes titled "Timeline" under one parent → ambiguous.
    const twoPanes = fakeTree();
    const content = twoPanes.children[1];
    if (content === undefined) throw new Error("fixture broken");
    (content.children as DockedAxNode[]).push(
      axLeaf({
        path: "0.2.3",
        depth: 2,
        role: "AXGroup",
        title: "Timeline",
        frame: { x: 0, y: 400, width: 1440, height: 200 },
        children: [],
      }),
    );
    try {
      resolve({
        locator: { parent: { title: "After Effects" }, pane: { title: "Timeline" } },
        tree: twoPanes,
      });
      expect.unreachable();
    } catch (error) {
      const panel = error as PanelError;
      expect(panel.code).toBe("ambiguous");
      expect(panel.candidates.length).toBe(2);
    }
  });

  it("refuses an empty locator rather than guessing a pane", () => {
    expect(() =>
      resolve({ locator: { parent: { title: "After Effects" } } }),
    ).toThrowError(expect.objectContaining({ code: "not-found" }) as Error);
  });

  it("refuses a frameless pane — no geometry, no honest surface", () => {
    const frameless = fakeTree();
    const timeline = frameless.children[1]?.children[0];
    if (timeline === undefined) throw new Error("fixture broken");
    // Mutate via a rebuilt node: frame removed.
    const rebuilt: DockedAxNode = { ...timeline, frame: null };
    const content = frameless.children[1];
    if (content === undefined) throw new Error("fixture broken");
    const newContent: DockedAxNode = {
      ...content,
      children: [rebuilt, ...(content.children[1] === undefined ? [] : [content.children[1]])],
    };
    const newTree: DockedAxNode = {
      ...frameless,
      children: [frameless.children[0] as DockedAxNode, newContent, frameless.children[2] as DockedAxNode],
    };
    expect(() =>
      resolve({
        locator: { parent: { title: "After Effects" }, pane: { title: "Timeline" } },
        tree: newTree,
      }),
    ).toThrowError(expect.objectContaining({ code: "not-found" }) as Error);
  });

  it("refuses unproven when the walk root does not match the parent frame", () => {
    const wrongRoot = axLeaf({
      ...fakeTree(),
      frame: { x: 999, y: 999, width: 10, height: 10 },
    });
    expect(() =>
      resolve({
        locator: { parent: { title: "After Effects" }, pane: { title: "Timeline" } },
        tree: wrongRoot,
      }),
    ).toThrowError(expect.objectContaining({ code: "unproven" }) as Error);
  });

  it("honours the census-frame bound on the pane", () => {
    const resolution = resolve({
      locator: {
        parent: { title: "After Effects" },
        pane: { title: "Render Queue" },
        frame: RQ_FRAME,
      },
    });
    expect(resolution.pane.path).toBe("0.2.2");
    expect(resolution.target.surface.frame).toEqual(RQ_FRAME);
  });
});

describe("DockedPaneObserver", () => {
  function observer(ops: DockedPaneOps, bounds?: { maxDepth: number; maxNodes: number; maxSeconds: number }) {
    return new DockedPaneObserver({
      pid: PID,
      ops,
      ...(bounds === undefined ? {} : { bounds }),
      now: () => new Date("2026-11-26T00:00:00Z"),
      clock: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
  }

  it("runs observe → census → walk → resolve end to end", () => {
    const { ops, calls } = fakeOps();
    const obs = observer(ops);
    const resolution = obs.identify(LOCATOR);
    expect(resolution.target.surface.kind).toBe("docked-region");
    expect(resolution.target.surface.frame).toEqual(TIMELINE_FRAME);
    expect(calls.observe).toBe(1);
    expect(calls.census).toBe(1);
    expect(calls.walk).toHaveLength(1);
    // The walk request carried the parent frame and the bounds.
    const request = calls.walk[0] as { parentFrame: GuiFrame; maxDepth: number };
    expect(request.parentFrame).toEqual(MAIN_FRAME);
    expect(request.maxDepth).toBe(14);
  });

  it("re-observes on every call — a locator, not a handle", () => {
    const { ops, calls } = fakeOps();
    const obs = observer(ops);
    obs.identify(LOCATOR);
    obs.rows(LOCATOR);
    expect(calls.observe).toBe(2);
    expect(calls.walk).toHaveLength(2);
  });

  it("enumerates rows inside the resolved pane", () => {
    const { ops } = fakeOps();
    const obs = observer(ops);
    const rows = obs.rows(LOCATOR);
    expect(rows.map((r) => r.text)).toEqual([
      "Background",
      "Comp 1",
      "Adjustment Layer",
    ]);
    expect(rows.map((r) => r.axPath)).toEqual(["0.2.1.1", "0.2.1.2", "0.2.1.3"]);
  });

  it("maps a failing observation to unavailable PanelError", () => {
    const { ops } = fakeOps({
      observe: () => {
        throw new Error("the accessibility query failed");
      },
    });
    const obs = observer(ops);
    expect(() => obs.identify(LOCATOR)).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("degrades a throwing census instead of crashing", () => {
    const { ops } = fakeOps({
      censusWindows: () => {
        throw new Error("census pipe broke");
      },
    });
    const obs = observer(ops);
    // The AX listing's own "owned" attribution still resolves the pane.
    const resolution = obs.identify(LOCATOR);
    expect(resolution.target.surface.attribution).toBe("owned");
  });

  it("maps walk-vehicle statuses to PanelError codes", () => {
    for (const [output, code] of [
      ["MISSING\n", "unavailable"],
      ["NOROOT\n", "not-found"],
      ["AMBIGUOUS\n", "ambiguous"],
      ["BADFRAME\n", "not-found"],
    ] as const) {
      const { ops } = fakeOps({ walkPane: () => output });
      const obs = observer(ops);
      expect(() => obs.identify(LOCATOR)).toThrowError(
        expect.objectContaining({ code }) as Error,
      );
    }
  });

  it("re-applies bounds to a scripted tree that exceeds them", () => {
    // A fake vehicle that ignores its bounds and returns the full deep
    // tree anyway: the TS-side bound must still prune it.
    const { ops } = fakeOps({
      walkPane: () => serializeReport(fakeTree()),
    });
    const obs = observer(ops, { maxDepth: 1, maxNodes: 800, maxSeconds: 20 });
    expect(() => obs.identify(LOCATOR)).toThrowError(
      expect.objectContaining({ code: "not-found" }) as Error,
    );
    // Depth 1 keeps only the window's direct children; "0.3" is a framed
    // AXStaticText — a legal pane candidate at the bound.
    const tree = obs.tree({
      parent: { title: "After Effects" },
      pane: { role: "AXStaticText" },
    });
    expect(tree.bounded.stopReason).toBe("depth");
    expect(tree.bounded.truncated).toBe(true);
  });

  it("surfaces stale-locator through the observer", () => {
    const { ops } = fakeOps();
    const obs = observer(ops);
    const first = obs.identify(LOCATOR);
    const axPath = first.pane.path;
    // Second observation: the pane at the recorded path now carries a
    // different identity — the tree drifted and the locator must refuse
    // rather than remap. (The script emits paths by position, so drift
    // shows up as a renamed/re-roled node at the same axPath.)
    const driftedReport = serializeReport(fakeTree()).replace(
      "N|0.2.1|2|AXGroup||Timeline|||",
      "N|0.2.1|2|AXGroup||Timeline (re-docked)|||",
    );
    const { ops: ops2 } = fakeOps({ walkPane: () => driftedReport });
    const obs2 = observer(ops2);
    expect(() =>
      obs2.identify({
        parent: { title: "After Effects" },
        axPath,
        pane: { title: "Timeline" },
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-locator" }) as Error);
  });
});

describe("dockedPaneForTarget", () => {
  it("refuses when no owned target is attested", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-docked-"));
    try {
      const transport = new FakeAfterEffectsTransport();
      const ae = await AfterEffects.launch({ transport, sessionRoot: root });
      expect(() => ae.dockedPane({ parent: { title: "x" } })).toThrowError(
        expect.objectContaining({ code: "unavailable" }) as Error,
      );
      await ae.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "darwin")(
    "reports unsupported on non-macOS platforms even with an attested target",
    () => {
      expect(() =>
        dockedPaneForTarget({ pid: PID, session: { uid: 1, username: "u", asid: 1, kind: "Aqua" } }, {
          parent: { title: "x" },
        }),
      ).toThrowError(expect.objectContaining({ code: "unsupported" }) as Error);
    },
  );
});
