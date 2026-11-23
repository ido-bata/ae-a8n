/**
 * Windows GUI probe (#282): parsing, mapping and honesty rules for the
 * Win32 census + UIA observation, driven entirely by fake NDJSON fixtures.
 * No Windows host is required or claimed — real-host verification is
 * recorded separately as pending.
 */

import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner, ProbeCommand } from "../src/platform/windows/probe.js";
import {
  WindowsGuiProbe,
  isBlockingWindowsWindow,
  parseWindowsGuiObservation,
  windowsGuiHostState,
  windowsGuiWindowToDialog,
  type WindowsWindowCensus,
} from "../src/platform/windows/gui-probe.js";
import { windowsGuiObserveScript } from "../src/platform/windows/gui-observe-script.js";
import { snapshotToBlocking } from "../src/supervision/probe.js";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function meta(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "meta",
    pid: 4321,
    exists: true,
    responding: true,
    sessionId: 1,
    startTime: "2026-11-20T00:00:00.0000000Z",
    imageName: "AfterFX",
    ...overrides,
  });
}

function session(overrides: Record<string, unknown> = {}): string {
  return line({ type: "session", foregroundPid: 9999, locked: false, ...overrides });
}

function windowRecord(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "window",
    hwnd: "65538",
    title: "After Effects",
    className: "AE_MainWindow",
    visible: true,
    enabled: true,
    iconic: false,
    rect: [0, 0, 1920, 1040],
    ownerPid: 4321,
    ownerHwnd: "0",
    ownerEnabled: null,
    threadId: 777,
    responding: true,
    sessionId: 1,
    ...overrides,
  });
}

function uiaRecord(hwnd: string, overrides: Record<string, unknown> = {}): string {
  return line({
    type: "uia",
    hwnd,
    ok: true,
    controlType: "ControlType.Window",
    name: "After Effects",
    automationId: "",
    enabled: true,
    texts: [],
    buttons: [],
    elementCount: 12,
    ...overrides,
  });
}

function done(overrides: Record<string, unknown> = {}): string {
  return line({ type: "done", windows: 1, uiaOk: 1, uiaFailed: 0, truncated: false, ...overrides });
}

function census(overrides: Partial<WindowsWindowCensus> = {}): WindowsWindowCensus {
  return {
    hwnd: "65538",
    title: "",
    className: "#32770",
    visible: true,
    enabled: true,
    iconic: false,
    rect: [10, 10, 210, 110],
    ownerPid: 4321,
    ownerHwnd: "65536",
    ownerEnabled: false,
    threadId: 777,
    responding: true,
    sessionId: 1,
    ...overrides,
  };
}

function fakeRunner(stdout: string, exitCode = 0, stderr = ""): CommandRunner & { calls: ProbeCommand[] } {
  const calls: ProbeCommand[] = [];
  return {
    calls,
    run(command: ProbeCommand): Promise<CommandResult> {
      calls.push(command);
      return Promise.resolve({ stdout, stderr, exitCode });
    },
  };
}

describe("parseWindowsGuiObservation", () => {
  it("returns null without a meta record", () => {
    expect(parseWindowsGuiObservation("")).toBeNull();
    expect(parseWindowsGuiObservation("not json\n{\"type\":\"window\"}\n")).toBeNull();
  });

  it("parses meta, session, windows, uia and done records", () => {
    const observation = parseWindowsGuiObservation(
      meta() +
        session() +
        windowRecord() +
        uiaRecord("65538", { texts: ["Save changes?"], buttons: ["Save", "Don't Save"] }) +
        done(),
    );
    expect(observation).not.toBeNull();
    expect(observation!.pid).toBe(4321);
    expect(observation!.process.exists).toBe(true);
    expect(observation!.process.responding).toBe(true);
    expect(observation!.locked).toBe(false);
    expect(observation!.foregroundPid).toBe(9999);
    expect(observation!.windows).toHaveLength(1);
    expect(observation!.windows[0]!.className).toBe("AE_MainWindow");
    const uia = observation!.uia.get("65538");
    expect(uia?.ok).toBe(true);
    if (uia?.ok) {
      expect(uia.texts).toEqual(["Save changes?"]);
      expect(uia.buttons).toEqual(["Save", "Don't Save"]);
    }
    expect(observation!.malformedLines).toBe(0);
  });

  it("counts malformed lines and keeps the good records", () => {
    const observation = parseWindowsGuiObservation(
      meta() + "garbage{\n" + windowRecord() + session() + done(),
    );
    expect(observation).not.toBeNull();
    expect(observation!.malformedLines).toBe(1);
    expect(observation!.windows).toHaveLength(1);
  });

  it("treats a missing session record as unknown lock/foreground, not false", () => {
    const observation = parseWindowsGuiObservation(meta() + windowRecord() + done());
    expect(observation!.locked).toBeNull();
    expect(observation!.foregroundPid).toBeNull();
  });

  it("reads census-error and uia-unavailable records", () => {
    const observation = parseWindowsGuiObservation(
      meta() +
        line({ type: "census-error", error: "Add-Type failed" }) +
        line({ type: "uia-unavailable", error: "assembly missing" }) +
        done(),
    );
    expect(observation!.censusError).toBe("Add-Type failed");
    expect(observation!.uiaUnavailable).toBe("assembly missing");
  });
});

describe("windowsGuiWindowToDialog / isBlockingWindowsWindow", () => {
  it("marks a visible #32770 dialog blocking", () => {
    expect(isBlockingWindowsWindow(census())).toBe(true);
    const dialog = windowsGuiWindowToDialog(census(), undefined);
    expect(dialog.blocking).toBe(true);
    expect(dialog.role).toBe("#32770");
  });

  it("marks an owned window blocking only when its owner is disabled", () => {
    const modal = census({ className: "AE_Dialog", ownerEnabled: false });
    expect(isBlockingWindowsWindow(modal)).toBe(true);
    const popup = census({ className: "AE_Popup", ownerEnabled: true });
    expect(isBlockingWindowsWindow(popup)).toBe(false);
  });

  it("never marks an invisible window blocking", () => {
    expect(isBlockingWindowsWindow(census({ visible: false }))).toBe(false);
    expect(isBlockingWindowsWindow(census({ visible: false, ownerEnabled: false }))).toBe(false);
  });

  it("maps UIA control type, texts and buttons through", () => {
    const uia = {
      ok: true as const,
      controlType: "ControlType.Pane",
      name: "Dialog",
      automationId: "dlgSave",
      enabled: true,
      texts: ["Do you want to save?"],
      buttons: ["Save", "Don't Save", "Cancel"],
      elementCount: 30,
    };
    const dialog = windowsGuiWindowToDialog(census(), uia);
    expect(dialog.subrole).toBe("ControlType.Pane");
    expect(dialog.texts).toEqual(["Do you want to save?"]);
    expect(dialog.buttons).toEqual(["Save", "Don't Save", "Cancel"]);
  });

  it("preserves census evidence and names the UIA failure when UIA fails", () => {
    const dialog = windowsGuiWindowToDialog(census({ title: "Crash Repair" }), {
      ok: false,
      error: "access denied",
    });
    expect(dialog.title).toBe("Crash Repair");
    expect(dialog.role).toBe("#32770");
    expect(dialog.blocking).toBe(true);
    expect(dialog.texts[0]).toContain("UIA inspection unavailable");
  });
});

describe("windowsGuiHostState", () => {
  function observation(overrides: {
    exists?: boolean;
    locked?: boolean | null;
    responding?: boolean | null;
    censusError?: string | null;
  }): Parameters<typeof windowsGuiHostState>[0] {
    return {
      pid: 4321,
      process: {
        exists: overrides.exists ?? true,
        responding: overrides.responding === undefined ? true : overrides.responding,
        sessionId: 1,
        startTime: null,
        imageName: "AfterFX",
      },
      foregroundPid: null,
      locked: overrides.locked === undefined ? false : overrides.locked,
      windows: [],
      uia: new Map(),
      censusError: overrides.censusError ?? null,
      uiaUnavailable: null,
      truncated: false,
      malformedLines: 0,
    };
  }

  it("reports process-gone for a dead pid", () => {
    expect(windowsGuiHostState(observation({ exists: false }))).toBe("process-gone");
  });

  it("reports gui-session-lost when the session is locked", () => {
    expect(windowsGuiHostState(observation({ locked: true }))).toBe("gui-session-lost");
  });

  it("reports not-responding when the process does not answer", () => {
    expect(windowsGuiHostState(observation({ responding: false }))).toBe("not-responding");
  });

  it("reports unknown when the census failed or responsiveness is unreadable", () => {
    expect(windowsGuiHostState(observation({ censusError: "Add-Type failed" }))).toBe("unknown");
    expect(windowsGuiHostState(observation({ responding: null }))).toBe("unknown");
  });

  it("reports none only when everything answered", () => {
    expect(windowsGuiHostState(observation({}))).toBe("none");
  });
});

describe("WindowsGuiProbe", () => {
  const healthy = meta() + session() + windowRecord() + uiaRecord("65538") + done();

  it("refuses off-win32 without running anything", async () => {
    const runner = fakeRunner(healthy);
    const probe = new WindowsGuiProbe(4321, { runner, platform: "darwin" });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("maps a healthy observation into a ProbeSnapshot", async () => {
    const probe = new WindowsGuiProbe(4321, { runner: fakeRunner(healthy), platform: "win32" });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.host).toBe("none");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]!.blocking).toBe(false);
    expect(snapshot.frontmost).toBe(false);
    expect(snapshot.degraded).toBeUndefined();
  });

  it("reports frontmost when the foreground window belongs to the pid", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(meta() + session({ foregroundPid: 4321 }) + windowRecord() + done()),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok && snapshot.frontmost).toBe(true);
  });

  it("surfaces a blocking dialog window with census evidence", async () => {
    const fixture =
      meta() +
      session() +
      windowRecord({
        hwnd: "65540",
        title: "After Effects",
        className: "#32770",
        ownerHwnd: "65538",
        ownerEnabled: false,
      }) +
      line({ type: "uia", hwnd: "65540", ok: false, error: "access denied" }) +
      done({ windows: 2 });
    const probe = new WindowsGuiProbe(4321, { runner: fakeRunner(fixture), platform: "win32" });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    const blocking = snapshot.windows.filter((window) => window.blocking);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.role).toBe("#32770");
    expect(snapshot.host).toBe("none");
    expect(snapshot.degraded).toBeDefined();
    const blockingInfo = snapshotToBlocking(snapshot);
    expect(blockingInfo.windows.find((window) => window.blocking)?.tier).toBe("unknown");
  });

  it("reports process-gone without window evidence", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(line({ type: "meta", pid: 4321, exists: false }) + done()),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok && snapshot.host).toBe("process-gone");
    expect(snapshot.ok && snapshot.windows).toHaveLength(0);
  });

  it("reports gui-session-lost when the session record says locked", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(meta() + session({ locked: true }) + windowRecord() + done()),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok && snapshot.host).toBe("gui-session-lost");
  });

  it("reports not-responding from process and window evidence", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(
        meta({ responding: false }) +
          session() +
          windowRecord({ responding: false }) +
          done(),
      ),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok && snapshot.host).toBe("not-responding");
  });

  it("keeps census evidence and marks degraded when the census failed", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(
        meta() +
          line({ type: "census-error", error: "Add-Type compilation failed" }) +
          done({ windows: 0 }),
      ),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.host).toBe("unknown");
    expect(snapshot.degraded?.join(" ")).toContain("window census failed");
  });

  it("marks degraded when UIA is unavailable but the census answered", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(
        meta() +
          session() +
          windowRecord() +
          line({ type: "uia-unavailable", error: "UIAutomationClient not found" }) +
          done({ uiaOk: 0, uiaFailed: 0 }),
      ),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.host).toBe("none");
    expect(snapshot.degraded?.join(" ")).toContain("UIA detail missing");
  });

  it("fails closed when the observer output has no meta record", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner("", 1, "powershell exploded"),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) {
      return;
    }
    expect(snapshot.reason).toContain("no readable meta");
  });

  it("uses partial NDJSON from a killed observer instead of failing outright", async () => {
    // A timeout kill still leaves the records already proven on stdout;
    // the probe must use them and flag the exit, never fabricate health.
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(meta() + session() + windowRecord(), 124),
      platform: "win32",
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.host).toBe("none");
    expect(snapshot.degraded?.join(" ")).toContain("observer exited 124");
  });

  it("rejects an invalid pid before spawning", async () => {
    const runner = fakeRunner(healthy);
    const probe = new WindowsGuiProbe(-3, { runner, platform: "win32" });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("accepts a target whose session id matches expectedSessionId", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(healthy),
      platform: "win32",
      expectedSessionId: 1,
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.host).toBe("none");
      expect(snapshot.degraded).toBeUndefined();
    }
  });

  it("fails closed when the live pid reports a different session (#316)", async () => {
    // The pid was reused by a process on another desktop: this observer's
    // window census cannot see its windows, so any "clean" answer would be
    // fabricated. The snapshot is refused instead.
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(meta({ sessionId: 7 }) + session() + windowRecord({ sessionId: 7 }) + done()),
      platform: "win32",
      expectedSessionId: 1,
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.reason).toContain("session 7");
      expect(snapshot.reason).toContain("session 1");
    }
  });

  it("marks degraded — not refused — when the target session id is unreadable", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(meta({ sessionId: null }) + session() + windowRecord() + done()),
      platform: "win32",
      expectedSessionId: 1,
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.host).toBe("none");
      expect(snapshot.degraded?.join(" ")).toContain("session id unreadable");
    }
  });

  it("still reports process-gone for a dead pid under expectedSessionId", async () => {
    const probe = new WindowsGuiProbe(4321, {
      runner: fakeRunner(line({ type: "meta", pid: 4321, exists: false }) + done()),
      platform: "win32",
      expectedSessionId: 1,
    });
    const snapshot = await probe.observe();
    expect(snapshot.ok && snapshot.host).toBe("process-gone");
  });
});

describe("windowsGuiObserveScript", () => {
  it("interpolates the pid and stays observation-only", () => {
    const script = windowsGuiObserveScript(4321);
    expect(script).toContain("$script:targetPid = 4321");
    // No mutation surface: no input injection, no window manipulation, no
    // UIA invoke patterns.
    for (const forbidden of [
      "SendInput",
      "SendKeys",
      "SetForegroundWindow",
      "SetWindowPos",
      "ShowWindow",
      ".Invoke(",
      "SetFocus",
      "taskkill",
    ]) {
      expect(script).not.toContain(forbidden);
    }
  });
});
