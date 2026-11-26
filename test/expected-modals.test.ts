/**
 * Expected-modal registration and its recovery integration (#342).
 *
 * The contract under test: a session-registered expectation re-classifies a
 * blocking window the measured taxonomy would refuse or quarantine — it
 * never widens what may be pressed. `human-only` windows are decided before
 * the registry is consulted, `wait` presses nothing, and `press` goes
 * through the same audited `pressButtonIn` path a measured class uses.
 *
 * Level: fake/mock only — the GUI surface is a stub; nothing here has run
 * against a real After Effects.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ExpectedModalRegistry,
  requireExpectedModal,
  toExpectedModalWindow,
  type ExpectedModalSpec,
  type ExpectedModalWindow,
} from "../src/driver/expected-modals.js";
import type { GuiAppState, GuiWindowInfo } from "../src/driver/gui-recovery.js";
import { MacHostRecovery, type GuiRecoverySurface } from "../src/driver/recovery.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-expected-modal-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function guiWindow(overrides: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "",
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [
      { title: "OK", description: "", position: null, size: null },
      { title: "Cancel", description: "", position: null, size: null },
    ],
    texts: [],
    ...overrides,
  };
}

/** A blocking window no measured class claims: quarantine territory. */
const UNKNOWN_DIALOG = guiWindow({
  title: "Plugin Prompt",
  texts: ["The plugin wants to continue. Proceed with the operation?"],
});

/** The measured human-required script-error class. */
const SCRIPT_ERROR = guiWindow({
  title: "After Effects",
  texts: ["Unable to execute script at line 0. Object is invalid"],
});

/** An Adobe account window: human-only, decided before any registry. */
const SIGN_IN = guiWindow({
  title: "Adobe",
  texts: ["Please sign in to continue"],
});

/** A `GuiRecoverySurface` the test scripts window by window. */
class FakeGui implements GuiRecoverySurface {
  windows: GuiWindowInfo[] = [];
  readonly pressed: Array<{ index: number; title: string }> = [];
  readonly captures: string[] = [];
  pressResult = true;
  captureError: Error | null = null;

  listWindows(): GuiAppState {
    return {
      pid: 4242,
      frontmost: true,
      windows: this.windows,
      windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
      axSuspect: false,
      axUnaccountedWindows: [],
      axForeignWindowCount: 0,
      axUnmatchedWindowCount: 0,
    };
  }

  capture(path: string): string {
    if (this.captureError !== null) {
      throw this.captureError;
    }
    this.captures.push(path);
    return path;
  }

  pressButtonIn(windowIndex: number, title: string): boolean {
    this.pressed.push({ index: windowIndex, title });
    return this.pressResult;
  }
}

function hostRecovery(gui: FakeGui, expectedModals?: ExpectedModalRegistry) {
  return new MacHostRecovery({
    session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
    pid: () => 4242,
    screenshotDir: join(root, "shots"),
    gui,
    ...(expectedModals === undefined ? {} : { expectedModals }),
  });
}

const CONTEXT = { requestId: "req-1", method: "app.info", timeoutMs: 1000 };

describe("ExpectedModalRegistry", () => {
  const spec = (name: string, matches: ExpectedModalSpec["matches"]): ExpectedModalSpec => ({
    name,
    matches,
  });

  it("refuses malformed specs at the boundary", () => {
    expect(() => requireExpectedModal(null)).toThrow(TypeError);
    expect(() => requireExpectedModal({ name: "", matches: () => true })).toThrow(TypeError);
    expect(() => requireExpectedModal({ name: "x" })).toThrow(TypeError);
    expect(() =>
      requireExpectedModal({ name: "x", matches: () => true, resolve: "nope" }),
    ).toThrow(TypeError);
  });

  it("matches in registration order and unregister removes", () => {
    const registry = new ExpectedModalRegistry();
    const window = toExpectedModalWindow({
      ...UNKNOWN_DIALOG,
      buttons: UNKNOWN_DIALOG.buttons,
    });
    const first = registry.register(spec("first", () => true));
    const second = registry.register(spec("second", () => true));
    expect(registry.match(window)?.spec.name).toBe("first");
    first();
    expect(registry.match(window)?.spec.name).toBe("second");
    second();
    second(); // idempotent
    expect(registry.match(window)).toBeNull();
  });

  it("treats a throwing matcher as non-matching and a throwing resolver as wait", () => {
    const registry = new ExpectedModalRegistry();
    registry.register(
      spec("broken-matcher", () => {
        throw new Error("matcher bug");
      }),
    );
    registry.register({
      name: "broken-resolver",
      matches: () => true,
      resolve: () => {
        throw new Error("resolver bug");
      },
    });
    registry.register({
      name: "bad-press",
      matches: () => true,
      resolve: () => ({ kind: "press", button: 42 as unknown as string }),
    });
    const window = toExpectedModalWindow(UNKNOWN_DIALOG);
    const match = registry.match(window);
    // The throwing matcher is skipped; the throwing resolver falls back to
    // wait — the safe default — rather than crashing the recovery.
    expect(match?.spec.name).toBe("broken-resolver");
    expect(match?.resolution).toEqual({ kind: "wait" });
  });

  it("defaults an omitted resolve to wait", () => {
    const registry = new ExpectedModalRegistry();
    registry.register(spec("silent", () => true));
    const match = registry.match(toExpectedModalWindow(UNKNOWN_DIALOG));
    expect(match?.resolution).toEqual({ kind: "wait" });
  });
});

describe("MacHostRecovery with expected modals", () => {
  it("quarantines an unknown window exactly as before when nothing is registered", async () => {
    const gui = new FakeGui();
    gui.windows = [UNKNOWN_DIALOG];
    const outcome = await hostRecovery(gui).attempt(CONTEXT);
    expect(outcome.outcome).toBe("quarantined");
    expect(outcome.code).toBe("A8N-SEC-001");
    expect(outcome.expectedModal).toBeUndefined();
    expect(gui.pressed).toHaveLength(0);
  });

  it("resolves a registered unknown window with wait: expected, not pressed, not quarantined", async () => {
    const gui = new FakeGui();
    gui.windows = [UNKNOWN_DIALOG];
    const registry = new ExpectedModalRegistry();
    registry.register({
      name: "plugin-prompt",
      matches: (window: ExpectedModalWindow) => window.title === "Plugin Prompt",
      // resolve omitted → wait
    });
    const outcome = await hostRecovery(gui, registry).attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.code).toBeUndefined();
    expect(outcome.expectedModal).toBe("plugin-prompt");
    expect(outcome.evidence).toContain('expected modal "plugin-prompt"');
    expect(gui.pressed).toHaveLength(0);
    // The before image was still captured as evidence.
    expect(outcome.screenshotPath).toBeDefined();
  });

  it("presses the declared button of a registered expectation through the audited path", async () => {
    const gui = new FakeGui();
    gui.windows = [SCRIPT_ERROR];
    const registry = new ExpectedModalRegistry();
    registry.register({
      name: "script-error-continue",
      matches: (window: ExpectedModalWindow) =>
        window.texts.some((text) => text.includes("Unable to execute script")),
      resolve: () => ({ kind: "press", button: "OK" }),
    });
    const outcome = await hostRecovery(gui, registry).attempt(CONTEXT);
    expect(outcome.recovered).toBe(true);
    expect(outcome.outcome).toBe("dismissed");
    expect(outcome.expectedModal).toBe("script-error-continue");
    // The press went through pressButtonIn addressed to the window index,
    // and the after image was captured for the before/after pair.
    expect(gui.pressed).toEqual([{ index: 1, title: "OK" }]);
    expect(outcome.screenshotPath).toBeDefined();
    expect(outcome.screenshotAfterPath).toBeDefined();
    expect(outcome.evidence).toContain('expected modal "script-error-continue"');
  });

  it("never lets an expectation reach a human-only window", async () => {
    const gui = new FakeGui();
    gui.windows = [SIGN_IN];
    const registry = new ExpectedModalRegistry();
    registry.register({
      name: "sign-in-please",
      matches: () => true,
      resolve: () => ({ kind: "press", button: "OK" }),
    });
    const outcome = await hostRecovery(gui, registry).attempt(CONTEXT);
    // The human-only decision happens before the registry is consulted:
    // refused, no expectation named, nothing pressed.
    expect(outcome.outcome).toBe("refused");
    expect(outcome.expectedModal).toBeUndefined();
    expect(outcome.dialogTier).toBe("human-required");
    expect(gui.pressed).toHaveLength(0);
    expect(outcome.evidence).toContain("account or licence");
  });

  it("reports a failed expectation press as refused, not retried", async () => {
    const gui = new FakeGui();
    gui.windows = [UNKNOWN_DIALOG];
    gui.pressResult = false;
    const registry = new ExpectedModalRegistry();
    registry.register({
      name: "plugin-prompt",
      matches: () => true,
      resolve: () => ({ kind: "press", button: "OK" }),
    });
    const outcome = await hostRecovery(gui, registry).attempt(CONTEXT);
    expect(outcome.recovered).toBe(false);
    expect(outcome.outcome).toBe("refused");
    expect(outcome.expectedModal).toBe("plugin-prompt");
    expect(gui.pressed).toHaveLength(1);
  });

  it("records a capture failure instead of dropping the screenshot silently", async () => {
    const gui = new FakeGui();
    gui.windows = [UNKNOWN_DIALOG];
    gui.captureError = new Error("screencapture denied");
    const registry = new ExpectedModalRegistry();
    registry.register({ name: "plugin-prompt", matches: () => true });
    const outcome = await hostRecovery(gui, registry).attempt(CONTEXT);
    expect(outcome.screenshotPath).toBeUndefined();
    expect(outcome.screenshotNote).toContain("screen capture failed");
  });
});
