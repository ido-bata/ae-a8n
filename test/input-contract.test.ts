/**
 * Input operation contract tests (#371, `specs/ime-input/spec.md`
 * §5–§7, parent #344 / program #337).
 *
 * Everything here is contract-level: the taxonomy → class/scope/gate
 * table, the fail-closed authorization verdict, the always-refusing
 * production gate, honest capability reporting, and the audit record
 * shape. No OS posting exists — these tests prove the *contract*, at
 * `automated test` level. Real delivery is #372/#373 and stays
 * `unverified` until a real host runs it.
 */

import { describe, expect, it } from "vitest";

import {
  INPUT_OPERATION_GATES,
  INPUT_OPERATION_KINDS,
  type GlobalInputAuthorization,
  type InputOperationKind,
} from "../src/input/types.js";
import {
  inputAuthorizationVerdict,
  inputMutationGate,
  panelTargetSurfaceKey,
} from "../src/input/gate.js";
import { inputCapabilities, type InputCapability } from "../src/input/capabilities.js";
import type { PanelTarget } from "../src/panels/types.js";

const PID = 4242;

function target(over: Partial<PanelTarget["surface"]> = {}): PanelTarget {
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
      attribution: "owned",
      ...over,
    },
  };
}

const SESSION_AUTH: GlobalInputAuthorization = {
  kind: "session",
  sessionId: "asid-100022",
  tokenRef: "grant-session-1",
};

const TARGET_AUTH: GlobalInputAuthorization = {
  kind: "target",
  pid: PID,
  surfaceKey: "window:777",
  classes: ["mutate-gui"],
  tokenRef: "grant-target-1",
};

describe("input operation taxonomy (spec §6)", () => {
  it("covers every spec operation kind exactly once", () => {
    // The spec §6 table: focus, key, type sequential/direct,
    // select/replace/delete, clipboard, mouse, ime-mode,
    // composition-observe.
    expect(INPUT_OPERATION_KINDS).toEqual([
      "focus",
      "key",
      "type-sequential",
      "type-direct",
      "select",
      "replace",
      "delete",
      "clipboard-read",
      "clipboard-write",
      "mouse-click",
      "mouse-drag",
      "mouse-scroll",
      "mouse-hover",
      "ime-mode-select",
      "ime-mode-query",
      "composition-observe",
    ]);
    for (const kind of INPUT_OPERATION_KINDS) {
      expect(INPUT_OPERATION_GATES[kind]).toBeDefined();
    }
  });

  it("maps session-stream kinds to mutate-gui + global authorization", () => {
    const streamKinds: InputOperationKind[] = [
      "key",
      "type-sequential",
      "type-direct",
      "select",
      "replace",
      "delete",
    ];
    for (const kind of streamKinds) {
      const row = INPUT_OPERATION_GATES[kind];
      expect(row.class).toBe("mutate-gui");
      expect(row.scope).toBe("session-stream");
      expect(row.requiresGlobalInputAuthorization).toBe(true);
    }
  });

  it("maps shared-state kinds to mutate-gui + save/restore + authorization", () => {
    for (const kind of ["clipboard-write", "ime-mode-select"] as const) {
      const row = INPUT_OPERATION_GATES[kind];
      expect(row.class).toBe("mutate-gui");
      expect(row.scope).toBe("shared-state");
      expect(row.requiresGlobalInputAuthorization).toBe(true);
    }
  });

  it("keeps observe and target-scoped kinds free of global authorization", () => {
    const free: InputOperationKind[] = [
      "focus",
      "clipboard-read",
      "mouse-click",
      "mouse-drag",
      "mouse-scroll",
      "mouse-hover",
      "ime-mode-query",
      "composition-observe",
    ];
    for (const kind of free) {
      const row = INPUT_OPERATION_GATES[kind];
      expect(row.requiresGlobalInputAuthorization).toBe(false);
      if (kind === "focus" || kind.startsWith("mouse-")) {
        expect(row.scope).toBe("target");
        expect(row.class).toBe("mutate-gui");
      } else {
        expect(row.class).toBe("observe");
      }
    }
  });
});

describe("global input authorization (spec §5.4)", () => {
  const req = {
    operation: "key" as const,
    operationClass: "mutate-gui" as const,
    target: target(),
    sessionKind: "shared" as const,
  };

  it("reports unavailable — not a silent no-op — when no grant exists", () => {
    const verdict = inputAuthorizationVerdict(undefined, req);
    expect(verdict.status).toBe("unavailable");
    if (verdict.status !== "granted") {
      expect(verdict.code).toBe("unavailable");
      expect(verdict.reason).toContain("GlobalInputAuthorization");
    }
    expect(inputAuthorizationVerdict(null, req).status).toBe("unavailable");
  });

  it("grants a session-scoped authorization only on the named dedicated session", () => {
    const granted = inputAuthorizationVerdict(SESSION_AUTH, {
      ...req,
      sessionKind: "dedicated",
      sessionId: "asid-100022",
    });
    expect(granted).toEqual({ status: "granted", tokenRef: "grant-session-1" });

    const wrongSession = inputAuthorizationVerdict(SESSION_AUTH, {
      ...req,
      sessionKind: "dedicated",
      sessionId: "asid-other",
    });
    expect(wrongSession.status).toBe("refused");

    // A session grant never covers a shared/attached session.
    const shared = inputAuthorizationVerdict(SESSION_AUTH, req);
    expect(shared.status).toBe("refused");
  });

  it("grants a target-scoped authorization only for the named pid/surface/class", () => {
    const granted = inputAuthorizationVerdict(TARGET_AUTH, req);
    expect(granted).toEqual({ status: "granted", tokenRef: "grant-target-1" });

    const wrongClass = inputAuthorizationVerdict(
      { ...TARGET_AUTH, classes: ["observe" as const] },
      req,
    );
    expect(wrongClass.status).toBe("refused");

    const wrongPid = inputAuthorizationVerdict(
      { ...TARGET_AUTH, pid: 9999 },
      req,
    );
    expect(wrongPid.status).toBe("refused");

    const wrongSurface = inputAuthorizationVerdict(
      { ...TARGET_AUTH, surfaceKey: "window:999" },
      req,
    );
    expect(wrongSurface.status).toBe("refused");
  });

  it("derives the surface key from the window number, then the AX index", () => {
    expect(panelTargetSurfaceKey(target())).toBe("window:777");
    expect(panelTargetSurfaceKey(target({ windowNumber: null }))).toBe(
      "window:index:3",
    );
    expect(
      panelTargetSurfaceKey(target({ windowNumber: null, windowIndex: null })),
    ).toBeNull();
  });
});

describe("input mutation gate (fail-closed)", () => {
  it("refuses every class today and cites the safety doc", () => {
    const gate = inputMutationGate();
    for (const scope of ["session-stream", "shared-state", "target"] as const) {
      const verdict = gate("mutate-gui", scope);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason).toContain("gui-supervision-safety-gates.md");
      }
    }
  });
});

describe("input capability reporting (spec §7)", () => {
  it("never claims verified-on-real-host for any capability", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const caps = inputCapabilities(platform, "shared");
      const all = Object.values(caps).filter(
        (v): v is InputCapability => typeof v === "object",
      );
      expect(all.length).toBeGreaterThan(0);
      for (const cap of all) {
        expect(cap.verification).not.toBe("verified on real host");
      }
    }
  });

  it("reports the global-input gate as closed with an honest reason", () => {
    const caps = inputCapabilities("darwin", "shared");
    expect(caps.globalInputAuthorization.support).toBe("unavailable");
    expect(caps.globalInputAuthorization.gate).toBe("closed");
    expect(caps.globalInputAuthorization.reason).toContain("foreign app");
  });

  it("reports delivery capabilities honestly per platform (#373 updated win32)", () => {
    const caps = inputCapabilities("win32", "unknown");
    // #373 landed the Windows helpers: implemented + automated test,
    // gate still closed, delivery unverified — never silent, never
    // "verified on real host".
    expect(caps.keyPosting.support).toBe("implemented");
    expect(caps.keyPosting.verification).toBe("automated test");
    expect(caps.keyPosting.gate).toBe("closed");
    expect(caps.keyPosting.reason).toContain("SendInput");
    expect(caps.keyPosting.reason).toContain("unverified");
    expect(caps.osImeEndToEnd.gate).toBe("needs-human");
    // darwin is unchanged until #372 lands.
    const mac = inputCapabilities("darwin", "unknown");
    expect(mac.keyPosting.support).toBe("unsupported");
    expect(mac.keyPosting.verification).toBe("unverified");
  });

  it("keeps the contract-level pieces honest about what IS implemented", () => {
    const caps = inputCapabilities("darwin", "dedicated");
    // Focus proof + cleanup + authorization logic exist and are
    // fake-tested; delivery does not.
    expect(caps.focus.verification).toBe("automated test");
    expect(caps.globalInputAuthorization.verification).toBe("automated test");
    expect(caps.compositionObserve.verification).toBe("implemented");
  });
});
