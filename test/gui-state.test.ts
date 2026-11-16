/**
 * Read-only GUI observation (`ae.guiState()`, #109).
 *
 * Contract tests for the report shape and the classification mapping,
 * plus the unavailable paths. Everything runs against fixtures and the
 * fake transport: this proves the report's honesty — an unattested target
 * or an unenterable session is `unavailable`, never an empty window list —
 * not that a real After Effects shows the same windows. Real-host
 * observation stays opt-in like the other GUI tests.
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

function window(partial: Partial<GuiWindowInfo> & { title: string }): GuiWindowInfo {
  return {
    role: "AXWindow",
    subrole: "AXStandardWindow",
    buttons: [],
    texts: [],
    ...partial,
  };
}

function state(windows: readonly GuiWindowInfo[], over: Partial<GuiAppState> = {}): GuiAppState {
  return {
    pid: TARGET.pid,
    frontmost: false,
    windows,
    windowServer: { available: true, reason: null, windowCount: windows.length, onScreenCount: windows.length },
    axSuspect: false,
    ...over,
  };
}

describe("classifyGuiWindow", () => {
  it("reports a non-dialog window as not-blocking", () => {
    const w = window({ title: "Composition", role: "AXWindow", subrole: "AXStandardWindow" });
    expect(classifyGuiWindow(w)).toEqual({ kind: "not-blocking" });
  });

  it("reports an unmeasured blocking window as unknown quarantine", () => {
    const w = window({
      title: "",
      role: "AXWindow",
      subrole: "AXDialog",
      texts: ["something nobody measured"],
    });
    expect(classifyGuiWindow(w)).toEqual({ kind: "unknown", code: "A8N-SEC-001" });
  });

  it("reports the measured ae-a8n alert as pressable", () => {
    const w = window({
      title: "",
      role: "AXWindow",
      subrole: "AXDialog",
      texts: ["ae-a8n: the test raised this"],
      buttons: [{ title: "OK", description: "", position: null, size: null }],
    });
    expect(classifyGuiWindow(w)).toEqual({
      kind: "measured",
      dialogClass: "ae-a8n ui.alert",
      presses: true,
      code: null,
    });
  });

  it("reports a scripting permission prompt as human-only, never pressable", () => {
    const w = window({
      title: "",
      role: "AXWindow",
      subrole: "AXDialog",
      texts: ["Allow Scripts to Write Files and Access Network"],
    });
    expect(classifyGuiWindow(w)).toEqual({
      kind: "human-only",
      dialogClass: "script-file-network-permission",
      code: "A8N-PERM-003",
    });
  });

  it("reports a sign-in window as human-only even when unclassed", () => {
    const w = window({
      title: "",
      role: "AXWindow",
      subrole: "AXSheet",
      texts: ["Adobe Creative Cloud にサインインしてください"],
    });
    const classified = classifyGuiWindow(w);
    expect(classified.kind).toBe("human-only");
  });
});

describe("guiStateReport", () => {
  it("is unavailable when no owned target is attested", () => {
    const report = guiStateReport(null, {});
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.reason).toContain("no owned After Effects");
    }
  });

  it("maps a prepared observation into the public report", () => {
    const report = guiStateReport(
      TARGET,
      {
        observed: state([
          window({ title: "Main", subrole: "AXStandardWindow" }),
          window({
            title: "",
            subrole: "AXDialog",
            texts: ["ae-a8n: hello"],
            buttons: [{ title: "OK", description: "", position: null, size: null }],
          }),
        ]),
      },
    );
    expect(report.status).toBe("observed");
    if (report.status !== "observed") {
      return;
    }
    expect(report.pid).toBe(TARGET.pid);
    expect(report.session).toMatchObject({ uid: 502, username: "ae-test", kind: "Aqua" });
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]).toMatchObject({ index: 1, blocking: false });
    expect(report.windows[0]?.classification).toEqual({ kind: "not-blocking" });
    expect(report.windows[1]?.classification).toMatchObject({ kind: "measured", presses: true });
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
    const report = guiStateReport(TARGET, {}, {
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
      window({
        title: "",
        subrole: "AXDialog",
        texts: ["ae-a8n: measured"],
        buttons: [{ title: "OK", description: "", position: null, size: null }],
      }),
      window({
        title: "",
        subrole: "AXDialog",
        texts: ["totally unknown dialog"],
      }),
    ]);
    expect(assessment.action).toBe("quarantine");
    expect(assessment.code).toBe("A8N-SEC-001");
  });
});

describe("observeGuiAppState", () => {
  it("propagates a session-entry failure for the caller to report", () => {
    expect(() =>
      observeGuiAppState(TARGET, {
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
