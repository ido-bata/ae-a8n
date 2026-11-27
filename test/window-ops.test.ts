/**
 * Window ops contract tests (#366, W4+ of
 * `specs/workspace-editing/spec.md` §9).
 *
 * Everything here runs against a scripted fake `WindowOpsSurfaceOps` —
 * a mutable window model plus a recording `act` that re-verifies
 * identity exactly like the compiled helper does — and a fake exec for
 * the darwin adapter: this proves the contract — observe-class `state`,
 * fail-closed mutate-gui gating, owned-attribution refusal, in-session
 * identity re-verification, bounded postcondition waits with no resend,
 * and the B-IME §5.3 focus proof — at `automated test` level. It does
 * NOT prove a real After Effects window honors any AX set; that stays
 * `unverified` for the real-host ticket.
 */

import { describe, expect, it } from "vitest";

import type { FocusHolder } from "../src/input/types.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import type { SessionCommandResult } from "../src/driver/mac-session.js";
import { WindowOpsController } from "../src/windowops/controller.js";
import {
  darwinWindowOpsOps,
  type DarwinWindowOpsExec,
} from "../src/windowops/darwin.js";
import { windowOpsMutationGate } from "../src/windowops/gate.js";
import {
  type WindowOpsActRequest,
  type WindowOpsActResult,
  type WindowOpsCensusView,
  type WindowOpsListing,
  type WindowOpsMutationGate,
  type WindowOpsSurfaceOps,
  type WindowOpsWindowInfo,
} from "../src/windowops/types.js";
import type { PanelFrame } from "../src/panels/types.js";
import { windowOpsCapabilities } from "../src/api/window-ops.js";

const PID = 4242;
const FRAME_TOLERANCE = 4;

const FRAME: PanelFrame = { x: 100, y: 50, width: 800, height: 600 };

function win(over: Partial<WindowOpsWindowInfo> = {}): WindowOpsWindowInfo {
  return {
    index: 1,
    title: "After Effects",
    role: "AXWindow",
    subrole: "AXStandardWindow",
    frame: { ...FRAME },
    miniaturized: false,
    main: true,
    focused: true,
    ...over,
  };
}

function censusRow(over: Partial<WindowServerWindow> = {}): WindowServerWindow {
  return {
    pid: PID,
    owner: "After Effects",
    layer: 0,
    onScreen: true,
    name: "",
    windowNumber: 9001,
    bounds: { ...FRAME },
    ...over,
  };
}

/** Readonly modifiers don't affect assignability — the fake mutates rows. */
type MutableWindowInfo = {
  -readonly [K in keyof WindowOpsWindowInfo]: WindowOpsWindowInfo[K];
};

/** A mutable fake screen: windows the helper would list, plus focus. */
function fakeScreen(over: {
  windows?: WindowOpsWindowInfo[];
  census?: WindowServerWindow[];
  censusAvailable?: boolean;
  holder?: FocusHolder | null;
} = {}) {
  const state = {
    windows: [...(over.windows ?? [win()])] as MutableWindowInfo[],
    census: over.census ?? [censusRow()],
    censusAvailable: over.censusAvailable ?? true,
    holder: over.holder === undefined ? null : over.holder,
    acts: [] as WindowOpsActRequest[],
    actResult: null as WindowOpsActResult | null,
    actCalls: 0,
  };

  const framesMatch = (a: PanelFrame, b: PanelFrame): boolean =>
    Math.abs(a.x - b.x) <= FRAME_TOLERANCE &&
    Math.abs(a.y - b.y) <= FRAME_TOLERANCE &&
    Math.abs(a.width - b.width) <= FRAME_TOLERANCE &&
    Math.abs(a.height - b.height) <= FRAME_TOLERANCE;

  const ops: WindowOpsSurfaceOps = {
    observeWindows(): WindowOpsListing {
      return {
        pid: PID,
        frontmostPid: PID,
        focusedWindowIndex: 1,
        windows: state.windows.map((w, i) => ({ ...w, index: i + 1 })),
        observedAt: new Date().toISOString(),
      };
    },
    censusWindows(): WindowOpsCensusView {
      if (!state.censusAvailable) {
        return {
          available: false,
          reason: "census unavailable in test",
          windows: [],
        };
      }
      return { available: true, reason: null, windows: state.census };
    },
    act(request: WindowOpsActRequest): WindowOpsActResult {
      state.acts.push(request);
      state.actCalls += 1;
      if (state.actResult !== null) {
        return state.actResult;
      }
      // Mimic the helper: re-verify identity inside the session, then
      // apply the op to the matched window and read it back.
      const expected = request.expected;
      const matches = state.windows.filter((w) => {
        if (w.frame === null || !framesMatch(w.frame, expected.frame)) {
          return false;
        }
        if (expected.title !== "" && w.title !== expected.title) return false;
        if (expected.subrole !== null && w.subrole !== expected.subrole) {
          return false;
        }
        return true;
      });
      if (matches.length === 0) {
        return {
          verdict: "not-found",
          window: null,
          displayFrame: null,
          detail: "no window matched the expected identity",
        };
      }
      if (matches.length > 1) {
        return {
          verdict: "ambiguous",
          window: null,
          displayFrame: null,
          detail: "multiple candidates",
        };
      }
      const target = matches[0]!;
      const idx = state.windows.indexOf(target);
      let displayFrame: PanelFrame | null = null;
      switch (request.op) {
        case "move":
          target.frame = {
            x: request.position!.x,
            y: request.position!.y,
            width: target.frame!.width,
            height: target.frame!.height,
          };
          break;
        case "resize":
          target.frame = {
            x: target.frame!.x,
            y: target.frame!.y,
            width: request.size!.width,
            height: request.size!.height,
          };
          break;
        case "minimize":
          target.miniaturized = true;
          break;
        case "restore":
          target.miniaturized = false;
          break;
        case "maximize":
          displayFrame = { x: 0, y: 0, width: 1440, height: 900 };
          target.frame = { ...displayFrame };
          break;
        case "focus":
          state.holder = {
            pid: PID,
            element: "AXWindow[0]/AXTextField[0]",
            app: "After Effects",
            observedAt: new Date().toISOString(),
          };
          break;
      }
      void idx;
      return {
        verdict: "performed",
        window: { ...target, index: idx + 1 },
        displayFrame,
        detail: null,
      };
    },
    readFocusHolder(): FocusHolder | null {
      return state.holder;
    },
  };
  return { state, ops };
}

function build(over: {
  ops?: WindowOpsSurfaceOps;
  authorizeMutation?: WindowOpsMutationGate;
  poll?: { timeoutMs?: number; intervalMs?: number; frameTolerance?: number };
} = {}) {
  const sleep = () => Promise.resolve();
  const controller = new WindowOpsController({
    pid: PID,
    locator: { title: "After Effects" },
    ops: over.ops ?? fakeScreen().ops,
    authorizeMutation:
      over.authorizeMutation === undefined
        ? () => ({ allowed: true })
        : over.authorizeMutation,
    poll: { timeoutMs: 60, intervalMs: 1, ...over.poll },
    sleep,
  });
  return { controller };
}

describe("windowOpsCapabilities", () => {
  it("reports observe implemented and every op gate-pending on macOS", () => {
    const caps = windowOpsCapabilities("darwin");
    expect(caps.observe.support).toBe("implemented");
    expect(caps.move.support).toBe("unavailable");
    expect(caps.focus.support).toBe("unavailable");
    expect(caps.move.verification).toBe("automated test");
  });

  it("reports everything unsupported off macOS", () => {
    const caps = windowOpsCapabilities("win32");
    expect(caps.observe.support).toBe("unsupported");
    expect(caps.move.support).toBe("unsupported");
  });
});

describe("state (observe)", () => {
  it("returns the resolved window's state with owned attribution", () => {
    const { ops } = fakeScreen();
    const { controller } = build({ ops });
    const state = controller.state();
    expect(state.pid).toBe(PID);
    expect(state.window.title).toBe("After Effects");
    expect(state.window.frame).toEqual(FRAME);
    expect(state.window.miniaturized).toBe(false);
    expect(state.attribution).toBe("owned");
    expect(state.windowNumber).toBe(9001);
    expect(state.app.frontmost).toBe(true);
  });

  it("does not consult the mutation gate", () => {
    const { ops } = fakeScreen();
    const { controller } = build({
      ops,
      authorizeMutation: () => ({
        allowed: false,
        reason: "must not be consulted",
      }),
    });
    expect(() => controller.state()).not.toThrow();
  });

  it("refuses not-found when the locator matches nothing", () => {
    const controller = new WindowOpsController({
      pid: PID,
      locator: { title: "No Such Window" },
      ops: fakeScreen().ops,
      sleep: () => Promise.resolve(),
    });
    expect(() => controller.state()).toThrowError(
      expect.objectContaining({ name: "WindowOpsError", code: "not-found" }),
    );
  });

  it("reports unavailable when the listing channel fails", () => {
    const ops = fakeScreen().ops;
    const broken: WindowOpsSurfaceOps = {
      ...ops,
      observeWindows: () => {
        throw new Error("session gone");
      },
    };
    const { controller } = build({ ops: broken });
    expect(() => controller.state()).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
  });
});

describe("move", () => {
  it("sets position and proves the postcondition by fresh observation", async () => {
    const { state, ops } = fakeScreen();
    const { controller } = build({ ops });
    const result = await controller.move({ x: 300, y: 200 });
    expect(result.op).toBe("move");
    expect(result.verdict).toBe("performed");
    expect(state.acts).toHaveLength(1);
    expect(state.acts[0]?.op).toBe("move");
    expect(state.acts[0]?.position).toEqual({ x: 300, y: 200 });
    // Identity was re-verified: the act carried the resolved frame.
    expect(state.acts[0]?.expected.frame).toEqual(FRAME);
    expect(result.before.window.frame).toEqual(FRAME);
    expect(result.after?.window.frame).toMatchObject({ x: 300, y: 200 });
    // Focus evidence is recorded on every result.
    expect(result.focus).toHaveProperty("before");
    expect(result.focus).toHaveProperty("after");
  });

  it("refuses before acting when the gate denies", async () => {
    const { state, ops } = fakeScreen();
    const { controller } = build({
      ops,
      authorizeMutation: windowOpsMutationGate(),
    });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      name: "WindowOpsError",
      code: "refused",
    });
    expect(state.acts).toHaveLength(0);
  });

  it("fails closed when no gate is wired", async () => {
    const { state, ops } = fakeScreen();
    const controller = new WindowOpsController({
      pid: PID,
      locator: { title: "After Effects" },
      ops,
      sleep: () => Promise.resolve(),
    });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "refused",
    });
    expect(state.acts).toHaveLength(0);
  });

  it("refuses unproven when the census attributes the frame to a foreign pid", async () => {
    const { state, ops } = fakeScreen({
      census: [censusRow({ pid: 9999, owner: "Other App" })],
    });
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "unproven",
    });
    expect(state.acts).toHaveLength(0);
  });

  it("maps the vehicle's not-found verdict to stale-locator", async () => {
    const { state, ops } = fakeScreen();
    state.actResult = {
      verdict: "not-found",
      window: null,
      displayFrame: null,
      detail: "identity drifted",
    };
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "stale-locator",
    });
    expect(state.acts).toHaveLength(1); // exactly one attempt, never resent
  });

  it("maps the vehicle's ambiguous verdict to ambiguous-target", async () => {
    const { state, ops } = fakeScreen();
    state.actResult = {
      verdict: "ambiguous",
      window: null,
      displayFrame: null,
      detail: "two candidates",
    };
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "ambiguous-target",
    });
  });

  it("maps the vehicle's missing verdict to unavailable", async () => {
    const { state, ops } = fakeScreen();
    state.actResult = {
      verdict: "missing",
      window: null,
      displayFrame: null,
      detail: "session never entered",
    };
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("maps the vehicle's failed verdict to indeterminate", async () => {
    const { state, ops } = fakeScreen();
    state.actResult = {
      verdict: "failed",
      window: null,
      displayFrame: null,
      detail: "AX error",
    };
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "indeterminate",
    });
  });

  it("reports indeterminate when the postcondition never holds and never resends", async () => {
    const { state, ops } = fakeScreen();
    // The vehicle "performs" but the listing never reflects the move —
    // the postcondition poll must expire, not retry the act.
    state.actResult = {
      verdict: "performed",
      window: null,
      displayFrame: null,
      detail: null,
    };
    const { controller } = build({ ops, poll: { timeoutMs: 30 } });
    await expect(controller.move({ x: 999, y: 999 })).rejects.toMatchObject({
      code: "indeterminate",
    });
    expect(state.acts).toHaveLength(1);
  });
});

describe("resize / minimize / restore / maximize / focus", () => {
  it("resize sets size and proves it", async () => {
    const { state, ops } = fakeScreen();
    const { controller } = build({ ops });
    const result = await controller.resize({ width: 640, height: 480 });
    expect(result.verdict).toBe("performed");
    expect(result.after?.window.frame).toMatchObject({ width: 640, height: 480 });
    expect(state.acts[0]?.size).toEqual({ width: 640, height: 480 });
  });

  it("minimize/restore cycle the AXMiniaturized flag", async () => {
    const { state, ops } = fakeScreen();
    const { controller } = build({ ops });
    const min = await controller.minimize();
    expect(min.verdict).toBe("performed");
    expect(min.after?.window.miniaturized).toBe(true);
    const restore = await controller.restore();
    expect(restore.verdict).toBe("performed");
    expect(restore.after?.window.miniaturized).toBe(false);
    expect(state.acts.map((a) => a.op)).toEqual(["minimize", "restore"]);
  });

  it("minimize still proves its postcondition when the frame is lost", async () => {
    const { state, ops } = fakeScreen();
    // A minimized window may lose its AX frame — the postcondition must
    // still be provable off the listing row, not the resolution.
    const baseAct = ops.act.bind(ops);
    ops.act = (request) => {
      const result = baseAct(request);
      if (request.op === "minimize") {
        const target = state.windows[0]!;
        target.frame = null;
      }
      return result;
    };
    const { controller } = build({ ops });
    const result = await controller.minimize();
    expect(result.verdict).toBe("performed");
    expect(result.after?.window.miniaturized).toBe(true);
    expect(result.after?.window.frame).toBeNull();
  });

  it("maximize targets the display frame the vehicle reports", async () => {
    const { state, ops } = fakeScreen();
    const { controller } = build({ ops });
    const result = await controller.maximize();
    expect(result.verdict).toBe("performed");
    expect(result.after?.window.frame).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    });
    expect(state.acts[0]?.op).toBe("maximize");
  });

  it("focus proves the holder is the target pid (B-IME §5.3)", async () => {
    const { state, ops } = fakeScreen({
      holder: {
        pid: 9999,
        element: null,
        app: "Other App",
        observedAt: new Date().toISOString(),
      },
    });
    const { controller } = build({ ops });
    const result = await controller.focus();
    expect(result.verdict).toBe("performed");
    expect(result.focus.before?.pid).toBe(9999);
    expect(result.focus.after?.pid).toBe(PID);
    expect(result.focus.after?.element).not.toBeNull();
    expect(state.acts[0]?.op).toBe("focus");
  });

  it("focus reports indeterminate when the holder never lands on the pid", async () => {
    const { state, ops } = fakeScreen({
      holder: {
        pid: 9999,
        element: null,
        app: "Other App",
        observedAt: new Date().toISOString(),
      },
    });
    // The vehicle performs but focus stays foreign — the proof never
    // holds, so the op is indeterminate, not performed.
    state.actResult = {
      verdict: "performed",
      window: null,
      displayFrame: null,
      detail: null,
    };
    const { controller } = build({ ops, poll: { timeoutMs: 30 } });
    await expect(controller.focus()).rejects.toMatchObject({
      code: "indeterminate",
    });
    expect(state.acts).toHaveLength(1);
  });
});

describe("resolution refusals", () => {
  it("refuses ambiguous-target when two windows match the locator", async () => {
    const { ops } = fakeScreen({
      windows: [
        win(),
        win({
          index: 2,
          frame: { x: 500, y: 100, width: 800, height: 600 },
        }),
      ],
      census: [
        censusRow(),
        censusRow({
          windowNumber: 9002,
          bounds: { x: 500, y: 100, width: 800, height: 600 },
        }),
      ],
    });
    const { controller } = build({ ops });
    await expect(controller.move({ x: 1, y: 1 })).rejects.toMatchObject({
      code: "ambiguous-target",
    });
  });

  it("refuses not-found when the locator matches nothing", async () => {
    const controller = new WindowOpsController({
      pid: PID,
      locator: { title: "No Such Window" },
      ops: fakeScreen().ops,
      authorizeMutation: () => ({ allowed: true }),
      sleep: () => Promise.resolve(),
    });
    await expect(controller.minimize()).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

// ---------------------------------------------------------------------
// darwin adapter: argv construction + JSON parsing against a fake exec
// ---------------------------------------------------------------------

function fakeExec(
  handler: (helper: string, args: readonly string[]) => SessionCommandResult,
): { exec: DarwinWindowOpsExec; calls: { helper: string; args: readonly string[] }[] } {
  const calls: { helper: string; args: readonly string[] }[] = [];
  return {
    calls,
    exec: (helper, args) => {
      calls.push({ helper, args: [...args] });
      return handler(helper, args);
    },
  };
}

const STATE_JSON = JSON.stringify({
  pid: PID,
  frontmostPid: PID,
  focusedWindowIndex: 1,
  windows: [
    {
      index: 1,
      title: "After Effects",
      role: "AXWindow",
      subrole: "AXStandardWindow",
      frame: { x: 100, y: 50, width: 800, height: 600 },
      miniaturized: false,
      main: true,
      focused: true,
    },
  ],
});

const ACT_JSON = JSON.stringify({
  verdict: "performed",
  window: {
    index: 1,
    title: "After Effects",
    role: "AXWindow",
    subrole: "AXStandardWindow",
    frame: { x: 300, y: 200, width: 800, height: 600 },
    miniaturized: false,
    main: true,
    focused: true,
  },
});

describe("darwinWindowOpsOps", () => {
  const request: WindowOpsActRequest = {
    op: "move",
    expected: {
      title: "After Effects",
      subrole: "AXStandardWindow",
      frame: FRAME,
    },
    position: { x: 300, y: 200 },
  };

  it("builds the act argv with identity + op parameters", () => {
    const { exec, calls } = fakeExec(() => ({
      status: 0,
      stdout: ACT_JSON,
      stderr: "",
      timedOut: false,
    }));
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    const result = ops.act(request);
    expect(result.verdict).toBe("performed");
    expect(result.window?.frame).toEqual({
      x: 300,
      y: 200,
      width: 800,
      height: 600,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.helper).toBe("window-ops");
    const args = calls[0]!.args;
    expect(args.slice(0, 2)).toEqual(["act", "--pid"]);
    expect(args).toContain("--op");
    expect(args[args.indexOf("--op") + 1]).toBe("move");
    expect(args[args.indexOf("--frame") + 1]).toBe("100,50,800,600");
    expect(args[args.indexOf("--x") + 1]).toBe("300");
    expect(args[args.indexOf("--y") + 1]).toBe("200");
  });

  it("maps a session-entry failure to the missing verdict", () => {
    const { exec } = fakeExec(() => {
      throw new Error("cannot run in session");
    });
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    const result = ops.act(request);
    expect(result.verdict).toBe("missing");
    expect(result.window).toBeNull();
  });

  it("maps a non-zero helper exit to the failed verdict", () => {
    const { exec } = fakeExec(() => ({
      status: 2,
      stdout: "",
      stderr: "usage error",
      timedOut: false,
    }));
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    const result = ops.act(request);
    expect(result.verdict).toBe("failed");
    expect(result.detail).toContain("usage error");
  });

  it("parses the state listing into a WindowOpsListing", () => {
    const { exec, calls } = fakeExec(() => ({
      status: 0,
      stdout: STATE_JSON,
      stderr: "",
      timedOut: false,
    }));
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    const listing = ops.observeWindows();
    expect(calls[0]?.args).toEqual(["state", "--pid", String(PID)]);
    expect(listing.windows).toHaveLength(1);
    expect(listing.windows[0]?.title).toBe("After Effects");
    expect(listing.windows[0]?.frame).toEqual(FRAME);
    expect(listing.frontmostPid).toBe(PID);
  });

  it("reads the focus holder through input-focus", () => {
    const { exec, calls } = fakeExec(() => ({
      status: 0,
      stdout: JSON.stringify({
        pid: PID,
        app: "After Effects",
        element: "AXWindow[0]",
        observedAt: "2026-01-01T00:00:00Z",
      }),
      stderr: "",
      timedOut: false,
    }));
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    const holder = ops.readFocusHolder();
    expect(calls[0]?.helper).toBe("input-focus");
    expect(holder?.pid).toBe(PID);
    expect(holder?.element).toBe("AXWindow[0]");
  });

  it("returns null focus when the read cannot prove a holder", () => {
    const { exec } = fakeExec(() => ({
      status: 0,
      stdout: JSON.stringify({ pid: null, reason: "no frontmost" }),
      stderr: "",
      timedOut: false,
    }));
    const ops = darwinWindowOpsOps({ pid: PID, exec });
    expect(ops.readFocusHolder()).toBeNull();
  });
});
