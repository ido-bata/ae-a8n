/**
 * Comp-view pan/zoom contract tests (#367,
 * `specs/workspace-editing/spec.md` §12 W4+ deferred list "comp-view
 * pan/zoom").
 *
 * Everything here runs against scripted fake AX trees, a fake
 * `DockedPaneOps`, a recording fake mouse/capture/session-stream and a
 * mutable pane frame: this proves the contract — mutate-gui gating,
 * pane/control re-resolution, `ambiguous-target`/`stale-locator`
 * refusals, the capture-diff + geometry oracle, bounded postcondition
 * waits with no resend, and the `GlobalInputAuthorization` check on
 * the shortcut leg — at `automated test` level. It does NOT prove a
 * real After Effects honors CGEvent drags in the comp viewer or that
 * its zoom dropdown exposes the assumed AX shape; those are the
 * spec's prime real-host questions (§11).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { axLeaf, DockedPaneObserver } from "../src/panels/docked/index.js";
import type { DockedPaneOps, DockedAxNode } from "../src/panels/docked/index.js";
import type { GuiAppState, GuiFrame, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { CompViewController } from "../src/comp-view/controller.js";
import { compViewMutationGate } from "../src/comp-view/gate.js";
import type {
  CompViewCapture,
  CompViewMouseOps,
} from "../src/comp-view/types.js";
import type { SessionStreamPoster } from "../src/input/session-stream.js";
import type { GlobalInputAuthorization } from "../src/input/types.js";
import { compViewCapabilities } from "../src/api/comp-view.js";

const PID = 4242;

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const PANE_FRAME: GuiFrame = { x: 200, y: 200, width: 800, height: 600 };
const VIEWPORT: GuiFrame = { x: 300, y: 300, width: 400, height: 300 };

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
    axSuspectReason: null,
    axUnaccountedWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
  };
}

const leaf = (
  path: string,
  depth: number,
  role: string,
  title: string,
  frame: GuiFrame | null,
  children: DockedAxNode[] = [],
): DockedAxNode =>
  axLeaf({ path, depth, role, title, frame: frame === null ? null : { ...frame }, children });

/**
 * The scripted Comp pane subtree:
 *
 *   0      AXLayoutArea "After Effects" MAIN_FRAME
 *   └─ 0.1  AXGroup "Comp Viewer" PANE_FRAME
 *      ├─ 0.1.1 AXButton "Zoom"        (dropdown control)
 *      └─ 0.1.2 AXGroup "Viewer"       (content area)
 *
 * `popup` adds the dropdown item node the post-open walk exposes.
 */
function compTree(popup = false): DockedAxNode {
  const paneChildren: DockedAxNode[] = [
    leaf("0.1.1", 2, "AXButton", "Zoom", { x: 880, y: 210, width: 60, height: 24 }),
    leaf("0.1.2", 2, "AXGroup", "Viewer", { x: 220, y: 240, width: 760, height: 540 }),
  ];
  if (popup) {
    paneChildren.push(
      leaf("0.1.3", 2, "AXButton", "200%", { x: 820, y: 250, width: 80, height: 24 }),
    );
  }
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      leaf("0.1", 1, "AXGroup", "Comp Viewer", { ...PANE_FRAME }, paneChildren),
    ],
  });
}

/** Two same-titled panes — the `ambiguous-target` probe. */
function ambiguousTree(): DockedAxNode {
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      leaf("0.1", 1, "AXGroup", "Comp Viewer", { ...PANE_FRAME }),
      leaf("0.2", 1, "AXGroup", "Comp Viewer", {
        x: 1100, y: 200, width: 300, height: 300,
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

const LOCATOR = { pane: { title: "Comp Viewer" } } as const;

function fakePaneOps(over: Partial<DockedPaneOps> = {}): DockedPaneOps {
  return {
    observe: () => appState([mainWindow()]),
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: [censusRow()],
    }),
    walkPane: () => serializeReport(compTree(state.popup)),
    ...over,
  };
}

const state = { popup: false, sha: "capture-a" };

beforeEach(() => {
  state.popup = false;
  state.sha = "capture-a";
});

function fakeCapture() {
  const frames: GuiFrame[] = [];
  const capture = (frame: GuiFrame): CompViewCapture => {
    frames.push({ ...frame });
    return { path: "cap.png", sha256: state.sha, bytes: 1 };
  };
  return { capture, frames };
}

function fakeMouse(over: Partial<CompViewMouseOps> = {}) {
  const clicks: { x: number; y: number }[] = [];
  const drags: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  const mouse: CompViewMouseOps = {
    click: (x, y) => {
      clicks.push({ x, y });
      state.popup = true; // the zoom control opened the popup
      state.sha = "capture-b";
    },
    drag: (from, to) => {
      drags.push({ from, to });
      state.sha = "capture-b";
    },
    ...over,
  };
  return { mouse, clicks, drags };
}

function fakeStream(verdict: "performed" | "refused" | "indeterminate" = "performed") {
  const requests: { operation: string; steps: readonly unknown[] }[] = [];
  const poster: SessionStreamPoster = (request) => {
    requests.push({ operation: request.operation, steps: request.steps });
    state.sha = "capture-b";
    return { verdict };
  };
  return { poster, requests };
}

const SESSION_AUTH: GlobalInputAuthorization = {
  kind: "session",
  sessionId: "asid-367",
  tokenRef: "grant-367",
};

function build(over: {
  paneOps?: Partial<DockedPaneOps>;
  mouse?: CompViewMouseOps;
  capture?: (frame: GuiFrame) => CompViewCapture;
  sessionStream?: SessionStreamPoster;
  authorizeMutation?: ConstructorParameters<typeof CompViewController>[0]["authorizeMutation"];
  postcondition?: ConstructorParameters<typeof CompViewController>[0]["postcondition"];
} = {}) {
  const pane = new DockedPaneObserver({
    pid: PID,
    ops: fakePaneOps(over.paneOps ?? {}),
  });
  const { capture, frames } = fakeCapture();
  const controller = new CompViewController({
    pane,
    paneLocator: LOCATOR,
    mouse: over.mouse ?? fakeMouse().mouse,
    capture: { capture: over.capture ?? capture },
    ...(over.sessionStream === undefined ? {} : { sessionStream: over.sessionStream }),
    authorizeMutation: over.authorizeMutation ?? (() => ({ allowed: true })),
    postcondition: { timeoutMs: 50, intervalMs: 1, settleMs: 0, ...over.postcondition },
    sleep: () => Promise.resolve(),
    newOperationId: () => "op-1",
  });
  return { controller, frames };
}

describe("compViewCapabilities", () => {
  it("reports mutate-gui ops unavailable on macOS and unsupported elsewhere", () => {
    const mac = compViewCapabilities("darwin");
    expect(mac.pan.support).toBe("unavailable");
    expect(mac.zoom.support).toBe("unavailable");
    expect(mac.pan.verification).toBe("automated test");
    const win = compViewCapabilities("win32");
    expect(win.pan.support).toBe("unsupported");
    expect(win.zoom.support).toBe("unsupported");
  });
});

describe("compViewMutationGate", () => {
  it("refuses every op while A-SAFETY is uncleared (fail-closed)", () => {
    const gate = compViewMutationGate();
    expect(gate("pan").allowed).toBe(false);
    expect(gate("zoom").allowed).toBe(false);
  });
});

describe("pan", () => {
  it("drags inside the viewport and verifies the capture diff", async () => {
    const { mouse, drags } = fakeMouse();
    const { controller, frames } = build({ mouse });
    const result = await controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: -20 } });
    expect(result.verdict).toBe("performed");
    expect(result.operationClass).toBe("mutate-gui");
    expect(result.channel).toBe("gui-act+capture-diff+geometry");
    expect(result.captureDelta?.changed).toBe(true);
    expect(result.geometryStable).toBe(true);
    expect(result.paneFrameAfter).toEqual(PANE_FRAME);
    expect(drags).toHaveLength(1);
    // from = viewport center (500,450); to = from + delta.
    expect(drags[0]?.from).toEqual({ x: 500, y: 450 });
    expect(drags[0]?.to).toEqual({ x: 560, y: 430 });
    // Every capture is scoped to the re-verified pane frame.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).toEqual(PANE_FRAME);
    }
  });

  it("reports indeterminate when the capture never changes and never resends", async () => {
    const drags: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
    const stillMouse: CompViewMouseOps = {
      click: () => {},
      drag: (from, to) => {
        drags.push({ from, to });
        // No capture change — uniform content or a dropped drag.
      },
    };
    const { controller } = build({ mouse: stillMouse });
    const result = await controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } });
    expect(result.verdict).toBe("indeterminate");
    expect(result.refusal?.code).toBe("indeterminate");
    expect(drags).toHaveLength(1);
  });

  it("accepts an unchanged capture when expectCaptureChange is false", async () => {
    const stillMouse: CompViewMouseOps = {
      click: () => {},
      drag: () => {
        /* capture stays "capture-a" */
      },
    };
    const { controller } = build({ mouse: stillMouse });
    const result = await controller.pan({
      viewport: VIEWPORT,
      delta: { dx: 60, dy: 0 },
      expectCaptureChange: false,
    });
    expect(result.verdict).toBe("performed");
    expect(result.captureDelta?.changed).toBe(false);
  });

  it("refuses before posting when the mutation gate denies", async () => {
    const { mouse, drags } = fakeMouse();
    const { controller } = build({
      mouse,
      authorizeMutation: () => ({ allowed: false, reason: "gate closed" }),
    });
    await expect(
      controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } }),
    ).rejects.toMatchObject({ name: "CompViewError", code: "refused" });
    expect(drags).toHaveLength(0);
  });

  it("refuses when no mutation gate is configured (fail-closed default)", async () => {
    const { mouse, drags } = fakeMouse();
    const pane = new DockedPaneObserver({ pid: PID, ops: fakePaneOps() });
    const { capture } = fakeCapture();
    const controller = new CompViewController({
      pane,
      paneLocator: LOCATOR,
      mouse,
      capture: { capture },
      sleep: () => Promise.resolve(),
    });
    await expect(
      controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(drags).toHaveLength(0);
  });

  it("refuses unsupported when no drag vehicle exists", async () => {
    const clickOnly: CompViewMouseOps = { click: () => {} };
    const { controller } = build({ mouse: clickOnly });
    await expect(
      controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses stale-locator when the viewport left the pane frame", async () => {
    const { mouse, drags } = fakeMouse();
    const { controller } = build({ mouse });
    await expect(
      controller.pan({
        viewport: { x: 5000, y: 5000, width: 100, height: 100 },
        delta: { dx: 60, dy: 0 },
      }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(drags).toHaveLength(0);
  });

  it("refuses ambiguous-target when two panes match the locator", async () => {
    const { mouse, drags } = fakeMouse();
    const { controller } = build({
      mouse,
      paneOps: { walkPane: () => serializeReport(ambiguousTree()) },
    });
    await expect(
      controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } }),
    ).rejects.toMatchObject({ code: "ambiguous-target" });
    expect(drags).toHaveLength(0);
  });

  it("refuses unproven when pid attribution is not owned", async () => {
    const { mouse, drags } = fakeMouse();
    const { controller } = build({
      mouse,
      paneOps: {
        // The census cannot attribute the window to this pid — the
        // surface exists but mutation on it is unproven.
        observe: () =>
          appState([mainWindow({ censusAttribution: "unmatched" })]),
      },
    });
    await expect(
      controller.pan({ viewport: VIEWPORT, delta: { dx: 60, dy: 0 } }),
    ).rejects.toMatchObject({ code: "unproven" });
    expect(drags).toHaveLength(0);
  });
});

describe("zoom via dropdown", () => {
  const ZOOM = {
    via: "dropdown" as const,
    percent: 200,
    control: { axPath: "0.1.1", title: "Zoom" },
    item: { axPath: "0.1.3", title: "200%" },
  };

  it("clicks the control, re-walks, clicks the item and verifies the capture", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse });
    const result = await controller.zoom(ZOOM);
    expect(result.verdict).toBe("performed");
    expect(result.via).toBe("dropdown");
    expect(result.channel).toBe("gui-act+capture-diff+geometry");
    expect(result.captureDelta?.changed).toBe(true);
    // Control center {910,222}; item center {860,262}.
    expect(clicks).toEqual([
      { x: 910, y: 222 },
      { x: 860, y: 262 },
    ]);
  });

  it("reports indeterminate when the item path is absent from the reopened walk", async () => {
    // The popup never materializes: the first click posts, then item
    // resolution fails — an indeterminate record, never a clean refusal.
    const clicks: { x: number; y: number }[] = [];
    const clickOnly: CompViewMouseOps = {
      click: (x, y) => {
        clicks.push({ x, y });
        state.sha = "capture-b";
      },
    };
    const { controller } = build({ mouse: clickOnly });
    const result = await controller.zoom(ZOOM);
    expect(result.verdict).toBe("indeterminate");
    expect(result.refusal?.code).toBe("indeterminate");
    expect(clicks).toHaveLength(1);
  });

  it("refuses stale-locator when the control path drifted", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse });
    await expect(
      controller.zoom({ ...ZOOM, control: { axPath: "0.1.99" } }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses stale-locator when the control title drifted", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse });
    await expect(
      controller.zoom({ ...ZOOM, control: { axPath: "0.1.1", title: "Other" } }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(clicks).toHaveLength(0);
  });
});

describe("zoom via shortcut", () => {
  const SHORTCUT = {
    via: "shortcut" as const,
    percent: 100,
    key: "=",
    modifiers: ["cmd"],
    authorization: SESSION_AUTH,
    sessionKind: "dedicated" as const,
    sessionId: "asid-367",
  };

  it("refuses unavailable when no authorization is provided", async () => {
    const { poster, requests } = fakeStream();
    const { controller } = build({ sessionStream: poster });
    await expect(
      controller.zoom({ ...SHORTCUT, authorization: null }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("refuses when the grant does not cover this session", async () => {
    const { poster, requests } = fakeStream();
    const { controller } = build({ sessionStream: poster });
    await expect(
      controller.zoom({
        ...SHORTCUT,
        authorization: { kind: "session", sessionId: "other", tokenRef: "t" },
      }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(requests).toHaveLength(0);
  });

  it("refuses unsupported when authorized but no poster is wired", async () => {
    const { controller } = build();
    await expect(controller.zoom(SHORTCUT)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("posts the chord and verifies the capture when authorized", async () => {
    const { poster, requests } = fakeStream();
    const { controller } = build({ sessionStream: poster });
    const result = await controller.zoom(SHORTCUT);
    expect(result.verdict).toBe("performed");
    expect(result.via).toBe("shortcut");
    expect(result.channel).toBe("gui-act+session-stream+capture-diff");
    expect(result.sessionStream?.verdict).toBe("performed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.operation).toBe("key");
    expect(requests[0]?.steps).toEqual([
      { type: "key", key: "=", modifiers: ["cmd"] },
    ]);
  });

  it("reports indeterminate when the poster's verdict is not performed", async () => {
    const { poster } = fakeStream("indeterminate");
    const { controller } = build({ sessionStream: poster });
    await expect(controller.zoom(SHORTCUT)).rejects.toMatchObject({
      code: "indeterminate",
    });
  });
});
