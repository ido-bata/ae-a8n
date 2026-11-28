/**
 * Public window-ops API (#366, W4+ of `specs/workspace-editing/spec.md`
 * §9; parent #345 / program #337).
 *
 * `ae.windowOps(locator)` resolves a `PanelTarget` — the same
 * pid-attributed surface resolution `ae.panel()` uses — and returns a
 * `WindowOps` handle whose operations run the window-ops contract:
 * `state` is observe-class; `move`/`resize`/`minimize`/`restore`/
 * `maximize`/`focus` are mutate-gui and stay gated — the production
 * gate refuses them until the A-SAFETY review clears a window-ops
 * class (`docs/gui-supervision-safety-gates.md`).
 *
 * Honesty rules carried from `ae.panel()`/`ae.workspace()`:
 *
 *   - No owned, attested target → construction throws `WindowOpsError`
 *     `unavailable`; there is no honest surface to observe.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Mutations re-resolve the window immediately before the act,
 *     refuse anything the census cannot attribute `"owned"`, never
 *     resend, and report `indeterminate` when the bounded postcondition
 *     wait expires — a `WindowOpsError`, never a guessed success.
 *   - `maximize` sets the frame to the containing display's bounds;
 *     there is no AX "unmaximize" — restoring means `move` + `resize`
 *     against the `before` frame the result reports.
 *   - The helper's AX set semantics on a real After Effects window —
 *     and whether a miniaturized window keeps a readable frame — are
 *     unverified on a real host; every capability reports
 *     `automated test` at most.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MacSession } from "../driver/mac-session.js";
import {
  darwinWindowOpsOps,
  sessionWindowCensus,
  sessionWindowOpsExec,
  DARWIN_WINDOW_OPS_HELPERS,
  type DarwinWindowOpsExec,
} from "../windowops/darwin.js";
import { WindowOpsController } from "../windowops/controller.js";
import { windowOpsMutationGate } from "../windowops/gate.js";
import {
  WindowOpsError,
  type WindowOpsMutationGate,
  type WindowOpsPollOptions,
  type WindowOpsState,
  type WindowOpsSurfaceOps,
  type WindowOpResult,
} from "../windowops/types.js";
import type { PanelLocator } from "../panels/types.js";
import type { GuiObservationSeams, GuiObservationTarget } from "./gui-state.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";

export type {
  WindowOpsActRequest,
  WindowOpsActResult,
  WindowOpsActVerdict,
  WindowOpsCensusView,
  WindowOpsErrorCode,
  WindowOpsListing,
  WindowOpsMutationGate,
  WindowOpsOp,
  WindowOpsPollOptions,
  WindowOpsState,
  WindowOpsSurfaceOps,
  WindowOpsWindowInfo,
  WindowOpResult,
} from "../windowops/types.js";
export { WindowOpsError } from "../windowops/types.js";
export { windowOpsFramesMatch } from "../windowops/controller.js";
export { DEFAULT_WINDOW_OPS_POLL } from "../windowops/types.js";
export { windowOpsMutationGate } from "../windowops/gate.js";

// ---------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------

/** Per-capability honesty record, same shape as `PanelCapability`. */
export type WindowOpsCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with OS windows on this platform. */
export type WindowOpsCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly observe: WindowOpsCapability;
  /**
   * The AXFocusedWindow observe path (#406): resolves ONLY the window
   * holding focus, for hosts where AE vends no AX windows at all.
   * Observe-class; unfocused windows are unreachable by construction.
   */
  readonly focusedObserve: WindowOpsCapability;
  readonly move: WindowOpsCapability;
  readonly resize: WindowOpsCapability;
  readonly minimize: WindowOpsCapability;
  readonly restore: WindowOpsCapability;
  readonly maximize: WindowOpsCapability;
  readonly focus: WindowOpsCapability;
};

/** The verification level every window-ops claim carries until real-host proof. */
const VERIFICATION: WindowOpsCapability["verification"] = "automated test";

const GATE_REASON =
  "mutate-gui class gated off by windowOpsMutationGate() per the " +
  "A-SAFETY audit (docs/gui-supervision-safety-gates.md) and the " +
  "workspace spec §13; the code path exists, is contract-tested and is " +
  "real-host verified on owned AE (#357) but refuses until the audit " +
  "clears the class";

const REAL_HOST_NOTE =
  "the helper's direct AXUIElementSetAttributeValue vehicle resized, " +
  "moved and restored a real ScriptUI palette on owned AE 2027 " +
  "(docs/evidence/realhost-2026-11-27/panel-ax-vehicle-poc.json)";

/**
 * What this build supports for window ops on `platform`. Windows is
 * deliberately all-unsupported: the AX vehicle is macOS-only in this
 * slice.
 */
export function windowOpsCapabilities(
  platform: NodeJS.Platform,
): WindowOpsCapabilities {
  if (platform !== "darwin") {
    const unsupported: WindowOpsCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "window ops are implemented for macOS only in this slice; " +
        "the Windows window-management vehicle is a separate ticket",
    };
    return {
      platform: "win32",
      observe: unsupported,
      focusedObserve: unsupported,
      move: unsupported,
      resize: unsupported,
      minimize: unsupported,
      restore: unsupported,
      maximize: unsupported,
      focus: unsupported,
    };
  }
  const gated = (op: string): WindowOpsCapability => ({
    support: "unavailable",
    verification: VERIFICATION,
    reason: `${GATE_REASON} — window ${op}: ${REAL_HOST_NOTE}`,
  });
  return {
    platform: "darwin",
    observe: {
      support: "implemented",
      verification: "verified on real host",
      reason:
        "AX window listing (frame/miniaturized/main/focused) plus the " +
        "WindowServer census attribution resolved a real ScriptUI " +
        "palette on owned AE 2027 (#357) — but ONLY after the app had " +
        "been frontmost; AE vends zero AX windows while it has never " +
        "been active, so observe can still legitimately return an " +
        "empty listing on a never-activated instance (use " +
        "focusedObserve for the only AX-reachable surface there)",
    },
    focusedObserve: {
      support: "partial",
      verification: "verified on real host",
      reason:
        "AXFocusedWindow resolution against the WindowServer census " +
        "(#406): only the FOCUSED window is reachable — unfocused " +
        "windows are AX-unreachable on AE by construction, and no " +
        "mutation vehicle exists for this path (observe-class only, " +
        "mutations refuse regardless of the gate). Verified on real " +
        "host: resolved the focused ScriptUI palette to census " +
        "windowNumber 2790 (docs/evidence/realhost-2026-11-27/)",
    },
    move: gated("move"),
    resize: gated("resize"),
    minimize: gated("minimize"),
    restore: gated("restore"),
    maximize: gated("maximize"),
    focus: gated("focus"),
  };
}

// ---------------------------------------------------------------------
// Ops dispatch (per-OS delivery channels)
// ---------------------------------------------------------------------

/** What the ops factory needs to build the platform surface ops. */
export type WindowOpsOpsContext = {
  readonly pid: number;
  readonly session: MacSession;
  readonly platform: NodeJS.Platform;
  /**
   * Compiled darwin helper directory when the caller already resolved
   * one (tests, a future packaged-helpers layout). Absent → auto-detect.
   */
  readonly helpersDir?: string | undefined;
  /** Census runner override (tests). */
  readonly censusRun?: Parameters<typeof sessionWindowCensus>[0]["censusRun"];
  /** Session exec override (tests). */
  readonly runSession?: Parameters<typeof sessionWindowCensus>[0]["runSession"];
};

export type WindowOpsOpsFactory = (
  ctx: WindowOpsOpsContext,
) => WindowOpsSurfaceOps | null;

// MARK: - darwin helper resolution

/**
 * Walk up from this module looking for the repo's
 * `scripts/isolated-session/window-ops.swift` + `input-focus.swift`
 * sources. Works from both `src/api/` (vitest) and `dist/api/`
 * (compiled) because both sit two levels under the package root.
 * Returns null when the sources are not shipped — the installed npm
 * package does not carry `scripts/`, so a packaged consumer gets
 * `unavailable`, never a guessed path.
 */
function findDarwinWindowOpsSources(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "scripts", "isolated-session");
    if (
      existsSync(join(candidate, "window-ops.swift")) &&
      existsSync(join(candidate, "input-focus.swift"))
    ) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Compile the darwin window-ops helpers into a content-keyed cache
 * under the OS temp dir and return the binary directory — or null when
 * the sources are absent or `swiftc` fails. Compilation is a one-time,
 * local, side-effect-bounded step (`swiftc -O`, the same invocation
 * the helper headers document); the binaries are Mach-O executables
 * run inside the target session via `runInSession`. This is the *only*
 * place helpers are built; `src/windowops/darwin.ts` itself never
 * compiles.
 */
export function ensureDarwinWindowOpsHelpers(): string | null {
  const srcDir = findDarwinWindowOpsSources();
  if (srcDir === null) {
    return null;
  }
  try {
    const hash = createHash("sha256");
    for (const name of DARWIN_WINDOW_OPS_HELPERS) {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(join(srcDir, `${name}.swift`)));
    }
    const outDir = join(
      tmpdir(),
      `ae-a8n-window-ops-helpers-${hash.digest("hex").slice(0, 16)}`,
    );
    const complete = DARWIN_WINDOW_OPS_HELPERS.every((name) =>
      existsSync(join(outDir, name)),
    );
    if (complete) {
      return outDir;
    }
    mkdirSync(outDir, { recursive: true });
    for (const name of DARWIN_WINDOW_OPS_HELPERS) {
      execFileSync("swiftc", ["-O", join(srcDir, `${name}.swift`), "-o", join(outDir, name)], {
        stdio: "pipe",
      });
    }
    return outDir;
  } catch {
    // No swiftc, no sources readable, compile failure — all mean the
    // helpers are unavailable, which the ops report honestly.
    return null;
  }
}

/**
 * The production ops factory: darwin dispatch to the compiled helpers.
 * Returns null when the platform's helpers cannot be constructed —
 * the caller substitutes fail-closed unavailable ops, never a partial
 * set.
 */
export function platformWindowOpsOps(
  ctx: WindowOpsOpsContext,
): WindowOpsSurfaceOps | null {
  if (ctx.platform !== "darwin") {
    return null;
  }
  const helpersDir = ctx.helpersDir ?? ensureDarwinWindowOpsHelpers();
  if (helpersDir === null) {
    return null;
  }
  const exec: DarwinWindowOpsExec = sessionWindowOpsExec({
    session: ctx.session,
    helpersDir,
  });
  return darwinWindowOpsOps({
    pid: ctx.pid,
    exec,
    census: sessionWindowCensus({
      session: ctx.session,
      ...(ctx.censusRun !== undefined ? { censusRun: ctx.censusRun } : {}),
      ...(ctx.runSession !== undefined ? { runSession: ctx.runSession } : {}),
    }),
  });
}

/**
 * Fail-closed ops for a platform whose helpers cannot be built: every
 * channel exists but reports unavailable/unproven, so calls still flow
 * through the controller and produce honest errors instead of bypassing
 * resolution or crashing on a missing channel.
 */
function unavailableWindowOpsOps(reason: string): WindowOpsSurfaceOps {
  const fail = (): never => {
    throw new WindowOpsError("unavailable", reason);
  };
  return {
    observeWindows: fail,
    censusWindows: () => ({
      available: false,
      reason,
      windows: [],
    }),
    act: () => ({
      verdict: "missing",
      window: null,
      displayFrame: null,
      detail: reason,
    }),
    readFocusHolder: () => null,
  };
}

// ---------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------

/** Seams the production adapter needs; mirrors `WorkspaceSeams`. */
export type WindowOpsSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: WindowOpsMutationGate;
  /** Ops factory override — production dispatches per-OS via `platformWindowOpsOps`. */
  readonly ops?: WindowOpsOpsFactory;
  /** darwin helpers dir override (tests / prebuilt helpers). */
  readonly helpersDir?: string | undefined;
  /** Census runner override (tests). */
  readonly censusRun?: WindowOpsOpsContext["censusRun"];
  /** Session exec override (tests). */
  readonly runSession?: WindowOpsOpsContext["runSession"];
  /** Bounded postcondition polling overrides (defaults in the controller). */
  readonly poll?: WindowOpsPollOptions;
  readonly now?: () => Date;
};

// ---------------------------------------------------------------------
// The WindowOps handle
// ---------------------------------------------------------------------

function requirePoint(
  value: { x?: number; y?: number } | undefined,
  label: string,
): { x: number; y: number } {
  const x = value?.x;
  const y = value?.y;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw new TypeError(`${label} must be { x: number, y: number }`);
  }
  return { x, y };
}

function requireSize(
  value: { width?: number; height?: number } | undefined,
): { width: number; height: number } {
  const width = value?.width;
  const height = value?.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError("size must be { width: number, height: number } with positive dimensions");
  }
  return { width, height };
}

/**
 * A handle to one OS window of the session's owned After Effects
 * (#366). Every method re-resolves the window against a fresh
 * observation — a `WindowOps` is a locator, not a cached identity, so
 * a moved, minimized or replaced window is re-proven or refused rather
 * than silently retargeted.
 */
export class WindowOps {
  readonly #controller: WindowOpsController;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(controller: WindowOpsController, telemetry?: OpTelemetry) {
    this.#controller = controller;
    this.#telemetry = telemetry;
  }

  /**
   * The resolved window's current state — frame, miniaturized/main/
   * focused flags, app-level frontmost evidence and census attribution.
   * Observe-class: no gate, re-observed on every call.
   */
  state(): Promise<WindowOpsState> {
    return observeOp(this.#telemetry, "windowOps.state", undefined, () =>
      Promise.resolve().then(() => this.#controller.state()),
    );
  }

  /**
   * Move the window: AX `set position`, size untouched. Mutate-gui +
   * gated — refuses `refused` while the A-SAFETY gate holds, `unproven`
   * on a non-owned surface, `indeterminate` when the postcondition
   * cannot be proven in the bounded wait.
   */
  move(position: { readonly x: number; readonly y: number }): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.move", { position }, () =>
      this.#controller.move(requirePoint(position, "position")),
    );
  }

  /**
   * Resize the window: AX `set size`, position untouched. Mutate-gui +
   * gated, same refusal vocabulary as `move`.
   */
  resize(size: { readonly width: number; readonly height: number }): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.resize", { size }, () =>
      this.#controller.resize(requireSize(size)),
    );
  }

  /**
   * Minimize the window to the Dock: AX `set miniaturized` true.
   * Mutate-gui + gated.
   */
  minimize(): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.minimize", undefined, () =>
      this.#controller.minimize(),
    );
  }

  /**
   * Un-minimize the window: AX `set miniaturized` false. Mutate-gui +
   * gated.
   */
  restore(): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.restore", undefined, () =>
      this.#controller.restore(),
    );
  }

  /**
   * Maximize the window: frame = the containing display's bounds
   * (position AND size — there is no AX "unmaximize"). Mutate-gui +
   * gated; the result's `before.window.frame` is the honest
   * pre-maximize frame to restore with `move` + `resize`.
   */
  maximize(): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.maximize", undefined, () =>
      this.#controller.maximize(),
    );
  }

  /**
   * Focus/activate the window: app activate + AXMain + AXFocused +
   * AXRaise, proven by the B-IME §5.3 focus-holder readback at pid
   * level. Mutate-gui + gated.
   */
  focus(): Promise<WindowOpResult> {
    return observeOp(this.#telemetry, "windowOps.focus", undefined, () =>
      this.#controller.focus(),
    );
  }
}

/** Options for `windowOpsForTarget` / `ae.windowOps()`. */
export type WindowOpsOptions = {
  /**
   * Resolve through the app's AXFocusedWindow instead of the AX window
   * enumeration (#406) — the explicit opt-in for hosts where After
   * Effects vends no AX windows at all (verified on real host,
   * `docs/evidence/realhost-2026-11-27/`).
   *
   * Observe-class ONLY: `state()` works; every mutation (`move`,
   * `resize`, `minimize`, `restore`, `maximize`, `focus`) refuses
   * `refused` regardless of the mutation gate, because the `act`
   * vehicle addresses enumerated windows and no focused-element
   * mutation vehicle exists yet — that needs a separate A-SAFETY
   * review (`docs/gui-supervision-safety-gates.md`).
   *
   * Hard limitation: ONLY the window currently holding focus is
   * reachable. Unfocused windows are AX-unreachable on AE — a
   * `windowNumber` naming one reports `not-found`, never a guess.
   */
  readonly focusedOnly?: boolean;
};

/**
 * The `ae.windowOps()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller. `target === null`
 * means no owned pid/session is provable — same fail-closed shape as
 * `workspaceForTarget`/`panelForTarget`.
 */
export function windowOpsForTarget(
  target: GuiObservationTarget | null,
  locator: PanelLocator,
  seams: WindowOpsSeams = {},
  options: WindowOpsOptions = {},
  telemetry?: OpTelemetry,
): WindowOps {
  if (target === null) {
    throw new WindowOpsError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window to operate on",
    );
  }
  if (process.platform !== "darwin") {
    throw new WindowOpsError(
      "unsupported",
      `window ops are implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const factory = seams.ops ?? platformWindowOpsOps;
  const built = factory({
    pid: target.pid,
    session: target.session,
    platform: process.platform,
    helpersDir: seams.helpersDir,
    ...(seams.censusRun !== undefined ? { censusRun: seams.censusRun } : {}),
    ...(seams.runSession !== undefined ? { runSession: seams.runSession } : {}),
  });
  const ops =
    built ??
    unavailableWindowOpsOps(
      "no window-ops helpers are available on this platform for this " +
        "session — the darwin helpers need their compiled " +
        "scripts/isolated-session/window-ops + input-focus binaries " +
        "(auto-built from source in a repo checkout) and win32 has no " +
        "window-ops vehicle in this slice",
    );
  const controller = new WindowOpsController({
    pid: target.pid,
    locator,
    ops,
    focusedOnly: options.focusedOnly === true,
    // The A-SAFETY gate is wired explicitly, not left to the
    // controller's fail-closed default: docs/gui-supervision-safety-gates.md
    // is the policy source and src/windowops/gate.ts its flip point.
    authorizeMutation: seams.authorizeMutation ?? windowOpsMutationGate(),
    ...(seams.poll === undefined ? {} : { poll: seams.poll }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
  });
  return new WindowOps(controller, telemetry);
}
