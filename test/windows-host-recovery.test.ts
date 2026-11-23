/**
 * The Windows `HostRecovery` wiring (#283): platform selection through
 * `createHostRecovery`, the census-verdict blocking adapter, and the
 * proof that no Windows dialog class is pressable — every blocking
 * window resolves to quarantine, report-only or human-required.
 *
 * Everything runs against a fake PowerShell runner and a fake lease
 * controller. No Windows host is required or claimed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner, ProbeCommand } from "../src/platform/windows/probe.js";
import { isBlockingWindow, type GuiWindowInfo } from "../src/driver/gui-recovery.js";
import type { GuiLeaseController } from "../src/driver/gui-recovery.js";
import { createHostRecovery } from "../src/driver/host-recovery.js";
import { MacHostRecovery, chooseRecoveryWindow } from "../src/driver/recovery.js";
import {
  parseWindowsGuiWindowList,
  windowsGuiWindowToGuiInfo,
  type WindowsGuiWindow,
} from "../src/driver/windows-gui-recovery.js";
import { WindowsHostRecovery } from "../src/driver/windows-host-recovery.js";

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
    texts: ["a dialog the run did not measure"],
    buttons: [{ name: "OK", rect: [20, 40, 60, 20] }],
    elementCount: 8,
    ...overrides,
  });
}

function done(): string {
  return line({ type: "done", windows: 1, uiaOk: 1, uiaFailed: 0, truncated: false });
}

/** A blocking `#32770` dialog whose class nothing has measured. */
const LIST_UNKNOWN = meta() + winRecord() + uiaRecord() + done();
/** The run's own alert text — pressable on macOS, never on Windows. */
const LIST_A8N_ALERT =
  meta() + winRecord() + uiaRecord({ texts: ["ae-a8n: close me"] }) + done();
/** An Adobe account prompt: a human's decision. */
const LIST_HUMAN_ONLY =
  meta() +
  winRecord() +
  uiaRecord({ texts: ["Please sign in to your Adobe ID to continue"] }) +
  done();
/** A measured-but-never-pressable taxonomy class (text-matched). */
const LIST_UNPRESSABLE =
  meta() +
  winRecord() +
  uiaRecord({ texts: ["The Scripting plugin is not installed"] }) +
  done();
/** A visible owned popup whose owner stayed enabled: not blocking. */
const LIST_NON_BLOCKING =
  meta() +
  winRecord({ className: "Chrome_WidgetWin_1", ownerHwnd: "0", ownerEnabled: null }) +
  uiaRecord() +
  done();

type ScriptKind = "list" | "press" | "click" | "unknown";

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

function fakeLease(events: string[]): GuiLeaseController {
  return {
    acquire(op: string) {
      events.push(`acquire:${op}`);
      return {
        path: "/fake/lease.json",
        release() {
          events.push("release");
        },
      };
    },
    audit(event) {
      events.push(`audit:${event.kind}`);
    },
  };
}

const roots: string[] = [];
function screenshotDir(): string {
  const root = mkdtempSync(join(tmpdir(), "a8n-win-host-recovery-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function makeHostRecovery(
  overrides: Partial<ConstructorParameters<typeof WindowsHostRecovery>[0]> & {
    runner: CommandRunner;
  },
): WindowsHostRecovery {
  const events: string[] = [];
  const lease = fakeLease(events);
  return new WindowsHostRecovery({
    session: SESSION,
    pid: () => PID,
    platform: "win32",
    consoleSessionId: () => 1,
    readTargetSession: () => ({ sessionId: SESSION.sessionId }),
    stateRoot: "/nonexistent-state-root-for-tests",
    lease,
    ...overrides,
  });
}

const CONTEXT = { requestId: "req-1", method: "app.info", timeoutMs: 1000 };

describe("createHostRecovery platform selection", () => {
  it("builds a MacHostRecovery for a darwin target", () => {
    const recovery = createHostRecovery({
      target: {
        platform: "darwin",
        session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      },
      pid: () => null,
      screenshotDir: screenshotDir(),
    });
    expect(recovery).toBeInstanceOf(MacHostRecovery);
  });

  it("builds a WindowsHostRecovery for a win32 target", () => {
    const recovery = createHostRecovery({
      target: { platform: "win32", session: SESSION },
      pid: () => null,
      screenshotDir: screenshotDir(),
      windows: {
        platform: "win32",
        consoleSessionId: () => 1,
        readTargetSession: () => ({ sessionId: SESSION.sessionId }),
        runner: fakeRunner({}),
        stateRoot: "/nonexistent-state-root-for-tests",
      },
    });
    expect(recovery).toBeInstanceOf(WindowsHostRecovery);
  });
});

describe("the census-verdict blocking adapter", () => {
  function guiWindow(overrides: Partial<WindowsGuiWindow> = {}): WindowsGuiWindow {
    return {
      index: 1,
      hwnd: "65538",
      title: "",
      className: "#32770",
      controlType: "ControlType.Pane",
      visible: true,
      blocking: true,
      texts: [],
      buttons: [],
      ...overrides,
    };
  }

  it("carries the census verdict into GuiWindowInfo.blocking", () => {
    const blocking = windowsGuiWindowToGuiInfo(guiWindow());
    expect(blocking.blocking).toBe(true);
    expect(isBlockingWindow(blocking)).toBe(true);
    const popup = windowsGuiWindowToGuiInfo(guiWindow({ blocking: false }));
    expect(isBlockingWindow(popup)).toBe(false);
  });

  it("lets an explicit verdict win over the AX-role heuristic", () => {
    // A Windows `#32770` class name contains no AX role word; without the
    // explicit verdict `isBlockingWindow` would read it as not blocking.
    const info: GuiWindowInfo = {
      title: "",
      role: "#32770",
      subrole: "ControlType.Pane",
      texts: [],
      buttons: [],
      blocking: true,
    };
    expect(isBlockingWindow(info)).toBe(true);
    // And the converse: an explicit "not blocking" is honoured even when
    // the role words would have said otherwise.
    const quiet: GuiWindowInfo = { ...info, blocking: false };
    expect(isBlockingWindow(quiet)).toBe(false);
  });

  it("feeds parsed Windows windows through chooseRecoveryWindow as quarantine", () => {
    const parsed = parseWindowsGuiWindowList(LIST_UNKNOWN);
    expect(parsed).not.toBeNull();
    const infos = (parsed?.windows ?? []).map(windowsGuiWindowToGuiInfo);
    const choice = chooseRecoveryWindow(infos);
    expect(choice.kind).toBe("quarantine");
    if (choice.kind === "quarantine") {
      expect(choice.code).toBe("A8N-SEC-001");
    }
  });
});

describe("WindowsHostRecovery.attempt", () => {
  it("reports A8N-AE-004 when no process this run started can be named", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNKNOWN } });
    const recovery = makeHostRecovery({ runner, pid: () => null });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.code).toBe("A8N-AE-004");
    expect(runner.calls).toHaveLength(0);
  });

  it("quarantines an unmeasured blocking class and never presses", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNKNOWN } });
    const recovery = makeHostRecovery({ runner });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("quarantined");
    expect(outcome.code).toBe("A8N-SEC-001");
    expect(outcome.evidence).toContain("session 2");
    expect(outcome.evidence).toContain("not a dialog class this project has measured");
    // Observation only: the listing ran, no press or click was ever spawned.
    expect(runner.calls.map(kindOf)).toEqual(["list"]);
  });

  it("does not let the macOS-measured ae-a8n alert become pressable on Windows", async () => {
    // The `ae-a8n ui.alert` class is auto-safe on macOS because its AX
    // subrole is AXDialog; a Windows UIA control type can never satisfy
    // that matcher, so the same text quarantines here instead of pressing.
    const runner = fakeRunner({ list: { stdout: LIST_A8N_ALERT } });
    const recovery = makeHostRecovery({ runner });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.outcome).toBe("quarantined");
    expect(outcome.code).toBe("A8N-SEC-001");
    expect(runner.calls.map(kindOf)).toEqual(["list"]);
  });

  it("refuses a human-only window without pressing", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_HUMAN_ONLY } });
    const recovery = makeHostRecovery({ runner });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.evidence).toContain("Adobe account or licence window");
    expect(runner.calls.map(kindOf)).toEqual(["list"]);
  });

  it("names a recognised-but-unpressable class instead of quarantining it as unknown", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNPRESSABLE } });
    const recovery = makeHostRecovery({ runner });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.evidence).toContain("after-effects-scripting-component-missing");
    expect(runner.calls.map(kindOf)).toEqual(["list"]);
  });

  it("reports no blocking window when the census verdict says none block", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_NON_BLOCKING } });
    const recovery = makeHostRecovery({ runner });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.evidence).toContain("no blocking window");
    expect(runner.calls.map(kindOf)).toEqual(["list"]);
  });

  it("refuses an attached/read-only target before anything is spawned", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNKNOWN } });
    const recovery = makeHostRecovery({ runner, attached: true });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.evidence).toContain("attached, not owned");
    expect(runner.calls).toHaveLength(0);
  });

  it("reports A8N-AE-004 when the pid stops verifying before the listing", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNKNOWN } });
    const recovery = makeHostRecovery({ runner, verifyProcess: () => false });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.code).toBe("A8N-AE-004");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses when the session proof no longer holds", async () => {
    const runner = fakeRunner({ list: { stdout: LIST_UNKNOWN } });
    const recovery = makeHostRecovery({
      runner,
      readTargetSession: () => ({ sessionId: 99 }),
    });
    const outcome = await recovery.attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.evidence).toContain("could not be inspected");
    expect(runner.calls).toHaveLength(0);
  });
});
