/**
 * Render Queue surface contract tests (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3).
 *
 * Everything here runs against scripted fake AX trees and fake
 * `DockedPaneOps`/menu invokers — the "scripted AX + fake host" level the
 * issue's AC names. This proves the contract — bounded-walk item
 * observation with the `limited` oracle, gated menu invoke composition,
 * and the never-resent bounded postcondition wait — at `automated test`
 * level. It does NOT prove a real After Effects exposes its Render Queue
 * pane through AX or that the menu path works; that stays unverified
 * until a real-host run records it.
 */

import { describe, expect, it } from "vitest";

import { axLeaf, type DockedAxNode, type DockedPaneOps } from "../src/panels/docked/index.js";
import { RenderQueueObserver } from "../src/renderqueue/observer.js";
import { addCompositionToRenderQueue } from "../src/renderqueue/orchestrate.js";
import { renderQueueCapabilities, renderQueueForTarget } from "../src/api/render-queue.js";
import { MenuError } from "../src/menus/types.js";
import {
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";

const PID = 4242;

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
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

/**
 * A scripted fake of AE's main-window AX subtree containing only the
 * Render Queue pane; `rqTitles` is mutable so a test can make the "add"
 * appear between observations — the postcondition delta the wait polls.
 *
 *   0      AXLayoutArea (the window)
 *   └─ 0.1 AXGroup "Render Queue"   RQ_FRAME
 *       └─ 0.1.N AXRow <title>
 */
function rqTree(rqTitles: readonly string[]): DockedAxNode {
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
        title: "Render Queue",
        frame: { ...RQ_FRAME },
        children: rqTitles.map((title, i) =>
          axLeaf({
            path: `0.1.${i + 1}`,
            depth: 2,
            role: "AXRow",
            title,
            frame: { x: 110, y: 60 + i * 20, width: 380, height: 20 },
          }),
        ),
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

const RQ_LOCATOR = {
  parent: { title: "After Effects" },
  pane: { title: "Render Queue" },
} as const;

function fakeOps(rqTitles: string[], over: Partial<DockedPaneOps> = {}) {
  const calls = { observe: 0, walk: 0 };
  const ops: DockedPaneOps = {
    observe: () => {
      calls.observe += 1;
      return appState([mainWindow()]);
    },
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: [censusRow()],
    }),
    walkPane: () => {
      calls.walk += 1;
      return serializeReport(rqTree(rqTitles));
    },
    ...over,
  };
  return { ops, calls };
}

describe("RenderQueueObserver", () => {
  it("snapshots pane rows as limited-oracle item candidates", () => {
    const rqTitles = ["Comp 1", "Comp 2"];
    const { ops } = fakeOps(rqTitles);
    const observer = new RenderQueueObserver({ pid: PID, ops });
    const snapshot = observer.snapshot(RQ_LOCATOR);
    expect(snapshot.oracle).toBe("limited");
    expect(snapshot.pid).toBe(PID);
    expect(snapshot.pane.surface.kind).toBe("docked-region");
    expect(snapshot.paneAxPath).toBe("0.1");
    expect(snapshot.items.map((row) => row.text)).toEqual(["Comp 1", "Comp 2"]);
    expect(snapshot.items.map((row) => row.axPath)).toEqual(["0.1.1", "0.1.2"]);
    expect(snapshot.walk.stopReason).toBe("complete");
  });

  it("re-observes on every snapshot — a locator, not a handle", () => {
    const rqTitles = ["Comp 1"];
    const { ops, calls } = fakeOps(rqTitles);
    const observer = new RenderQueueObserver({ pid: PID, ops });
    observer.snapshot(RQ_LOCATOR);
    observer.snapshot(RQ_LOCATOR);
    expect(calls.walk).toBe(2);
  });

  it("maps pane-resolution failures onto RenderQueueError codes", () => {
    const { ops } = fakeOps([], { walkPane: () => "NOROOT\n" });
    const observer = new RenderQueueObserver({ pid: PID, ops });
    expect(() => observer.snapshot(RQ_LOCATOR)).toThrowError(
      expect.objectContaining({ code: "not-found" }) as Error,
    );
  });
});

describe("addCompositionToRenderQueue", () => {
  const MENU = { menuPath: ["Composition"], itemTitle: "Add to Render Queue" } as const;

  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it("performs when the pane gains a row inside the bounded wait", async () => {
    const rqTitles = ["Comp 1"];
    const { ops } = fakeOps(rqTitles);
    const observer = new RenderQueueObserver({ pid: PID, ops });
    const invokes: unknown[] = [];
    const { now, sleep } = clock();
    const result = await addCompositionToRenderQueue(
      {
        observer,
        pane: RQ_LOCATOR,
        invokeMenu: (locator) => {
          invokes.push(locator);
          rqTitles.push("Comp 2"); // the menu act lands: a new queue row
          return Promise.resolve();
        },
        now,
        sleep,
      },
      { menu: MENU, timeoutMs: 5_000, pollIntervalMs: 100 },
    );
    expect(invokes).toEqual([MENU]);
    expect(result.before).toBe(1);
    expect(result.after).toBe(2);
    expect(result.added.map((row) => row.text)).toEqual(["Comp 2"]);
    expect(result.oracle).toBe("limited");
    expect(result.beforeSnapshot.oracle).toBe("limited");
  });

  it("reports indeterminate on wait expiry and never resends the invoke", async () => {
    const rqTitles = ["Comp 1"];
    const { ops } = fakeOps(rqTitles);
    const observer = new RenderQueueObserver({ pid: PID, ops });
    let invokeCalls = 0;
    const { now, sleep } = clock();
    await expect(
      addCompositionToRenderQueue(
        {
          observer,
          pane: RQ_LOCATOR,
          invokeMenu: () => {
            invokeCalls += 1;
            // The click never lands — simulating a lost/ignored menu press.
            return Promise.resolve();
          },
          now,
          sleep,
        },
        { menu: MENU, timeoutMs: 1_000, pollIntervalMs: 100 },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "indeterminate",
        message: expect.stringContaining("never resend"),
      }) as Error,
    );
    expect(invokeCalls).toBe(1);
  });

  it("propagates a refused menu invoke without waiting", async () => {
    const rqTitles = ["Comp 1"];
    const { ops } = fakeOps(rqTitles);
    const observer = new RenderQueueObserver({ pid: PID, ops });
    const { now, sleep } = clock();
    await expect(
      addCompositionToRenderQueue(
        {
          observer,
          pane: RQ_LOCATOR,
          invokeMenu: () =>
            Promise.reject(
              new MenuError("refused", "menu invoke refused by the mutation gate: test"),
            ),
          now,
          sleep,
        },
        { menu: MENU, timeoutMs: 60_000 },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "refused" }) as Error);
  });

  it("propagates pane resolution failures as RenderQueueError", async () => {
    const { ops } = fakeOps([], { walkPane: () => "AMBIGUOUS\n" });
    const observer = new RenderQueueObserver({ pid: PID, ops });
    const { now, sleep } = clock();
    await expect(
      addCompositionToRenderQueue(
        {
          observer,
          pane: RQ_LOCATOR,
          invokeMenu: () => Promise.resolve(),
          now,
          sleep,
        },
        { menu: MENU, timeoutMs: 60_000 },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "ambiguous" }) as Error);
  });
});

describe("renderQueueForTarget / capabilities", () => {
  it("refuses when no owned target is attested", () => {
    expect(() => renderQueueForTarget(null, RQ_LOCATOR)).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("reports unsupported on non-macOS platforms", () => {
    const caps = renderQueueCapabilities("win32");
    expect(caps.platform).toBe("win32");
    expect(caps.observe.support).toBe("unsupported");
    expect(caps.addViaMenu.support).toBe("unsupported");
  });

  it("reports the honest darwin capability levels", () => {
    const caps = renderQueueCapabilities("darwin");
    expect(caps.observe.support).toBe("implemented");
    expect(caps.observe.verification).toBe("automated test");
    // addViaMenu stays gate-pending: the menu invoke class is not cleared.
    expect(caps.addViaMenu.support).toBe("unavailable");
    expect(caps.addViaMenu.reason).toContain("A-SAFETY");
  });
});
