/**
 * File-dialog contract tests (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3, §5, §10).
 *
 * Everything here runs against scripted window listings and fake
 * `FileDialogOps` — the "fake dialog census" the issue's AC names. This
 * proves the contract — bounded wait, dialog-class verification by
 * declared titles, re-resolution before act, fail-closed gates, and the
 * honest `unsupported` filename entry — at `automated test` level. It
 * does NOT prove a real After Effects native picker exposes stable AX
 * button titles or that any press lands; that stays unverified until a
 * real-host run records it.
 */

import { describe, expect, it } from "vitest";

import { FileDialogController, type FileDialogOps } from "../src/filedialog/controller.js";
import { fileDialogMutationGate } from "../src/filedialog/gate.js";
import { matchFileDialog } from "../src/filedialog/classify.js";
import type { FileDialogTitles } from "../src/filedialog/types.js";
import {
  fileDialogCapabilities,
  fileDialogForTarget,
} from "../src/api/file-dialog.js";
import {
  type GuiAppState,
  type GuiButtonInfo,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";

const PID = 4242;
const DIALOG_FRAME: GuiFrame = { x: 500, y: 300, width: 600, height: 400 };

const TITLES: FileDialogTitles = {
  confirm: ["Open", "Choose", "Import"],
  cancel: ["Cancel"],
};

function button(title: string): GuiButtonInfo {
  return {
    title,
    description: "",
    position: { x: 400, y: 600 },
    size: { width: 80, height: 32 },
  };
}

function mainWindow(): GuiWindowInfo {
  return {
    title: "After Effects",
    role: "AXLayoutArea",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { x: 0, y: 25, width: 1440, height: 900 },
    censusAttribution: "owned",
  };
}

/** A scripted native-picker-shaped dialog: dialog role + Open/Cancel. */
function pickerWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "",
    role: "AXDialog",
    subrole: "AXSystemDialog",
    buttons: [button("Open"), button("Cancel")],
    texts: [],
    frame: { ...DIALOG_FRAME },
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

describe("matchFileDialog", () => {
  it("classifies a dialog whose buttons match the declared titles", () => {
    const match = matchFileDialog(pickerWindow(), TITLES);
    expect(match.kind).toBe("file-dialog");
    if (match.kind !== "file-dialog") return;
    expect(match.matchedConfirmTitles).toEqual(["Open"]);
    expect(match.matchedCancelTitles).toEqual(["Cancel"]);
  });

  it("refuses unrecognized dialogs — never a blind confirm", () => {
    const unknown = pickerWindow({ buttons: [button("OK")] });
    expect(matchFileDialog(unknown, TITLES).kind).toBe("unrecognized-dialog");
  });

  it("ignores ordinary windows and foreign-attributed dialogs", () => {
    expect(matchFileDialog(mainWindow(), TITLES).kind).toBe("not-a-dialog");
    const foreign = pickerWindow({ censusAttribution: "foreign" });
    expect(matchFileDialog(foreign, TITLES).kind).toBe("not-a-dialog");
    const unmatched = pickerWindow({ censusAttribution: "unmatched" });
    expect(matchFileDialog(unmatched, TITLES).kind).toBe("not-a-dialog");
  });

  it("names human-only windows for what they are", () => {
    const signIn = pickerWindow({ texts: ["Sign in to continue"] });
    expect(matchFileDialog(signIn, TITLES).kind).toBe("human-only");
  });
});

describe("FileDialogController.awaitFileDialog", () => {
  function controllerWith(states: GuiAppState[] | (() => GuiAppState), over: Partial<FileDialogOps> = {}) {
    let index = 0;
    const observeCalls: number[] = [];
    const ops: FileDialogOps = {
      observe: () => {
        observeCalls.push(index);
        if (typeof states === "function") return states();
        const state = states[Math.min(index, states.length - 1)];
        index += 1;
        if (state === undefined) throw new Error("fixture exhausted");
        return state;
      },
      pressButton: () => true,
      ...over,
    };
    return { ops, observeCalls };
  }

  it("resolves when the picker appears inside the bounded wait", async () => {
    const { ops } = controllerWith([
      appState([mainWindow()]),
      appState([mainWindow(), pickerWindow()]),
    ]);
    const c = clock();
    const controller = new FileDialogController({
      pid: PID,
      ops,
      authorizeMutation: () => ({ allowed: true }),
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    const resolution = await controller.awaitFileDialog({
      titles: TITLES,
      timeoutMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(resolution.index).toBe(2);
    expect(resolution.window.role).toBe("AXDialog");
    expect(resolution.matchedConfirmTitles).toEqual(["Open"]);
    expect(resolution.matchedCancelTitles).toEqual(["Cancel"]);
  });

  it("reports indeterminate on deadline — nothing was pressed, nothing resent", async () => {
    const { ops, observeCalls } = controllerWith(() => appState([mainWindow()]));
    const c = clock();
    const controller = new FileDialogController({
      pid: PID,
      ops,
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    await expect(
      controller.awaitFileDialog({ titles: TITLES, timeoutMs: 1_000, pollIntervalMs: 100 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "indeterminate",
        message: expect.stringContaining("never resend"),
      }) as Error,
    );
    // Bounded: roughly timeout/poll observations, not an unbounded spin.
    expect(observeCalls.length).toBeLessThanOrEqual(12);
    expect(observeCalls.length).toBeGreaterThan(5);
  });

  it("refuses on an unrecognized blocking dialog — no blind confirm", async () => {
    const mystery = pickerWindow({ buttons: [button("Repair"), button("Later")] });
    const { ops } = controllerWith(() => appState([mainWindow(), mystery]));
    const c = clock();
    const controller = new FileDialogController({
      pid: PID,
      ops,
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    await expect(
      controller.awaitFileDialog({ titles: TITLES, timeoutMs: 60_000 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "refused" }) as Error);
  });

  it("refuses on a human-only window", async () => {
    const signIn = pickerWindow({ texts: ["Adobe sign-in required"] });
    const { ops } = controllerWith(() => appState([mainWindow(), signIn]));
    const c = clock();
    const controller = new FileDialogController({
      pid: PID,
      ops,
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    await expect(
      controller.awaitFileDialog({ titles: TITLES, timeoutMs: 60_000 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "refused" }) as Error);
  });

  it("refuses ambiguous when two windows match the picker titles", async () => {
    const { ops } = controllerWith(() =>
      appState([mainWindow(), pickerWindow(), pickerWindow({ frame: { x: 700, y: 300, width: 600, height: 400 } })]),
    );
    const c = clock();
    const controller = new FileDialogController({
      pid: PID,
      ops,
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    await expect(
      controller.awaitFileDialog({ titles: TITLES, timeoutMs: 60_000 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "ambiguous" }) as Error);
  });
});

describe("FileDialogController acts", () => {
  function resolvedState() {
    return appState([mainWindow(), pickerWindow()]);
  }

  async function resolveDialog(controller: FileDialogController) {
    return controller.awaitFileDialog({ titles: TITLES, timeoutMs: 1_000 });
  }

  function makeController(over: Partial<FileDialogOps> = {}, gate?: ConstructorParameters<typeof FileDialogController>[0]["authorizeMutation"]) {
    const c = clock();
    const ops: FileDialogOps = {
      observe: () => resolvedState(),
      pressButton: () => true,
      ...over,
    };
    const controller = new FileDialogController({
      pid: PID,
      ops,
      authorizeMutation: gate ?? (() => ({ allowed: true })),
      clock: c.now,
      now: c.nowDate,
      sleep: c.sleep,
    });
    return { controller, c, ops };
  }

  it("confirm presses the declared confirm title inside the dialog window", async () => {
    const presses: { index: number; title: string; expectedTitle: string }[] = [];
    const { controller } = makeController({
      pressButton: (index, title, expected) => {
        presses.push({ index, title, expectedTitle: expected.title });
        return true;
      },
    });
    const dialog = await resolveDialog(controller);
    const result = controller.confirm(dialog, TITLES);
    expect(result.action).toBe("confirm");
    expect(result.detail).toContain("Open");
    expect(presses).toEqual([{ index: 2, title: "Open", expectedTitle: "" }]);
  });

  it("cancel presses the declared cancel title", () => {
    const presses: string[] = [];
    const { controller } = makeController({
      pressButton: (_i, title) => {
        presses.push(title);
        return true;
      },
    });
    // awaitFileDialog is async; resolve synchronously through the same
    // observe path by calling it with an already-resolved microtask.
    return resolveDialog(controller).then((dialog) => {
      const result = controller.cancel(dialog, TITLES);
      expect(result.action).toBe("cancel");
      expect(presses).toEqual(["Cancel"]);
    });
  });

  it("refuses acts when the mutation gate denies — before any press", () => {
    let observeCalls = 0;
    const { controller } = makeController(
      {
        observe: () => {
          observeCalls += 1;
          return resolvedState();
        },
      },
      () => ({ allowed: false, reason: "A-SAFETY has not cleared dialog acts" }),
    );
    return resolveDialog(controller).then((dialog) => {
      // awaitFileDialog is observe-class: the gate does not block it.
      expect(() => controller.confirm(dialog, TITLES)).toThrowError(
        expect.objectContaining({ code: "refused" }) as Error,
      );
      expect(observeCalls).toBe(1); // only the await observed; confirm refused pre-observe
    });
  });

  it("reports stale-locator when the dialog changed before the act", async () => {
    let listings = 0;
    const { controller } = makeController({
      observe: () => {
        listings += 1;
        // First listing (await): the picker. Second (reresolve): it is gone.
        return listings === 1 ? resolvedState() : appState([mainWindow()]);
      },
    });
    const dialog = await resolveDialog(controller);
    expect(() => controller.confirm(dialog, TITLES)).toThrowError(
      expect.objectContaining({ code: "stale-locator" }) as Error,
    );
  });

  it("reports stale-locator when the press provably did not land", async () => {
    const { controller } = makeController({ pressButton: () => false });
    const dialog = await resolveDialog(controller);
    expect(() => controller.confirm(dialog, TITLES)).toThrowError(
      expect.objectContaining({ code: "stale-locator" }) as Error,
    );
  });

  it("enterFilename refuses unsupported without a text-input channel", async () => {
    const { controller } = makeController();
    const dialog = await resolveDialog(controller);
    await expect(controller.enterFilename(dialog, "/tmp/fixture.png")).rejects.toThrowError(
      expect.objectContaining({ code: "unsupported" }) as Error,
    );
  });

  it("enterFilename uses the injected channel and maps its verdicts", async () => {
    const entered: string[] = [];
    const { controller } = makeController({
      enterFilename: ({ text }) => {
        entered.push(text);
        return "entered" as const;
      },
    });
    const dialog = await resolveDialog(controller);
    const result = await controller.enterFilename(dialog, "/tmp/fixture.png");
    expect(result.action).toBe("enter-filename");
    expect(entered).toEqual(["/tmp/fixture.png"]);

    const failing = makeController({ enterFilename: () => "failed" });
    const dialog2 = await resolveDialog(failing.controller);
    await expect(failing.controller.enterFilename(dialog2, "x")).rejects.toThrowError(
      expect.objectContaining({ code: "indeterminate" }) as Error,
    );
  });
});

describe("fileDialogForTarget / capabilities / gate", () => {
  it("refuses when no owned target is attested", () => {
    expect(() => fileDialogForTarget(null)).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("reports unsupported on non-macOS platforms", () => {
    const caps = fileDialogCapabilities("win32");
    expect(caps.awaitDialog.support).toBe("unsupported");
    expect(caps.confirm.support).toBe("unsupported");
    expect(caps.enterFilename.support).toBe("unsupported");
  });

  it("reports the honest darwin capability levels", () => {
    const caps = fileDialogCapabilities("darwin");
    expect(caps.awaitDialog.support).toBe("implemented");
    expect(caps.awaitDialog.verification).toBe("automated test");
    expect(caps.confirm.support).toBe("unavailable");
    expect(caps.enterFilename.support).toBe("unsupported");
    expect(caps.enterFilename.reason).toContain("#372");
  });

  it("the production gate refuses every act class, fail-closed", () => {
    const gate = fileDialogMutationGate();
    for (const op of ["confirm", "cancel", "enter-filename"] as const) {
      const verdict = gate(op);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
