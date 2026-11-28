/**
 * What the driver does when an operation times out and a recovery unblocks
 * the host.
 *
 * The rule under test: the operation that timed out is **not** sent again.
 * A timeout says the answer did not arrive in time, not that the work was
 * abandoned — the request may still be running inside After Effects, and
 * sending it twice would run it twice.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import type { GuiAppState, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import {
  KNOWN_DIALOG_CLASSES,
  MacHostRecovery,
  chooseRecoveryWindow,
  classifyDialog,
  type GuiRecoverySurface,
  type HostRecovery,
} from "../src/driver/recovery.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A host that never answers by itself: the request is accepted and the
 * result appears only when the test says so.
 */
class BlockedTransport implements HostTransport {
  readonly kind = "blocked";
  invocations = 0;
  /** The id of the request that is waiting. */
  pendingId: string | null = null;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async launch(): Promise<void> {
    // Nothing to start.
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.invocations += 1;
    // The request file holds the id the driver will wait for.
    const inbox = join(root, "inbox");
    const file = readdirSync(inbox).find((name) => name.endsWith(".request.json"));
    this.pendingId = file === undefined ? null : file.replace(".request.json", "");
    // The result is never written here: the host is blocked.
    return Promise.resolve();
  }

  ownership(): HostOwnership {
    return { kind: "owned", evidence: "blocked test host" };
  }

  /** The blocked host finishes the request it already has. */
  finish(result: unknown): void {
    this.#write({ v: 1, id: this.#pending(), ok: true, durationMs: 1, result });
  }

  /** The blocked host finishes the request with an error of its own. */
  finishError(message: string): void {
    this.#write({
      v: 1,
      id: this.#pending(),
      ok: false,
      durationMs: 1,
      error: { name: "Error", message },
    });
  }

  /** The blocked host leaves a result file that is never whole. */
  finishUnparseable(): void {
    const id = this.#pending();
    writeFileSync(join(root, "outbox", `${id}.result.json`), '{"v":1,"id":"');
  }

  #pending(): string {
    if (this.pendingId === null) {
      throw new Error("no request is pending");
    }
    return this.pendingId;
  }

  #write(envelope: unknown): void {
    const id = this.#pending();
    writeFileSync(join(root, "outbox", `${id}.result.json`), JSON.stringify(envelope));
  }

  close(): Promise<void> {
    // Nothing to close.
    return Promise.resolve();
  }
}

function startDriver(transport: HostTransport, recovery?: HostRecovery): AeDriver {
  const trace = new TraceRecorder({ file: join(root, "trace.jsonl") });
  const driver = new AeDriver({
    transport,
    sessionRoot: root,
    trace,
    defaultTimeoutMs: 200,
    ...(recovery === undefined ? {} : { recovery, recoveryGraceMs: 800 }),
  });
  return driver;
}

function readOps(op: string): Array<{ status: string }> {
  return readFileSync(join(root, "trace.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { op: string; status: string })
    .filter((event) => event.op === op);
}

describe("a timeout followed by a recovery", () => {
  it("waits for the original request instead of sending it again", async () => {
    const transport = new BlockedTransport();
    let attempts = 0;
    const recovery: HostRecovery = {
      attempt: () => {
        attempts += 1;
        // Closing the dialog lets the host finish the request it already has.
        transport.finish({ version: "26.5x89" });
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const info = await driver.call<{ version: string }>("app.info", {});
    expect(info.version).toBe("26.5x89");
    expect(attempts).toBe(1);
    // One request, one invocation: the operation was not repeated.
    expect(transport.invocations).toBe(1);
  });

  it("reports the timeout when the recovery does not help", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => Promise.resolve({ recovered: false, evidence: "no dialog was found" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
  });

  it("reports a quarantined state instead of a timeout", async () => {
    // A licence, sign-in or permission dialog is a human's decision. The run
    // must stop and say so; reporting a timeout invites the caller to retry
    // the one state the policy refuses to press through.
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "quarantined",
          code: "A8N-SEC-001",
          evidence: "a licence dialog is open; nothing was pressed",
        }),
    };
    const driver = startDriver(transport, recovery);
    const error = (await driver.call("app.info", {}).catch((reason: unknown) => reason)) as {
      name?: string;
      code?: string;
      message: string;
    };
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.code).toBe("A8N-SEC-001");
    expect(error.message).toContain("licence dialog");
    // The operation was not sent again.
    expect(transport.invocations).toBe(1);
  });

  it("does not repeat the operation when the recovery only half worked", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({ recovered: true, evidence: "pressed OK, but the host stayed quiet" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    // The request was sent once; the recovery waited for its result and gave up.
    expect(transport.invocations).toBe(1);
  });

  it("reports the host's own error, not a timeout, when the host answers after the recovery", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        // The dialog was the only thing blocking the host; once it is closed
        // the request finishes, and it fails on its own terms.
        transport.finishError("the project was not open");
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const error = await driver.call("app.info", {}).catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toMatch(/the project was not open/);
    // Still one request: the answer belongs to it, it was not sent again.
    expect(transport.invocations).toBe(1);
  });

  it("keeps the timeout when the result file is never readable", async () => {
    // An unreadable result is a publication problem, not the host's answer.
    // Reporting ProtocolError here would replace the timeout with a less
    // useful error; the host never answered.
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        transport.finishUnparseable();
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const error = await driver.call("app.info", {}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
  });

  it("records the operation exactly once when the recovery resolves it (#20)", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        transport.finish({ version: "26.5x89" });
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    await driver.call("app.info", {});
    const ops = readOps("app.info");
    expect(ops.map((event) => event.status)).toEqual(["ok"]);
  });

  it("records the operation exactly once when the host answers with an error (#20)", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        transport.finishError("the project was not open");
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    await driver.call("app.info", {}).catch(() => undefined);
    const ops = readOps("app.info");
    expect(ops.map((event) => event.status)).toEqual(["error"]);
  });

  it("records the operation exactly once as a timeout when nothing answers (#20)", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => Promise.resolve({ recovered: false, evidence: "no dialog was found" }),
    };
    const driver = startDriver(transport, recovery);
    await driver.call("app.info", {}).catch(() => undefined);
    const ops = readOps("app.info");
    // One record, and it is the timeout — not a spurious "error" first.
    expect(ops.map((event) => event.status)).toEqual(["timeout"]);
  });

  it("records the operation exactly once when the host is quarantined (#20)", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "quarantined",
          code: "A8N-SEC-001",
          evidence: "a licence dialog is open; nothing was pressed",
        }),
    };
    const driver = startDriver(transport, recovery);
    await driver.call("app.info", {}).catch(() => undefined);
    const ops = readOps("app.info");
    expect(ops).toHaveLength(1);
  });
});

describe("which window a recovery may act on", () => {
  const dialog = (title: string, text = ""): GuiWindowInfo => ({
    title,
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [{ title: "OK", description: "", position: null, size: null }],
    texts: text.length === 0 ? [] : [text],
  });

  /**
   * The one class measured on a real host (docs/offstage-macos.md §10.14):
   * `ui.alert` is an AXDialog with an empty title and the run's own
   * `ae-a8n:` message among its static texts.
   */
  const measuredAlert = (message = "ae-a8n: close me"): GuiWindowInfo => dialog("", message);

  it("does nothing when no window is blocking the host", () => {
    const windows: GuiWindowInfo[] = [
      { title: "Project", role: "AXWindow", subrole: "AXStandardWindow", buttons: [], texts: [] },
    ];
    expect(chooseRecoveryWindow(windows)).toEqual({ kind: "none" });
  });

  it("acts only on the measured ae-a8n alert", () => {
    expect(KNOWN_DIALOG_CLASSES.length).toBeGreaterThan(0);
    expect(classifyDialog(measuredAlert())?.name).toBe("ae-a8n ui.alert");
    // An ordinary-looking AE dialog has not been measured, whatever its title.
    expect(classifyDialog(dialog("Script"))).toBeNull();
    expect(classifyDialog(dialog("警告"))).toBeNull();
  });

  it("addresses the measured alert by its listing index", () => {
    const windows: GuiWindowInfo[] = [
      { title: "Project", role: "AXWindow", subrole: "AXStandardWindow", buttons: [], texts: [] },
      measuredAlert(),
    ];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("known");
    if (choice.kind !== "known") return;
    // 1-based: the standard window above it must be skipped.
    expect(choice.index).toBe(2);
    expect(choice.window.title).toBe("");
    expect(choice.blockingCount).toBe(1);
    expect(choice.dialogClass).toBe("ae-a8n ui.alert");
  });

  it("quarantines an unclassified blocking window and reports A8N-SEC-001", () => {
    // "警告" is AE's start-up modal. Its AX title is empty too, but what it
    // says is a sign-in, licence or script-permission decision. Pressing OK
    // would decide it for the human; an allow list must not contain it.
    const windows: GuiWindowInfo[] = [dialog("警告", "スクリプトを実行するには許可が必要です")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("quarantine");
    if (choice.kind !== "quarantine") return;
    expect(choice.index).toBe(1);
    expect(choice.code).toBe("A8N-SEC-001");
  });

  it("presses nothing when a measured dialog is followed by an unclassified one", () => {
    // Acting on the first window would still leave the unknown state behind
    // the press, and the next press could land on it.
    const windows: GuiWindowInfo[] = [measuredAlert(), dialog("Script")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("quarantine");
    if (choice.kind !== "quarantine") return;
    expect(choice.index).toBe(2);
  });

  it("presses nothing anywhere when a sign-in window is among the blockers", () => {
    // The Japanese wording is what the session shows; an English-only match
    // would have pressed OK on the visible dialog while the licence prompt
    // stayed underneath it.
    const windows: GuiWindowInfo[] = [dialog("警告", "Creative Cloud にサインインしてください"), dialog("Script")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("human-only");
    if (choice.kind !== "human-only") return;
    expect(choice.index).toBe(1);
  });

  it("refuses when a licence window comes after an ordinary dialog", () => {
    const windows: GuiWindowInfo[] = [dialog("Script"), dialog("ライセンスの確認")];
    expect(chooseRecoveryWindow(windows).kind).toBe("human-only");
  });

  it("does not let the measured prefix hide an account prompt", () => {
    // Both rules apply: the window is unclassified for a human decision even
    // if its agent-supplied text starts with the prefix.
    const windows: GuiWindowInfo[] = [measuredAlert("ae-a8n: sign in to Adobe ID")];
    expect(chooseRecoveryWindow(windows).kind).toBe("human-only");
  });

  it("names the crash-repair dialog as recognised but never pressable", () => {
    // Observed on a real host 2026-11-15: its choices include repair method
    // and report submission — a human's decision, not a dismissal.
    const windows: GuiWindowInfo[] = [dialog("クラッシュ修復オプション", "クラッシュレポートを送信しますか")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("unpressable");
    if (choice.kind !== "unpressable") return;
    expect(choice.dialogClass.name).toBe("after-effects-crash-repair");
  });

  it("names the AppDirs/Required Dir startup warning and the recovery project window", () => {
    const warning = chooseRecoveryWindow([dialog("警告", "AppDirs <5> Required Dir = /Applications/Adobe After Effects 2026")]);
    expect(warning.kind).toBe("unpressable");
    if (warning.kind === "unpressable") {
      expect(warning.dialogClass.name).toBe("after-effects-startup-directory-warning");
    }
    const recovery = chooseRecoveryWindow([dialog("リカバリプロジェクトを生成", "After Effects Crash_33.aep")]);
    expect(recovery.kind).toBe("unpressable");
    if (recovery.kind === "unpressable") {
      expect(recovery.dialogClass.name).toBe("after-effects-crash-recovery-project");
    }
  });

  it("presses nothing when a recognised unpressable dialog sits beside a measured alert", () => {
    const windows: GuiWindowInfo[] = [measuredAlert(), dialog("クラッシュ修復オプション")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("unpressable");
    if (choice.kind !== "unpressable") return;
    expect(choice.index).toBe(2);
  });

  it("ignores blocking windows the census attributes to another pid (#330)", () => {
    // The bundle-confused listing: the foreign instance's dialog must not
    // read as this instance's blocker — not even as an unclassified one
    // that would quarantine the run.
    const foreign = {
      ...dialog("Script"),
      censusAttribution: "foreign" as const,
    };
    expect(chooseRecoveryWindow([foreign])).toEqual({ kind: "none" });
    // Mixed with an owned measured alert, only the owned window is seen —
    // and its index stays the raw listing position for the press.
    const owned = { ...measuredAlert(), censusAttribution: "owned" as const };
    const choice = chooseRecoveryWindow([foreign, owned]);
    expect(choice.kind).toBe("known");
    if (choice.kind !== "known") return;
    expect(choice.index).toBe(2);
  });

  it("vetoes every automatic press while an unmatched blocking window exists (#332)", () => {
    // An unmatched window is unproven, not absent: a frameless or
    // AX-phantom dialog of THIS instance reads exactly like this, so it
    // must stop the measured-alert press the way a human-only window
    // does. Only a fully attributed listing keeps the press path open.
    const unmatchedAlert = {
      ...measuredAlert(),
      censusAttribution: "unmatched" as const,
    };
    const owned = { ...measuredAlert(), censusAttribution: "owned" as const };
    const foreign = {
      ...dialog("Script"),
      censusAttribution: "foreign" as const,
    };
    // Alone, the unmatched blocker is still a blocker — never "none".
    const alone = chooseRecoveryWindow([unmatchedAlert]);
    expect(alone.kind).toBe("human-only");
    // Beside a fully attributed measured alert it vetoes the press.
    const mixed = chooseRecoveryWindow([owned, unmatchedAlert]);
    expect(mixed.kind).toBe("human-only");
    if (mixed.kind !== "human-only") return;
    expect(mixed.index).toBe(2);
    // Positively foreign windows still do not veto: they are another
    // instance's windows, not this one's blocker.
    const foreignOnly = chooseRecoveryWindow([foreign, owned]);
    expect(foreignOnly.kind).toBe("known");
  });
});

describe("the macOS host recovery's target process", () => {
  it("reports A8N-AE-004 when no process this run started can be named", async () => {
    // `pid()` returning null means the transport could not tie a process to
    // this run — attached, ambiguous, or already gone. That is a refusal
    // with a stable code, not a generic "no host found".
    const recovery = new MacHostRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: () => null,
      screenshotDir: join(root, "shots"),
    });
    const outcome = await recovery.attempt({ requestId: "req-1", method: "app.info", timeoutMs: 1000 });
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.code).toBe("A8N-AE-004");
  });
});

describe("the AX-invisible census evidence path (#451)", () => {
  const censusWindow = (over: Partial<WindowServerWindow> = {}): WindowServerWindow => ({
    pid: 4242,
    owner: "After Effects",
    layer: 8,
    onScreen: false,
    name: "BirthPrefs",
    windowNumber: 777,
    bounds: { x: 10, y: 20, width: 200, height: 100 },
    ...over,
  });

  /** An AX-blind listing: no AX windows, census windows for the pid. */
  function axBlindState(census: readonly WindowServerWindow[]): GuiAppState {
    return {
      pid: 4242,
      frontmost: false,
      windows: [],
      windowServer: {
        available: true,
        reason: null,
        windowCount: census.length,
        onScreenCount: census.filter((w) => w.onScreen).length,
      },
      axSuspect: true,
      axSuspectReason: "fixture: the AX listing is untrusted",
      axUnaccountedWindows: [],
      axUnaccountedCensusWindows: census,
      axForeignWindowCount: 0,
      axUnmatchedWindowCount: 0,
    };
  }

  function fakeGui(
    state: GuiAppState,
    options: { windowCapture?: boolean; windowCaptureError?: Error } = {},
  ): {
    gui: GuiRecoverySurface;
    captures: string[];
    windowCaptures: Array<{ path: string; windowNumber: number }>;
  } {
    const captures: string[] = [];
    const windowCaptures: Array<{ path: string; windowNumber: number }> = [];
    const gui: GuiRecoverySurface = {
      listWindows: () => state,
      capture: (path: string) => {
        captures.push(path);
        return path;
      },
      pressButtonIn: () => false,
      ...(options.windowCapture === false
        ? {}
        : {
            captureWindowById: (path: string, windowNumber: number) => {
              if (options.windowCaptureError !== undefined) {
                throw options.windowCaptureError;
              }
              windowCaptures.push({ path, windowNumber });
              return path;
            },
          }),
    };
    return { gui, captures, windowCaptures };
  }

  function hostRecovery(gui: GuiRecoverySurface) {
    return new MacHostRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: () => 4242,
      screenshotDir: join(root, "shots"),
      gui,
    });
  }

  const CONTEXT = { requestId: "req-1", method: "app.info", timeoutMs: 1000 };

  it("captures the session and each census window AX cannot see", async () => {
    // The BirthPrefs shape: AX reports nothing, the census lists the
    // modal parked off-screen. The old branch returned before any
    // capture; now every census row is imaged by window number.
    const state = axBlindState([
      censusWindow({ windowNumber: 777, onScreen: false }),
      censusWindow({ layer: 0, onScreen: true, name: "", windowNumber: 778, bounds: null }),
    ]);
    const { gui, captures, windowCaptures } = fakeGui(state);
    const outcome = await hostRecovery(gui).attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    // The session screenshot exists — the branch no longer skips it.
    expect(captures).toHaveLength(1);
    expect(outcome.screenshotPath).toBe(captures[0]);
    // Each census window was addressed by its window number.
    expect(windowCaptures.map((c) => c.windowNumber)).toEqual([777, 778]);
    expect(outcome.censusCaptures).toHaveLength(2);
    expect(outcome.censusCaptures?.[0]?.path).toBe(windowCaptures[0]?.path);
    // The off-screen row is labelled honestly, never as a proven blocker.
    expect(outcome.censusCaptures?.[0]?.window).toContain("possibly parked/offscreen");
    expect(outcome.evidence).toContain("possibly parked/offscreen");
    expect(outcome.evidence).toContain("invisible to AX");
  });

  it("records uncapturable rows with the reason instead of dropping them", async () => {
    const state = axBlindState([
      censusWindow({ windowNumber: null }),
      censusWindow({ windowNumber: 779 }),
    ]);
    const { gui } = fakeGui(state, { windowCapture: false });
    const outcome = await hostRecovery(gui).attempt(CONTEXT);
    expect(outcome.censusCaptures).toHaveLength(2);
    expect(outcome.censusCaptures?.[0]?.note).toContain("no window number");
    expect(outcome.censusCaptures?.[1]?.note).toContain("cannot capture a single window");
    expect(outcome.censusCaptures?.every((c) => c.path === undefined)).toBe(true);
    // The session screenshot still ran: only the per-window path was absent.
    expect(outcome.screenshotPath).toBeDefined();
  });

  it("records a failed window capture rather than claiming an image", async () => {
    const state = axBlindState([censusWindow({ windowNumber: 780 })]);
    const { gui } = fakeGui(state, { windowCaptureError: new Error("screencapture denied") });
    const outcome = await hostRecovery(gui).attempt(CONTEXT);
    expect(outcome.censusCaptures?.[0]?.path).toBeUndefined();
    expect(outcome.censusCaptures?.[0]?.note).toContain("window capture failed");
  });

  it("captures nothing when AX and the census agree there is nothing to see", async () => {
    // A routine timeout with a clean observation keeps the old shape:
    // no screenshot was owed, so none is invented.
    const state: GuiAppState = {
      ...axBlindState([]),
      axSuspect: false,
      axSuspectReason: null,
      windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
    };
    const { gui, captures, windowCaptures } = fakeGui(state);
    const outcome = await hostRecovery(gui).attempt(CONTEXT);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.screenshotPath).toBeUndefined();
    expect(outcome.censusCaptures).toBeUndefined();
    expect(captures).toHaveLength(0);
    expect(windowCaptures).toHaveLength(0);
  });
});
