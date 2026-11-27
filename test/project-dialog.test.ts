/**
 * Project Open/Save dialog round-trip contract tests (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5, §10).
 *
 * Everything here runs against fake `ProjectDialogOps` — a scripted
 * menu invoke, a fake file-dialog channel, and scripted DOM/file
 * oracles. This proves the contract — the GUI-only act path (menu →
 * picker → filename entry → confirm), bounded postcondition waits,
 * recorded evidence channels, fail-closed gates at every layer, and
 * the honest `unsupported`/`indeterminate` paths — at `automated test`
 * level. It does NOT prove a real After Effects native picker accepts
 * the entered filename or that `project.info` converges after a GUI
 * open; that stays unverified until a real-host run records it.
 */

import { describe, expect, it } from "vitest";

import {
  ProjectDialogController,
  type ProjectDialogOps,
} from "../src/projectdialog/controller.js";
import { projectDialogMutationGate } from "../src/projectdialog/gate.js";
import type {
  ProjectDialogFileStat,
  ProjectDialogProjectInfo,
} from "../src/projectdialog/types.js";
import {
  projectDialogCapabilities,
  projectDialogForTarget,
} from "../src/api/project-dialog.js";
import { FileDialogError } from "../src/filedialog/types.js";
import type { FileDialogResolution, FileDialogTitles } from "../src/filedialog/types.js";
import { MenuError } from "../src/menus/types.js";
import type { MenuItemLocator } from "../src/menus/types.js";
import type { GuiAppState, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { Session } from "../src/api/session.js";

const PID = 4242;
const TITLES: FileDialogTitles = { confirm: ["Open", "Save"], cancel: ["Cancel"] };
const OPEN_MENU: MenuItemLocator = { menuPath: ["File"], itemTitle: "Open…" };
const SAVE_MENU: MenuItemLocator = { menuPath: ["File"], itemTitle: "Save As…" };
const FIXTURE = "/fixtures/round-trip.aep";
const OUT = "/fixtures/round-trip-out.aep";

function dialogResolution(): FileDialogResolution {
  const window: GuiWindowInfo = {
    title: "",
    role: "AXDialog",
    subrole: "AXSystemDialog",
    buttons: [
      {
        title: "Open",
        description: "",
        position: { x: 400, y: 600 },
        size: { width: 80, height: 32 },
      },
    ],
    texts: [],
    frame: { x: 500, y: 300, width: 600, height: 400 },
    censusAttribution: "owned",
  };
  return {
    index: 2,
    window,
    matchedConfirmTitles: ["Open"],
    matchedCancelTitles: [],
    observedAt: new Date(0).toISOString(),
  };
}

function emptyState(): GuiAppState {
  return {
    pid: PID,
    frontmost: true,
    windows: [],
    windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
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
  };
}

type FakeOps = {
  ops: ProjectDialogOps;
  menus: MenuItemLocator[];
  entered: string[];
  confirmed: string[];
  cancelled: string[];
};

function makeOps(over: Partial<ProjectDialogOps> = {}): FakeOps {
  const menus: MenuItemLocator[] = [];
  const entered: string[] = [];
  const confirmed: string[] = [];
  const cancelled: string[] = [];
  const ops: ProjectDialogOps = {
    invokeMenu: (locator) => {
      menus.push(locator);
    },
    dialog: {
      awaitDialog: () => Promise.resolve(dialogResolution()),
      enterFilename: (_res, text) => {
        entered.push(text);
        return Promise.resolve({
          action: "enter-filename",
          detail: "entered",
          actedAt: new Date(0).toISOString(),
        });
      },
      confirm: (res, titles) => {
        confirmed.push(titles.confirm[0] ?? "?");
        void res;
        return { action: "confirm", detail: 'pressed "Open"', actedAt: new Date(0).toISOString() };
      },
      cancel: (res, titles) => {
        cancelled.push(titles.cancel[0] ?? "?");
        void res;
        return { action: "cancel", detail: 'pressed "Cancel"', actedAt: new Date(0).toISOString() };
      },
    },
    observe: () => emptyState(),
    projectInfo: (): ProjectDialogProjectInfo => ({ file: FIXTURE, name: "round-trip.aep" }),
    statFile: (): ProjectDialogFileStat => ({ exists: true, mtimeMs: 1_700_000_000_000, sizeBytes: 4096 }),
    ...over,
  };
  return { ops, menus, entered, confirmed, cancelled };
}

function makeController(
  fake: FakeOps,
  gate?: ConstructorParameters<typeof ProjectDialogController>[0]["authorizeMutation"],
) {
  const c = clock();
  const controller = new ProjectDialogController({
    pid: PID,
    ops: fake.ops,
    authorizeMutation: gate ?? (() => ({ allowed: true })),
    clock: c.now,
    now: c.nowDate,
    sleep: c.sleep,
  });
  return { controller, c };
}

describe("ProjectDialogController.openProject", () => {
  it("runs menu → picker → filename → confirm and verifies project.info", async () => {
    const fake = makeOps();
    const { controller } = makeController(fake);
    const result = await controller.openProject({
      menu: OPEN_MENU,
      titles: TITLES,
      fileName: FIXTURE,
      expectedFile: FIXTURE,
      postconditionTimeoutMs: 1_000,
    });
    expect(result.action).toBe("open");
    expect(result.verdict).toBe("performed");
    expect(fake.menus).toEqual([OPEN_MENU]);
    expect(fake.entered).toEqual([FIXTURE]);
    expect(fake.confirmed).toEqual(["Open"]);
    expect(result.evidence.postconditionMet).toBe(true);
    expect(result.evidence.channels.projectInfo?.file).toBe(FIXTURE);
    expect(result.evidence.channels.fileStat).toBeNull();
  });

  it("reports indeterminate when project.info never converges — no resend", async () => {
    const fake = makeOps({
      projectInfo: (): ProjectDialogProjectInfo => ({ file: null, name: null }),
    });
    const { controller } = makeController(fake);
    const result = await controller.openProject({
      menu: OPEN_MENU,
      titles: TITLES,
      fileName: FIXTURE,
      expectedFile: FIXTURE,
      postconditionTimeoutMs: 500,
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.detail).toContain("no resend");
    // Exactly one confirm — the postcondition wait never re-acts.
    expect(fake.confirmed).toHaveLength(1);
  });

  it("accepts a suffix match when expectedFile is omitted", async () => {
    const fake = makeOps({
      projectInfo: (): ProjectDialogProjectInfo => ({
        file: "/other/prefix/round-trip.aep",
        name: "round-trip.aep",
      }),
    });
    const { controller } = makeController(fake);
    const result = await controller.openProject({
      menu: OPEN_MENU,
      titles: TITLES,
      fileName: "round-trip.aep",
      postconditionTimeoutMs: 500,
    });
    expect(result.verdict).toBe("performed");
  });

  it("refuses before any act when the gate denies", async () => {
    const fake = makeOps();
    const { controller } = makeController(fake, () => ({
      allowed: false,
      reason: "A-SAFETY has not cleared project dialogs",
    }));
    await expect(
      controller.openProject({ menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE }),
    ).rejects.toThrowError(expect.objectContaining({ code: "refused" }) as Error);
    expect(fake.menus).toHaveLength(0);
    expect(fake.entered).toHaveLength(0);
  });

  it("propagates the menu invoke's coded refusal", async () => {
    const fake = makeOps({
      invokeMenu: () => {
        throw new MenuError("unsupported-locale", "menu path absent");
      },
    });
    const { controller } = makeController(fake);
    await expect(
      controller.openProject({ menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE }),
    ).rejects.toThrowError(expect.objectContaining({ code: "unsupported-locale" }) as Error);
    expect(fake.entered).toHaveLength(0);
  });

  it("propagates the dialog wait's indeterminate", async () => {
    const fake = makeOps({
      dialog: {
        awaitDialog: () => Promise.reject(new FileDialogError("indeterminate", "no picker appeared")),
        enterFilename: () => Promise.reject(new Error("unreachable")),
        confirm: () => {
          throw new Error("unreachable");
        },
        cancel: () => {
          throw new Error("unreachable");
        },
      },
    });
    const { controller } = makeController(fake);
    await expect(
      controller.openProject({ menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE }),
    ).rejects.toThrowError(expect.objectContaining({ code: "indeterminate" }) as Error);
  });

  it("propagates the filename-entry unsupported honestly", async () => {
    const fake = makeOps({
      dialog: {
        awaitDialog: () => Promise.resolve(dialogResolution()),
        enterFilename: () =>
          Promise.reject(new FileDialogError("unsupported", "no B-IME text vehicle")),
        confirm: () => {
          throw new Error("unreachable");
        },
        cancel: () => {
          throw new Error("unreachable");
        },
      },
    });
    const { controller } = makeController(fake);
    await expect(
      controller.openProject({ menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE }),
    ).rejects.toThrowError(expect.objectContaining({ code: "unsupported" }) as Error);
    expect(fake.confirmed).toHaveLength(0);
  });
});

describe("ProjectDialogController.saveProjectAs", () => {
  it("verifies the declared path exists via the read-only stat oracle", async () => {
    const stats: string[] = [];
    const fake = makeOps({
      statFile: (path) => {
        stats.push(path);
        return { exists: true, mtimeMs: 42, sizeBytes: 10 };
      },
    });
    const { controller } = makeController(fake);
    const result = await controller.saveProjectAs({
      menu: SAVE_MENU,
      titles: TITLES,
      fileName: "round-trip-out.aep",
      path: OUT,
      postconditionTimeoutMs: 500,
    });
    expect(result.action).toBe("save-as");
    expect(result.verdict).toBe("performed");
    expect(stats).toContain(OUT);
    expect(result.evidence.channels.fileStat?.exists).toBe(true);
    expect(result.evidence.channels.projectInfo).toBeNull();
  });

  it("reports indeterminate when the file never appears", async () => {
    const fake = makeOps({
      statFile: () => ({ exists: false, mtimeMs: null, sizeBytes: null }),
    });
    const { controller } = makeController(fake);
    const result = await controller.saveProjectAs({
      menu: SAVE_MENU,
      titles: TITLES,
      fileName: "round-trip-out.aep",
      path: OUT,
      postconditionTimeoutMs: 500,
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.detail).toContain("no resend");
  });
});

describe("ProjectDialogController.cancelDialog", () => {
  it("cancels the picker and verifies no file-dialog window remains", async () => {
    const fake = makeOps();
    const { controller } = makeController(fake);
    const result = await controller.cancelDialog({
      menu: OPEN_MENU,
      titles: TITLES,
      timeoutMs: 1_000,
    });
    expect(result.action).toBe("cancel");
    expect(result.verdict).toBe("performed");
    expect(fake.cancelled).toEqual(["Cancel"]);
    expect(result.evidence.channels.windows).toBe(0);
  });

  it("reports indeterminate while a matching dialog window remains", async () => {
    const lingering: GuiWindowInfo = {
      title: "",
      role: "AXDialog",
      subrole: "AXSystemDialog",
      buttons: [
        { title: "Open", description: "", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
        { title: "Cancel", description: "", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
      ],
      texts: [],
      frame: { x: 1, y: 1, width: 10, height: 10 },
      censusAttribution: "owned",
    };
    const fake = makeOps({
      observe: () => ({
        ...emptyState(),
        windows: [lingering],
        windowServer: { available: true, reason: null, windowCount: 1, onScreenCount: 1 },
      }),
    });
    const { controller } = makeController(fake);
    const result = await controller.cancelDialog({
      menu: OPEN_MENU,
      titles: TITLES,
      timeoutMs: 1_000,
    });
    expect(result.verdict).toBe("indeterminate");
  });
});

describe("ProjectDialogController.roundTrip", () => {
  it("composes open + save-as; performed only when both converge", async () => {
    const fake = makeOps();
    const { controller } = makeController(fake);
    const result = await controller.roundTrip({
      open: { menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE, expectedFile: FIXTURE },
      save: { menu: SAVE_MENU, titles: TITLES, fileName: "round-trip-out.aep", path: OUT },
    });
    expect(result.verdict).toBe("performed");
    expect(result.open.verdict).toBe("performed");
    expect(result.save.verdict).toBe("performed");
    expect(fake.menus).toEqual([OPEN_MENU, SAVE_MENU]);
    expect(fake.entered).toEqual([FIXTURE, "round-trip-out.aep"]);
  });

  it("is indeterminate when either leg fails to converge", async () => {
    const fake = makeOps({
      statFile: () => ({ exists: false, mtimeMs: null, sizeBytes: null }),
    });
    const { controller } = makeController(fake);
    const result = await controller.roundTrip({
      open: { menu: OPEN_MENU, titles: TITLES, fileName: FIXTURE, expectedFile: FIXTURE },
      save: { menu: SAVE_MENU, titles: TITLES, fileName: "x.aep", path: OUT, postconditionTimeoutMs: 300 },
    });
    expect(result.verdict).toBe("indeterminate");
    expect(result.open.verdict).toBe("performed");
    expect(result.save.verdict).toBe("indeterminate");
  });
});

describe("projectDialogForTarget / capabilities / gate", () => {
  it("refuses when no owned target is attested", () => {
    expect(() =>
      projectDialogForTarget(null, {} as Session),
    ).toThrowError(expect.objectContaining({ code: "unavailable" }) as Error);
  });

  it("reports unsupported on non-macOS platforms", () => {
    const caps = projectDialogCapabilities("win32");
    for (const cap of [caps.openProject, caps.saveProjectAs, caps.cancelDialog, caps.roundTrip]) {
      expect(cap.support).toBe("unsupported");
    }
  });

  it("reports the honest darwin capability levels", () => {
    const caps = projectDialogCapabilities("darwin");
    expect(caps.openProject.support).toBe("unavailable");
    expect(caps.openProject.verification).toBe("automated test");
    expect(caps.roundTrip.support).toBe("unavailable");
    expect(caps.openProject.reason).toContain("A-SAFETY");
    expect(caps.openProject.reason).toContain("#372");
  });

  it("the production gate refuses every leg, fail-closed", () => {
    const gate = projectDialogMutationGate();
    for (const op of ["open", "save", "cancel", "round-trip"] as const) {
      const verdict = gate(op);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
