/**
 * Context-menu contract tests (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5–§7, §10).
 *
 * Everything here runs against scripted window listings and fake
 * `ContextMenuOps` — the "fake AX context menu" the issue's AC names.
 * This proves the contract — gated right-click inside a re-verified
 * frame, bounded new-window wait, dialog-class refusal on unmatched
 * modals, re-resolution before press, and the honest `unsupported`
 * vehicle paths — at `automated test` level. It does NOT prove a real
 * After Effects context menu appears as an AX window, that a CGEvent
 * right-button post opens it, or that item presses land; that stays
 * unverified until a real-host run records it.
 */

import { describe, expect, it } from "vitest";

import {
  ContextMenuController,
  type ContextMenuOps,
} from "../src/contextmenu/controller.js";
import { contextMenuMutationGate } from "../src/contextmenu/gate.js";
import {
  contextMenuItems,
  contextMenuWindowKey,
  matchContextMenu,
} from "../src/contextmenu/classify.js";
import type {
  ContextMenuResolution,
  ContextMenuTargetLocator,
  ContextMenuTitles,
} from "../src/contextmenu/types.js";
import {
  contextMenuCapabilities,
  contextMenuForTarget,
} from "../src/api/context-menu.js";
import {
  type GuiAppState,
  type GuiButtonInfo,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";

const PID = 4242;
const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const MENU_FRAME: GuiFrame = { x: 300, y: 200, width: 220, height: 160 };

const TITLES: ContextMenuTitles = { items: ["Copy", "Delete", "Rename"] };

function button(title: string): GuiButtonInfo {
  return {
    title,
    description: "",
    position: { x: 300, y: 200 },
    size: { width: 200, height: 24 },
  };
}

function mainWindow(): GuiWindowInfo {
  return {
    title: "After Effects",
    role: "AXLayoutArea",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { ...MAIN_FRAME },
    censusAttribution: "owned",
  };
}

/** A scripted context-menu-shaped window: new AX window + item titles. */
function menuWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "",
    role: "AXWindow",
    subrole: null,
    buttons: [button("Copy"), button("Delete"), button("Rename")],
    texts: [],
    frame: { ...MENU_FRAME },
    censusAttribution: "owned",
    ...over,
  };
}

/** A new blocking dialog that is NOT the menu — the modal the click raised instead. */
function mysteryDialog(): GuiWindowInfo {
  return {
    title: "",
    role: "AXDialog",
    subrole: "AXSystemDialog",
    buttons: [button("OK"), button("Cancel")],
    texts: [],
    frame: { x: 500, y: 300, width: 400, height: 200 },
    censusAttribution: "owned",
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

function clock(start = 0) {
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

function locator(over: Partial<ContextMenuTargetLocator> = {}): ContextMenuTargetLocator {
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

describe("matchContextMenu", () => {
  it("classifies a new attributed window whose titles match", () => {
    const match = matchContextMenu(menuWindow(), TITLES);
    expect(match.kind).toBe("context-menu");
    if (match.kind !== "context-menu") return;
    expect(match.matchedTitles).toEqual(["Copy", "Delete", "Rename"]);
  });

  it("matches titles exposed as static texts too", () => {
    const viaText = menuWindow({ buttons: [], texts: ["Copy", "Other"] });
    const match = matchContextMenu(viaText, TITLES);
    expect(match.kind).toBe("context-menu");
    if (match.kind !== "context-menu") return;
    expect(match.matchedTitles).toEqual(["Copy"]);
  });

  it("refuses unrecognized new dialogs — never a blind press", () => {
    expect(matchContextMenu(mysteryDialog(), TITLES).kind).toBe("unrecognized-dialog");
  });

  it("ignores unattributed, frameless, foreign and ordinary windows", () => {
    expect(matchContextMenu(menuWindow({ censusAttribution: "foreign" }), TITLES).kind).toBe(
      "not-a-window",
    );
    expect(matchContextMenu(menuWindow({ frame: null }), TITLES).kind).toBe("not-a-window");
    expect(matchContextMenu(menuWindow({ censusAttribution: "unmatched" }), TITLES).kind).toBe(
      "not-a-window",
    );
    // An ordinary new window with no declared titles and no dialog shape.
    const panel = menuWindow({
      role: "AXWindow",
      buttons: [button("Panel")],
      texts: [],
    });
    expect(matchContextMenu(panel, TITLES).kind).toBe("not-a-menu");
  });

  it("names human-only windows for what they are", () => {
    const signIn = menuWindow({ texts: ["Sign in to continue"] });
    expect(matchContextMenu(signIn, TITLES).kind).toBe("human-only");
  });

  it("an empty title list can never classify a window", () => {
    expect(matchContextMenu(menuWindow(), { items: [] }).kind).not.toBe("context-menu");
  });
});

describe("contextMenuWindowKey / contextMenuItems", () => {
  it("keys windows by title+role+subrole+rounded frame", () => {
    expect(contextMenuWindowKey(menuWindow())).toBe(contextMenuWindowKey(menuWindow()));
    expect(contextMenuWindowKey(menuWindow())).not.toBe(
      contextMenuWindowKey(menuWindow({ frame: { ...MENU_FRAME, x: MENU_FRAME.x + 1 } })),
    );
    expect(contextMenuWindowKey(menuWindow())).not.toBe(contextMenuWindowKey(mainWindow()));
  });

  it("lists button items before text items, deduplicated", () => {
    const items = contextMenuItems(
      menuWindow({ buttons: [button("Copy")], texts: ["Copy", "Layers"] }),
    );
    expect(items.map((item) => `${item.via}:${item.title}`)).toEqual([
      "button:Copy",
      "text:Layers",
    ]);
  });
});

describe("ContextMenuController.open", () => {
  type ObserveScript = GuiAppState[] | (() => GuiAppState);

  type OpsOverride = {
    [K in keyof ContextMenuOps]?: ContextMenuOps[K] | undefined;
  };

  function makeController(
    script: ObserveScript,
    over: OpsOverride = {},
    gate?: ConstructorParameters<typeof ContextMenuController>[0]["authorizeMutation"],
  ) {
    let index = 0;
    const observeCalls: number[] = [];
    const ops: ContextMenuOps = {
      observe: () => {
        observeCalls.push(index);
        if (typeof script === "function") return script();
        const state = script[Math.min(index, script.length - 1)];
        index += 1;
        if (state === undefined) throw new Error("fixture exhausted");
        return state;
      },
      rightClick: () => "clicked",
      pressItem: () => "clicked",
    };
    // Apply overrides; an explicit `undefined` removes the optional
    // vehicle, which is how "no right-click/press channel" is scripted.
    for (const [key, value] of Object.entries(over)) {
      const record = ops as Record<string, unknown>;
      if (value === undefined) {
        delete record[key];
      } else {
        record[key] = value;
      }
    }
    const c = clock();
    const controller = new ContextMenuController({
      pid: PID,
      ops,
      authorizeMutation: gate ?? (() => ({ allowed: true })),
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    return { controller, c, ops, observeCalls };
  }

  /** observe#1 resolves the target, observe#2 is the baseline, observe#3+ polls. */
  function openScript(menuStates: GuiAppState[]): GuiAppState[] {
    return [appState([mainWindow()]), appState([mainWindow()]), ...menuStates];
  }

  it("posts one right-click inside the re-verified frame and resolves the new menu", async () => {
    const posts: { windowIndex: number; x: number; y: number }[] = [];
    const { controller } = makeController(
      openScript([appState([mainWindow(), menuWindow()])]),
      {
        rightClick: ({ windowIndex, expected, point }) => {
          posts.push({ windowIndex, x: point.x, y: point.y });
          expect(expected.title).toBe("After Effects");
          return "clicked";
        },
      },
    );
    const resolution = await controller.open(locator(), {
      titles: TITLES,
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });
    expect(resolution.index).toBe(2);
    expect(resolution.window.role).toBe("AXWindow");
    expect(resolution.items.map((item) => item.title)).toEqual([
      "Copy",
      "Delete",
      "Rename",
    ]);
    // Default point is the frame center.
    expect(posts).toEqual([
      { windowIndex: 1, x: MAIN_FRAME.x + MAIN_FRAME.width / 2, y: MAIN_FRAME.y + MAIN_FRAME.height / 2 },
    ]);
  });

  it("honours an explicit `at` point inside the frame", async () => {
    const posts: { x: number; y: number }[] = [];
    const { controller } = makeController(
      openScript([appState([mainWindow(), menuWindow()])]),
      {
        rightClick: ({ point }) => {
          posts.push(point);
          return "clicked";
        },
      },
    );
    await controller.open(locator({ at: { x: 100, y: 100 } }), {
      titles: TITLES,
      timeoutMs: 5_000,
    });
    expect(posts).toEqual([{ x: 100, y: 100 }]);
  });

  it("refuses a point outside the re-verified frame — no remembered positions", async () => {
    let posted = 0;
    const { controller } = makeController(
      openScript([]),
      {
        rightClick: () => {
          posted += 1;
          return "clicked";
        },
      },
    );
    await expect(
      controller.open(locator({ at: { x: 5000, y: 5000 } }), { titles: TITLES }),
    ).rejects.toThrowError(expect.objectContaining({ code: "invalid-locator" }) as Error);
    expect(posted).toBe(0);
  });

  it("refuses when the mutation gate denies — before any observation or post", async () => {
    let observes = 0;
    let posts = 0;
    const { controller } = makeController(
      () => appState([mainWindow()]),
      {
        observe: () => {
          observes += 1;
          return appState([mainWindow()]);
        },
        rightClick: () => {
          posts += 1;
          return "clicked";
        },
      },
      () => ({ allowed: false, reason: "A-SAFETY has not cleared context menus" }),
    );
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "refused" }) as Error,
    );
    expect(observes).toBe(0);
    expect(posts).toBe(0);
  });

  it("refuses unsupported when no right-click vehicle exists", async () => {
    const { controller } = makeController(openScript([]), { rightClick: undefined });
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "unsupported" }) as Error,
    );
  });

  it("refuses unsupported-locale on an empty declared title list", async () => {
    const { controller } = makeController(openScript([]));
    await expect(
      controller.open(locator(), { titles: { items: [] } }),
    ).rejects.toThrowError(expect.objectContaining({ code: "unsupported-locale" }) as Error);
  });

  it("reports stale-locator when the target window drifted before the post", async () => {
    const drifted = mainWindow();
    const { controller } = makeController([
      appState([drifted]),
      // baseline never reached — resolve fails first
    ]);
    await expect(
      controller.open(
        locator({ expected: { title: "Other", subrole: null, frame: { ...MAIN_FRAME } } }),
        { titles: TITLES },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "stale-locator" }) as Error);
  });

  it("reports unproven when the target window is not pid-attributed", async () => {
    const foreign = { ...mainWindow(), censusAttribution: "foreign" as const };
    const { controller } = makeController([appState([foreign])]);
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "unproven" }) as Error,
    );
  });

  it("reports indeterminate on deadline — the post is never resent", async () => {
    const posts: unknown[] = [];
    const { controller } = makeController(
      () => appState([mainWindow()]),
      {
        rightClick: (req) => {
          posts.push(req);
          return "clicked";
        },
      },
    );
    await expect(
      controller.open(locator(), { titles: TITLES, timeoutMs: 1_000, pollIntervalMs: 100 }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "indeterminate", message: expect.stringContaining("never resend") }) as Error,
    );
    expect(posts).toHaveLength(1);
  });

  it("refuses when the click raised an unrecognized blocking dialog", async () => {
    const { controller } = makeController(
      openScript([appState([mainWindow(), mysteryDialog()])]),
    );
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "refused" }) as Error,
    );
  });

  it("refuses when the click raised a human-only window", async () => {
    const signIn = menuWindow({ texts: ["Adobe sign-in required"] });
    const { controller } = makeController(openScript([appState([mainWindow(), signIn])]));
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "refused" }) as Error,
    );
  });

  it("refuses ambiguous when two new windows match the titles", async () => {
    const { controller } = makeController(
      openScript([appState([mainWindow(), menuWindow(), menuWindow({ frame: { ...MENU_FRAME, x: 600 } })])]),
    );
    await expect(controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "ambiguous-target" }) as Error,
    );
  });

  it("ignores a menu-titled window that existed BEFORE the click", async () => {
    // The same menu-shaped window is already open: it is baseline, so
    // the diff never counts it — the wait expires honestly.
    const { controller } = makeController([
      appState([mainWindow()]), // resolve target
      appState([mainWindow(), menuWindow()]), // baseline already holds it
      appState([mainWindow(), menuWindow()]), // poll: still baseline
    ]);
    await expect(
      controller.open(locator(), { titles: TITLES, timeoutMs: 500, pollIntervalMs: 100 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "indeterminate" }) as Error);
  });

  it("maps vehicle verdicts: failed → indeterminate, changed → stale-locator", async () => {
    const failing = makeController(openScript([appState([mainWindow(), menuWindow()])]), {
      rightClick: () => "failed",
    });
    await expect(failing.controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "indeterminate" }) as Error,
    );

    const changed = makeController(openScript([]), { rightClick: () => "changed" });
    await expect(changed.controller.open(locator(), { titles: TITLES })).rejects.toThrowError(
      expect.objectContaining({ code: "stale-locator" }) as Error,
    );
  });
});

describe("ContextMenuController.items / invokeItem", () => {
  async function openMenu(
    over: { [K in keyof ContextMenuOps]?: ContextMenuOps[K] | undefined } = {},
    gate?: ConstructorParameters<typeof ContextMenuController>[0]["authorizeMutation"],
  ): Promise<{ controller: ContextMenuController; resolution: ContextMenuResolution }> {
    let index = 0;
    const states = [
      appState([mainWindow()]), // resolve target
      appState([mainWindow()]), // baseline
      appState([mainWindow(), menuWindow()]), // poll → menu
      appState([mainWindow(), menuWindow()]), // reresolve
    ];
    const ops: ContextMenuOps = {
      observe: () => states[Math.min(index++, states.length - 1)] ?? appState([mainWindow()]),
      rightClick: () => "clicked",
      pressItem: () => "clicked",
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
    const controller = new ContextMenuController({
      pid: PID,
      ops,
      authorizeMutation: gate ?? (() => ({ allowed: true })),
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    const resolution = await controller.open(locator(), {
      titles: TITLES,
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });
    return { controller, resolution };
  }

  it("items re-resolves and lists candidates", async () => {
    const { controller, resolution } = await openMenu();
    const result = controller.items(resolution, TITLES);
    expect(result.items.map((item) => item.title)).toEqual(["Copy", "Delete", "Rename"]);
  });

  it("invokeItem presses the declared title inside the menu window", async () => {
    const presses: { windowIndex: number; title: string }[] = [];
    const { controller, resolution } = await openMenu({
      pressItem: ({ windowIndex, title }) => {
        presses.push({ windowIndex, title });
        return "clicked";
      },
    });
    const result = await controller.invokeItem(resolution, TITLES, "Delete");
    expect(result.action).toBe("invoke-item");
    expect(result.detail).toContain("Delete");
    expect(presses).toEqual([{ windowIndex: 2, title: "Delete" }]);
  });

  it("invokeItem refuses a title the menu does not expose — no nearest match", async () => {
    const { controller, resolution } = await openMenu();
    await expect(
      controller.invokeItem(resolution, TITLES, "Purge"),
    ).rejects.toThrowError(expect.objectContaining({ code: "not-found" }) as Error);
  });

  it("invokeItem is gated — refuses before re-resolving", async () => {
    const { resolution } = await openMenu();
    let observes = 0;
    // A gate that allows open but denies invoke-item.
    const gated = new ContextMenuController({
      pid: PID,
      ops: {
        observe: () => {
          observes += 1;
          return appState([mainWindow(), menuWindow()]);
        },
        rightClick: () => "clicked",
        pressItem: () => "clicked",
      },
      authorizeMutation: (op) =>
        op === "open"
          ? { allowed: true }
          : { allowed: false, reason: "invoke-item not cleared" },
      clock: () => 0,
      now: () => new Date(0),
      sleep: () => Promise.resolve(),
    });
    await expect(
      gated.invokeItem(resolution, TITLES, "Copy"),
    ).rejects.toThrowError(expect.objectContaining({ code: "refused" }) as Error);
    expect(observes).toBe(0);
  });

  it("invokeItem reports stale-locator when the menu was dismissed", async () => {
    let calls = 0;
    const { controller, resolution } = await openMenu({
      observe: () => {
        calls += 1;
        // open consumes observes 1-3 (resolve, baseline, poll); the
        // reresolve at call 4 sees the menu gone.
        if (calls <= 2) return appState([mainWindow()]);
        if (calls === 3) return appState([mainWindow(), menuWindow()]);
        return appState([mainWindow()]);
      },
    });
    await expect(
      controller.invokeItem(resolution, TITLES, "Copy"),
    ).rejects.toThrowError(expect.objectContaining({ code: "stale-locator" }) as Error);
  });

  it("invokeItem maps a failed press to indeterminate", async () => {
    const { controller, resolution } = await openMenu({
      pressItem: () => "failed",
    });
    await expect(
      controller.invokeItem(resolution, TITLES, "Copy"),
    ).rejects.toThrowError(expect.objectContaining({ code: "indeterminate" }) as Error);
  });

  it("invokeItem refuses unsupported without a press vehicle", async () => {
    const { controller, resolution } = await openMenu({ pressItem: undefined });
    await expect(
      controller.invokeItem(resolution, TITLES, "Copy"),
    ).rejects.toThrowError(expect.objectContaining({ code: "unsupported" }) as Error);
  });
});

describe("contextMenuForTarget / capabilities / gate", () => {
  it("refuses when no owned target is attested", () => {
    expect(() => contextMenuForTarget(null)).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("reports unsupported on non-macOS platforms", () => {
    const caps = contextMenuCapabilities("win32");
    expect(caps.open.support).toBe("unsupported");
    expect(caps.items.support).toBe("unsupported");
    expect(caps.invokeItem.support).toBe("unsupported");
  });

  it("reports the honest darwin capability levels", () => {
    const caps = contextMenuCapabilities("darwin");
    expect(caps.open.support).toBe("unavailable");
    expect(caps.open.verification).toBe("automated test");
    expect(caps.items.support).toBe("implemented");
    expect(caps.invokeItem.support).toBe("unavailable");
    expect(caps.open.reason).toContain("A-SAFETY");
  });

  it("the production gate refuses every act class, fail-closed", () => {
    const gate = contextMenuMutationGate();
    for (const op of ["open", "invoke-item"] as const) {
      const verdict = gate(op);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
