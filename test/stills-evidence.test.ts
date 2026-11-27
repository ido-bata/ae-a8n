/**
 * Stills → evidence binding tests (#380, `specs/gui-evidence/spec.md`
 * §5.1, §5.3 rule 1, §6.3 T1).
 *
 * Everything here runs against `PanelSurfaceOps` fakes that write real
 * PNG files into a temp artifacts dir, plus a real `TraceRecorder`:
 * this proves the contract — a successful `panel.capture` becomes a
 * `screen-still` `EvidenceArtifact` in `evidence-index.json`, the
 * operation row and trace row correlate through `evidenceId`, and every
 * refusal/failure lands as an honest gap — at `automated test` level.
 * It does NOT prove a real After Effects window was photographed; that
 * stays unverified until a real-host run records it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PanelController, type PanelSurfaceOps } from "../src/panels/controller.js";
import { Panel } from "../src/api/panels.js";
import type { StillEvidenceContext } from "../src/evidence/stills.js";
import { PanelError } from "../src/panels/types.js";
import {
  GuiMutationError,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import { encodePng } from "../src/testing/index.js";
import { GuiEvidenceIndex } from "../src/evidence/index.js";
import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";

const PID = 4242;
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

/** Fake capture surface: writes a deterministic PNG per vehicle. */
function fakeOps(over: Partial<PanelSurfaceOps> = {}) {
  const state = {
    window: axWindow(),
    census: [censusWindow()] as WindowServerWindow[],
    captures: [] as { kind: "region" | "window"; path: string }[],
    captureError: null as Error | null,
  };
  const ops: PanelSurfaceOps = {
    observe: () => appState([state.window]),
    censusWindows: () => ({
      available: true,
      reason: null,
      windows: state.census,
    }),
    resizePanel: () => {
      throw new GuiMutationError("resize is not exercised here");
    },
    captureRegion: (path) => {
      state.captures.push({ kind: "region", path });
      if (state.captureError !== null) {
        throw state.captureError;
      }
      writeFileSync(path, encodePng(1280, 1008, () => [10, 20, 30]));
    },
    captureWindow: (path) => {
      state.captures.push({ kind: "window", path });
      if (state.captureError !== null) {
        throw state.captureError;
      }
      // 2x backing scale of the panel frame, like the panels fake.
      writeFileSync(
        path,
        encodePng(state.window.frame!.width * 2, state.window.frame!.height * 2, () => [
          200, 100, 50,
        ]),
      );
    },
    ...over,
  };
  return { ops, state };
}

let root: string;
let artifactsDir: string;
let trace: TraceRecorder;
let traceEvents: TraceEvent[];
let requestSeq: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-stills-evidence-"));
  artifactsDir = join(root, "artifacts");
  traceEvents = [];
  trace = new TraceRecorder();
  trace.subscribe((event) => traceEvents.push(event));
  requestSeq = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function evidenceContext(over: Partial<StillEvidenceContext> = {}): StillEvidenceContext {
  return {
    artifactsDir,
    session: {
      sessionRoot: root,
      adapter: "fake-transport",
      pid: PID,
      processStartIdentity: "startedAt=1700000000000",
      sessionId: "session-under-test",
      sessionKind: "isolated",
    },
    trace,
    now: () => new Date("2026-02-01T12:00:00.000Z"),
    monoNow: () => 1234.5,
    newRequestId: () => `req-${++requestSeq}`,
    ...over,
  };
}

function panelWith(ops: PanelSurfaceOps, over: Record<string, unknown> = {}) {
  const controller = new PanelController({
    pid: PID,
    locator: { title: "My Plugin Panel" },
    ops,
    artifactDir: artifactsDir,
    settleMs: 0,
    sleep: () => Promise.resolve(),
    newOperationId: (() => {
      let n = 0;
      return () => `op-${++n}`;
    })(),
    ...over,
  });
  return new Panel(controller, evidenceContext());
}

function loadIndex() {
  const index = GuiEvidenceIndex.load(artifactsDir);
  expect(index).not.toBeNull();
  return index!;
}

describe("panel.capture stills binding (#380)", () => {
  it("records a screen-still artifact and correlates trace → evidenceId", async () => {
    const { ops, state } = fakeOps();
    const panel = panelWith(ops);

    const capture = await panel.capture();

    // The capture itself still reports the panel-level operation id.
    expect(capture.operationId).toBe("op-1");
    expect(capture.vehicle).toBe("window");
    expect(state.captures).toEqual([{ kind: "window", path: capture.original.path }]);

    const index = loadIndex();
    const doc = index.document;
    const stills = doc.artifacts.filter((a) => a.kind === "screen-still");
    expect(stills).toHaveLength(1);
    const artifact = stills[0]!;
    expect(artifact.id).toBe(`still-${capture.operationId}`);
    expect(artifact.role).toBe("original");
    expect(artifact.path).toBe(`panels/${capture.operationId}.png`);
    expect(artifact.sha256).toBe(
      createHash("sha256").update(readFileSync(capture.original.path)).digest("hex"),
    );
    expect(artifact.bytes).toBe(capture.original.bytes);
    expect(existsSync(join(artifactsDir, artifact.path))).toBe(true);

    // Scope: the window vehicle was used, so the artifact claims window scope.
    expect(artifact.scope).toEqual({ kind: "window", window: capture.target });
    expect(artifact.leakage).toBe("region");
    expect(artifact.geometry?.widthPx).toBe(1280);
    expect(artifact.geometry?.heightPx).toBe(1008);
    expect(artifact.geometry?.backingScale).toBe(2);
    expect(artifact.time.capturedAt).toBe(capture.capturedAt);
    expect(artifact.time.durationMs).toBeNull();
    expect(artifact.provenance).toEqual({ producer: "os-capture", tool: "screencapture" });
    expect(artifact.operationIds).toContain("req-1");
    expect(artifact.operationIds).toContain(capture.operationId);

    // The operation row links the requestId to the artifact.
    const operation = doc.operations.find((o) => o.requestId === "req-1");
    expect(operation).toBeDefined();
    expect(operation!.op).toBe("panel.capture");
    expect(operation!.coverage).toBe("screen");
    expect(operation!.evidenceRefs).toContain(artifact.id);

    // The trace row carries result.evidenceId — trace → artifact walk.
    const row = traceEvents.find((e) => e.op === "panel.capture");
    expect(row).toBeDefined();
    expect(row!.status).toBe("ok");
    expect(row!.result?.evidenceId).toBe(artifact.id);
    expect(doc.gaps.uncapturable).toHaveLength(0);
  });

  it("records a region-scoped artifact when the window vehicle is unavailable", async () => {
    const { ops, state } = fakeOps({
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ windowNumber: null })],
      }),
    });
    // A null windowNumber on the census row flows into the resolved
    // surface, so the controller falls back to the region vehicle.
    const panel = panelWith(ops);
    const capture = await panel.capture();
    expect(capture.vehicle).toBe("region");
    expect(state.captures[0]!.kind).toBe("region");

    const artifact = loadIndex().document.artifacts.find(
      (a) => a.kind === "screen-still",
    )!;
    expect(artifact.scope?.kind).toBe("region");
    if (artifact.scope?.kind === "region") {
      expect(artifact.scope.frame).toEqual(capture.target.surface.frame);
      expect(artifact.scope.parent?.pid).toBe(PID);
    }
  });

  it("refuses a foreign/unproven surface and records the gap, never a fake artifact", async () => {
    const { ops, state } = fakeOps({
      observe: () =>
        appState([axWindow({ censusAttribution: "foreign" })]),
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ pid: 9999 })],
      }),
    });
    const panel = panelWith(ops);

    await expect(panel.capture()).rejects.toBeInstanceOf(PanelError);
    expect(state.captures).toHaveLength(0);

    const doc = loadIndex().document;
    expect(doc.artifacts.filter((a) => a.kind === "screen-still")).toHaveLength(0);
    expect(doc.gaps.uncapturable.length).toBeGreaterThan(0);
    expect(doc.gaps.uncapturable[0]).toContain("panel.capture");

    const operation = doc.operations.find((o) => o.requestId === "req-1");
    expect(operation).toBeDefined();
    expect(operation!.coverage).toBe("none");
    expect(operation!.uncovered).toBeDefined();

    const row = traceEvents.find((e) => e.op === "panel.capture");
    expect(row!.status).toBe("error");
    expect(row!.result?.evidenceId).toBeUndefined();
  });

  it("records a capture vehicle failure as uncapturable, not as success", async () => {
    const { ops, state } = fakeOps();
    state.captureError = new Error("screencapture exited 1 (TCC denial)");
    const panel = panelWith(ops);

    await expect(panel.capture()).rejects.toThrow(/screencapture exited 1/);

    const doc = loadIndex().document;
    expect(doc.artifacts.filter((a) => a.kind === "screen-still")).toHaveLength(0);
    expect(doc.gaps.uncapturable.some((g) => g.includes("TCC denial"))).toBe(true);
    const operation = doc.operations.find((o) => o.requestId === "req-1");
    expect(operation!.coverage).toBe("none");
  });

  it("deduplicates identical captures by sha256 and unions operation ids", async () => {
    // Both vehicles write deterministic PNGs; force two region captures of
    // the same frame so the bytes — and sha256 — are identical.
    const { ops } = fakeOps({
      censusWindows: () => ({
        available: true,
        reason: null,
        windows: [censusWindow({ windowNumber: null })],
      }),
    });
    const controller = new PanelController({
      pid: PID,
      locator: { title: "My Plugin Panel" },
      ops,
      artifactDir: artifactsDir,
      settleMs: 0,
      sleep: () => Promise.resolve(),
      newOperationId: (() => {
        let n = 0;
        return () => `op-${++n}`;
      })(),
    });
    const panel = new Panel(controller, evidenceContext());

    await panel.capture();
    await panel.capture();

    const doc = loadIndex().document;
    const stills = doc.artifacts.filter((a) => a.kind === "screen-still");
    expect(stills).toHaveLength(1);
    // The first artifact id wins so the first trace row's evidenceId
    // still resolves; both captures' operation ids are bound.
    expect(stills[0]!.id).toBe("still-op-1");
    expect(stills[0]!.operationIds).toEqual(
      expect.arrayContaining(["req-1", "req-2", "op-1", "op-2"]),
    );
    // Both operation rows point at the same surviving artifact id.
    for (const requestId of ["req-1", "req-2"]) {
      const operation = doc.operations.find((o) => o.requestId === requestId);
      expect(operation!.evidenceRefs).toContain("still-op-1");
    }
    const rows = traceEvents.filter((e) => e.op === "panel.capture");
    expect(rows.map((r) => r.result?.evidenceId)).toEqual([
      "still-op-1",
      "still-op-1",
    ]);
  });

  it("keeps working when no evidence context is installed (panel without session)", async () => {
    const { ops } = fakeOps();
    const controller = new PanelController({
      pid: PID,
      locator: { title: "My Plugin Panel" },
      ops,
      artifactDir: artifactsDir,
      settleMs: 0,
      sleep: () => Promise.resolve(),
    });
    const panel = new Panel(controller);
    const capture = await panel.capture();
    expect(capture.kind).toBe("original");
    // No index was created — evidence binding is opt-in per session.
    expect(GuiEvidenceIndex.load(artifactsDir)).toBeNull();
  });
});
