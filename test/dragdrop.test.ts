/**
 * Drag-drop contract tests (#422,
 * `specs/workspace-editing/spec.md` §5, §9 "File/element drag-drop",
 * §10, §12 W4+).
 *
 * Everything here runs against scripted window listings, scripted
 * census answers and fake `DragDropOps` — the "fake drag vehicle" the
 * issue's AC names. This proves the contract — fail-closed gate,
 * census/attribution pre-flight, segmented element-drag abort,
 * foreign-window refusal, bounded oracle wait, no resend — at
 * `automated test` level. It does NOT prove a real drag lands on a
 * real After Effects; that is the #411 real-host evidence plus this
 * ticket's e2e run.
 */

import { describe, expect, it } from "vitest";

import {
  DragDropController,
  dragDropDelta,
  type DragDropControllerOptions,
} from "../src/dragdrop/controller.js";
import { dragDropMutationGate } from "../src/dragdrop/gate.js";
import {
  type DragDropDelta,
  type DragDropOps,
  type DragDropPoint,
  type DragDropRequest,
  type DragDropSnapshot,
  type DragDropSurfaceLocator,
  type DragDropTopmost,
  type DragDropVerdict,
} from "../src/dragdrop/types.js";
import {
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import {
  dragDropCapabilities,
  dragDropForTarget,
} from "../src/api/drag-drop.js";
import type { Session } from "../src/api/session.js";
import type { MacSession } from "../src/driver/mac-session.js";

const PID = 4242;
const FOREIGN_PID = 9999;
const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const FROM: DragDropPoint = { x: 100, y: 200 };
const TO: DragDropPoint = { x: 300, y: 400 };
const FILE = "/tmp/fixtures/drop-me.png";

function mainWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "After Effects",
    role: "AXWindow",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { ...MAIN_FRAME },
    censusAttribution: "owned",
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

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    nowDate: () => new Date(t),
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function locator(over: Partial<DragDropSurfaceLocator> = {}): DragDropSurfaceLocator {
  return {
    windowIndex: 1,
    expected: {
      title: "After Effects",
      subrole: null,
      frame: { ...MAIN_FRAME },
    },
    ...over,
  };
}

function ownedTopmost(): DragDropTopmost {
  return {
    pid: PID,
    windowNumber: 77,
    layer: 0,
    bounds: { ...MAIN_FRAME },
  };
}

// Stable ids per name — a real `project.items` id follows the item
// across a reorder, so the fake must not renumber positionally.
const ITEM_IDS = new Map<string, number>();
let nextItemId = 1;

function snapshot(
  names: readonly string[],
  itemCount: number | null = names.length,
): DragDropSnapshot {
  return {
    items: names.map((name) => {
      let id = ITEM_IDS.get(name);
      if (id === undefined) {
        id = nextItemId;
        nextItemId += 1;
        ITEM_IDS.set(name, id);
      }
      return { id, name, type: "File" };
    }),
    itemCount,
    observedAt: new Date(0).toISOString(),
  };
}

type OpsOverride = {
  [K in keyof DragDropOps]?: DragDropOps[K] | undefined;
};

function makeController(
  over: OpsOverride = {},
  options: {
    authorizeMutation?: DragDropControllerOptions["authorizeMutation"] | undefined;
    poll?: DragDropControllerOptions["poll"];
  } = {},
) {
  const calls = {
    press: 0,
    move: 0,
    release: 0,
    fileDrag: 0,
    readback: 0,
    topmostAt: 0,
  };
  const ops: DragDropOps = {
    observe: () => appState([mainWindow()]),
    topmostAt: () => ownedTopmost(),
    activate: () => {},
    probeFile: () => ({ exists: true, isFile: true, size: 1234, sha256: "ab".repeat(32) }),
    readback: () => snapshot(["a.png", "b.png"]),
    press: () => {
      calls.press += 1;
      return "performed";
    },
    move: () => {
      calls.move += 1;
      return "performed";
    },
    release: () => {
      calls.release += 1;
      return "performed";
    },
    fileDrag: () => {
      calls.fileDrag += 1;
      return { verdict: "performed", operation: "copy" };
    },
  };
  for (const [key, value] of Object.entries(over)) {
    const record = ops as Record<string, unknown>;
    if (value === undefined) {
      delete record[key];
    } else {
      record[key] = value;
    }
  }
  const c = clock();
  // An absent gate reaches the controller as "no gate" — the
  // fail-closed path under test.
  const gate =
    options.authorizeMutation === undefined && !Object.hasOwn(options, "authorizeMutation")
      ? () => ({ allowed: true as const })
      : options.authorizeMutation;
  const controller = new DragDropController({
    pid: PID,
    ops,
    ...(gate === undefined ? {} : { authorizeMutation: gate }),
    poll: options.poll ?? { timeoutMs: 2_000, intervalMs: 100 },
    sleep: c.sleep,
    now: c.nowDate,
  });
  return { controller, c, ops, calls };
}

function fileRequest(over: Record<string, unknown> = {}): DragDropRequest {
  return {
    kind: "file-drop",
    surface: locator(),
    file: { path: FILE },
    to: { ...TO },
    ...over,
  };
}

function elementRequest(over: Record<string, unknown> = {}): DragDropRequest {
  return {
    kind: "element-drag",
    surface: locator(),
    from: { ...FROM },
    to: { ...TO },
    steps: 4,
    stepDelayMs: 0,
    ...over,
  };
}

describe("dragDropMutationGate", () => {
  it("permits drop-file and refuses element-drag with the audit citation", () => {
    const gate = dragDropMutationGate();
    expect(gate("drop-file")).toEqual({ allowed: true });
    const refused = gate("element-drag");
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.reason).toContain("docs/gui-supervision-safety-gates.md");
    }
  });
});

describe("dragDropDelta", () => {
  it("computes added/removed names, order change and count delta", () => {
    const before = snapshot(["a", "b", "c"]);
    const after = snapshot(["b", "a", "d"]);
    const delta: DragDropDelta = dragDropDelta(before, after);
    expect(delta.addedNames).toEqual(["d"]);
    expect(delta.removedNames).toEqual(["c"]);
    expect(delta.orderChanged).toBe(true);
    expect(delta.countDelta).toBe(0);
  });

  it("a pure append is added-only; equal snapshots are empty", () => {
    const before = snapshot(["a"]);
    expect(dragDropDelta(before, snapshot(["a", "b"]))).toEqual({
      addedNames: ["b"],
      removedNames: [],
      orderChanged: false,
      countDelta: 1,
    });
    expect(dragDropDelta(before, snapshot(["a"]))).toEqual({
      addedNames: [],
      removedNames: [],
      orderChanged: false,
      countDelta: 0,
    });
    expect(dragDropDelta(null, snapshot(["a"])).addedNames).toEqual([]);
  });
});

describe("DragDropController file-drop", () => {
  it("posts one fileDrag and verifies via the DOM delta", async () => {
    let reads = 0;
    const { controller, calls } = makeController({
      readback: () => {
        reads += 1;
        return reads === 1 ? snapshot(["a.png"]) : snapshot(["a.png", "drop-me.png"]);
      },
    });
    const result = await controller.run(fileRequest());
    expect(calls.fileDrag).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.delta.addedNames).toEqual(["drop-me.png"]);
    expect(result.file?.name).toBe("drop-me.png");
    expect(result.file?.sha256).toBe("ab".repeat(32));
  });

  it("is refused fail-closed when no gate is configured", async () => {
    let posted = 0;
    const { controller } = makeController(
      {
        fileDrag: () => {
          posted += 1;
          return { verdict: "performed" as DragDropVerdict, operation: null };
        },
      },
      { authorizeMutation: undefined },
    );
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      name: "DragDropError",
      code: "refused",
    });
    expect(posted).toBe(0);
  });

  it("refuses element-drag under the production gate", async () => {
    const { controller, calls } = makeController({}, {
      authorizeMutation: dragDropMutationGate(),
    });
    await expect(controller.run(elementRequest())).rejects.toMatchObject({
      code: "refused",
    });
    expect(calls.press).toBe(0);
  });

  it("drop-file is permitted under the production gate", async () => {
    let reads = 0;
    const { controller } = makeController(
      {
        readback: () => {
          reads += 1;
          return reads === 1 ? snapshot(["a"]) : snapshot(["a", "f.png"]);
        },
      },
      { authorizeMutation: dragDropMutationGate() },
    );
    const result = await controller.run(fileRequest());
    expect(result.verified).toBe(true);
  });

  it("refuses when the vehicle channel is absent — unsupported", async () => {
    const { controller } = makeController({ fileDrag: undefined });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("refuses when no oracle is wired — unavailable before posting", async () => {
    const { controller, calls } = makeController({ readback: undefined });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(calls.fileDrag).toBe(0);
  });

  it("refuses a missing payload file — fixture files only", async () => {
    const { controller, calls } = makeController({
      probeFile: () => ({ exists: false, isFile: false, size: 0, sha256: "" }),
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "not-found",
    });
    expect(calls.fileDrag).toBe(0);
  });

  it("refuses a drop point outside the re-verified frame", async () => {
    const { controller, calls } = makeController();
    await expect(
      controller.run(fileRequest({ to: { x: 5000, y: 5000 } })),
    ).rejects.toMatchObject({ code: "invalid-locator" });
    expect(calls.fileDrag).toBe(0);
  });

  it("refuses when a foreign window covers the drop point", async () => {
    const { controller, calls } = makeController({
      topmostAt: () => ({ pid: FOREIGN_PID, windowNumber: 1, layer: 0, bounds: null }),
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "unproven",
    });
    expect(calls.fileDrag).toBe(0);
  });

  it("refuses when an owned aux panel (bounds mismatch) covers the point", async () => {
    const { controller, calls } = makeController({
      topmostAt: () => ({
        pid: PID,
        windowNumber: 88,
        layer: 0,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      }),
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "unproven",
    });
    expect(calls.fileDrag).toBe(0);
  });

  it("refuses an unattributed surface", async () => {
    const { controller, calls } = makeController({
      observe: () => appState([mainWindow({ censusAttribution: "foreign" })]),
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "unproven",
    });
    expect(calls.fileDrag).toBe(0);
  });

  it("reports stale-locator when the listing entry changed", async () => {
    const { controller } = makeController({
      observe: () => appState([mainWindow({ title: "Renamed" })]),
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "stale-locator",
    });
  });

  it("a vehicle not-performed verdict is a provable non-mutation", async () => {
    let fileDragCalls = 0;
    const { controller } = makeController({
      fileDrag: () => {
        fileDragCalls += 1;
        return { verdict: "not-performed" as DragDropVerdict, operation: null };
      },
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "stale-locator",
    });
    expect(fileDragCalls).toBe(1);
  });

  it("a vehicle failed verdict is indeterminate — never resent", async () => {
    let fileDragCalls = 0;
    const { controller } = makeController({
      fileDrag: () => {
        fileDragCalls += 1;
        return { verdict: "failed" as DragDropVerdict, operation: null };
      },
    });
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "indeterminate",
    });
    expect(fileDragCalls).toBe(1);
  });

  it("no delta within the budget is indeterminate — never resent", async () => {
    const { controller, calls } = makeController();
    await expect(controller.run(fileRequest())).rejects.toMatchObject({
      code: "indeterminate",
    });
    expect(calls.fileDrag).toBe(1);
  });
});

describe("DragDropController element-drag", () => {
  it("runs press→moves→release and verifies the project delta", async () => {
    let reads = 0;
    const moves: DragDropPoint[] = [];
    const { controller, calls } = makeController({
      move: (point) => {
        calls.move += 1;
        moves.push(point);
        return "performed";
      },
      readback: () => {
        reads += 1;
        return reads === 1 ? snapshot(["a", "b"]) : snapshot(["b", "a"]);
      },
    });
    const result = await controller.run(elementRequest());
    expect(calls.press).toBe(1);
    expect(calls.move).toBe(4);
    expect(calls.release).toBe(1);
    expect(moves.at(-1)).toEqual(TO);
    expect(result.verified).toBe(true);
    expect(result.delta.orderChanged).toBe(true);
    expect(result.segments.every((s) => s.ok)).toBe(true);
  });

  it("aborts mid-drag when the topmost window turns foreign — never finishes", async () => {
    let censusCalls = 0;
    const moves: DragDropPoint[] = [];
    const releases: DragDropPoint[] = [];
    const { controller } = makeController({
      // Census for pre-flight (from+to) answers owned; segment 3 flips foreign.
      topmostAt: () => {
        censusCalls += 1;
        if (censusCalls <= 2) return ownedTopmost();
        if (censusCalls === 5) {
          return { pid: FOREIGN_PID, windowNumber: 1, layer: 0, bounds: null };
        }
        return ownedTopmost();
      },
      move: (point) => {
        moves.push(point);
        return "performed";
      },
      release: (point) => {
        releases.push(point);
        return "performed";
      },
    });
    await expect(controller.run(elementRequest())).rejects.toMatchObject({
      code: "indeterminate",
    });
    // Released at the LAST VERIFIED point, never at the failed one, and
    // never completed toward `to`.
    expect(releases).toHaveLength(1);
    expect(releases[0]).not.toEqual(TO);
    expect(moves.length).toBeLessThan(4);
    expect(moves.at(-1)).toEqual(releases[0]);
  });

  it("aborts before the first move as stale-locator when identity flips instantly", async () => {
    let censusCalls = 0;
    const { controller, calls } = makeController({
      topmostAt: () => {
        censusCalls += 1;
        if (censusCalls <= 2) return ownedTopmost();
        return { pid: FOREIGN_PID, windowNumber: 1, layer: 0, bounds: null };
      },
    });
    await expect(controller.run(elementRequest())).rejects.toMatchObject({
      code: "stale-locator",
    });
    expect(calls.press).toBe(1);
    expect(calls.move).toBe(0);
    expect(calls.release).toBe(1);
  });

  it("refuses when a mouse channel is absent — unsupported", async () => {
    const { controller } = makeController({ move: undefined });
    await expect(controller.run(elementRequest())).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("refuses a press point covered by a foreign window", async () => {
    let foreign = true;
    const { controller, calls } = makeController({
      // First census call (the `from` gate) sees a foreign window; flip
      // back so the `to` gate — never reached — stays owned.
      topmostAt: () => {
        if (foreign) {
          foreign = false;
          return { pid: FOREIGN_PID, windowNumber: 1, layer: 0, bounds: null };
        }
        return ownedTopmost();
      },
    });
    await expect(controller.run(elementRequest())).rejects.toMatchObject({
      code: "unproven",
    });
    expect(calls.press).toBe(0);
  });
});

describe("dragDropForTarget / capabilities / gate", () => {
  it("refuses when no owned target is attested", () => {
    expect(() =>
      dragDropForTarget(null, {} as Session),
    ).toThrowError(expect.objectContaining({ code: "unavailable" }) as Error);
  });

  it("reports unsupported on non-macOS platforms", () => {
    const caps = dragDropCapabilities("win32");
    expect(caps.dropFile.support).toBe("unsupported");
    expect(caps.elementDrag.support).toBe("unsupported");
  });

  it("reports the honest darwin capability levels", () => {
    const caps = dragDropCapabilities("darwin");
    expect(caps.dropFile.support).toBe("implemented");
    expect(caps.dropFile.reason).toContain("#411");
    expect(caps.elementDrag.support).toBe("unavailable");
    expect(caps.elementDrag.reason).toContain("A-SAFETY");
  });

  it("the production gate permits drop-file and refuses element-drag", () => {
    const gate = dragDropMutationGate();
    expect(gate("drop-file").allowed).toBe(true);
    const refused = gate("element-drag");
    expect(refused.allowed).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "binds a handle for an attested target without posting anything",
    () => {
    const session: MacSession = { uid: 501, username: "u", asid: 1, kind: "Aqua" };
    const handle = dragDropForTarget(
      { pid: PID, session },
      {} as Session,
      // helpersDir short-circuits helper auto-compile; nothing is
      // invoked at bind time anyway.
      { helpersDir: "/tmp" },
    );
    expect(typeof handle.run).toBe("function");
    expect(typeof handle.dropFile).toBe("function");
    expect(typeof handle.dragElement).toBe("function");
    },
  );
});
