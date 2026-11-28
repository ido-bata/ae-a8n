/**
 * Effect Controls contract tests (#367,
 * `specs/workspace-editing/spec.md` §12 W4+ deferred list "effect
 * controls", §3 W2 boundary rule).
 *
 * Everything here runs against scripted fake AX trees, a fake
 * `DockedPaneOps`, a recording fake mouse, a mutable fake DOM readback
 * (`effect.getParameter`) and a fake session-stream poster: this proves
 * the contract — mutate-gui gating, row/control re-resolution,
 * `ambiguous-target`/`stale-locator` refusals, the row-delta oracle for
 * fold, the DOM-readback oracle for parameter edit, bounded
 * postcondition waits with no resend, and the `GlobalInputAuthorization`
 * check on the type+commit leg — at `automated test` level. It does NOT
 * prove a real After Effects Effect Controls panel exposes the assumed
 * AX fidelity (disclosure nodes, value gutters) or that a session-stream
 * chord lands in the focused field; those are the spec's real-host
 * questions (§11).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { axLeaf, DockedPaneObserver } from "../src/panels/docked/index.js";
import type { DockedPaneOps, DockedAxNode } from "../src/panels/docked/index.js";
import type { GuiAppState, GuiFrame, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { EffectControlsController } from "../src/effect-controls/controller.js";
import { effectControlsMutationGate } from "../src/effect-controls/gate.js";
import {
  formatParameterValue,
  parameterValueMatches,
} from "../src/effect-controls/controller.js";
import type {
  EffectControlsMouseOps,
  EffectControlsReadback,
} from "../src/effect-controls/types.js";
import type { SessionStreamPoster } from "../src/input/session-stream.js";
import type { GlobalInputAuthorization } from "../src/input/types.js";
import type { ParameterValue, PropertyInfo } from "../src/api/types.js";
import { effectControlsCapabilities } from "../src/api/effect-controls.js";

const PID = 4242;

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const PANE_FRAME: GuiFrame = { x: 1000, y: 200, width: 400, height: 600 };

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
    axUnaccountedCensusWindows: [],
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

const PARAM_ROWS: readonly { path: string; title: string; y: number }[] = [
  { path: "0.1.2", title: "Blur Radius", y: 260 },
  { path: "0.1.3", title: "Blurriness", y: 290 },
  { path: "0.1.4", title: "Blur Dimensions", y: 320 },
];

/**
 * The scripted Effect Controls pane subtree:
 *
 *   0      AXLayoutArea "After Effects" MAIN_FRAME
 *   └─ 0.1  AXGroup "Effect Controls" PANE_FRAME
 *      ├─ 0.1.1 AXRow "Gaussian Blur"          (effect header)
 *      │   └─ 0.1.1.1 AXButton "disclosure"   (fold control)
 *      └─ 0.1.2..4 AXRow parameter rows        (present while unfolded)
 *
 * `state.folded` drops the parameter rows — the post-click walk the
 * row-delta oracle diffs.
 */
function effectTree(folded: boolean, withDisclosure = true): DockedAxNode {
  const children: DockedAxNode[] = [
    leaf("0.1.1", 2, "AXRow", "Gaussian Blur", { x: 1000, y: 220, width: 400, height: 24 }, [
      ...(withDisclosure
        ? [leaf("0.1.1.1", 3, "AXButton", "disclosure", { x: 1002, y: 222, width: 16, height: 20 })]
        : []),
    ]),
  ];
  if (!folded) {
    for (const row of PARAM_ROWS) {
      children.push(
        leaf(row.path, 2, "AXRow", row.title, { x: 1000, y: row.y, width: 400, height: 24 }),
      );
    }
  }
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      leaf("0.1", 1, "AXGroup", "Effect Controls", { ...PANE_FRAME }, children),
    ],
  });
}

/** Two same-named effect headers — the `ambiguous-target` probe. */
function ambiguousTree(): DockedAxNode {
  return axLeaf({
    path: "0",
    depth: 0,
    role: "AXLayoutArea",
    title: "After Effects",
    frame: { ...MAIN_FRAME },
    children: [
      leaf("0.1", 1, "AXGroup", "Effect Controls", { ...PANE_FRAME }, [
        leaf("0.1.1", 2, "AXRow", "Gaussian Blur", { x: 1000, y: 220, width: 400, height: 24 }),
        leaf("0.1.2", 2, "AXRow", "Gaussian Blur", { x: 1000, y: 260, width: 400, height: 24 }),
      ]),
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

const LOCATOR = { pane: { title: "Effect Controls" } } as const;

const state = { folded: false, value: 12 as ParameterValue };

beforeEach(() => {
  state.folded = false;
  state.value = 12;
});

function fakePaneOps(over: Partial<DockedPaneOps> = {}): DockedPaneOps {
  return {
    observe: () => appState([mainWindow()]),
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: [censusRow()],
    }),
    walkPane: () => serializeReport(effectTree(state.folded)),
    ...over,
  };
}

function fakeMouse(over: Partial<EffectControlsMouseOps> = {}) {
  const clicks: { x: number; y: number }[] = [];
  const mouse: EffectControlsMouseOps = {
    click: (x, y) => {
      clicks.push({ x, y });
      // Clicking the disclosure folds the section; clicking a value
      // gutter leaves the tree alone — the tests that need a fold set
      // state.folded through the click effect below.
    },
    ...over,
  };
  return { mouse, clicks };
}

function propertyInfo(over: Partial<PropertyInfo> = {}): PropertyInfo {
  return {
    name: "Blur Radius",
    kind: "value",
    valueType: "Scalar",
    value: state.value,
    selected: false,
    isTimeVarying: false,
    keyframes: [],
    ...over,
  } as PropertyInfo;
}

function fakeReadback(over: Partial<EffectControlsReadback> = {}) {
  const calls: { comp: string; layer: string; effect: string; parameter: string }[] = [];
  const readback: EffectControlsReadback = {
    parameter: (comp, layer, effect, parameter) => {
      calls.push({ comp, layer, effect, parameter });
      return propertyInfo();
    },
    ...over,
  };
  return { readback, calls };
}

function fakeStream(verdict: "performed" | "refused" | "indeterminate" = "performed") {
  const requests: { operation: string; steps: readonly unknown[] }[] = [];
  const poster: SessionStreamPoster = (request) => {
    requests.push({ operation: request.operation, steps: request.steps });
    return { verdict };
  };
  return { poster, requests };
}

/** Target-scoped grant covering this pane's surface (`docked-region:index:1`). */
const TARGET_AUTH: GlobalInputAuthorization = {
  kind: "target",
  pid: PID,
  surfaceKey: "docked-region:index:1",
  classes: ["mutate-gui"],
  tokenRef: "grant-ec",
};

function build(over: {
  paneOps?: Partial<DockedPaneOps>;
  mouse?: EffectControlsMouseOps;
  readback?: Partial<EffectControlsReadback>;
  sessionStream?: SessionStreamPoster;
  authorizeMutation?: ConstructorParameters<typeof EffectControlsController>[0]["authorizeMutation"];
  postcondition?: ConstructorParameters<typeof EffectControlsController>[0]["postcondition"];
} = {}) {
  const pane = new DockedPaneObserver({
    pid: PID,
    ops: fakePaneOps(over.paneOps ?? {}),
  });
  const { readback, calls } = fakeReadback(over.readback ?? {});
  const controller = new EffectControlsController({
    pane,
    paneLocator: LOCATOR,
    mouse: over.mouse ?? fakeMouse().mouse,
    readback,
    ...(over.sessionStream === undefined ? {} : { sessionStream: over.sessionStream }),
    authorizeMutation: over.authorizeMutation ?? (() => ({ allowed: true })),
    postcondition: { timeoutMs: 50, intervalMs: 1, settleMs: 0, ...over.postcondition },
    sleep: () => Promise.resolve(),
    newOperationId: () => "op-1",
  });
  return { controller, calls };
}

describe("effectControlsCapabilities", () => {
  it("reports mutate-gui ops unavailable on macOS and unsupported elsewhere", () => {
    const mac = effectControlsCapabilities("darwin");
    expect(mac.setFolded.support).toBe("unavailable");
    expect(mac.setParameter.support).toBe("unavailable");
    const win = effectControlsCapabilities("win32");
    expect(win.setFolded.support).toBe("unsupported");
    expect(win.setParameter.support).toBe("unsupported");
  });
});

describe("effectControlsMutationGate", () => {
  it("refuses every op while A-SAFETY is uncleared (fail-closed)", () => {
    const gate = effectControlsMutationGate();
    expect(gate("set-folded").allowed).toBe(false);
    expect(gate("set-parameter").allowed).toBe(false);
  });
});

describe("parameterValueMatches / formatParameterValue", () => {
  it("compares scalar and vector values elementwise within tolerance", () => {
    expect(parameterValueMatches(12, 12, 1e-6)).toBe(true);
    expect(parameterValueMatches(12.0000005, 12, 1e-6)).toBe(true);
    expect(parameterValueMatches(12.001, 12, 1e-6)).toBe(false);
    expect(parameterValueMatches([1, 2], [1, 2], 1e-6)).toBe(true);
    expect(parameterValueMatches([1, 2], [1, 3], 1e-6)).toBe(false);
    expect(parameterValueMatches([1], [1, 2], 1e-6)).toBe(false);
    expect(parameterValueMatches(undefined, 12, 1e-6)).toBe(false);
    expect(formatParameterValue([100, 50])).toBe("100 50");
    expect(formatParameterValue(12.5)).toBe("12.5");
  });
});

describe("setFolded", () => {
  it("clicks the disclosure node and verifies the row delta", async () => {
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        state.folded = true; // the fold landed
      },
    });
    const { controller } = build({ mouse });
    const result = await controller.setFolded({
      effect: "Gaussian Blur",
      folded: true,
    });
    expect(result.verdict).toBe("performed");
    expect(result.operationClass).toBe("mutate-gui");
    expect(result.channel).toBe("gui-act+row-delta");
    expect(result.rowsBefore).toBe(4); // header + 3 parameter rows
    expect(result.rowsAfter).toBe(1);
    expect(result.rowDeltaMatches).toBe(true);
    expect(result.aimedAt.control).toBe("disclosure-node");
    // Disclosure frame center: {1010, 232}.
    expect(clicks).toEqual([{ x: 1010, y: 232 }]);
  });

  it("uses the header gutter when no disclosure node is exposed", async () => {
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
        state.folded = true;
      },
    });
    const { controller } = build({
      mouse,
      // No disclosure button in the walked tree → the documented
      // header-gutter fallback.
      paneOps: {
        walkPane: () => serializeReport(effectTree(state.folded, false)),
      },
    });
    const result = await controller.setFolded({
      effect: "Gaussian Blur",
      folded: true,
    });
    expect(result.verdict).toBe("performed");
    expect(result.aimedAt.control).toBe("header-gutter");
    // Header left gutter: x=1000+min(10, 20)=1010, y=220+12=232.
    expect(clicks[0]?.x).toBeCloseTo(1010);
    expect(clicks[0]?.y).toBeCloseTo(232);
  });

  it("reports indeterminate when the row delta does not move", async () => {
    const { mouse } = fakeMouse(); // click does not fold
    const { controller } = build({ mouse });
    const result = await controller.setFolded({
      effect: "Gaussian Blur",
      folded: true,
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.refusal?.code).toBe("indeterminate");
    expect(result.rowsBefore).toBe(4);
    expect(result.rowsAfter).toBe(4);
  });

  it("refuses ambiguous-target for duplicate headers without an ordinal", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({
      mouse,
      paneOps: { walkPane: () => serializeReport(ambiguousTree()) },
    });
    await expect(
      controller.setFolded({ effect: "Gaussian Blur", folded: true }),
    ).rejects.toMatchObject({ code: "ambiguous-target" });
    expect(clicks).toHaveLength(0);
  });

  it("disambiguates duplicate headers with an ordinal", async () => {
    const { mouse, clicks } = fakeMouse({
      click: (x, y) => {
        clicks.push({ x, y });
      },
    });
    const { controller } = build({
      mouse,
      paneOps: { walkPane: () => serializeReport(ambiguousTree()) },
    });
    // Second header, no disclosure node → header gutter; rows never
    // change → indeterminate, but the act aimed at the right row.
    const result = await controller.setFolded({
      effect: "Gaussian Blur",
      folded: true,
      ordinal: 2,
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.aimedAt.rowAxPath).toBe("0.1.2");
    expect(clicks).toHaveLength(1);
  });

  it("refuses not-found when no header matches", async () => {
    const { mouse } = fakeMouse();
    const { controller } = build({ mouse });
    await expect(
      controller.setFolded({ effect: "No Such Effect", folded: true }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses before posting when the mutation gate denies", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({
      mouse,
      authorizeMutation: () => ({ allowed: false, reason: "gate closed" }),
    });
    await expect(
      controller.setFolded({ effect: "Gaussian Blur", folded: true }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses unsupported when no click vehicle exists", async () => {
    const { controller } = build({ mouse: {} });
    await expect(
      controller.setFolded({ effect: "Gaussian Blur", folded: true }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("setParameter", () => {
  const REQUEST = {
    comp: "Comp 1",
    layer: "Solid 1",
    effect: "Gaussian Blur",
    parameter: "Blur Radius",
    value: 55,
    authorization: TARGET_AUTH,
    sessionKind: "shared" as const,
  };

  it("clicks the value gutter, posts type+commit and verifies the DOM readback", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster, requests } = fakeStream();
    const wrappedStream: SessionStreamPoster = (request) => {
      const result = poster(request);
      state.value = 55; // the entry landed
      return result;
    };
    const { controller, calls } = build({ mouse, sessionStream: wrappedStream });
    const result = await controller.setParameter(REQUEST);
    expect(result.verdict).toBe("performed");
    expect(result.operationClass).toBe("mutate-gui");
    expect(result.channel).toBe("gui-act+dom-readback");
    expect(result.withinTolerance).toBe(true);
    expect(result.observedValue).toBe(55);
    expect(result.enteredText).toBe("55");
    expect(result.aimedAt.control).toBe("value-gutter");
    // Value gutter: x=1000+400-min(24,40)=1376, y=260+12=272.
    expect(clicks).toEqual([{ x: 1376, y: 272 }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.operation).toBe("type-sequential");
    expect(requests[0]?.steps).toEqual([
      { type: "text", text: "55" },
      { type: "key", key: "enter" },
    ]);
    // The readback oracle is `effect.getParameter` — observe channel only.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({
      comp: "Comp 1",
      layer: "Solid 1",
      effect: "Gaussian Blur",
      parameter: "Blur Radius",
    });
  });

  it("reports indeterminate when the readback never reaches the value", async () => {
    const { mouse } = fakeMouse();
    const { poster } = fakeStream(); // value stays 12
    const { controller } = build({ mouse, sessionStream: poster });
    const result = await controller.setParameter(REQUEST);
    expect(result.verdict).toBe("indeterminate");
    expect(result.withinTolerance).toBe(false);
    expect(result.observedValue).toBe(12);
  });

  it("clicks a recorded value-control node when provided", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster } = fakeStream();
    const wrappedStream: SessionStreamPoster = (request) => {
      const result = poster(request);
      state.value = 55;
      return result;
    };
    const withControl = effectTree(false);
    // Give the "Blur Radius" row (pane child index 1) a value-control
    // child at 0.1.2.1.
    const row = withControl.children[0]?.children[1];
    if (row !== undefined) {
      (row.children as DockedAxNode[]).push(
        leaf("0.1.2.1", 3, "AXTextField", "value", { x: 1300, y: 262, width: 80, height: 20 }),
      );
    }
    const { controller } = build({
      mouse,
      sessionStream: wrappedStream,
      paneOps: { walkPane: () => serializeReport(withControl) },
    });
    const result = await controller.setParameter({
      ...REQUEST,
      control: { axPath: "0.1.2.1", title: "value" },
    });
    expect(result.verdict).toBe("performed");
    expect(result.aimedAt.control).toBe("value-control");
    expect(clicks).toEqual([{ x: 1340, y: 272 }]);
  });

  it("refuses stale-locator when the control path drifted", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster } = fakeStream();
    const { controller } = build({ mouse, sessionStream: poster });
    await expect(
      controller.setParameter({ ...REQUEST, control: { axPath: "0.1.99" } }),
    ).rejects.toMatchObject({ code: "stale-locator" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses unavailable when no authorization is provided", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster, requests } = fakeStream();
    const { controller } = build({ mouse, sessionStream: poster });
    await expect(
      controller.setParameter({ ...REQUEST, authorization: null }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(clicks).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("refuses when the grant does not cover this surface", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster, requests } = fakeStream();
    const { controller } = build({ mouse, sessionStream: poster });
    await expect(
      controller.setParameter({
        ...REQUEST,
        authorization: { ...TARGET_AUTH, surfaceKey: "window:1" },
      }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(clicks).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("refuses unsupported when authorized but no poster is wired", async () => {
    const { mouse, clicks } = fakeMouse();
    const { controller } = build({ mouse });
    await expect(controller.setParameter(REQUEST)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(clicks).toHaveLength(0);
  });

  it("refuses not-found when the parameter does not exist", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster } = fakeStream();
    const { controller } = build({
      mouse,
      sessionStream: poster,
      readback: {
        parameter: () => {
          const error = new Error("parameter not found");
          error.name = "NotFoundError";
          throw error;
        },
      },
    });
    await expect(
      controller.setParameter({ ...REQUEST, parameter: "No Such Param" }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(clicks).toHaveLength(0);
  });

  it("refuses unsupported for non-value property kinds", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster } = fakeStream();
    const { controller } = build({
      mouse,
      sessionStream: poster,
      readback: { parameter: () => propertyInfo({ kind: "group" }) },
    });
    await expect(controller.setParameter(REQUEST)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(clicks).toHaveLength(0);
  });

  it("refuses ambiguous-target for a repeated row text without an ordinal", async () => {
    const dup = effectTree(false);
    const pane = dup.children[0];
    if (pane !== undefined) {
      (pane.children as DockedAxNode[]).push(
        leaf("0.1.5", 2, "AXRow", "Blur Radius", { x: 1000, y: 350, width: 400, height: 24 }),
      );
    }
    const { mouse, clicks } = fakeMouse();
    const { poster } = fakeStream();
    const { controller } = build({
      mouse,
      sessionStream: poster,
      paneOps: { walkPane: () => serializeReport(dup) },
    });
    await expect(controller.setParameter(REQUEST)).rejects.toMatchObject({
      code: "ambiguous-target",
    });
    expect(clicks).toHaveLength(0);
  });

  it("refuses before posting when the mutation gate denies", async () => {
    const { mouse, clicks } = fakeMouse();
    const { poster, requests } = fakeStream();
    const { controller } = build({
      mouse,
      sessionStream: poster,
      authorizeMutation: () => ({ allowed: false, reason: "gate closed" }),
    });
    await expect(controller.setParameter(REQUEST)).rejects.toMatchObject({
      code: "refused",
    });
    expect(clicks).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});
