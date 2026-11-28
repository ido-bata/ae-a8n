/**
 * Input negative-case suite (#378, `specs/ime-input/spec.md` §8,
 * parent #344 / program #337).
 *
 * Spec §8's negative cases, pinned at contract level against fakes —
 * the same seam style as `input-runner.test.ts` / `input-api.test.ts`:
 *
 *   - wrong-focus abort: a focus change mid-sequence stops posting —
 *     the op never finishes typing into the new holder;
 *   - insufficient permission: absent/mismatched `GlobalInputAuthorization`,
 *     a closed mutation gate, missing delivery channels and unavailable
 *     helper ops all refuse BEFORE posting — `unavailable`/`refused`,
 *     never a silent no-op;
 *   - interruption cleanup: exception/cancel mid-plan still runs the
 *     pressed-set reverse key-up, modifier release, clipboard/IME
 *     restore and focus restore, and reports residue honestly;
 *   - foreign/ambiguous attribution: `attribution !== "owned"`,
 *     multiple locator candidates and stale/drifted handles all refuse;
 *   - forbidden evidence: direct value-set, CDP-synthesized input and
 *     paste-only are never accepted as IME evidence (Tier-1b), and a
 *     fixture record claiming `provesOsIme` is rejected at ingest.
 *
 * Verification level: `automated test` (fake/mock only). Every negative
 * here must land on "refused before posting" or "cleaned up + evidence
 * reported" — no half-state. Real-host negatives are a separate ticket
 * (#379 lane); nothing in this file claims real After Effects delivery.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type Input,
  inputForTarget,
  type InputOps,
  type InputSeams,
} from "../src/api/input.js";
import { inputMutationGate } from "../src/input/gate.js";
import { runInputPlan, type InputRunnerDeps } from "../src/input/runner.js";
import type { InputFocusOps } from "../src/input/focus.js";
import {
  InputError,
  type ClipboardSnapshot,
  type FocusHolder,
  type GlobalInputAuthorization,
  type InputAuditRecord,
  type InputMouseEvent,
  type InputPlan,
  type InputPoster,
  type ImeModeSnapshot,
} from "../src/input/types.js";
import type { PanelTarget } from "../src/panels/types.js";
import type {
  GuiAppState,
  GuiFrame,
  GuiLeaseController,
  GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import { GuiRecoveryError } from "../src/driver/gui-recovery.js";
import type { MacSession } from "../src/driver/mac-session.js";
import type { PanelCensusView } from "../src/panels/controller.js";
import type { PanelLocator } from "../src/panels/types.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";
import {
  classifyInputDelivery,
  evaluateTier1bEvidence,
  parseFixtureReportLine,
  INPUT_FIXTURE_ID,
} from "../src/input/evidence.js";

// ------------------------------------------------------------ constants

const PID = 4242;
const ELEMENT = "AXTextField[search]";
const FRAME: GuiFrame = { x: 100, y: 100, width: 400, height: 300 };
const FRAME2: GuiFrame = { x: 600, y: 100, width: 400, height: 300 };

const SESSION: MacSession = {
  uid: 501,
  username: "tester",
  asid: 42,
  kind: "Aqua",
};

const OBSERVATION_TARGET = { pid: PID, session: SESSION };
const LOCATOR: PanelLocator = { windowNumber: 9001 };

const GRANT: GlobalInputAuthorization = {
  kind: "target",
  pid: PID,
  surfaceKey: "window:9001",
  classes: ["mutate-gui"],
  tokenRef: "grant-neg-1",
};

const ALLOW_GATE = () => ({ allowed: true as const });

// ------------------------------------------------------- runner-level fakes

function makeTarget(
  attribution: PanelTarget["surface"]["attribution"] = "owned",
  windowNumber: number | null = 9001,
): PanelTarget {
  return {
    pid: PID,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    surface: {
      kind: "window",
      windowIndex: 3,
      windowNumber,
      locator: windowNumber === null ? {} : { windowNumber },
      frame: { ...FRAME },
      state: { onScreen: true, occluded: "unknown" },
      attribution,
    },
  };
}

function holder(pid: number, element: string | null = ELEMENT): FocusHolder {
  return {
    pid,
    element,
    app: pid === PID ? "After Effects" : "Foreign App",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A fake poster recording every call in order; `failOn` throws once. */
class FakePoster implements InputPoster {
  readonly calls: string[] = [];
  failOn: string | null = null;

  private record(name: string): void {
    if (this.failOn === name) {
      throw new Error(`fake poster failure on ${name}`);
    }
    this.calls.push(name);
  }

  keyDown(key: string, modifiers?: readonly string[]): void {
    this.record(`down:${key}${mods(modifiers)}`);
  }
  keyUp(key: string, modifiers?: readonly string[]): void {
    this.record(`up:${key}${mods(modifiers)}`);
  }
  typeSequential(text: string): void {
    this.record(`type-seq:${text.length}chars`);
  }
  postText(text: string): void {
    this.record(`post-text:${text.length}chars`);
  }
  clipboardWrite(text: string): void {
    this.record(`clip-write:${text.length}chars`);
  }
  imeSelect(mode: string): void {
    this.record(`ime-select:${mode}`);
  }
  mouse(event: InputMouseEvent): void {
    this.record(`mouse:${event.type}`);
  }
}

function mods(modifiers: readonly string[] | undefined): string {
  return modifiers && modifiers.length > 0
    ? `[${[...modifiers].sort().join("+")}]`
    : "";
}

/**
 * Fake focus ops over a mutable holder. `requestFocus` normally leaves
 * the holder alone; `moveOnRequestTo` makes the request actually move
 * focus (the "we changed focus, must restore it" shape).
 */
function fakeFocus(
  initial: FocusHolder | null,
  options: { moveOnRequestTo?: FocusHolder | null } = {},
) {
  let current = initial;
  const restored: FocusHolder[] = [];
  const requests: unknown[] = [];
  const ops: InputFocusOps & {
    set(h: FocusHolder | null): void;
    restored: FocusHolder[];
    requests: unknown[];
  } = {
    restored,
    requests,
    readFocusHolder: () => current,
    requestFocus: (expected) => {
      requests.push(expected);
      if (options.moveOnRequestTo !== undefined) {
        current = options.moveOnRequestTo;
      }
    },
    restoreFocus: (h) => {
      restored.push(h);
      current = h;
    },
    set(h: FocusHolder | null) {
      current = h;
    },
  };
  return ops;
}

const CLIP_PRIOR: ClipboardSnapshot = {
  flavors: ["public.utf8-plain-text"],
  sha256: createHash("sha256").update("prior", "utf8").digest("hex"),
  bytes: 5,
};

function fakeClipboard(restoreError?: Error) {
  const restored: ClipboardSnapshot[] = [];
  const snapshots = { count: 0 };
  return {
    restored,
    snapshots,
    ops: {
      snapshot: () => {
        snapshots.count += 1;
        return CLIP_PRIOR;
      },
      restore: (s: ClipboardSnapshot) => {
        if (restoreError !== undefined) throw restoreError;
        restored.push(s);
      },
    },
  };
}

function fakeIme(restoreError?: Error) {
  const restored: (string | null)[] = [];
  return {
    restored,
    ops: {
      currentMode: (): ImeModeSnapshot => ({
        mode: "com.apple.inputmethod.Kotoeri.RomajiTyping",
      }),
      restore: (mode: string | null) => {
        if (restoreError !== undefined) throw restoreError;
        restored.push(mode);
      },
    },
  };
}

function deps(over: Partial<InputRunnerDeps> = {}): InputRunnerDeps {
  return {
    target: makeTarget(),
    poster: new FakePoster(),
    focus: fakeFocus(holder(PID)),
    authorizeMutation: ALLOW_GATE,
    authorization: GRANT,
    sessionKind: "shared",
    expectedFocus: { pid: PID, element: ELEMENT },
    newOperationId: () => "op-neg-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

/** A session-stream key plan — the shape every negative starts from. */
function keyPlan(times = 3): InputPlan {
  return {
    operation: "key",
    steps: Array.from({ length: times }, (_, i) => ({
      kind: "key-press" as const,
      key: `k${i}`,
    })),
  };
}

/** Assert the "no half-state" invariant on a refused record. */
function expectCleanRefusal(
  record: InputAuditRecord,
  code: string,
  poster: FakePoster,
): void {
  expect(record.verdict).toBe("refused");
  expect(record.refusal?.code).toBe(code);
  expect(poster.calls).toEqual([]);
  expect(record.steps).toEqual([]);
  expect(record.cleanup.allRestored).toBe(true);
}

// ================================================================
// 1. Wrong-focus abort (spec §8)
// ================================================================

describe("wrong-focus abort", () => {
  it("refuses before posting when the proven holder is a foreign pid", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(
      keyPlan(),
      deps({ poster, focus: fakeFocus(holder(9999, "AXTextField[foreign]")) }),
    );
    expectCleanRefusal(record, "focus-unproven", poster);
    expect(record.focus.proven?.pid).toBe(9999);
    expect(record.focus.elementProven).toBe(false);
  });

  it("refuses before posting when only the element differs inside the target pid", async () => {
    const poster = new FakePoster();
    // Same pid, wrong element — element-level proof fails even though
    // the pid matches.
    const record = await runInputPlan(
      keyPlan(),
      deps({
        poster,
        focus: fakeFocus(holder(PID, "AXTextField[other]")),
      }),
    );
    expectCleanRefusal(record, "focus-unproven", poster);
  });

  it("refuses before posting when focus cannot be read back at all", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(
      keyPlan(),
      deps({ poster, focus: fakeFocus(null) }),
    );
    expectCleanRefusal(record, "focus-unproven", poster);
    expect(record.focus.proven).toBeNull();
  });

  it("aborts mid-sequence when focus jumps to a foreign pid — remaining keys never post", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(holder(PID));
    // Focus escapes to a foreign app the moment the first key lands.
    const origDown = poster.keyDown.bind(poster);
    poster.keyDown = (key: string, modifiers?: readonly string[]) => {
      origDown(key, modifiers);
      focus.set(holder(31337, null));
    };
    const record = await runInputPlan(keyPlan(4), deps({ poster, focus }));
    expect(record.verdict).toBe("indeterminate");
    expect(record.refusal?.code).toBe("focus-lost");
    expect(record.focus.changedMidSequence).toBe(true);
    expect(record.focus.after?.pid).toBe(31337);
    // Step 0 posted (down+up of k0); the guard before step 1 saw the
    // move and aborted — k1..k3 never reached the poster.
    expect(poster.calls.filter((c) => c.startsWith("down:"))).toEqual([
      "down:k0",
    ]);
    expect(record.steps).toHaveLength(1);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("aborts mid-sequence when focus moves to a different element in the same pid", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(holder(PID));
    poster.typeSequential = (text: string) => {
      poster.calls.push(`type-seq:${text.length}chars`);
      focus.set(holder(PID, "AXTextField[wrong]"));
    };
    const plan: InputPlan = {
      operation: "type-sequential",
      steps: [
        { kind: "type-sequential", text: "ab" },
        { kind: "type-sequential", text: "cd" },
      ],
    };
    const record = await runInputPlan(plan, deps({ poster, focus }));
    expect(record.refusal?.code).toBe("focus-lost");
    expect(record.focus.changedMidSequence).toBe(true);
    // Only the first type-sequential posted; the second was aborted.
    expect(poster.calls.filter((c) => c.startsWith("type-seq:"))).toEqual([
      "type-seq:2chars",
    ]);
  });

  it("aborts mid-sequence when the focus readback goes dark", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(holder(PID));
    poster.keyDown = (key: string) => {
      poster.calls.push(`down:${key}`);
      focus.set(null);
    };
    const record = await runInputPlan(keyPlan(3), deps({ poster, focus }));
    expect(record.refusal?.code).toBe("focus-lost");
    expect(record.focus.changedMidSequence).toBe(true);
    expect(poster.calls.filter((c) => c.startsWith("down:"))).toEqual([
      "down:k0",
    ]);
  });
});

// ================================================================
// 2. Insufficient permission / missing authorization refuse
// ================================================================

describe("insufficient permission refuse", () => {
  it("absent global authorization is unavailable — reported, never a silent no-op", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: null }),
    );
    expectCleanRefusal(record, "unavailable", poster);
    expect(record.authorization).toBeNull();
    expect(record.scope).toBe("session-stream");
    expect(record.refusal?.reason).toContain("GlobalInputAuthorization");
  });

  it("a session grant never covers a shared console session", async () => {
    const poster = new FakePoster();
    const sessionGrant: GlobalInputAuthorization = {
      kind: "session",
      sessionId: "asid-999",
      tokenRef: "grant-session",
    };
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: sessionGrant, sessionKind: "shared" }),
    );
    expectCleanRefusal(record, "unavailable", poster);
    expect(record.authorization).toBeNull();
  });

  it("a target grant naming a different surface is refused", async () => {
    const poster = new FakePoster();
    const wrongSurface: GlobalInputAuthorization = {
      ...GRANT,
      surfaceKey: "window:9999",
    };
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: wrongSurface }),
    );
    expectCleanRefusal(record, "refused", poster);
    expect(record.authorization).toBeNull();
  });

  it("a target grant for a different pid is refused", async () => {
    const poster = new FakePoster();
    const wrongPid: GlobalInputAuthorization = { ...GRANT, pid: 31337 };
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: wrongPid }),
    );
    expectCleanRefusal(record, "refused", poster);
  });

  it("a grant that does not list the operation class is refused", async () => {
    const poster = new FakePoster();
    const observeOnly: GlobalInputAuthorization = {
      ...GRANT,
      classes: ["observe"],
    };
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: observeOnly }),
    );
    expectCleanRefusal(record, "refused", poster);
  });

  it("the closed production mutation gate refuses even with a valid grant", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorizeMutation: inputMutationGate() }),
    );
    expectCleanRefusal(record, "refused", poster);
    expect(record.refusal?.reason).toContain("gui-supervision-safety-gates.md");
    // The grant was evaluated and recorded before the gate refused.
    expect(record.authorization).toEqual({
      tokenRef: "grant-neg-1",
      scope: "target",
    });
  });

  it("an unwired mutation gate fails closed", async () => {
    const poster = new FakePoster();
    const d = deps({ poster });
    delete (d as { authorizeMutation?: unknown }).authorizeMutation;
    const record = await runInputPlan(keyPlan(1), d);
    expectCleanRefusal(record, "refused", poster);
    expect(record.refusal?.reason).toContain("fail-closed");
  });

  it("missing helper ops (AX/trust grant absent analogue) refuse before posting", async () => {
    const poster = new FakePoster();
    // This is the shape `unavailableInputOps` produces when platform
    // helpers cannot be built: requestFocus throws `unavailable`, so
    // the focus proof refuses `focus-unproven` before any post — the
    // same path a denied Accessibility/trust grant takes when the
    // helper cannot even ask.
    const focus: InputFocusOps = {
      readFocusHolder: () => null,
      requestFocus: () => {
        throw new InputError(
          "unavailable",
          "input-focus helper cannot run: Accessibility trust not granted",
        );
      },
    };
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, focus }),
    );
    expectCleanRefusal(record, "focus-unproven", poster);
    expect(record.refusal?.reason).toContain("trust");
  });

  it("a step whose delivery channel does not exist refuses unsupported at preflight", async () => {
    // Target-scoped op needing the mouse channel the poster lacks.
    const bare: InputPoster = {
      keyDown: () => {},
      keyUp: () => {},
    };
    const plan: InputPlan = {
      operation: "mouse-click",
      steps: [
        {
          kind: "custom",
          summary: "click the target",
          channel: "mouse",
          run: () => {
            throw new Error("must never run");
          },
        },
      ],
    };
    const record = await runInputPlan(
      plan,
      deps({
        poster: bare,
        // mouse-click is target-scoped: no global authorization needed,
        // but the mutation gate still applies.
        authorization: null,
      }),
    );
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unsupported");
    expect(record.steps).toEqual([]);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("a poster that throws mid-post fails honestly — step recorded, cleanup runs", async () => {
    const poster = new FakePoster();
    poster.failOn = "down:k1";
    const record = await runInputPlan(keyPlan(3), deps({ poster }));
    expect(record.verdict).toBe("indeterminate");
    expect(record.refusal?.code).toBe("indeterminate");
    const failed = record.steps.find((s) => s.outcome === "failed");
    expect(failed?.kind).toBe("key-press");
    expect(failed?.detail).toContain("fake poster failure");
    // Steps after the failure never posted: only k0's down/up landed.
    expect(poster.calls.filter((c) => c.startsWith("down:"))).toEqual([
      "down:k0",
    ]);
    expect(record.cleanup.allRestored).toBe(true);
  });
});

// ================================================================
// 3. Interruption cleanup (spec §8 / §5.5)
// ================================================================

describe("interruption cleanup", () => {
  it("releases pressed keys in reverse order and clears modifiers on exception", async () => {
    const poster = new FakePoster();
    const plan: InputPlan = {
      operation: "key",
      steps: [
        { kind: "key-down", key: "shift", modifiers: [] },
        { kind: "key-down", key: "a", modifiers: ["shift"] },
        {
          kind: "custom",
          summary: "interrupted (timeout/cancel analogue)",
          run: () => {
            throw new Error("interrupted");
          },
        },
      ],
    };
    const record = await runInputPlan(plan, deps({ poster }));
    expect(record.verdict).toBe("indeterminate");
    // Residue sweep: 'a' (with shift) released before 'shift', then the
    // held modifiers themselves.
    const upCalls = poster.calls.filter((c) => c.startsWith("up:"));
    expect(upCalls.slice(0, 3)).toEqual([
      "up:a[shift]",
      "up:shift",
      "up:shift",
    ]);
    const residue = record.cleanup.actions.filter(
      (r) => r.action.type === "key-up" && r.action.residue,
    );
    expect(residue.length).toBeGreaterThan(0);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("restores the clipboard snapshot when a clipboard write is interrupted", async () => {
    const poster = new FakePoster();
    poster.failOn = "clip-write:7chars";
    const clip = fakeClipboard();
    const plan: InputPlan = {
      operation: "clipboard-write",
      steps: [{ kind: "clipboard-write", text: "payload" }],
    };
    const record = await runInputPlan(
      plan,
      deps({ poster, clipboard: clip.ops }),
    );
    // Nothing posted successfully → failed, and the prior clipboard is
    // still restored: no half-state.
    expect(record.verdict).toBe("failed");
    expect(clip.restored).toEqual([CLIP_PRIOR]);
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-clipboard",
    );
    expect(restore?.outcome).toBe("performed");
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("restores the prior IME mode when an ime-mode-select is interrupted", async () => {
    const poster = new FakePoster();
    poster.failOn =
      "ime-select:com.apple.inputmethod.Kotoeri.Japanese";
    const ime = fakeIme();
    const plan: InputPlan = {
      operation: "ime-mode-select",
      steps: [
        { kind: "ime-mode-select", mode: "com.apple.inputmethod.Kotoeri.Japanese" },
      ],
    };
    const record = await runInputPlan(plan, deps({ poster, ime: ime.ops }));
    expect(record.verdict).toBe("failed");
    expect(ime.restored).toEqual([
      "com.apple.inputmethod.Kotoeri.RomajiTyping",
    ]);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("restores the pre-op focus holder when requesting focus moved it", async () => {
    const poster = new FakePoster();
    const foreignBefore = holder(9999, null);
    // Focus request moves the holder from a foreign app to the target.
    const focus = fakeFocus(foreignBefore, {
      moveOnRequestTo: holder(PID, ELEMENT),
    });
    const record = await runInputPlan(keyPlan(1), deps({ poster, focus }));
    expect(record.verdict).toBe("performed");
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-focus",
    );
    expect(restore).toBeDefined();
    expect(restore?.outcome).toBe("performed");
    // The restore returned focus to the holder that held it before us.
    expect(focus.restored).toEqual([foreignBefore]);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("reports a failed focus restore instead of claiming clean", async () => {
    const poster = new FakePoster();
    const foreignBefore = holder(9999, null);
    const focus = fakeFocus(foreignBefore, {
      moveOnRequestTo: holder(PID, ELEMENT),
    });
    focus.restoreFocus = () => {
      throw new Error("cannot reactivate foreign app");
    };
    const record = await runInputPlan(keyPlan(1), deps({ poster, focus }));
    // Posted fine, but the restore failed → indeterminate, reported.
    expect(record.verdict).toBe("indeterminate");
    expect(record.cleanup.allRestored).toBe(false);
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-focus",
    );
    expect(restore?.outcome).toBe("failed");
    expect(restore?.detail).toContain("cannot reactivate");
  });

  it("emits a clean cleanup report even on a refused op — nothing was pressed", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(
      keyPlan(1),
      deps({ poster, authorization: null }),
    );
    expect(record.verdict).toBe("refused");
    expect(record.cleanup.actions).toEqual([]);
    expect(record.cleanup.allRestored).toBe(true);
  });
});

// ================================================================
// 4. Foreign / ambiguous / stale attribution refuse (spec §8)
// ================================================================

describe("foreign / ambiguous / stale attribution", () => {
  it.each(["foreign", "unmatched", "unproven"] as const)(
    "refuses attribution=%s before authorization or posting",
    async (attribution) => {
      const poster = new FakePoster();
      const record = await runInputPlan(
        keyPlan(1),
        deps({
          target: makeTarget(attribution),
          poster,
          // Even a fully valid grant cannot rescue a non-owned surface.
          authorization: GRANT,
          authorizeMutation: ALLOW_GATE,
        }),
      );
      expectCleanRefusal(record, "unproven", poster);
      expect(record.refusal?.reason).toContain(attribution);
    },
  );

  it("refuses a shared-state op on a foreign surface too — no clipboard touch", async () => {
    const poster = new FakePoster();
    const clip = fakeClipboard();
    const plan: InputPlan = {
      operation: "clipboard-write",
      steps: [{ kind: "clipboard-write", text: "x" }],
    };
    const record = await runInputPlan(
      plan,
      deps({
        target: makeTarget("foreign"),
        poster,
        clipboard: clip.ops,
      }),
    );
    expectCleanRefusal(record, "unproven", poster);
    // No snapshot was even taken — refuse happens before shared-state
    // capture.
    expect(clip.snapshots.count).toBe(0);
    expect(clip.restored).toEqual([]);
  });
});

// ------------------------------------------- API-level resolution negatives

// A slimmed harness mirroring input-api.test.ts: scripted surface ops,
// fake poster/focus/clipboard/lease. Enough to drive `ae.input()`.

function panelWindow(over: Partial<GuiWindowInfo> = {}): GuiWindowInfo {
  return {
    title: "Effect Controls",
    role: "AXWindow",
    subrole: null,
    buttons: [],
    texts: [],
    frame: { ...FRAME },
    censusAttribution: "owned",
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
    axSuspectReason: null,
    axUnaccountedWindows: [],
    axUnaccountedCensusWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
  };
}

function censusView(rows: readonly WindowServerWindow[]): PanelCensusView {
  return { available: true, reason: null, windows: rows };
}

const API_HOLDER: FocusHolder = {
  pid: PID,
  element: null,
  app: "After Effects",
  observedAt: "2026-01-01T00:00:00.000Z",
};

type RecordedCall = { method: string; args: readonly unknown[] };

function apiPoster() {
  const calls: RecordedCall[] = [];
  const poster: InputPoster = {
    keyDown: (key, modifiers) => calls.push({ method: "keyDown", args: [key, modifiers] }),
    keyUp: (key, modifiers) => calls.push({ method: "keyUp", args: [key, modifiers] }),
    typeSequential: (text) => calls.push({ method: "typeSequential", args: [text] }),
    postText: (text) => calls.push({ method: "postText", args: [text] }),
    clipboardWrite: (text) => calls.push({ method: "clipboardWrite", args: [text] }),
    imeSelect: (mode) => calls.push({ method: "imeSelect", args: [mode] }),
    mouse: (event) => calls.push({ method: "mouse", args: [event] }),
  };
  return { poster, calls };
}

function apiFocus() {
  const ops: InputFocusOps = {
    readFocusHolder: () => API_HOLDER,
    requestFocus: () => {},
  };
  return ops;
}

function apiLease() {
  const ctl: GuiLeaseController = {
    acquire: () => ({ path: "/fake/lease.json", release: () => {} }),
    audit: () => {},
  };
  return ctl;
}

function makeApiInput(options: {
  windows?: readonly GuiWindowInfo[];
  census?: readonly WindowServerWindow[];
  locator?: PanelLocator;
  seams?: Partial<InputSeams>;
}): { input: Input; calls: RecordedCall[] } {
  const { poster, calls } = apiPoster();
  const ops: InputOps = {
    poster,
    focus: apiFocus(),
    clipboard: {
      snapshot: () => ({
        flavors: ["public.utf8-plain-text"],
        sha256: "ab".repeat(32),
        bytes: 1,
      }),
      restore: () => {},
    },
    ime: {
      currentMode: () => ({ mode: null }),
      restore: () => {},
    },
  };
  const seams: InputSeams = {
    surfaceOps: {
      observe: () => appState(options.windows ?? [panelWindow()]),
      censusWindows: () =>
        censusView(options.census ?? [censusRow()]),
    },
    inputOps: () => ops,
    lease: apiLease(),
    newOperationId: () => "op-neg-api",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...options.seams,
  };
  const input = inputForTarget(
    OBSERVATION_TARGET,
    options.locator ?? LOCATOR,
    seams,
  );
  return { input, calls };
}

describe("api-level resolution negatives", () => {
  it("ambiguous locator candidates refuse with ambiguous-target — never a guess", async () => {
    const second = panelWindow({ frame: { ...FRAME2 } });
    const { input, calls } = makeApiInput({
      windows: [panelWindow(), second],
      census: [censusRow(), censusRow({ windowNumber: 9002, bounds: { ...FRAME2 } })],
      locator: { title: "Effect Controls" },
      seams: { authorization: GRANT, authorizeMutation: ALLOW_GATE },
    });
    try {
      await input.press("a");
      expect.unreachable("press should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe("ambiguous-target");
      expect(inputError.candidates.length).toBeGreaterThan(0);
    }
    expect(calls).toEqual([]);
  });

  it("a windowNumber naming another pid's window refuses unproven — wrong-target attempt", async () => {
    const { input, calls } = makeApiInput({
      census: [censusRow({ pid: 9999, owner: "TextEdit" })],
      seams: { authorization: GRANT, authorizeMutation: ALLOW_GATE },
    });
    try {
      await input.press("a");
      expect.unreachable("press should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe("unproven");
      expect((error as InputError).message).toContain("9999");
    }
    expect(calls).toEqual([]);
  });

  it("a stale handle — window number gone from the census — refuses not-found", async () => {
    const { input, calls } = makeApiInput({
      census: [censusRow({ windowNumber: 7777 })],
      seams: { authorization: GRANT, authorizeMutation: ALLOW_GATE },
    });
    await expect(input.press("a")).rejects.toMatchObject({
      name: "InputError",
      code: "not-found",
    });
    expect(calls).toEqual([]);
  });

  it("a drifted frame that loses census attribution refuses unproven at post time", async () => {
    // The listing flagged the window "unmatched" — the drifted/stale
    // attribution shape: the frame still resolves, but the census could
    // not prove ownership, so the runner refuses before posting.
    const drifted = panelWindow({ censusAttribution: "unmatched" });
    const { input, calls } = makeApiInput({
      windows: [drifted],
      census: [censusRow()],
      seams: { authorization: GRANT, authorizeMutation: ALLOW_GATE },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unproven");
    expect(calls).toEqual([]);
  });

  it("a lease refusal throws InputError refused — nothing posts", async () => {
    const { input, calls } = makeApiInput({
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
        lease: {
          acquire: () => {
            throw new GuiRecoveryError("GUI mutation refused: lease held");
          },
          audit: () => {},
        },
      },
    });
    await expect(input.press("a")).rejects.toMatchObject({
      name: "InputError",
      code: "refused",
    });
    expect(calls).toEqual([]);
  });
});

// ================================================================
// 5. Forbidden evidence — no IME-credit false positives (spec §4.2/§8)
// ================================================================

describe("forbidden evidence negatives", () => {
  it("a performed type-direct op never produces Tier-1a/Tier-1b evidence", async () => {
    const poster = new FakePoster();
    const plan: InputPlan = {
      operation: "type-direct",
      steps: [{ kind: "type-direct", text: "bulk text" }],
      readback: () => "bulk text",
    };
    const record = await runInputPlan(plan, deps({ poster }));
    expect(record.verdict).toBe("performed");
    // Direct/bulk entry is labelled direct-entry — the audit record
    // carries no tier evidence at all; it can never be read back as
    // "the OS IME ran".
    expect(record.tier1a).toBeNull();
    expect(record.tier1b).toBeNull();
    expect(record.valueReadback?.observed).toBe("bulk text");
  });

  it("Tier-1b rejects direct value-set, CDP synthesis and paste-only", () => {
    for (const mechanism of [
      "dom-value-set",
      "cdp-input",
      "extendscript-write",
      "cep-evalscript",
      "uia-set-value",
      "clipboard-paste",
    ] as const) {
      const assessment = classifyInputDelivery(mechanism);
      expect(assessment.tier1b, mechanism).toBe("rejected");
    }
    // And a Tier-1b record built only on those mechanisms is rejected
    // even when a committed value exists.
    const record = evaluateTier1bEvidence({
      deliveries: ["dom-value-set", "cdp-input", "clipboard-paste"],
      committedValue: "にほん",
    });
    expect(record.verdict).toBe("rejected");
    expect(record.rejectedEvidence.length).toBe(3);
  });

  it("a fixture record claiming provesOsIme is rejected at ingest", () => {
    const line = JSON.stringify({
      v: 1,
      fixture: INPUT_FIXTURE_ID,
      surface: "cep-composition",
      ts: "2026-11-27T00:00:00.000Z",
      kind: "compositionend",
      channel: "composition-event",
      tier: "1a",
      provesOsIme: true, // the overclaim — must never parse
      verification: "implemented",
      data: { data: "にほん" },
    });
    const result = parseFixtureReportLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("provesOsIme");
    }
  });
});
