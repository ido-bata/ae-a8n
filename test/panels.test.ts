/**
 * Panel interaction contract tests (#343,
 * `specs/panel-interaction/spec.md`).
 *
 * Everything here runs against `PanelSurfaceOps` fakes and fixture
 * `GuiAppState`/census data: this proves the contract — resolution,
 * attribution gates, requested-vs-observed readback, artifact honesty,
 * and every refusal path — at `automated test` level. It does NOT prove a
 * real After Effects resizes or captures a panel; that stays unverified
 * until a real-host run records it (T002).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PanelController, type PanelSurfaceOps } from "../src/panels/controller.js";
import { resolvePanelTarget } from "../src/panels/resolve.js";
import { PanelError } from "../src/panels/types.js";
import {
  GuiMutationError,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { encodePng } from "../src/testing/index.js";
import { panelCapabilities, panelForTarget } from "../src/api/panels.js";
import { panelMutationGate } from "../src/panels/gate.js";
import { AfterEffects } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

const PID = 4242;
const SESSION = { uid: 502, username: "ae-test", asid: 100022, kind: "Aqua" as const };

const PANEL_FRAME: GuiFrame = { x: 100, y: 200, width: 640, height: 504 };

function axWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "My Plugin Panel",
    role: "AXLayoutArea",
    subrole: "AXFloatingWindow",
    buttons: [],
    texts: [],
    frame: { ...PANEL_FRAME },
    censusAttribution: "owned",
    ...over,
  };
}

function censusWindow(over: Partial<WindowServerWindow> = {}): WindowServerWindow {
  return {
    pid: PID,
    owner: "After Effects",
    layer: 0,
    onScreen: true,
    name: "",
    windowNumber: 777,
    bounds: { ...PANEL_FRAME },
    ...over,
  };
}

function appState(windows: readonly GuiWindowInfo[], over: Partial<GuiAppState> = {}): GuiAppState {
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
    ...over,
  };
}

/** A mutable fake surface: resizePanel actually changes the fake frame. */
function fakeOps(over: Partial<PanelSurfaceOps> = {}) {
  const state = {
    frame: { ...PANEL_FRAME },
    window: axWindow(),
    census: [censusWindow()] as WindowServerWindow[],
    resizes: [] as { width: number; height: number }[],
    captures: [] as { kind: "region" | "window"; path: string }[],
    readbackValue: null as { width: number; height: number } | null,
  };
  const ops: PanelSurfaceOps = {
    observe: () => appState([state.window], {
      windowServer: {
        available: true,
        reason: null,
        windowCount: 1,
        onScreenCount: 1,
      },
    }),
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: state.census,
    }),
    resizePanel: (_expected, size) => {
      state.resizes.push({ ...size });
      state.frame = { ...state.frame, width: size.width, height: size.height };
      state.window = { ...state.window, frame: { ...state.frame } };
      state.census = state.census.map((w) => ({
        ...w,
        bounds: { ...state.frame },
      }));
      return true;
    },
    captureRegion: (path) => {
      state.captures.push({ kind: "region", path });
      writeFileSync(path, encodePng(1280, 1008, () => [10, 20, 30]));
    },
    captureWindow: (path) => {
      state.captures.push({ kind: "window", path });
      // 2x backing scale of whatever frame the panel currently has.
      writeFileSync(
        path,
        encodePng(state.frame.width * 2, state.frame.height * 2, () => [200, 100, 50]),
      );
    },
    readback: () => state.readbackValue,
    ...over,
  };
  return { ops, state };
}

const ALLOW_ALL = { allowed: true as const };
const DENY = { allowed: false as const, reason: "test gate" };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a8n-panels-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function controller(ops: PanelSurfaceOps, over: Record<string, unknown> = {}) {
  return new PanelController({
    pid: PID,
    locator: { title: "My Plugin Panel" },
    ops,
    artifactDir: dir,
    authorizeMutation: () => ALLOW_ALL,
    settleMs: 0,
    sleep: () => Promise.resolve(),
    newOperationId: (() => {
      let n = 0;
      return () => `op-${++n}`;
    })(),
    ...over,
  });
}

describe("resolvePanelTarget", () => {
  it("resolves a titled window to an owned panel target", () => {
    const { target } = resolvePanelTarget({
      pid: PID,
      state: appState([axWindow()]),
      census: [censusWindow()],
      locator: { title: "My Plugin Panel" },
      now: () => new Date("2026-11-26T00:00:00Z"),
    });
    expect(target.pid).toBe(PID);
    expect(target.surface.kind).toBe("window");
    expect(target.surface.attribution).toBe("owned");
    expect(target.surface.windowNumber).toBe(777);
    expect(target.surface.state.onScreen).toBe(true);
    expect(target.surface.frame).toEqual(PANEL_FRAME);
    expect(target.resolvedAt).toBe("2026-11-26T00:00:00.000Z");
  });

  it("refuses ambiguous locators and names the candidates", () => {
    const other = axWindow({ title: "My Plugin Panel", frame: { x: 0, y: 0, width: 300, height: 200 } });
    try {
      resolvePanelTarget({
        pid: PID,
        state: appState([axWindow(), other]),
        census: [censusWindow()],
        locator: { title: "My Plugin Panel" },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PanelError);
      const panel = error as PanelError;
      expect(panel.code).toBe("ambiguous");
      expect(panel.candidates.length).toBe(2);
    }
  });

  it("reports not-found with the observed window count", () => {
    try {
      resolvePanelTarget({
        pid: PID,
        state: appState([axWindow()]),
        census: [censusWindow()],
        locator: { title: "No Such Panel" },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PanelError).code).toBe("not-found");
      expect((error as Error).message).toContain("1 window(s) observed");
    }
  });

  it("refuses a windowNumber that belongs to another pid", () => {
    try {
      resolvePanelTarget({
        pid: PID,
        state: appState([axWindow()]),
        census: [censusWindow({ pid: 9999, owner: "Other AE" })],
        locator: { windowNumber: 777 },
      });
      expect.unreachable();
    } catch (error) {
      const panel = error as PanelError;
      expect(panel.code).toBe("unproven");
      expect(panel.message).toContain("pid 9999");
    }
  });

  it("reports the AX-invisible shape: census window with no AX account", () => {
    // A window the census sees but no AX frame matches is the docked /
    // AX-invisible case — reported, never guessed (#321 shape).
    try {
      resolvePanelTarget({
        pid: PID,
        state: appState([]),
        census: [censusWindow()],
        locator: { windowNumber: 777 },
      });
      expect.unreachable();
    } catch (error) {
      const panel = error as PanelError;
      expect(panel.code).toBe("not-found");
      expect(panel.message).toContain("no Accessibility");
    }
  });

  it("degrades to unproven attribution when the census cannot run", () => {
    const { censusAttribution: _drop, ...unattributed } = axWindow();
    const { target } = resolvePanelTarget({
      pid: PID,
      state: appState([unattributed]),
      census: [],
      locator: { title: "My Plugin Panel" },
    });
    expect(target.surface.attribution).toBe("unproven");
    expect(target.surface.windowNumber).toBeNull();
    expect(target.surface.state.onScreen).toBeNull();
  });

  it("excludes frameless windows from panel candidacy", () => {
    const frameless = axWindow({ frame: null });
    try {
      resolvePanelTarget({
        pid: PID,
        state: appState([frameless]),
        census: [],
        locator: { title: "My Plugin Panel" },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PanelError).code).toBe("not-found");
    }
  });
});

describe("PanelController slice", () => {
  it("runs identify → resize → measure → capture → restore end to end", async () => {
    const { ops, state } = fakeOps();
    const ctl = controller(ops);

    const identified = ctl.identify();
    expect(identified.surface.attribution).toBe("owned");
    expect(state.resizes).toHaveLength(0);

    const measured = await ctl.resize({ width: 800, height: 600 });
    expect(state.resizes).toEqual([{ width: 800, height: 600 }]);
    expect(measured.frame.width).toBe(800);
    expect(measured.frame.height).toBe(600);
    expect(measured.matchesRequested).toBe(true);

    const capture = ctl.capture();
    expect(capture.kind).toBe("original");
    expect(capture.operationId).toBe("op-1");
    expect(state.captures).toEqual([{ kind: "window", path: capture.original.path }]);
    expect(capture.geometry.leakage).toBe("region");
    expect(capture.original.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The panel was resized to 800x600 pt; the fake wrote 1600x1200 px.
    expect(capture.original.pixelSize).toEqual({ width: 1600, height: 1200 });
    expect(capture.geometry.backingScale).toBe(2);
    expect(capture.derived).toBeNull();

    const restored = await ctl.restore();
    expect(state.resizes[1]).toEqual({ width: 640, height: 504 });
    expect(restored.frame.width).toBe(640);
    expect(restored.frame.height).toBe(504);
  });

  it("falls back to region capture when no window number exists", () => {
    // The census ran (so attribution stays "owned") but the matched row
    // carries no window number: capture must degrade to the frame region,
    // never guess a window id.
    const { ops, state } = fakeOps({
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ windowNumber: null })],
      }),
    });
    const ctl = controller(ops);
    const capture = ctl.capture();
    expect(state.captures).toEqual([{ kind: "region", path: capture.original.path }]);
    expect(capture.geometry.backingScale).toBe(2); // 1280x1008 px / 640x504 pt
  });

  it("refuses capture when the census cannot attribute the surface", () => {
    // Census unavailable at listing time → no censusAttribution on the AX
    // window and no census rows: attribution resolves "unproven" and a
    // capture could photograph another instance's window.
    const { ops } = fakeOps({
      observe: () => {
        const { censusAttribution: _drop, ...unattributed } = axWindow();
        return appState([unattributed]);
      },
      censusWindows: () => ({ available: false, reason: "no census", windows: [] }),
    });
    const ctl = controller(ops);
    expect(() => ctl.capture()).toThrowError(
      expect.objectContaining({ code: "unproven" }) as Error,
    );
  });

  it("captures by region when the surface is not proven on-screen", () => {
    const { ops, state } = fakeOps({
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ windowNumber: null, onScreen: false })],
      }),
    });
    const ctl = controller(ops);
    const capture = ctl.capture();
    expect(state.captures[0]?.kind).toBe("region");
    expect(capture.geometry.backingScale).toBe(2); // 1280x1008 px / 640x504 pt
  });

  it("refuses mutation without a gate (fail-closed default)", async () => {
    const { ops } = fakeOps();
    const ctl = controller(ops, { authorizeMutation: undefined });
    await expect(ctl.resize({ width: 100, height: 100 })).rejects.toMatchObject({
      code: "refused",
    });
    await expect(ctl.restore()).rejects.toMatchObject({ code: "refused" });
  });

  it("honours a denying gate before any observation", async () => {
    const { ops, state } = fakeOps();
    let observed = 0;
    const wrapped: PanelSurfaceOps = {
      ...ops,
      observe: () => {
        observed += 1;
        return ops.observe();
      },
    };
    const ctl = controller(wrapped, { authorizeMutation: () => DENY });
    await expect(ctl.resize({ width: 1, height: 1 })).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("test gate") as unknown as string,
    });
    expect(observed).toBe(0);
    expect(state.resizes).toHaveLength(0);
  });

  it("refuses resize and capture on non-owned attribution", async () => {
    // foreign / unmatched / unproven are all non-mutation evidence: the
    // post-flip contract must keep refusing every one of them (#358).
    // "unproven" is the absent-attribution + unavailable-census shape.
    const cases: { name: string; window: GuiWindowInfo; census: WindowServerWindow[] }[] = [
      {
        name: "foreign",
        window: axWindow({ censusAttribution: "foreign" }),
        census: [censusWindow()],
      },
      {
        name: "unmatched",
        window: axWindow({ censusAttribution: "unmatched" }),
        census: [censusWindow()],
      },
      {
        name: "unproven",
        window: (() => {
          const { censusAttribution: _drop, ...rest } = axWindow();
          return rest;
        })(),
        census: [],
      },
    ];
    for (const { window, census } of cases) {
      const { ops, state } = fakeOps({
        observe: () => appState([window]),
        censusWindows: () => ({ available: true, reason: null, windows: census }),
      });
      const ctl = controller(ops);
      await expect(ctl.resize({ width: 10, height: 10 })).rejects.toMatchObject({
        code: "unproven",
      });
      await expect(ctl.restore()).rejects.toMatchObject({ code: "unproven" });
      expect(() => ctl.capture()).toThrowError(
        expect.objectContaining({ code: "unproven" }) as Error,
      );
      expect(state.resizes).toHaveLength(0);
      expect(state.captures).toHaveLength(0);
    }
  });

  it("reports a stale handle as refused, not resized", async () => {
    // The window moves between resolution and the platform mutation:
    // resizePanel returns false (its in-session identity check refused).
    const { ops, state } = fakeOps({
      resizePanel: () => false,
    });
    const ctl = controller(ops);
    await expect(ctl.resize({ width: 10, height: 10 })).rejects.toMatchObject({
      code: "refused",
    });
    expect(state.resizes).toHaveLength(0);
  });

  it("reports an unknown mutation outcome as indeterminate, never a clean refusal", async () => {
    // GuiMutationError means the platform mutation may have partially
    // applied: the caller must re-observe, and the code says so.
    const { ops } = fakeOps({
      resizePanel: () => {
        throw new GuiMutationError("the resizePanelWindow mutation was attempted but its result is unknown");
      },
    });
    const ctl = controller(ops);
    await expect(ctl.resize({ width: 10, height: 10 })).rejects.toMatchObject({
      code: "indeterminate",
    });
  });

  it("maps a pre-mutation ops failure to unavailable, keeping the driver message", async () => {
    const { ops } = fakeOps({
      resizePanel: () => {
        throw new Error("session command died mid-mutation");
      },
    });
    const ctl = controller(ops);
    await expect(ctl.resize({ width: 10, height: 10 })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("session command died") as unknown as string,
    });
  });

  it("maps an observation failure to unavailable PanelError", () => {
    const { ops } = fakeOps({
      observe: () => {
        throw new Error("the accessibility query failed");
      },
    });
    const ctl = controller(ops);
    expect(() => ctl.identify()).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
    expect(() => ctl.measure()).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("treats a throwing census as unavailable attribution, not a crash", () => {
    const { ops, state } = fakeOps({
      censusWindows: () => {
        throw new Error("census pipe broke");
      },
    });
    const ctl = controller(ops);
    // The AX listing still carries its own "owned" attribution, so the
    // surface resolves; only the window-number/on-screen enrichment is
    // lost — capture degrades to the region vehicle.
    const capture = ctl.capture();
    expect(state.captures[0]?.kind).toBe("region");
    expect(capture.target.surface.attribution).toBe("owned");
  });

  it("reports an uncapturable surface as unavailable PanelError, never an empty artifact", () => {
    // Permission denied / screencapture failure at the platform layer:
    // the ops throw, the file never lands, and the caller gets a coded
    // refusal — not a zero-byte "capture".
    const { ops } = fakeOps({
      captureWindow: () => {
        throw new Error("screencapture exited 1: could not create image");
      },
    });
    const ctl = controller(ops);
    expect(() => ctl.capture()).toThrowError(
      expect.objectContaining({
        code: "unavailable",
        message: expect.stringContaining("could not create image") as unknown as string,
      }) as Error,
    );
  });

  it("reports a capture that exits zero but writes nothing as unavailable", () => {
    const { ops } = fakeOps({
      captureWindow: () => {
        // screencapture "succeeded" but produced no file (TCC denial can
        // look like this on some macOS versions).
      },
    });
    const ctl = controller(ops);
    expect(() => ctl.capture()).toThrowError(
      expect.objectContaining({ code: "unavailable" }) as Error,
    );
  });

  it("keeps occlusion honestly unknown and leakage scoped to the region", () => {
    const { ops } = fakeOps();
    const ctl = controller(ops);
    const capture = ctl.capture();
    // Neither CGWindowList nor the AX frame proves what covers the
    // surface — guessing would make the artifact claim more than it shows.
    expect(capture.geometry.occlusion).toBe("unknown");
    expect(capture.geometry.leakage).toBe("region");
    expect(capture.geometry.coordinateSpace).toBe("points-top-left");
  });

  it("refuses capture when the resolved surface is no longer owned at capture time", () => {
    // Stale-handle negative: the locator still matches by title, but the
    // window's attribution flipped to foreign between identify and
    // capture — the fresh resolution must refuse, not photograph it.
    let attribution: "owned" | "foreign" = "owned";
    const { ops } = fakeOps({
      observe: () => appState([axWindow({ censusAttribution: attribution })]),
    });
    const ctl = controller(ops);
    ctl.identify();
    attribution = "foreign";
    expect(() => ctl.capture()).toThrowError(
      expect.objectContaining({ code: "unproven" }) as Error,
    );
  });

  it("reports matchesRequested false when the OS disagrees with the request", async () => {
    // The platform claims RESIZED but the next observation shows the old
    // size — AE clamped it. The measurement says so; nothing is rounded.
    const { ops } = fakeOps({
      resizePanel: () => true, // reports success but does not move the frame
    });
    const ctl = controller(ops);
    const measured = await ctl.resize({ width: 800, height: 600 });
    expect(measured.frame.width).toBe(640);
    expect(measured.matchesRequested).toBe(false);
  });

  it("reports readback honestly: in-ae, os-only and unavailable", async () => {
    const withReadback = fakeOps();
    withReadback.state.readbackValue = { width: 800, height: 600 };
    const ctlA = controller(withReadback.ops);
    const m1 = await ctlA.resize({ width: 800, height: 600 });
    expect(m1.readback).toEqual({ width: 800, height: 600 });
    expect(m1.readbackSource).toBe("in-ae");

    const noReadback = fakeOps();
    // Absent readback reports "os-only"; an explicit undefined is not a
    // valid PanelSurfaceOps member under exactOptionalPropertyTypes.
    delete (noReadback.ops as { readback?: unknown }).readback;
    const ctlB = controller(noReadback.ops);
    const m2 = ctlB.measure();
    expect(m2.readback).toBeNull();
    expect(m2.readbackSource).toBe("os-only");

    const failing = fakeOps({
      readback: () => {
        throw new Error("no script channel");
      },
    });
    const ctlC = controller(failing.ops);
    const m3 = ctlC.measure();
    expect(m3.readbackSource).toBe("unavailable");
  });

  it("keeps backingScale null when pixels are not an exact multiple", () => {
    const { ops } = fakeOps({
      captureRegion: (path) => writeFileSync(path, encodePng(1000, 800, () => [0, 0, 0])),
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ windowNumber: null, onScreen: false })],
      }),
    });
    const ctl = controller(ops);
    const capture = ctl.capture();
    expect(capture.geometry.backingScale).toBeNull();
    expect(capture.original.pixelSize).toEqual({ width: 1000, height: 800 });
  });
});

describe("panelForTarget / public surface", () => {
  it("panelCapabilities reports the honest per-OS matrix", () => {
    const darwin = panelCapabilities("darwin");
    expect(darwin.platform).toBe("darwin");
    // #358: the A-SAFETY class decision cleared panel resize/restore on
    // the direct-AX vehicle; the capability reports it honestly.
    expect(darwin.resize.support).toBe("implemented");
    expect(darwin.resize.verification).toBe("verified on real host");
    // #445: restore rides the same gate-permitted class and is
    // advertised with the same evidence level — no capability gap.
    expect(darwin.restore.support).toBe("implemented");
    expect(darwin.restore.verification).toBe("verified on real host");
    // #361: the docked-region observe walk exists on macOS; mutation of a
    // docked region stays unsupported because it is not a window.
    expect(darwin.dockedRegion.support).toBe("partial");
    expect(darwin.inAeReadback.support).toBe("unsupported");
    for (const cap of Object.values(darwin)) {
      if (typeof cap === "object" && cap !== null && "verification" in cap) {
        expect(["implemented", "automated test", "fake/mock only", "verified on real host"])
          .toContain((cap as { verification: string }).verification);
      }
    }

    const win = panelCapabilities("win32");
    expect(win.platform).toBe("win32");
    expect(win.identify.support).toBe("unsupported");
    expect(win.resize.support).toBe("unsupported");
    expect(win.restore.support).toBe("unsupported");
  });

  it("refuses panel() when no owned target is attested", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-panel-api-"));
    try {
      const transport = new FakeAfterEffectsTransport();
      const ae = await AfterEffects.launch({ transport, sessionRoot: root });
      expect(() => ae.panel({ title: "x" })).toThrowError(
        expect.objectContaining({ code: "unavailable" }) as Error,
      );
      await ae.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("panelMutationGate permits the #358-cleared resize/restore class", () => {
    // Platform-neutral: the gate is policy, not platform code. The #358
    // A-SAFETY decision cleared exactly resize/restore on the
    // direct-AX vehicle; anything outside that class still refuses.
    const gate = panelMutationGate();
    for (const op of ["resize", "restore"] as const) {
      expect(gate(op).allowed).toBe(true);
    }
    const unknown = gate("move" as never);
    expect(unknown.allowed).toBe(false);
    if (!unknown.allowed) {
      expect(unknown.reason).toContain("gui-supervision-safety-gates");
    }
  });

  // `panelForTarget` is macOS-only by contract: on any other platform it
  // reports `unsupported` before a controller exists, so the wiring tests
  // below can only run where the path exists.
  const PANEL_STATE = (width: number, height: number) =>
    JSON.stringify({
      pid: PID,
      frontmostPid: PID,
      focusedWindowIndex: 1,
      windows: [
        {
          index: 1,
          title: "My Plugin Panel",
          role: "AXLayoutArea",
          subrole: "AXFloatingWindow",
          frame: { x: 100, y: 200, width, height },
          miniaturized: false,
          main: false,
          focused: true,
        },
      ],
      focusedWindow: null,
      axTrusted: true,
    });
  const CENSUS_LINE = (width: number, height: number) =>
    `4242|After Effects|0|1|My Plugin Panel|100|200|${width}|${height}|777\n`;

  it.runIf(process.platform === "darwin")(
    "wires the production path: identify → resize → measure → restore through the window-ops vehicle",
    async () => {
      // The production gate now permits the #358-cleared class, so this
      // exercises the REAL wiring: window-ops `state` observation →
      // census attribution → lease/audit → `act --op resize` →
      // post-resolve measure. Only the session exec and census are
      // stubbed; every gate, resolver and verdict mapping is production.
      let size = { width: 640, height: 504 };
      const acts: string[][] = [];
      const runSession = (_s: unknown, program: unknown, args: readonly string[]) => {
        const p = String(program);
        if (p.endsWith("/window-ops") && args[0] === "state") {
          return {
            status: 0,
            stdout: PANEL_STATE(size.width, size.height),
            stderr: "",
            timedOut: false,
          };
        }
        if (p.endsWith("/window-ops") && args[0] === "act") {
          acts.push([...args]);
          const w = Number(args[args.indexOf("--width") + 1]);
          const h = Number(args[args.indexOf("--height") + 1]);
          size = { width: w, height: h };
          return {
            status: 0,
            stdout: JSON.stringify({
              verdict: "performed",
              window: {
                index: 1,
                title: "My Plugin Panel",
                role: "AXLayoutArea",
                subrole: "AXFloatingWindow",
                frame: { x: 100, y: 200, width: w, height: h },
                miniaturized: false,
                main: false,
                focused: true,
              },
            }),
            stderr: "",
            timedOut: false,
          };
        }
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      };
      const panel = panelForTarget(
        { pid: PID, session: SESSION },
        { title: "My Plugin Panel" },
        dir,
        {
          helpersDir: "/fake-helpers",
          runSession,
          censusRun: () => CENSUS_LINE(size.width, size.height),
          readTargetSession: () => SESSION,
          lease: {
            acquire: () => ({ path: "/fake/lease", release: () => {} }),
            audit: () => {},
          },
        },
      );

      const identified = await panel.identify();
      expect(identified.surface.attribution).toBe("owned");
      expect(identified.surface.windowNumber).toBe(777);
      expect(identified.surface.frame).toMatchObject({ width: 640, height: 504 });

      const resized = await panel.resize({ width: 800, height: 600 });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toContain("act");
      expect(acts[0]).toContain("resize");
      expect(resized.frame).toMatchObject({ width: 800, height: 600 });
      expect(resized.matchesRequested).toBe(true);

      const restored = await panel.restore();
      expect(acts).toHaveLength(2);
      expect(restored.frame).toMatchObject({ width: 640, height: 504 });
    },
  );

  it.runIf(process.platform === "darwin")(
    "reports unavailable honestly when the window-ops helpers cannot run",
    async () => {
      // helpersDir points nowhere and the session stub answers empty:
      // observation fails as `unavailable`, never as a guessed window.
      const panel = panelForTarget(
        { pid: PID, session: SESSION },
        { title: "My Plugin Panel" },
        dir,
        {
          helpersDir: "/definitely/not/here",
          runSession: () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
          readTargetSession: () => SESSION,
        },
      );
      await expect(panel.identify()).rejects.toMatchObject({ code: "unavailable" });
      await expect(panel.resize({ width: 1, height: 1 })).rejects.toMatchObject({
        code: "unavailable",
      });
    },
  );

  it.runIf(process.platform !== "darwin")(
    "reports unsupported on non-macOS platforms even with an attested target",
    () => {
      expect(() =>
        panelForTarget({ pid: PID, session: SESSION }, { title: "x" }, dir),
      ).toThrowError(expect.objectContaining({ code: "unsupported" }) as Error);
    },
  );
});
