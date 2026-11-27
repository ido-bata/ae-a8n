/**
 * Input runner contract tests (#371, `specs/ime-input/spec.md` §5).
 *
 * Everything runs against fakes: a scripted `InputPoster`, a mutable
 * fake focus-holder, and fake clipboard/IME ports. This proves the
 * contract — fail-closed ordering, the three-step focus proof, the
 * pressed-set cleanup invariants, restore records, and the audit
 * shape — at `automated test` level. It does NOT prove After Effects
 * receives real input; that stays `unverified` for #372/#373 and a
 * real host.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runInputPlan, type InputRunnerDeps } from "../src/input/runner.js";
import { PressedKeySet, payloadDigest } from "../src/input/cleanup.js";
import { inputMutationGate } from "../src/input/gate.js";
import type { InputFocusOps } from "../src/input/focus.js";
import type {
  ClipboardSnapshot,
  FocusHolder,
  GlobalInputAuthorization,
  InputPlan,
  InputPoster,
} from "../src/input/types.js";
import type { PanelTarget } from "../src/panels/types.js";

const PID = 4242;
const ELEMENT = "AXTextField[search]";

function makeTarget(attribution: PanelTarget["surface"]["attribution"] = "owned"): PanelTarget {
  return {
    pid: PID,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    surface: {
      kind: "window",
      windowIndex: 3,
      windowNumber: 777,
      locator: {},
      frame: { x: 0, y: 0, width: 100, height: 100 },
      state: { onScreen: true, occluded: "unknown" },
      attribution,
    },
  };
}

function holder(pid: number, element: string | null = ELEMENT): FocusHolder {
  return { pid, element, app: "After Effects", observedAt: "2026-01-01T00:00:00.000Z" };
}

/** A fake poster that records every call in order. */
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
}

function mods(modifiers: readonly string[] | undefined): string {
  return modifiers && modifiers.length > 0 ? `[${[...modifiers].sort().join("+")}]` : "";
}

/** Fake focus ops over a mutable holder the test controls. */
function fakeFocus(initial: FocusHolder | null) {
  let current = initial;
  const ops: InputFocusOps & { set(h: FocusHolder | null): void; requests: number } = {
    requests: 0,
    readFocusHolder: () => current,
    requestFocus: () => {
      ops.requests += 1;
    },
    set(h: FocusHolder | null) {
      current = h;
    },
  };
  return ops;
}

const GRANT: GlobalInputAuthorization = {
  kind: "target",
  pid: PID,
  surfaceKey: "window:777",
  classes: ["mutate-gui"],
  tokenRef: "grant-1",
};

const ALLOW_GATE = () => ({ allowed: true as const });

function deps(over: Partial<InputRunnerDeps> = {}): InputRunnerDeps {
  return {
    target: makeTarget(),
    poster: new FakePoster(),
    focus: fakeFocus(holder(PID)),
    authorizeMutation: ALLOW_GATE,
    authorization: GRANT,
    sessionKind: "shared",
    sessionId: undefined,
    expectedFocus: { pid: PID, element: ELEMENT },
    newOperationId: () => "op-test-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

const KEY_PLAN: InputPlan = {
  operation: "key",
  steps: [
    { kind: "key-down", key: "a" },
    { kind: "key-up", key: "a" },
  ],
};

describe("fail-closed ordering", () => {
  it("refuses unproven attribution before anything posts", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(KEY_PLAN, deps({
      target: makeTarget("foreign"),
      poster,
    }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unproven");
    expect(poster.calls).toEqual([]);
  });

  it("reports unavailable — not silent — when global authorization is absent", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(KEY_PLAN, deps({
      authorization: null,
      poster,
    }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unavailable");
    expect(record.authorization).toBeNull();
    expect(poster.calls).toEqual([]);
  });

  it("refuses when the production gate denies, even with a valid grant", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(KEY_PLAN, deps({
      authorizeMutation: inputMutationGate(),
      poster,
    }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("refused");
    expect(record.refusal?.reason).toContain("gui-supervision-safety-gates.md");
    expect(poster.calls).toEqual([]);
  });

  it("refuses when no mutation gate is wired at all", async () => {
    const poster = new FakePoster();
    const d = deps({ poster });
    delete (d as { authorizeMutation?: unknown }).authorizeMutation;
    const record = await runInputPlan(KEY_PLAN, d);
    expect(record.verdict).toBe("refused");
    expect(poster.calls).toEqual([]);
  });
});

describe("three-step focus proof (spec §5.3)", () => {
  it("refuses before posting when the readback names a different holder", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(holder(9999, "AXTextField[other]"));
    const record = await runInputPlan(KEY_PLAN, deps({ poster, focus }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("focus-unproven");
    expect(record.focus.proven?.pid).toBe(9999);
    expect(record.focus.elementProven).toBe(false);
    expect(poster.calls).toEqual([]);
  });

  it("refuses before posting when focus cannot be read back", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(null);
    const record = await runInputPlan(KEY_PLAN, deps({ poster, focus }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("focus-unproven");
    expect(poster.calls).toEqual([]);
  });

  it("posts and reports performed when focus proof holds", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(KEY_PLAN, deps({ poster }));
    expect(record.verdict).toBe("performed");
    expect(record.focus.elementProven).toBe(true);
    expect(record.steps.map((s) => s.outcome)).toEqual(["posted", "posted"]);
    expect(poster.calls).toEqual(["down:a", "up:a"]);
  });

  it("aborts mid-sequence when focus moves — never finishes into the new focus", async () => {
    const poster = new FakePoster();
    const focus = fakeFocus(holder(PID));
    // After the first step posts, focus jumps to a foreign pid.
    const origDown = poster.keyDown.bind(poster);
    poster.keyDown = (key: string, modifiers?: readonly string[]) => {
      origDown(key, modifiers);
      focus.set(holder(31337, "AXTextField[foreign]"));
    };
    const plan: InputPlan = {
      operation: "type-sequential",
      steps: [
        { kind: "key-press", key: "h" },
        { kind: "key-press", key: "i" },
        { kind: "key-press", key: "!" },
      ],
    };
    const record = await runInputPlan(plan, deps({ poster, focus }));
    expect(record.verdict).toBe("indeterminate");
    expect(record.refusal?.code).toBe("focus-lost");
    expect(record.focus.changedMidSequence).toBe(true);
    // Steps 0 posted; step 1's guard saw the move and aborted — step 2
    // never posted. Only the first key-press's down/up hit the poster.
    expect(poster.calls.filter((c) => c.startsWith("down:h"))).toHaveLength(1);
    expect(poster.calls.some((c) => c.includes("down:i") || c.includes("down:!"))).toBe(false);
    // Cleanup still released nothing extra (key-press pairs itself).
    expect(record.cleanup.allRestored).toBe(true);
  });
});

describe("cleanup contract (spec §5.5)", () => {
  it("releases a stuck key-down in reverse order with its modifiers", async () => {
    const poster = new FakePoster();
    const plan: InputPlan = {
      operation: "key",
      steps: [
        { kind: "key-down", key: "shift", modifiers: [] },
        { kind: "key-down", key: "a", modifiers: ["shift"] },
        // No key-ups: simulate an interrupted sequence.
      ],
    };
    // Force a mid-plan failure so cleanup must sweep residue: make the
    // third step a custom that throws.
    const failing: InputPlan = {
      operation: "key",
      steps: [
        ...plan.steps,
        {
          kind: "custom",
          summary: "boom",
          run: () => {
            throw new Error("interrupted");
          },
        },
      ],
    };
    const record = await runInputPlan(failing, deps({ poster }));
    expect(record.verdict).not.toBe("performed");
    // Residue sweep: 'a' released before 'shift' (reverse press order),
    // 'a' still carrying its shift modifier.
    const residueUps = record.cleanup.actions.filter(
      (r) => r.action.type === "key-up" && r.action.residue,
    );
    expect(residueUps.map((r) => (r.action as { key: string }).key).slice(0, 2)).toEqual([
      "a",
      "shift",
    ]);
    const first = residueUps[0]?.action;
    expect(first?.type === "key-up" && first.modifiers).toEqual(["shift"]);
    // The poster saw the same order: 'a' (with shift) before 'shift'.
    const upCalls = poster.calls.filter((c) => c.startsWith("up:"));
    expect(upCalls[0]).toBe("up:a[shift]");
    expect(upCalls[1]).toBe("up:shift");
  });

  it("clears held modifiers after residue key-ups", async () => {
    const poster = new FakePoster();
    const plan: InputPlan = {
      operation: "key",
      steps: [
        { kind: "key-down", key: "a", modifiers: ["cmd", "shift"] },
        {
          kind: "custom",
          summary: "boom",
          run: () => {
            throw new Error("interrupted");
          },
        },
      ],
    };
    const record = await runInputPlan(plan, deps({ poster }));
    // After 'a' is released, the held modifiers cmd+shift are cleared
    // as their own key-ups (the release-modifiers sweep).
    const upSequence = poster.calls.filter((c) => c.startsWith("up:"));
    expect(upSequence[0]).toBe("up:a[cmd+shift]");
    expect(upSequence.slice(1)).toEqual(["up:cmd", "up:shift"]);
    const modifierUps = record.cleanup.actions.filter(
      (r) =>
        r.action.type === "key-up" &&
        r.action.residue &&
        (r.action as { key: string }).key !== "a",
    );
    expect(modifierUps.map((r) => (r.action as { key: string }).key)).toEqual([
      "cmd",
      "shift",
    ]);
  });

  it("saves and restores the clipboard around a write", async () => {
    const poster = new FakePoster();
    const prior: ClipboardSnapshot = {
      flavors: ["public.utf8-plain-text"],
      sha256: createHash("sha256").update("old", "utf8").digest("hex"),
      bytes: 3,
    };
    const restored: ClipboardSnapshot[] = [];
    const clipboard = {
      snapshot: () => prior,
      restore: (s: ClipboardSnapshot) => {
        restored.push(s);
      },
    };
    const plan: InputPlan = {
      operation: "clipboard-write",
      steps: [{ kind: "clipboard-write", text: "paste me" }],
    };
    const record = await runInputPlan(plan, deps({ poster, clipboard }));
    expect(record.verdict).toBe("performed");
    expect(poster.calls).toContain("clip-write:8chars");
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-clipboard",
    );
    expect(restore).toBeDefined();
    expect(restored).toEqual([prior]);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("reports clipboard restore failure instead of hiding it", async () => {
    const poster = new FakePoster();
    const clipboard = {
      snapshot: (): ClipboardSnapshot => ({
        flavors: ["public.utf8-plain-text"],
        sha256: "x",
        bytes: 1,
      }),
      restore: () => {
        throw new Error("pasteboard denied");
      },
    };
    const plan: InputPlan = {
      operation: "clipboard-write",
      steps: [{ kind: "clipboard-write", text: "x" }],
    };
    const record = await runInputPlan(plan, deps({ poster, clipboard }));
    // The op posted, but the failed restore downgrades performed →
    // indeterminate: honesty over optimism.
    expect(record.verdict).toBe("indeterminate");
    expect(record.cleanup.allRestored).toBe(false);
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-clipboard",
    );
    expect(restore?.outcome).toBe("failed");
    expect(restore?.detail).toContain("pasteboard denied");
  });

  it("records the prior IME mode and restores it after select", async () => {
    const poster = new FakePoster();
    const restoredModes: (string | null)[] = [];
    const ime = {
      currentMode: () => ({ mode: "com.apple.inputmethod.Kotoeri.RomajiTyping" }),
      restore: (mode: string | null) => {
        restoredModes.push(mode);
      },
    };
    const plan: InputPlan = {
      operation: "ime-mode-select",
      steps: [{ kind: "ime-mode-select", mode: "com.apple.inputmethod.Kotoeri.Japanese" }],
    };
    const record = await runInputPlan(plan, deps({ poster, ime }));
    expect(record.verdict).toBe("performed");
    expect(poster.calls).toEqual(["ime-select:com.apple.inputmethod.Kotoeri.Japanese"]);
    const restore = record.cleanup.actions.find(
      (r) => r.action.type === "restore-ime-mode",
    );
    expect(restore).toBeDefined();
    expect(restoredModes).toEqual(["com.apple.inputmethod.Kotoeri.RomajiTyping"]);
  });

  it("resolves a pending composition explicitly when declared", async () => {
    const poster = new FakePoster();
    const resolved: string[] = [];
    const plan: InputPlan = {
      operation: "type-sequential",
      steps: [{ kind: "type-sequential", text: "こんにちは" }],
    };
    const record = await runInputPlan(plan, deps({
      poster,
      compositionResolution: "commit",
      compositionResolveChannel: (r) => {
        resolved.push(r);
      },
    }));
    expect(record.verdict).toBe("performed");
    expect(resolved).toEqual(["commit"]);
    const action = record.cleanup.actions.find(
      (r) => r.action.type === "resolve-composition",
    );
    expect(action).toBeDefined();
  });
});

describe("preflight and step evidence", () => {
  it("refuses unsupported before any post when a channel is missing", async () => {
    // No typeSequential on this poster.
    const bare: InputPoster = {
      keyDown: () => {},
      keyUp: () => {},
    };
    const plan: InputPlan = {
      operation: "type-sequential",
      steps: [{ kind: "type-sequential", text: "abc" }],
    };
    const record = await runInputPlan(plan, deps({ poster: bare }));
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unsupported");
    expect(record.steps).toEqual([]);
  });

  it("digests text payloads instead of storing them raw", async () => {
    const poster = new FakePoster();
    const secret = "s3cret-text";
    const plan: InputPlan = {
      operation: "type-direct",
      steps: [{ kind: "type-direct", text: secret }],
    };
    const record = await runInputPlan(plan, deps({ poster }));
    expect(record.verdict).toBe("performed");
    const step = record.steps[0];
    expect(step?.payload?.sensitive).toBe(true);
    expect(step?.payload?.sha256).toBe(
      createHash("sha256").update(secret, "utf8").digest("hex"),
    );
    expect(step?.summary).not.toContain(secret);
    expect(payloadDigest(secret).length).toBe(secret.length);
  });
});

describe("audit record shape (spec §5.6)", () => {
  it("carries operationId, target, class/scope, authorization, focus, steps, cleanup, verdict", async () => {
    const poster = new FakePoster();
    const record = await runInputPlan(KEY_PLAN, deps({ poster }));
    expect(record.operationId).toBe("op-test-1");
    expect(record.target.pid).toBe(PID);
    expect(record.operation).toBe("key");
    expect(record.operationClass).toBe("mutate-gui");
    expect(record.scope).toBe("session-stream");
    expect(record.authorization).toEqual({
      tokenRef: "grant-1",
      scope: "target",
    });
    expect(record.focus.before?.pid).toBe(PID);
    expect(record.focus.proven?.element).toBe(ELEMENT);
    expect(record.focus.after?.pid).toBe(PID);
    expect(record.tier1a).toBeNull();
    expect(record.tier1b).toBeNull();
    expect(record.verdict).toBe("performed");
    expect(record.refusal).toBeNull();
    expect(record.observedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("PressedKeySet unit", () => {
  it("tracks presses and releases residue in reverse order", () => {
    const set = new PressedKeySet();
    set.press("a", ["shift"]);
    set.press("b");
    set.release("b");
    const residue = set.pendingReleases();
    expect(residue).toHaveLength(1);
    expect(residue[0]).toMatchObject({ type: "key-up", key: "a", residue: true });
    expect(set.heldModifiers()).toEqual(["shift"]);
    set.release("a");
    expect(set.clean).toBe(true);
  });
});
