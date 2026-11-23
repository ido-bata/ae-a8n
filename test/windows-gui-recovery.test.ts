/**
 * Windows GUI recovery (#283): the mutation path's safety contract,
 * exercised entirely through a fake PowerShell runner, a fake lease
 * controller and stubbed session seams. No Windows host is required or
 * claimed — real-host verification (InvokePattern reachability,
 * SetCursorPos/mouse_event delivery, WTSGetActiveConsoleSessionId) is
 * recorded separately as pending.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner, ProbeCommand } from "../src/platform/windows/probe.js";
import { windowsGuiActScript } from "../src/platform/windows/gui-act-script.js";
import { acquireGuiLease, guiSessionKey, guiLeasePaths } from "../src/platform/darwin/gui-lease.js";
import {
  GuiMutationError,
  GuiRecoveryError,
  type GuiLeaseController,
} from "../src/driver/gui-recovery.js";
import {
  parseWindowsGuiActResult,
  parseWindowsGuiWindowList,
  WindowsGuiRecovery,
  WindowsGuiSessionError,
  windowsGuiWindowToGuiInfo,
  type WindowsGuiRecoveryOptions,
} from "../src/driver/windows-gui-recovery.js";

const SESSION = { sessionId: 2 };
const PID = 4321;

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function meta(): string {
  return line({ type: "meta", pid: PID, exists: true, sessionId: 2 });
}

function winRecord(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "window",
    index: 1,
    hwnd: "65538",
    title: "",
    className: "#32770",
    visible: true,
    enabled: true,
    iconic: false,
    rect: [0, 0, 200, 100],
    ownerHwnd: "65536",
    ownerEnabled: false,
    threadId: 777,
    sessionId: 2,
    ...overrides,
  });
}

function uiaRecord(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "uia",
    index: 1,
    hwnd: "65538",
    ok: true,
    controlType: "ControlType.Pane",
    texts: ["ae-a8n: a dialog the run raised"],
    buttons: [{ name: "OK", rect: [20, 40, 60, 20] }],
    elementCount: 8,
    ...overrides,
  });
}

function done(overrides: Record<string, unknown> = {}): string {
  return line({ type: "done", windows: 1, uiaOk: 1, uiaFailed: 0, truncated: false, ...overrides });
}

const LIST_OK = meta() + winRecord() + uiaRecord() + done();
const PRESS_OK = line({ type: "result", status: "INVOKED" });
const PRESS_CHANGED = line({ type: "result", status: "CHANGED", detail: "title differs" });
const PRESS_NOT_FOUND = line({ type: "result", status: "NOT_FOUND" });
const PRESS_UNVERIFIED = line({ type: "result", status: "UNVERIFIED" });
const PRESS_NO_FRAME = line({ type: "result", status: "NO_FRAME" });
const PRESS_SESSION_MISMATCH = line({
  type: "result",
  status: "SESSION_MISMATCH",
  detail: "pid session 3 != own session 2",
});
const PRESS_INVOKE_FAILED = line({ type: "result", status: "INVOKE_FAILED", detail: "boom" });
const CLICK_OK = line({ type: "result", status: "CLICKED" });

type ScriptKind = "list" | "press" | "click";

function kindOf(command: ProbeCommand): ScriptKind {
  const script = command.args[command.args.length - 1] ?? "";
  if (script.includes("$script:mode = 'list'")) {
    return "list";
  }
  if (script.includes("$script:mode = 'press'")) {
    return "press";
  }
  if (script.includes("$script:mode = 'click'")) {
    return "click";
  }
  return "unknown";
}

/** A runner that answers each mode from a fixture table. */
function fakeRunner(
  fixtures: Partial<Record<ScriptKind, { stdout: string; exitCode?: number; stderr?: string }>>,
): CommandRunner & { calls: ProbeCommand[] } {
  const calls: ProbeCommand[] = [];
  return {
    calls,
    run(command: ProbeCommand): Promise<CommandResult> {
      calls.push(command);
      const kind = kindOf(command);
      const fixture = fixtures[kind];
      if (fixture === undefined) {
        return Promise.resolve({ stdout: "", stderr: `no fixture for ${kind}`, exitCode: 1 });
      }
      return Promise.resolve({
        stdout: fixture.stdout,
        stderr: fixture.stderr ?? "",
        exitCode: fixture.exitCode ?? 0,
      });
    },
  };
}

type LeaseEvent =
  | { readonly kind: "acquire"; readonly op: string }
  | { readonly kind: "audit"; readonly event: { kind: string; op?: string; outcome?: string } }
  | { readonly kind: "release" };

function fakeLease(
  events: LeaseEvent[],
  options: { refuse?: string } = {},
): GuiLeaseController {
  return {
    acquire(op: string) {
      events.push({ kind: "acquire", op });
      if (options.refuse !== undefined) {
        throw new GuiRecoveryError(options.refuse);
      }
      return {
        path: "/fake/lease.json",
        release() {
          events.push({ kind: "release" });
        },
      };
    },
    audit(event) {
      events.push({ kind: "audit", event });
    },
  };
}

function makeRecovery(
  overrides: Partial<WindowsGuiRecoveryOptions> & { runner: CommandRunner },
): WindowsGuiRecovery {
  const events: LeaseEvent[] = [];
  const lease = overrides.lease ?? fakeLease(events);
  const recovery = new WindowsGuiRecovery({
    session: SESSION,
    pid: PID,
    platform: "win32",
    consoleSessionId: () => 1,
    readTargetSession: () => ({ sessionId: SESSION.sessionId }),
    stateRoot: "/nonexistent-state-root-for-tests",
    ...overrides,
    lease,
  });
  return recovery;
}

const roots: string[] = [];
function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "a8n-win-gui-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("WindowsGuiRecovery construction refusals", () => {
  const runner = fakeRunner({});

  it("refuses off-win32 before anything can run", () => {
    expect(
      () =>
        new WindowsGuiRecovery({
          session: SESSION,
          pid: PID,
          platform: "darwin",
          consoleSessionId: () => 1,
        }),
    ).toThrow(GuiRecoveryError);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an attached/read-only target outright", () => {
    expect(
      () =>
        new WindowsGuiRecovery({
          session: SESSION,
          pid: PID,
          platform: "win32",
          attached: true,
          consoleSessionId: () => 1,
        }),
    ).toThrow(/attached, not owned/);
  });

  it("refuses a session id that is not an interactive session", () => {
    for (const sessionId of [0, -1, 1.5]) {
      expect(
        () =>
          new WindowsGuiRecovery({
            session: { sessionId },
            pid: PID,
            platform: "win32",
            consoleSessionId: () => 1,
          }),
      ).toThrow(GuiRecoveryError);
    }
  });

  it("refuses an invalid pid", () => {
    expect(
      () =>
        new WindowsGuiRecovery({
          session: SESSION,
          pid: 0,
          platform: "win32",
          consoleSessionId: () => 1,
        }),
    ).toThrow(GuiRecoveryError);
  });

  it("refuses the console session unless explicitly allowed", () => {
    expect(
      () =>
        new WindowsGuiRecovery({
          session: { sessionId: 1 },
          pid: PID,
          platform: "win32",
          consoleSessionId: () => 1,
        }),
    ).toThrow(/console session/);
    // The explicit allowance is the observation-only opt-in.
    expect(
      () =>
        new WindowsGuiRecovery({
          session: { sessionId: 1 },
          pid: PID,
          platform: "win32",
          consoleSessionId: () => 1,
          allowConsoleSession: true,
        }),
    ).not.toThrow();
  });

  it("refuses when the console owner cannot be read", () => {
    expect(
      () =>
        new WindowsGuiRecovery({
          session: SESSION,
          pid: PID,
          platform: "win32",
          consoleSessionId: () => null,
        }),
    ).toThrow(/console session could not be identified/);
  });
});

describe("listWindows", () => {
  it("parses windows, UIA detail and the blocking verdict", async () => {
    const events: LeaseEvent[] = [];
    const runner = fakeRunner({ list: { stdout: LIST_OK } });
    const recovery = makeRecovery({ runner, lease: fakeLease(events) });
    const state = await recovery.listWindows();
    expect(state.pid).toBe(PID);
    expect(state.sessionId).toBe(2);
    expect(state.windows).toHaveLength(1);
    const window = state.windows[0]!;
    expect(window.index).toBe(1);
    expect(window.className).toBe("#32770");
    expect(window.blocking).toBe(true);
    expect(window.texts).toEqual(["ae-a8n: a dialog the run raised"]);
    expect(window.buttons[0]).toMatchObject({
      title: "OK",
      position: { x: 20, y: 40 },
      size: { width: 60, height: 20 },
    });
    const info = windowsGuiWindowToGuiInfo(window);
    expect(info.role).toBe("#32770");
    expect(info.subrole).toBe("ControlType.Pane");
    // Observation is audited but never leased.
    expect(events.filter((event) => event.kind === "acquire")).toHaveLength(0);
    expect(events).toContainEqual({
      kind: "audit",
      event: { kind: "observe", op: "listWindows" },
    });
  });

  it("refuses before spawning when the process identity fails", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_OK } });
    const recovery = makeRecovery({ runner, verifyProcess: () => false });
    await expect(recovery.listWindows()).rejects.toMatchObject({ code: "A8N-AE-004" });
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses before spawning when the session proof changed", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_OK } });
    const recovery = makeRecovery({
      runner,
      readTargetSession: () => ({ sessionId: 99 }),
    });
    await expect(recovery.listWindows()).rejects.toBeInstanceOf(WindowsGuiSessionError);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses when the proven session became the console session", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_OK } });
    let consoleId: number | null = 1;
    const recovery = makeRecovery({
      runner,
      consoleSessionId: () => consoleId,
    });
    consoleId = 2; // the proven session became console-active mid-run
    await expect(recovery.listWindows()).rejects.toBeInstanceOf(WindowsGuiSessionError);
    expect(runner.calls).toHaveLength(0);
  });

  it("throws GuiRecoveryError when the listing has no done record", async () => {
    const runner = fakeRunner({ list: { stdout: meta() + winRecord() } });
    const recovery = makeRecovery({ runner });
    await expect(recovery.listWindows()).rejects.toBeInstanceOf(GuiRecoveryError);
  });
});

describe("pressButtonIn", () => {
  const EXPECTED = {
    title: "",
    role: "#32770",
    subrole: "ControlType.Pane",
    texts: ["ae-a8n: a dialog the run raised"],
    buttons: [{ title: "OK", description: "", position: { x: 20, y: 40 }, size: { width: 60, height: 20 } }],
  };

  it("returns true on INVOKED and audits acquire/mutate/release in order", async () => {
    const events: LeaseEvent[] = [];
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    const recovery = makeRecovery({ runner, lease: fakeLease(events) });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(true);
    expect(runner.calls).toHaveLength(1);
    const script = String(runner.calls[0]!.args.at(-1));
    expect(script).toContain("$script:mode = 'press'");
    expect(script).toContain("InvokePattern");
    // Lease ordering: acquire, mutate performed, release, release-audit
    // (the release audit is written after the file is gone, same as macOS).
    const kinds = events.map((event) =>
      event.kind === "acquire" ? "acquire" : event.kind === "release" ? "release" : `audit:${event.event.kind}:${event.event.outcome ?? ""}`,
    );
    expect(kinds).toEqual([
      "acquire",
      "audit:mutate:performed",
      "release",
      "audit:lease-release:",
    ]);
  });

  it("refuses before spawning when the lease is held", async () => {
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    const recovery = makeRecovery({
      runner,
      lease: fakeLease([], { refuse: "GUI mutation refused: held by agent-b" }),
    });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).rejects.toBeInstanceOf(
      GuiRecoveryError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("re-checks the process identity before the press command", async () => {
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    let checks = 0;
    const recovery = makeRecovery({
      runner,
      verifyProcess: () => {
        checks += 1;
        return checks > 0; // first (only) call decides
      },
    });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(true);
    expect(checks).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });

  it("throws A8N-AE-004 before spawning when the pid no longer verifies", async () => {
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    const events: LeaseEvent[] = [];
    const recovery = makeRecovery({ runner, verifyProcess: () => false, lease: fakeLease(events) });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).rejects.toMatchObject({
      code: "A8N-AE-004",
    });
    expect(runner.calls).toHaveLength(0);
    // The coded refusal is audited as not-performed, not unknown.
    expect(events).toContainEqual({
      kind: "audit",
      event: expect.objectContaining({ kind: "mutate", outcome: "not-performed" }),
    });
  });

  it("treats a changed window as a clean refusal and never clicks", async () => {
    const runner = fakeRunner({
      press: { stdout: PRESS_CHANGED },
      // The fallback listing shows a window that no longer says the marker.
      list: {
        stdout:
          meta() +
          winRecord({ title: "Different" }) +
          uiaRecord({ texts: ["something else entirely"] }) +
          done(),
      },
    });
    const recovery = makeRecovery({ runner });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(false);
    const kinds = runner.calls.map(kindOf);
    expect(kinds).toEqual(["press", "list"]);
    expect(kinds).not.toContain("click");
  });

  it("falls back to a coordinate click at the listed button's own frame", async () => {
    const runner = fakeRunner({
      press: { stdout: PRESS_NOT_FOUND },
      list: { stdout: LIST_OK },
      click: { stdout: CLICK_OK },
    });
    const recovery = makeRecovery({ runner });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(true);
    const kinds = runner.calls.map(kindOf);
    expect(kinds).toEqual(["press", "list", "click"]);
    const clickScript = String(runner.calls[2]!.args.at(-1));
    // Button frame [20,40,60,20] → center (50, 50).
    expect(clickScript).toContain("$script:clickX = 50");
    expect(clickScript).toContain("$script:clickY = 50");
  });

  it("does not click when the re-listed window lost its marker text", async () => {
    const runner = fakeRunner({
      press: { stdout: PRESS_NOT_FOUND },
      list: {
        stdout:
          meta() +
          winRecord() +
          uiaRecord({ texts: ["a different dialog now"] }) +
          done(),
      },
      click: { stdout: CLICK_OK },
    });
    const recovery = makeRecovery({ runner });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(false);
    expect(runner.calls.map(kindOf)).toEqual(["press", "list"]);
  });

  it("maps SESSION_MISMATCH to a session refusal, not a mutation error", async () => {
    const events: LeaseEvent[] = [];
    const runner = fakeRunner({ press: { stdout: PRESS_SESSION_MISMATCH } });
    const recovery = makeRecovery({ runner, lease: fakeLease(events) });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).rejects.toBeInstanceOf(
      WindowsGuiSessionError,
    );
    expect(events).toContainEqual({
      kind: "audit",
      event: expect.objectContaining({ kind: "mutate", outcome: "not-performed" }),
    });
  });

  it("maps INVOKE_FAILED to GuiMutationError — the press may have landed", async () => {
    const events: LeaseEvent[] = [];
    const runner = fakeRunner({ press: { stdout: PRESS_INVOKE_FAILED } });
    const recovery = makeRecovery({ runner, lease: fakeLease(events) });
    const error: unknown = await recovery
      .pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuiMutationError);
    expect(events).toContainEqual({
      kind: "audit",
      event: expect.objectContaining({ kind: "mutate", outcome: "unknown" }),
    });
  });

  it("maps an unreadable press outcome to GuiMutationError", async () => {
    const runner = fakeRunner({ press: { stdout: "", exitCode: 1, stderr: "powershell died" } });
    const recovery = makeRecovery({ runner });
    await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).rejects.toBeInstanceOf(
      GuiMutationError,
    );
  });

  it("treats UNVERIFIED and NO_FRAME as clean refusals", async () => {
    for (const stdout of [PRESS_UNVERIFIED, PRESS_NO_FRAME]) {
      const runner = fakeRunner({
        press: { stdout },
        list: { stdout: LIST_OK },
        click: { stdout: CLICK_OK },
      });
      const recovery = makeRecovery({ runner });
      // Fallback listing still verifies identity and clicks the listed
      // button frame — UNVERIFIED/NO_FRAME only refuse the invoke path.
      await expect(recovery.pressButtonIn(1, "OK", EXPECTED, "ae-a8n:")).resolves.toBe(true);
    }
  });
});

describe("clickAt", () => {
  it("returns true on CLICKED", async () => {
    const runner = fakeRunner({ click: { stdout: CLICK_OK } });
    const recovery = makeRecovery({ runner });
    await expect(recovery.clickAt(50, 60)).resolves.toBe(true);
  });

  it("maps a script failure to GuiMutationError", async () => {
    const runner = fakeRunner({ click: { stdout: "", exitCode: 1, stderr: "dead" } });
    const recovery = makeRecovery({ runner });
    await expect(recovery.clickAt(1, 2)).rejects.toBeInstanceOf(GuiMutationError);
  });
});

describe("lease integration (real lease files)", () => {
  it("scopes the Windows lease to the session id and audits the mutation", async () => {
    const root = stateRoot();
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    const recovery = new WindowsGuiRecovery({
      session: SESSION,
      pid: PID,
      platform: "win32",
      consoleSessionId: () => 1,
      readTargetSession: () => ({ sessionId: 2 }),
      stateRoot: root,
      ownerId: "agent-test",
      runner,
    });
    await expect(
      recovery.pressButtonIn(1, "OK", {
        title: "",
        role: "#32770",
        subrole: "ControlType.Pane",
        texts: ["ae-a8n: x"],
        buttons: [],
      }),
    ).resolves.toBe(true);
    const { dir, auditLog } = guiLeasePaths(root);
    // The lease was released after the mutation: no gui-win32 file remains.
    expect(existsSync(join(dir, "gui-win32-2.json"))).toBe(false);
    const audit = readFileSync(auditLog, "utf-8");
    expect(audit).toContain('"kind":"lease-acquire"');
    expect(audit).toContain('"kind":"mutate"');
    expect(audit).toContain('"kind":"lease-release"');
    expect(audit).toContain("win32:session:2");
    expect(guiSessionKey({ platform: "win32", sessionId: 2 })).toBe("win32:session:2");
    expect(guiSessionKey({ platform: "win32", sessionId: 2 })).not.toBe(
      guiSessionKey({ uid: 501, asid: 100015 }),
    );
  });

  it("a second mutator is refused while the first holds the lease", async () => {
    const root = stateRoot();
    const held = acquireGuiLease({
      stateRoot: root,
      session: { platform: "win32", sessionId: 2 },
      owner: { id: "other-agent", pid: process.pid },
      pidAlive: () => true,
      pidStartedAt: () => null,
    });
    expect(held.ok).toBe(true);
    const runner = fakeRunner({ press: { stdout: PRESS_OK } });
    const recovery = new WindowsGuiRecovery({
      session: SESSION,
      pid: PID,
      platform: "win32",
      consoleSessionId: () => 1,
      readTargetSession: () => ({ sessionId: 2 }),
      stateRoot: root,
      ownerId: "agent-test",
      runner,
    });
    await expect(recovery.pressButtonIn(1, "OK")).rejects.toThrow(/lease/);
    expect(runner.calls).toHaveLength(0);
    if (held.ok) {
      held.lease.release();
    }
  });
});

describe("parse helpers", () => {
  it("parseWindowsGuiActResult reads the terminal result record", () => {
    expect(parseWindowsGuiActResult(PRESS_OK)).toEqual({ status: "INVOKED", detail: null });
    expect(parseWindowsGuiActResult(PRESS_INVOKE_FAILED)?.status).toBe("INVOKE_FAILED");
    expect(parseWindowsGuiActResult("not json\n")).toBeNull();
  });

  it("parseWindowsGuiWindowList requires a done record", () => {
    expect(parseWindowsGuiWindowList(meta() + winRecord())).toBeNull();
    const parsed = parseWindowsGuiWindowList(LIST_OK);
    expect(parsed).not.toBeNull();
    expect(parsed!.windows[0]!.blocking).toBe(true);
    expect(parsed!.degraded).toHaveLength(0);
  });
});

describe("windowsGuiActScript", () => {
  it("builds a press script with identity checks before any input", () => {
    const script = windowsGuiActScript({
      mode: "press",
      pid: PID,
      windowIndex: 1,
      buttonTitle: "OK",
      expectedTitle: "Dialog",
      expectedClass: "#32770",
      expectedText: "ae-a8n:",
    });
    expect(script).toContain("$script:mode = 'press'");
    expect(script).toContain("$script:targetPid = 4321");
    expect(script).toContain("InvokePattern");
    expect(script).toContain("mouse_event");
    // Identity verification precedes the invoke in the emitted script.
    expect(script.indexOf("CHANGED")).toBeLessThan(script.indexOf("InvokePattern"));
  });

  it("escapes string parameters as PowerShell literals", () => {
    const script = windowsGuiActScript({
      mode: "press",
      pid: PID,
      windowIndex: 2,
      buttonTitle: "O'K",
      expectedTitle: "",
      expectedClass: "",
      expectedText: "it's here",
    });
    expect(script).toContain("$script:buttonTitle = 'O''K'");
    expect(script).toContain("$script:expectedText = 'it''s here'");
  });

  it("never emits an untargeted key or a session-escape primitive", () => {
    for (const command of [
      { mode: "list", pid: PID } as const,
      {
        mode: "press",
        pid: PID,
        windowIndex: 1,
        buttonTitle: "OK",
        expectedTitle: "",
        expectedClass: "",
        expectedText: "",
      } as const,
      { mode: "click", x: 10, y: 20 } as const,
    ]) {
      const script = windowsGuiActScript(command);
      for (const forbidden of ["SendKeys", "SetForegroundWindow", "SetWindowPos", "taskkill"]) {
        expect(script).not.toContain(forbidden);
      }
    }
  });

  it("rejects invalid parameters before interpolation", () => {
    expect(() => windowsGuiActScript({ mode: "list", pid: -1 })).toThrow(TypeError);
    expect(() =>
      windowsGuiActScript({ mode: "press", pid: PID, windowIndex: 0, buttonTitle: "", expectedTitle: "", expectedClass: "", expectedText: "" }),
    ).toThrow(TypeError);
    expect(() => windowsGuiActScript({ mode: "click", x: 1.5, y: 2 })).toThrow(TypeError);
  });
});
