/**
 * Public `ae.input()` surface tests (#374,
 * `specs/ime-input/spec.md` §5–§7, parent #344 / program #337).
 *
 * Everything here runs against scripted fake surfaces, posters, focus
 * readbacks and lease controllers: this proves the contract — PanelTarget
 * re-resolution, owned-attribution refusal, global-input authorization,
 * the mutation gate, the three-step focus proof, mid-sequence abort,
 * cleanup-on-all-paths and the §5.6 audit record — at `automated test`
 * level. It does NOT prove a real key event reaches After Effects; that
 * stays unverified for the real-host ticket.
 */

import { describe, expect, it } from "vitest";

import {
  type Input,
  inputCapabilities,
  inputForTarget,
  inputSessionKind,
  type InputOps,
  type InputSeams,
} from "../src/api/input.js";
import { InputError } from "../src/input/types.js";
import type {
  ClipboardSnapshot,
  FocusHolder,
  GlobalInputAuthorization,
  ImeModeSnapshot,
  InputAuditRecord,
  InputMouseEvent,
  InputPoster,
} from "../src/input/types.js";
import type { InputFocusOps } from "../src/input/focus.js";
import type {
  InputClipboardOps,
  InputImeOps,
} from "../src/input/runner.js";
import type {
  GuiAppState,
  GuiFrame,
  GuiLeaseController,
  GuiWindowInfo,
} from "../src/driver/gui-recovery.js";
import { GuiRecoveryError } from "../src/driver/gui-recovery.js";
import type { MacSession } from "../src/driver/mac-session.js";
import type { PanelCensusView } from "../src/panels/controller.js";
import type { PanelLocator, PanelTarget } from "../src/panels/types.js";
import type { WindowServerWindow } from "../src/platform/darwin/window-census.js";

const PID = 4242;
const FRAME: GuiFrame = { x: 100, y: 100, width: 400, height: 300 };
const FRAME2: GuiFrame = { x: 600, y: 100, width: 400, height: 300 };

const SESSION: MacSession = {
  uid: 501,
  username: "tester",
  asid: 42,
  kind: "Aqua",
};

const OBSERVATION_TARGET = { pid: PID, session: SESSION };

/** The strongest locator: the census window number. */
const LOCATOR: PanelLocator = { windowNumber: 9001 };

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
    axUnaccountedWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
  };
}

function censusView(rows: readonly WindowServerWindow[]): PanelCensusView {
  return { available: true, reason: null, windows: rows };
}

const HOLDER: FocusHolder = {
  pid: PID,
  element: null,
  app: "After Effects",
  observedAt: "2026-01-01T00:00:00.000Z",
};

const FOREIGN_HOLDER: FocusHolder = {
  pid: 9999,
  element: null,
  app: "TextEdit",
  observedAt: "2026-01-01T00:00:00.000Z",
};

const CLIP_SNAPSHOT: ClipboardSnapshot = {
  flavors: ["public.utf8-plain-text"],
  sha256: "ab".repeat(32),
  bytes: 12,
};

/** A target-scoped grant naming exactly this resolved surface. */
const GRANT: GlobalInputAuthorization = {
  kind: "target",
  pid: PID,
  surfaceKey: "window:9001",
  classes: ["mutate-gui"],
  tokenRef: "grant-token-1",
};

const ALLOW_GATE = () => ({ allowed: true as const });

// ---------------------------------------------------------------- fakes

type RecordedCall = { method: string; args: readonly unknown[] };

function fakePoster(over: Partial<InputPoster> = {}) {
  const calls: RecordedCall[] = [];
  const poster: InputPoster = {
    keyDown: (key, modifiers) => {
      calls.push({ method: "keyDown", args: [key, modifiers] });
    },
    keyUp: (key, modifiers) => {
      calls.push({ method: "keyUp", args: [key, modifiers] });
    },
    typeSequential: (text) => {
      calls.push({ method: "typeSequential", args: [text] });
    },
    postText: (text) => {
      calls.push({ method: "postText", args: [text] });
    },
    clipboardWrite: (text) => {
      calls.push({ method: "clipboardWrite", args: [text] });
    },
    imeSelect: (mode) => {
      calls.push({ method: "imeSelect", args: [mode] });
    },
    mouse: (event: InputMouseEvent) => {
      calls.push({ method: "mouse", args: [event] });
    },
  };
  Object.assign(poster, over);
  return { poster, calls };
}

/**
 * Focus ops whose readback serves a queue, repeating the last entry —
 * enough to script "proof ok, then focus moved" sequences.
 */
function fakeFocus(holders: readonly (FocusHolder | null)[]) {
  let i = 0;
  const requests: ExpectedFocusLike[] = [];
  const restored: FocusHolder[] = [];
  const ops: InputFocusOps = {
    readFocusHolder: () => {
      const holder = holders[Math.min(i, holders.length - 1)] ?? null;
      i += 1;
      return holder;
    },
    requestFocus: (expected) => {
      requests.push(expected);
    },
    restoreFocus: (holder) => {
      restored.push(holder);
    },
  };
  return { ...ops, requests, restored };
}

type ExpectedFocusLike = Parameters<InputFocusOps["requestFocus"]>[0];

function fakeClipboard() {
  const restores: ClipboardSnapshot[] = [];
  const ops: InputClipboardOps & { restores: ClipboardSnapshot[] } = {
    restores,
    snapshot: () => CLIP_SNAPSHOT,
    restore: (snapshot) => {
      restores.push(snapshot);
    },
  };
  return ops;
}

function fakeIme(mode: ImeModeSnapshot = { mode: "com.apple.inputmethod.Kotoeri" }) {
  const ops: InputImeOps = {
    currentMode: () => mode,
    restore: () => {},
  };
  return ops;
}

function fakeLease() {
  const events: { kind: string; op?: string; outcome?: string }[] = [];
  const acquisitions: string[] = [];
  const ctl: GuiLeaseController & {
    events: typeof events;
    acquisitions: string[];
    refuseNext: boolean;
  } = {
    events,
    acquisitions,
    refuseNext: false,
    acquire(op) {
      acquisitions.push(op);
      if (ctl.refuseNext) {
        throw new GuiRecoveryError("GUI mutation refused: lease held by other-owner");
      }
      return {
        path: "/fake/lease.json",
        release: () => {},
      };
    },
    audit(event) {
      events.push({
        kind: event.kind,
        ...(event.op !== undefined ? { op: event.op } : {}),
        ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
      });
    },
  };
  return ctl;
}

type Harness = {
  input: Input;
  ops: InputOps;
  poster: InputPoster;
  posterCalls: RecordedCall[];
  focus: ReturnType<typeof fakeFocus>;
  clipboard: ReturnType<typeof fakeClipboard>;
  lease: ReturnType<typeof fakeLease>;
};

function makeInput(options: {
  windows?: readonly GuiWindowInfo[];
  census?: readonly WindowServerWindow[];
  locator?: PanelLocator;
  seams?: Partial<InputSeams>;
  ops?: Partial<InputOps>;
  poster?: Partial<InputPoster>;
  focusHolders?: readonly (FocusHolder | null)[];
}): Harness {
  const windows = options.windows ?? [panelWindow()];
  const rows = options.census ?? [censusRow()];
  const { poster, calls } = fakePoster(options.poster ?? {});
  const focus = fakeFocus(options.focusHolders ?? [HOLDER]);
  const clipboard = fakeClipboard();
  const lease = fakeLease();
  const ops: InputOps = {
    poster,
    focus,
    clipboard,
    ime: fakeIme(),
    ...options.ops,
  };
  const seams: InputSeams = {
    surfaceOps: {
      observe: () => appState(windows),
      censusWindows: () => censusView(rows),
    },
    inputOps: () => ops,
    lease,
    newOperationId: () => "op-test-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...options.seams,
  };
  const input = inputForTarget(OBSERVATION_TARGET, options.locator ?? LOCATOR, seams);
  return { input, ops, poster, posterCalls: calls, focus, clipboard, lease };
}

// ---------------------------------------------------------------- tests

describe("inputForTarget / inputSessionKind", () => {
  it("refuses when no owned target is attested", () => {
    expect(() => inputForTarget(null, LOCATOR, {})).toThrowError(InputError);
    try {
      inputForTarget(null, LOCATOR, {});
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe("unavailable");
    }
  });

  it("derives shared/dedicated/unknown session kinds honestly", () => {
    const consoleUid = () => 501;
    expect(inputSessionKind(SESSION, consoleUid)).toBe("shared");
    expect(
      inputSessionKind({ ...SESSION, uid: 999, asid: 7 }, consoleUid),
    ).toBe("dedicated");
    expect(
      inputSessionKind({ ...SESSION, uid: 999, asid: null }, consoleUid),
    ).toBe("unknown");
    expect(
      inputSessionKind(SESSION, () => -1),
    ).toBe("dedicated");
  });
});

describe("PanelTarget resolution", () => {
  it("identify() resolves the locator against the live observation", async () => {
    const { input } = makeInput({});
    const target: PanelTarget = await input.identify();
    expect(target.pid).toBe(PID);
    expect(target.surface.windowNumber).toBe(9001);
    expect(target.surface.attribution).toBe("owned");
    expect(target.surface.frame).toEqual(FRAME);
  });

  it("throws InputError not-found when nothing matches", async () => {
    const { input } = makeInput({ locator: { title: "No Such Panel" } });
    await expect(input.identify()).rejects.toMatchObject({
      name: "InputError",
      code: "not-found",
    });
  });

  it("throws InputError ambiguous-target naming the candidates", async () => {
    const second = panelWindow({
      title: "Effect Controls",
      frame: { ...FRAME2 },
    });
    const { input } = makeInput({
      windows: [panelWindow(), second],
      census: [
        censusRow(),
        censusRow({ windowNumber: 9002, bounds: { ...FRAME2 } }),
      ],
      locator: { title: "Effect Controls" },
    });
    try {
      await input.identify();
      expect.unreachable("identify should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe("ambiguous-target");
      expect(inputError.candidates.length).toBeGreaterThan(0);
    }
  });
});

describe("observe-class operations", () => {
  it("imeModeQuery returns the platform mode without taking the lease", async () => {
    const { input, lease } = makeInput({});
    const mode = await input.imeModeQuery();
    expect(mode.mode).toBe("com.apple.inputmethod.Kotoeri");
    expect(lease.acquisitions).toHaveLength(0);
  });

  it("clipboardRead returns the digest snapshot, never the payload", async () => {
    const { input, lease } = makeInput({});
    const snap = await input.clipboardRead();
    expect(snap).toEqual(CLIP_SNAPSHOT);
    expect(lease.acquisitions).toHaveLength(0);
  });

  it("observe ops refuse unproven surfaces", async () => {
    const { input } = makeInput({
      windows: [panelWindow({ censusAttribution: "foreign" })],
      census: [censusRow()],
    });
    await expect(input.imeModeQuery()).rejects.toMatchObject({
      code: "unproven",
    });
  });
});

describe("mutation gating order", () => {
  it("refuses unproven attribution before any authorization check", async () => {
    const { input, posterCalls, lease } = makeInput({
      windows: [panelWindow({ censusAttribution: "foreign" })],
      census: [censusRow()],
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unproven");
    expect(posterCalls).toHaveLength(0);
    // Non-owned targets skip the lease entirely — the runner refuses
    // `unproven` before anything could post.
    expect(lease.acquisitions).toHaveLength(0);
  });

  it("reports unavailable when a gated scope has no global authorization", async () => {
    const { input, posterCalls } = makeInput({
      seams: { authorizeMutation: ALLOW_GATE },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("unavailable");
    expect(record.authorization).toBeNull();
    expect(record.scope).toBe("session-stream");
    expect(posterCalls).toHaveLength(0);
  });

  it("the production gate refuses even with a grant", async () => {
    const { input } = makeInput({
      seams: { authorization: GRANT },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("refused");
    expect(record.refusal?.reason).toContain("A-SAFETY");
    // The grant was evaluated and recorded before the gate refused.
    expect(record.authorization).toEqual({
      tokenRef: "grant-token-1",
      scope: "target",
    });
  });

  it("a mismatched grant is refused, not silently widened", async () => {
    const { input } = makeInput({
      seams: {
        authorization: { ...GRANT, surfaceKey: "window:9999" },
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("refused");
    expect(record.authorization).toBeNull();
  });
});

describe("focus proof (session-stream)", () => {
  it("refuses focus-unproven before posting when the holder is foreign", async () => {
    const { input, posterCalls } = makeInput({
      focusHolders: [FOREIGN_HOLDER],
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("refused");
    expect(record.refusal?.code).toBe("focus-unproven");
    expect(record.focus.proven?.pid).toBe(FOREIGN_HOLDER.pid);
    expect(posterCalls).toHaveLength(0);
    expect(record.steps).toHaveLength(0);
  });

  it("posts and reports performed when focus is proven", async () => {
    const { input, posterCalls } = makeInput({
      focusHolders: [HOLDER],
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a", { times: 2 });
    expect(record.verdict).toBe("performed");
    expect(record.refusal).toBeNull();
    expect(record.steps).toHaveLength(2);
    expect(record.steps.every((s) => s.outcome === "posted")).toBe(true);
    expect(
      posterCalls.filter((c) => c.method === "keyDown"),
    ).toHaveLength(2);
    expect(record.focus.proven?.pid).toBe(PID);
    expect(record.focus.changedMidSequence).toBe(false);
    expect(record.cleanup.allRestored).toBe(true);
  });

  it("aborts mid-sequence when focus moves — never finishes into new focus", async () => {
    // press times=3, recheckEvery=1: holder reads are
    // before / proof / guard(step1) / guard(step2)=moved / after.
    const { input, posterCalls } = makeInput({
      focusHolders: [HOLDER, HOLDER, HOLDER, FOREIGN_HOLDER, FOREIGN_HOLDER],
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a", { times: 3 });
    expect(record.verdict).toBe("indeterminate");
    expect(record.refusal?.code).toBe("focus-lost");
    expect(record.focus.changedMidSequence).toBe(true);
    // Steps 0 and 1 posted; step 2 was aborted before posting.
    expect(record.steps).toHaveLength(2);
    expect(
      posterCalls.filter((c) => c.method === "keyDown"),
    ).toHaveLength(2);
  });
});

describe("cleanup contract (spec §5.5)", () => {
  it("restores the clipboard snapshot after clipboardWrite", async () => {
    const { input, clipboard, posterCalls } = makeInput({
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.clipboardWrite("payload");
    expect(record.verdict).toBe("performed");
    expect(
      posterCalls.some((c) => c.method === "clipboardWrite"),
    ).toBe(true);
    expect(clipboard.restores).toEqual([CLIP_SNAPSHOT]);
    const restore = record.cleanup.actions.find(
      (a) => a.action.type === "restore-clipboard",
    );
    expect(restore?.outcome).toBe("performed");
    expect(record.cleanup.allRestored).toBe(true);
    // Text payloads are digested, never stored raw.
    const step = record.steps[0];
    expect(step?.payload?.kind).toBe("text");
    expect(step?.payload?.sensitive).toBe(true);
    expect(step?.summary).not.toContain("payload");
  });

  it("runs cleanup even when a step fails mid-plan", async () => {
    const { input, clipboard } = makeInput({
      poster: {
        clipboardWrite: () => {
          throw new Error("pasteboard refused");
        },
      },
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.clipboardWrite("payload");
    expect(record.verdict).toBe("failed");
    expect(record.steps[0]?.outcome).toBe("failed");
    // The prior snapshot was still restored — no residue.
    expect(clipboard.restores).toEqual([CLIP_SNAPSHOT]);
  });

  it("releases a pressed key the poster never confirmed", async () => {
    const { input, posterCalls } = makeInput({
      poster: {
        keyDown: () => {
          throw new Error("post failed after key-down");
        },
      },
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.keyDown("shift");
    expect(record.verdict).toBe("failed");
    // The pressed-set registered before posting, so cleanup issued the
    // residue key-up even though the down itself threw.
    expect(
      posterCalls.some(
        (c) => c.method === "keyUp" && c.args[0] === "shift",
      ),
    ).toBe(true);
  });
});

describe("lease + audit integration", () => {
  it("mutations run inside the GUI lease and audit acquire/mutate/release", async () => {
    const { input, lease } = makeInput({
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record = await input.press("a");
    expect(record.verdict).toBe("performed");
    expect(lease.acquisitions).toEqual(["input:key"]);
    const kinds = lease.events.map((e) => e.kind);
    expect(kinds).toContain("mutate");
    expect(kinds).toContain("lease-release");
    const mutate = lease.events.find((e) => e.kind === "mutate");
    expect(mutate?.outcome).toBe("performed");
  });

  it("a lease refusal throws InputError refused — nothing posts", async () => {
    const { input, posterCalls, lease } = makeInput({
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    lease.refuseNext = true;
    await expect(input.press("a")).rejects.toMatchObject({
      name: "InputError",
      code: "refused",
    });
    expect(posterCalls).toHaveLength(0);
  });
});

describe("audit record shape (spec §5.6)", () => {
  it("carries every §5.6 field with Tier-1a/Tier-1b kept separate", async () => {
    const { input } = makeInput({
      seams: {
        authorization: GRANT,
        authorizeMutation: ALLOW_GATE,
      },
    });
    const record: InputAuditRecord = await input.typeSequential("abc");
    expect(record.operationId).toBe("op-test-1");
    expect(record.target.pid).toBe(PID);
    expect(record.operation).toBe("type-sequential");
    expect(record.operationClass).toBe("mutate-gui");
    expect(record.scope).toBe("session-stream");
    expect(record.authorization).toEqual({
      tokenRef: "grant-token-1",
      scope: "target",
    });
    expect(record.focus.proven).not.toBeNull();
    expect(record.steps.length).toBeGreaterThan(0);
    // Tier-1a (fixture composition report) and Tier-1b (OS-IME
    // end-to-end) are separate fields — neither is claimed here.
    expect(record.tier1a).toBeNull();
    expect(record.tier1b).toBeNull();
    expect(record.valueReadback).toBeNull();
    expect(record.cleanup.allRestored).toBe(true);
    expect(record.verdict).toBe("performed");
    expect(record.observedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("capabilities (spec §7)", () => {
  it("reports per-OS/per-session-kind honesty with gates closed", () => {
    const darwin = inputCapabilities("darwin", "shared");
    expect(darwin.platform).toBe("darwin");
    expect(darwin.sessionKind).toBe("shared");
    expect(darwin.keyPosting.support).toBe("implemented");
    expect(darwin.keyPosting.verification).toBe("automated test");
    expect(darwin.keyPosting.gate).toBe("closed");
    // Session-stream/shared-state input is unavailable without a grant.
    expect(darwin.globalInputAuthorization.support).toBe("unavailable");
    expect(darwin.globalInputAuthorization.gate).toBe("closed");
    // Tier-1b OS-IME end-to-end is never claimed.
    expect(darwin.osImeEndToEnd.support).toBe("unsupported");
    expect(darwin.osImeEndToEnd.verification).toBe("unverified");

    const win32 = inputCapabilities("win32", "dedicated");
    expect(win32.platform).toBe("win32");
    expect(win32.keyPosting.support).toBe("implemented");
    expect(win32.clipboard.support).toBe("implemented");
    expect(win32.globalInputAuthorization.gate).toBe("closed");

    const shared = inputCapabilities("darwin", "shared");
    const dedicated = inputCapabilities("darwin", "dedicated");
    expect(shared.globalInputAuthorization.reason).not.toBe(
      dedicated.globalInputAuthorization.reason,
    );
  });
});

describe("compositionObserve (spec §6, #376)", () => {
  const fixtureJsonl = [
    JSON.stringify({
      v: 1,
      fixture: "ae-a8n-ime-input",
      surface: "cep-composition",
      ts: "2026-01-01T00:00:00.000Z",
      kind: "surface-ready",
      channel: "none",
      tier: "1a",
      provesOsIme: false,
      verification: "implemented",
      data: { compositionObserve: "supported", valueReadback: "supported" },
    }),
    JSON.stringify({
      v: 1,
      fixture: "ae-a8n-ime-input",
      surface: "cep-composition",
      ts: "2026-01-01T00:00:01.000Z",
      kind: "compositionend",
      channel: "composition-event",
      tier: "1a",
      provesOsIme: false,
      verification: "implemented",
      data: { data: "にほん" },
      committedValue: "にほん",
    }),
  ].join("\n");

  it("ingests the fixture self-report seam and returns the Tier-1a record", async () => {
    const { input, lease } = makeInput({
      seams: { fixtureReport: () => fixtureJsonl },
    });
    const report = await input.compositionObserve({ surface: "cep-composition" });
    expect(report.surface).toBe("cep-composition");
    expect(report.tier1a?.verdict).toBe("observed");
    expect(report.tier1a?.provesOsIme).toBe(false);
    expect(report.tier1a?.committedDomValue).toBe("にほん");
    expect(report.coverage[0]?.compositionObserve).toBe("supported");
    expect(report.channels.find((c) => c.channel === "cdp")?.status).toBe("unverified");
    // Observe-class: no GUI lease, no mutation.
    expect(lease.acquisitions).toEqual([]);
  });

  it("accepts per-call fixtureReport text and reports ingest rejections", async () => {
    const { input } = makeInput({});
    const report = await input.compositionObserve({
      fixtureReport: `{bad\n${fixtureJsonl}`,
    });
    expect(report.ingestRejections).toHaveLength(1);
    expect(report.tier1a).toBeNull();
  });

  it("answers honestly when no report source is wired", async () => {
    const { input } = makeInput({});
    const report = await input.compositionObserve();
    expect(report.surface).toBeNull();
    expect(report.tier1a).toBeNull();
    expect(report.coverage).toEqual([]);
    expect(report.channels.length).toBeGreaterThan(0);
  });
});
