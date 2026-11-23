/**
 * Read-only GUI observation (`ae.guiState()`, #109).
 *
 * Contract tests for the report shape and the classification mapping,
 * plus the unavailable paths. Everything runs against `GuiWindowInfo`
 * fixtures and the fake transport: this proves the report's honesty — an
 * unattested target or an unenterable session is `unavailable`, never an
 * empty window list — and that the verdict matches what `session.recover`
 * would decide. It does not prove a real After Effects shows the same
 * windows; real-host observation stays UNVERIFIED until a real-host run
 * records it (release-candidate aggregate gate, #99).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import {
  assessGuiWindows,
  classifyGuiWindow,
  guiStateReport,
  observeGuiAppState,
} from "../src/api/gui-state.js";
import { MacSessionError, type MacSession } from "../src/driver/mac-session.js";
import type { GuiAppState, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

const SESSION: MacSession = {
  uid: 502,
  username: "ae-test",
  asid: 100022,
  kind: "Aqua",
};

const TARGET = { pid: 4242, session: SESSION };

const OK_BUTTON = { title: "OK", description: "", position: null, size: null };

function window(partial: Partial<GuiWindowInfo> & { title: string }): GuiWindowInfo {
  return {
    role: "AXWindow",
    subrole: "AXStandardWindow",
    buttons: [],
    texts: [],
    ...partial,
  };
}

/** A blocking dialog window with the given static texts. */
function dialog(texts: readonly string[], over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return window({ title: "", subrole: "AXDialog", texts, ...over });
}

function state(windows: readonly GuiWindowInfo[], over: Partial<GuiAppState> = {}): GuiAppState {
  return {
    pid: TARGET.pid,
    frontmost: false,
    windows,
    windowServer: {
      available: true,
      reason: null,
      windowCount: windows.length,
      onScreenCount: windows.length,
    },
    axSuspect: false,
    ...over,
  };
}

describe("classifyGuiWindow", () => {
  it("reports a non-dialog window as not-blocking", () => {
    const w = window({ title: "Composition", role: "AXWindow", subrole: "AXStandardWindow" });
    expect(classifyGuiWindow(w)).toEqual({ kind: "not-blocking" });
  });

  it("reports the measured ae-a8n alert as pressable", () => {
    const w = dialog(["ae-a8n: the test raised this"], { buttons: [OK_BUTTON] });
    expect(classifyGuiWindow(w)).toEqual({
      kind: "pressable",
      dialogClass: "ae-a8n ui.alert",
    });
  });

  it("reports each measured unpressable class by name", () => {
    const cases: [string, GuiWindowInfo][] = [
      [
        "after-effects-crash-repair",
        dialog(["クラッシュ修復オプション", "レポートを送信しますか？"]),
      ],
      [
        "after-effects-startup-directory-warning",
        dialog(["AppDirs/Required Dir warning"]),
      ],
      [
        "after-effects-crash-recovery-project",
        dialog(["リカバリプロジェクト crash_123.aep"]),
      ],
      [
        "script-file-network-permission",
        dialog(["Allow Scripts to Write Files and Access Network"]),
      ],
    ];
    for (const [name, w] of cases) {
      const classified = classifyGuiWindow(w);
      expect(classified.kind, name).toBe("unpressable");
      if (classified.kind === "unpressable") {
        expect(classified.dialogClass).toBe(name);
        expect(classified.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("reports a sign-in window as human-only even when unclassed", () => {
    const w = dialog(["Adobe Creative Cloud にサインインしてください"]);
    const classified = classifyGuiWindow(w);
    expect(classified.kind).toBe("human-only");
  });

  it("reports a licence window as human-only", () => {
    const w = dialog(["Please activate your licence"]);
    expect(classifyGuiWindow(w).kind).toBe("human-only");
  });

  it("reports an unmeasured blocking window as unknown quarantine", () => {
    const w = dialog(["something nobody measured"]);
    expect(classifyGuiWindow(w)).toEqual({ kind: "unknown", code: "A8N-SEC-001" });
  });
});

describe("guiStateReport", () => {
  it("is unavailable when no owned target is attested", () => {
    const report = guiStateReport(null);
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.reason).toContain("no owned After Effects");
    }
  });

  it("maps a prepared observation into the public report", () => {
    const report = guiStateReport(TARGET, {
      observed: state([
        window({ title: "Main", subrole: "AXStandardWindow" }),
        dialog(["ae-a8n: hello"], { buttons: [OK_BUTTON] }),
      ]),
    });
    expect(report.status).toBe("observed");
    if (report.status !== "observed") {
      return;
    }
    expect(report.pid).toBe(TARGET.pid);
    expect(report.session).toMatchObject({ uid: 502, username: "ae-test", kind: "Aqua" });
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]).toMatchObject({ index: 1, blocking: false });
    expect(report.windows[0]?.classification).toEqual({ kind: "not-blocking" });
    expect(report.windows[1]?.classification).toEqual({
      kind: "pressable",
      dialogClass: "ae-a8n ui.alert",
    });
    expect(report.assessment.action).toBe("known");
    expect(report.axSuspect).toBe(false);
  });

  it("carries axSuspect and degraded census through honestly", () => {
    const report = guiStateReport(TARGET, {
      observed: state([], {
        windowServer: { available: false, reason: "no python", windowCount: 0, onScreenCount: 0 },
        axSuspect: true,
      }),
    });
    expect(report.status).toBe("observed");
    if (report.status === "observed") {
      expect(report.axSuspect).toBe(true);
      expect(report.windowServer.available).toBe(false);
      expect(report.assessment.action).toBe("none");
    }
  });

  it("turns a session-entry failure into unavailable, not an empty report", () => {
    const report = guiStateReport(TARGET, undefined, {
      readTargetSession: () => SESSION,
      runSession: () => {
        throw new MacSessionError("cannot enter the session");
      },
    });
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.reason).toContain("cannot enter the session");
    }
  });
});

describe("assessGuiWindows", () => {
  it("quarantines when any blocking window is unmeasured", () => {
    const assessment = assessGuiWindows([
      dialog(["ae-a8n: measured"], { buttons: [OK_BUTTON] }),
      dialog(["totally unknown dialog"]),
    ]);
    expect(assessment.action).toBe("quarantine");
    expect(assessment.code).toBe("A8N-SEC-001");
    expect(assessment.window).toContain("AXDialog");
  });

  it("prefers human-only over a measured class, like the recovery does", () => {
    const assessment = assessGuiWindows([
      dialog(["ae-a8n: measured"], { buttons: [OK_BUTTON] }),
      dialog(["Adobe Creative Cloud sign in required"]),
    ]);
    expect(assessment.action).toBe("human-only");
    expect(assessment.code).toBeNull();
  });

  it("reports the script permission prompt as unpressable, not quarantine", () => {
    const assessment = assessGuiWindows([
      dialog(["Allow Scripts to Write Files and Access Network"]),
    ]);
    expect(assessment.action).toBe("unpressable");
    expect(assessment.detail).toContain("script-file-network-permission");
  });
});

describe("observeGuiAppState", () => {
  it("propagates a session-entry failure for the caller to report", () => {
    expect(() =>
      observeGuiAppState(TARGET, {
        readTargetSession: () => SESSION,
        runSession: () => {
          throw new MacSessionError("denied");
        },
      }),
    ).toThrow(MacSessionError);
  });
});

describe("AfterEffects.guiState", () => {
  let sessionRoot: string;
  let transport: FakeAfterEffectsTransport;

  beforeEach(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), "a8n-gui-"));
    transport = new FakeAfterEffectsTransport();
  });

  afterEach(() => {
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  it("is unavailable through the fake transport, which cannot attest a GUI target", async () => {
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const report = await ae.guiState();
    expect(report.status).toBe("unavailable");
    await ae.close();
  });
});
