/**
 * Workspace editing W1 contract tests (#363,
 * `specs/workspace-editing/spec.md` §3 W1, §5, §10; parent #345).
 *
 * Everything here runs against scripted menu listings, fake window
 * observations, fixture workspace XML and injected `WorkspaceSurfaceOps`
 * fakes — the "scripted AX/menu listings + fixture XML" the issue's AC
 * names. This proves the contract: checkmark identity, switch gating +
 * postcondition wait (never resend), arrange gating + frame readback,
 * restore verification, and the typed refusal paths. It does NOT prove
 * After Effects honors any of it on a real host — menu checkmark
 * fidelity, real drags and XML write timing stay `unverified`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GuiAppState, GuiFrame, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import { parseMenuBarListing } from "../src/menus/parse.js";
import type { MenuBarSnapshot } from "../src/menus/types.js";
import type { MenuInvokeVerdict } from "../src/menus/controller.js";
import { axLeaf } from "../src/panels/docked/ax-node.js";
import type {
  DockedPaneLocator,
  DockedPaneResolution,
} from "../src/panels/docked/index.js";
import { PanelError, type PanelLocator, type PanelTarget } from "../src/panels/types.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { workspaceMutationGate } from "../src/workspace/gate.js";
import {
  WorkspaceError,
  type WorkspaceArrangeRequest,
  type WorkspaceSurfaceOps,
} from "../src/workspace/types.js";
import { snapshotWorkspaceStore } from "../src/workspace-xml/index.js";
import { workspaceCapabilities, workspaceForTarget } from "../src/api/workspace.js";

const PID = 4242;
const OBSERVED_AT = "2026-11-30T00:00:00.000Z";

const MAIN_FRAME: GuiFrame = { x: 0, y: 25, width: 1440, height: 900 };
const PANEL_FRAME: GuiFrame = { x: 100, y: 200, width: 640, height: 504 };
const MOVED_FRAME: GuiFrame = { x: 300, y: 260, width: 640, height: 504 };

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

/**
 * A scripted Window > Workspace menu whose checkmark follows a mutable
 * `checked` name — the fake stands in for AE flipping the mark after a
 * real menu click.
 */
function menuListing(checked: string | null): string {
  const items = ["Standard", "Motion", "New Workspace…"];
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

function panelTarget(over: Partial<PanelTarget["surface"]> = {}): PanelTarget {
  return {
    pid: PID,
    surface: {
      kind: "window",
      windowIndex: 2,
      windowNumber: 777,
      locator: { title: "My Plugin Panel" },
      frame: { ...PANEL_FRAME },
      state: { onScreen: true, occluded: "unknown" },
      attribution: "owned",
      ...over,
    },
    resolvedAt: OBSERVED_AT,
  };
}

function dockedResolution(frame: GuiFrame = { x: 200, y: 400, width: 500, height: 300 }): DockedPaneResolution {
  const target = panelTarget({
    kind: "docked-region",
    windowIndex: 1,
    windowNumber: null,
    locator: { title: "Timeline" },
    frame: { ...frame },
  });
  return {
    target,
    pane: axLeaf({ path: "0.1", depth: 1, role: "AXGroup", title: "Timeline", frame: { ...frame } }),
    tree: axLeaf({ path: "0", depth: 0, role: "AXWindow", frame: { ...MAIN_FRAME } }),
    parentWindow: axWindow(),
    parentWindowIndex: 1,
    walk: { nodesKept: 2, truncated: false, stopReason: "complete", scriptTruncated: false },
  };
}

type FakeState = {
  checked: string | null;
  windows: GuiWindowInfo[];
  panelFrames: Map<string, GuiFrame>;
  invokes: { path: readonly number[]; titles: readonly string[] }[];
  invokeVerdict: MenuInvokeVerdict;
  drags: { from: GuiFrame; to: GuiFrame }[];
  dragVerdict: "performed" | "not-performed" | "failed";
  menuAvailable: boolean;
};

function fakeOps(state: FakeState, xmlDir: string): WorkspaceSurfaceOps {
  return {
    observeMenuBar: (): MenuBarSnapshot => {
      if (!state.menuAvailable) {
        return {
          pid: PID,
          channel: "system-events",
          observedAt: OBSERVED_AT,
          available: false,
          reason: "scripted: no menu bar",
          menuBarItems: [],
          truncated: false,
        };
      }
      return parseMenuBarListing(menuListing(state.checked), PID, OBSERVED_AT);
    },
    invokeMenuItem: (target) => {
      state.invokes.push(target);
      if (state.invokeVerdict === "clicked") {
        // The fake AE flips the checkmark to the invoked leaf title.
        state.checked = target.titles[target.titles.length - 1] ?? null;
      }
      return state.invokeVerdict;
    },
    observeWindows: () => appState(state.windows),
    resolvePanel: (locator: PanelLocator): PanelTarget => {
      const title = locator.title ?? "";
      const frame = state.panelFrames.get(title);
      if (frame === undefined) {
        throw new PanelError("not-found", `no fake panel titled "${title}"`);
      }
      return panelTarget({ locator, frame: { ...frame } });
    },
    resolveDockedPane: (_locator: DockedPaneLocator) => dockedResolution(),
    drag: (request) => {
      state.drags.push({ from: { ...request.from }, to: { ...request.to } });
      if (state.dragVerdict === "performed") {
        // The fake drag lands the panel on the destination frame.
        const title = [...state.panelFrames.keys()][0];
        if (title !== undefined) {
          state.panelFrames.set(title, { ...request.to });
        }
      }
      return state.dragVerdict;
    },
    snapshotXml: () => snapshotWorkspaceStore({ preferencesDir: xmlDir }),
  };
}

function fakeState(over: Partial<FakeState> = {}): FakeState {
  return {
    checked: "Standard",
    windows: [
      axWindow(),
      axWindow({
        title: "My Plugin Panel",
        role: "AXLayoutArea",
        subrole: "AXFloatingWindow",
        frame: { ...PANEL_FRAME },
      }),
    ],
    panelFrames: new Map([["My Plugin Panel", { ...PANEL_FRAME }]]),
    invokes: [],
    invokeVerdict: "clicked",
    drags: [],
    dragVerdict: "performed",
    menuAvailable: true,
    ...over,
  };
}

const FAST_POLL = { timeoutMs: 60, intervalMs: 5, frameTolerance: 4 };
const ALLOW_ALL = () => ({ allowed: true as const });

async function workspaceErrorOf(fn: () => Promise<unknown>): Promise<WorkspaceError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return error as WorkspaceError;
  }
  throw new Error("expected a WorkspaceError, none was thrown");
}

describe("workspace W1 contract", () => {
  let xmlDir: string;
  let prefsDir: string;

  beforeEach(() => {
    xmlDir = mkdtempSync(join(tmpdir(), "ae-a8n-workspace-363-"));
    prefsDir = join(xmlDir, "ModifiedWorkspaces");
    mkdirSync(join(xmlDir, "OriginalUserWorkspaces"), { recursive: true });
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(
      join(prefsDir, "UserWorkspace_10.xml"),
      `<?xml version="1.0"?><WorkspaceSet>` +
        `<Workspace name="Standard"/><Workspace name="Motion"/>` +
        `</WorkspaceSet>`,
    );
    writeFileSync(
      join(xmlDir, "OriginalUserWorkspaces", "Original_1.xml"),
      `<?xml version="1.0"?><WorkspaceSet><Workspace name="Standard"/></WorkspaceSet>`,
    );
  });

  afterEach(() => {
    rmSync(xmlDir, { recursive: true, force: true });
  });

  function controller(state: FakeState, over: Partial<ConstructorParameters<typeof WorkspaceController>[0]> = {}) {
    return new WorkspaceController({
      pid: PID,
      ops: fakeOps(state, xmlDir),
      authorizeMutation: ALLOW_ALL,
      poll: FAST_POLL,
      sleep: () => Promise.resolve(),
      now: () => new Date(OBSERVED_AT),
      ...over,
    });
  }

  describe("observe / identity", () => {
    it("resolves the active workspace from the menu checkmark and marks XML persistence", () => {
      const obs = controller(fakeState()).observe();
      expect(obs.identity.status).toBe("resolved");
      if (obs.identity.status !== "resolved") return;
      expect(obs.identity.target.workspace.name).toBe("Standard");
      expect(obs.identity.target.workspace.persisted).toBe(true);
      expect(obs.identity.target.workspace.xmlRef?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.panels.length).toBeGreaterThanOrEqual(2);
      expect(obs.xml.status).toBe("observed");
    });

    it("reports identity unknown when no item carries a readable checkmark", () => {
      const obs = controller(fakeState({ checked: null })).observe();
      expect(obs.identity.status).toBe("unknown");
      // The rest of the observation still stands — panels and XML are evidence.
      expect(obs.panels.length).toBeGreaterThanOrEqual(2);
      expect(obs.xml.status).toBe("observed");
    });

    it("degrades honestly when the menu bar is unavailable", () => {
      const obs = controller(fakeState({ menuAvailable: false })).observe();
      expect(obs.menu.available).toBe(false);
      expect(obs.identity.status).toBe("unknown");
      expect(obs.panels.length).toBeGreaterThanOrEqual(2);
    });

    it("records docked-pane frames and pane failures inside one observation", () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      const failing: WorkspaceSurfaceOps = {
        ...ops,
        resolveDockedPane: () => {
          throw new PanelError("stale-locator", "scripted drift");
        },
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: failing,
        authorizeMutation: ALLOW_ALL,
        dockedPanes: [{ pane: { title: "Timeline" } }],
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const obs = c.observe();
      expect(obs.failures).toHaveLength(1);
      expect(obs.failures[0]?.channel).toBe("docked-pane");
      expect(obs.failures[0]?.code).toBe("stale-locator");
    });
  });

  describe("listWorkspaces", () => {
    it("lists submenu entries with check state and persistence", () => {
      const entries = controller(fakeState()).listWorkspaces();
      const standard = entries.find((e) => e.title === "Standard");
      const motion = entries.find((e) => e.title === "Motion");
      expect(standard?.check).toBe("checked");
      expect(standard?.persisted).toBe(true);
      expect(motion?.check).toBe("unchecked");
      expect(motion?.persisted).toBe(true);
    });

    it("refuses unsupported-locale when the menu path is absent", () => {
      const state = fakeState({ menuAvailable: false });
      const c = controller(state);
      // listWorkspaces is synchronous on the controller.
      expect(() => c.listWorkspaces()).toThrowError(WorkspaceError);
      try {
        c.listWorkspaces();
      } catch (error) {
        expect((error as WorkspaceError).code).toBe("unavailable");
      }
    });

    it("refuses unsupported-locale for a non-English menu path", () => {
      const c = controller(fakeState(), {
        menuPath: { barTitle: "ウィンドウ", submenuTitle: "Workspace" },
      });
      try {
        c.listWorkspaces();
        throw new Error("expected WorkspaceError");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
        expect((error as WorkspaceError).code).toBe("unsupported-locale");
      }
    });
  });

  describe("switchTo", () => {
    it("is refused by the fail-closed gate before anything is invoked", async () => {
      const state = fakeState();
      const c = new WorkspaceController({
        pid: PID,
        ops: fakeOps(state, xmlDir),
        // No authorizeMutation — the controller's own fail-closed default.
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.switchTo("Motion"));
      expect(error.code).toBe("refused");
      expect(state.invokes).toHaveLength(0);
    });

    it("uses the production gate which always refuses", async () => {
      const state = fakeState();
      const c = new WorkspaceController({
        pid: PID,
        ops: fakeOps(state, xmlDir),
        authorizeMutation: workspaceMutationGate(),
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.switchTo("Motion"));
      expect(error.code).toBe("refused");
      expect(state.invokes).toHaveLength(0);
    });

    it("switches via one menu invoke and verifies the checkmark flip", async () => {
      const state = fakeState();
      const result = await controller(state).switchTo("Motion");
      expect(state.invokes).toHaveLength(1);
      expect(state.invokes[0]?.titles).toEqual(["Window", "Workspace", "Motion"]);
      expect(result.checkConfirmed).toBe(true);
      expect(result.activeAfter.status).toBe("resolved");
      if (result.activeAfter.status === "resolved") {
        expect(result.activeAfter.target.workspace.name).toBe("Motion");
      }
      expect(result.before.identity.status).toBe("resolved");
    });

    it("records panel frame deltas and XML changes across the switch", async () => {
      const state = fakeState();
      // Simulate AE rewriting layout: the panel frame moves on switch.
      const ops = fakeOps(state, xmlDir);
      const wrapped: WorkspaceSurfaceOps = {
        ...ops,
        invokeMenuItem: (target) => {
          const verdict = ops.invokeMenuItem(target);
          state.windows = state.windows.map((w) =>
            w.title === "My Plugin Panel"
              ? { ...w, frame: { ...MOVED_FRAME } }
              : w,
          );
          state.panelFrames.set("My Plugin Panel", { ...MOVED_FRAME });
          return verdict;
        },
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: wrapped,
        authorizeMutation: ALLOW_ALL,
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const result = await c.switchTo("Motion");
      expect(result.framesChanged).toBe(true);
      // AE "writes" the workspace XML on switch — the fake store is
      // unchanged, so xmlChanged is honestly empty here.
      expect(result.xmlChanged).toEqual([]);
    });

    it("reports indeterminate on postcondition timeout and never resends", async () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      let invokes = 0;
      const counting: WorkspaceSurfaceOps = {
        ...ops,
        // The click "succeeds" but the checkmark never flips.
        invokeMenuItem: () => {
          invokes += 1;
          return "clicked" as const;
        },
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: counting,
        authorizeMutation: ALLOW_ALL,
        poll: { timeoutMs: 30, intervalMs: 5, frameTolerance: 4 },
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.switchTo("Motion"));
      expect(error.code).toBe("indeterminate");
      expect(invokes).toBe(1); // blind resend prohibited (spec §10)
    });

    it("maps invoke verdicts: changed→stale-locator, failed→indeterminate", async () => {
      for (const [verdict, code] of [
        ["changed", "stale-locator"],
        ["not-found", "stale-locator"],
        ["failed", "indeterminate"],
        ["missing", "unavailable"],
      ] as const) {
        const state = fakeState({ invokeVerdict: verdict });
        const error = await workspaceErrorOf(() => controller(state).switchTo("Motion"));
        expect(error.code).toBe(code);
      }
    });

    it("refuses not-found for a workspace the menu does not offer", async () => {
      const error = await workspaceErrorOf(() =>
        controller(fakeState()).switchTo("Broadcast"),
      );
      expect(error.code).toBe("not-found");
    });

    it("refuses ambiguous-target when two items share the name", async () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      const dupListing = menuListing("Standard").replace(
        "I|2,1,3|New Workspace…|AXMenuItem|1|0|||item",
        "I|2,1,3|Motion|AXMenuItem|1|0|||item",
      );
      const wrapped: WorkspaceSurfaceOps = {
        ...ops,
        observeMenuBar: () => parseMenuBarListing(dupListing, PID, OBSERVED_AT),
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: wrapped,
        authorizeMutation: ALLOW_ALL,
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.switchTo("Motion"));
      expect(error.code).toBe("ambiguous-target");
    });

    it("refuses unsupported-locale when the Workspace submenu is absent", async () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      const noWorkspace = "MB|1|AE-A8N|AXMenuBarItem|1\nMB|2|Window|AXMenuBarItem|1\nI|2,1|Minimize|AXMenuItem|1|0||item";
      const wrapped: WorkspaceSurfaceOps = {
        ...ops,
        observeMenuBar: () => parseMenuBarListing(noWorkspace, PID, OBSERVED_AT),
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: wrapped,
        authorizeMutation: ALLOW_ALL,
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.switchTo("Motion"));
      expect(error.code).toBe("unsupported-locale");
    });
  });

  describe("arrange", () => {
    const request: WorkspaceArrangeRequest = {
      panel: { title: "My Plugin Panel" },
      destination: { kind: "float", frame: { ...MOVED_FRAME } },
    };

    it("reports unsupported when no drag vehicle is wired", async () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      const noDrag: WorkspaceSurfaceOps = { ...ops };
      delete noDrag.drag;
      const c = new WorkspaceController({
        pid: PID,
        ops: noDrag,
        authorizeMutation: ALLOW_ALL,
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.arrange(request));
      expect(error.code).toBe("unsupported");
      expect(state.drags).toHaveLength(0);
    });

    it("is refused by the gate even with a drag vehicle", async () => {
      const state = fakeState();
      const c = new WorkspaceController({
        pid: PID,
        ops: fakeOps(state, xmlDir),
        // No authorizeMutation → fail-closed.
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.arrange(request));
      expect(error.code).toBe("refused");
      expect(state.drags).toHaveLength(0);
    });

    it("drags once and verifies the landing frame within tolerance", async () => {
      const state = fakeState();
      const result = await controller(state).arrange(request);
      expect(state.drags).toHaveLength(1);
      expect(state.drags[0]?.from).toEqual(PANEL_FRAME);
      expect(state.drags[0]?.to).toEqual(MOVED_FRAME);
      expect(result.verified).toBe(true);
      expect(result.after?.surface.frame).toEqual(MOVED_FRAME);
      expect(result.frameDelta).toEqual({ dx: 200, dy: 60, dWidth: 0, dHeight: 0 });
    });

    it("verifies a dock as a surface change, not an exact frame", async () => {
      const state = fakeState();
      const dockRequest: WorkspaceArrangeRequest = {
        panel: { title: "My Plugin Panel" },
        destination: { kind: "dock", pane: { pane: { title: "Timeline" } } },
      };
      const result = await controller(state).arrange(dockRequest);
      expect(result.expectation.kind).toBe("changed");
      expect(result.verified).toBe(true);
    });

    it("reports indeterminate when the landing frame never matches", async () => {
      const state = fakeState({ dragVerdict: "performed" });
      const ops = fakeOps(state, xmlDir);
      const stuck: WorkspaceSurfaceOps = {
        ...ops,
        // The drag "performed" but the panel never moved.
        resolvePanel: () => panelTarget(),
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: stuck,
        authorizeMutation: ALLOW_ALL,
        poll: { timeoutMs: 30, intervalMs: 5, frameTolerance: 4 },
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.arrange(request));
      expect(error.code).toBe("indeterminate");
      expect(state.drags).toHaveLength(1); // never resent
    });

    it("maps a failed drag verdict to indeterminate and not-performed to stale-locator", async () => {
      const failed = fakeState({ dragVerdict: "failed" });
      const error1 = await workspaceErrorOf(() => controller(failed).arrange(request));
      expect(error1.code).toBe("indeterminate");

      const notPerformed = fakeState({ dragVerdict: "not-performed" });
      const error2 = await workspaceErrorOf(() => controller(notPerformed).arrange(request));
      expect(error2.code).toBe("stale-locator");
    });

    it("refuses unproven when the panel attribution is not owned", async () => {
      const state = fakeState();
      const ops = fakeOps(state, xmlDir);
      const foreign: WorkspaceSurfaceOps = {
        ...ops,
        resolvePanel: () =>
          panelTarget({ attribution: "foreign" }),
      };
      const c = new WorkspaceController({
        pid: PID,
        ops: foreign,
        authorizeMutation: ALLOW_ALL,
        poll: FAST_POLL,
        sleep: () => Promise.resolve(),
      });
      const error = await workspaceErrorOf(() => c.arrange(request));
      expect(error.code).toBe("unproven");
      expect(state.drags).toHaveLength(0);
    });
  });

  describe("verifyRestore", () => {
    it("verifies a restored workspace by name, frames and XML records", () => {
      const state = fakeState();
      const c = controller(state);
      const before = c.observe();
      // Simulate switch away and back: frames leave and return.
      state.checked = "Motion";
      state.windows = state.windows.map((w) =>
        w.title === "My Plugin Panel" ? { ...w, frame: { ...MOVED_FRAME } } : w,
      );
      state.panelFrames.set("My Plugin Panel", { ...MOVED_FRAME });
      state.checked = "Standard";
      state.windows = state.windows.map((w) =>
        w.title === "My Plugin Panel" ? { ...w, frame: { ...PANEL_FRAME } } : w,
      );
      state.panelFrames.set("My Plugin Panel", { ...PANEL_FRAME });
      const report = c.verifyRestore(before);
      expect(report.verdict).toBe("restored");
      expect(report.activeNameMatches).toBe(true);
      expect(report.framesRestored).toBe(true);
      expect(report.xml?.unchanged).toBe(report.xml?.checked);
    });

    it("reports mismatch when a panel frame did not come back", () => {
      const state = fakeState();
      const c = controller(state);
      const before = c.observe();
      state.windows = state.windows.map((w) =>
        w.title === "My Plugin Panel" ? { ...w, frame: { ...MOVED_FRAME } } : w,
      );
      const report = c.verifyRestore(before);
      expect(report.verdict).toBe("mismatch");
      expect(report.framesRestored).toBe(false);
      expect(report.frames.mismatches.length).toBeGreaterThan(0);
    });

    it("reports unknown rather than guessing when identity is unreadable", () => {
      const state = fakeState({ checked: null });
      const c = controller(state);
      const before = c.observe();
      const report = c.verifyRestore(before);
      expect(report.activeNameMatches).toBeNull();
      expect(report.verdict).toBe("unknown");
    });
  });

  describe("capabilities and target attestation", () => {
    it("reports honest capability levels", () => {
      const caps = workspaceCapabilities("darwin");
      expect(caps.observe.support).toBe("implemented");
      expect(caps.observe.verification).toBe("automated test");
      expect(caps.switchWorkspace.support).toBe("unavailable");
      expect(caps.arrange.support).toBe("unsupported"); // no drag vehicle yet
      expect(caps.verifyRestore.support).toBe("implemented");
      const win = workspaceCapabilities("win32");
      expect(win.observe.support).toBe("unsupported");
    });

    it("refuses construction without an owned target", () => {
      expect(() => workspaceForTarget(null)).toThrowError(WorkspaceError);
      try {
        workspaceForTarget(null);
      } catch (error) {
        expect((error as WorkspaceError).code).toBe("unavailable");
      }
    });
  });
});
