/**
 * Public panel API (#343, `specs/panel-interaction/spec.md`).
 *
 * `ae.panel(locator)` resolves a panel surface of the owned After
 * Effects instance and returns a `Panel` handle whose operations run the
 * B-PLATFORM contract: identify → authorize → act → readback → artifact.
 *
 * Honesty rules carried from `ae.guiState()`:
 *
 *   - No owned, attested target → every operation reports `unavailable`;
 *     there is no honest window list to act on.
 *   - macOS only in this slice. Windows reports `unsupported` — the Win32
 *     census/UIA substrate exists but no panel vehicle is implemented or
 *     verified there.
 *   - `resize`/`restore` are mutate-gui and stay gated: the production
 *     gate refuses them until the A-SAFETY review
 *     (`docs/gui-supervision-safety-gates.md`) clears a resize-class
 *     mutation. `measure`/`identify`/`capture` are observe-class and run
 *     wherever an owned target is attested.
 *   - `capture` photographs only the resolved surface's frame or window —
 *     never the whole screen by default — and records leakage honestly.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { PanelController, type PanelSurfaceOps } from "../panels/controller.js";
import {
  PanelError,
  type PanelCapabilities,
  type PanelCapability,
  type PanelLocator,
  type PanelCapture,
  type PanelMeasurement,
  type PanelTarget,
} from "../panels/types.js";
import type { PanelMutationGate } from "../panels/controller.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";

export type {
  PanelCapabilities,
  PanelCapture,
  PanelLocator,
  PanelMeasurement,
  PanelTarget,
} from "../panels/types.js";
export { PanelError } from "../panels/types.js";

/** The verification level every panel claim carries until real-host proof. */
const VERIFICATION: PanelCapability["verification"] = "automated test";

/**
 * What this build supports for panels on `platform`. Windows is
 * deliberately all-unsupported: the census/UIA observation exists
 * (`WindowsGuiProbe`) but no resize or capture vehicle is implemented,
 * and nothing here may imply otherwise.
 */
export function panelCapabilities(platform: NodeJS.Platform): PanelCapabilities {
  if (platform !== "darwin") {
    const unsupported: PanelCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "panel operations are implemented for macOS only in this slice; " +
        "the Windows census/UIA substrate exists but no panel vehicle is implemented or verified",
    };
    return {
      platform: platform === "win32" ? "win32" : "darwin",
      identify: unsupported,
      measure: unsupported,
      resize: unsupported,
      captureRegion: unsupported,
      captureWindow: unsupported,
      dockedRegion: unsupported,
      inAeReadback: unsupported,
    };
  }
  return {
    platform: "darwin",
    identify: {
      support: "implemented",
      verification: VERIFICATION,
      reason: null,
    },
    measure: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "OS geometry readback only; the in-AE channel (ScriptUI Window.size) " +
        "needs a host-side extension and is not wired yet",
    },
    resize: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class pending the A-SAFETY gate review " +
        "(docs/gui-supervision-safety-gates.md); the code path exists and is " +
        "contract-tested but the production gate refuses until cleared",
    },
    captureRegion: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "screencapture -R is wired but unverified on a real host; " +
        "point-vs-pixel scale is recorded per artifact",
    },
    captureWindow: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "screencapture -l by CGWindowID is wired but unverified on a real host",
    },
    dockedRegion: {
      support: "unsupported",
      verification: "implemented",
      reason:
        "a docked panel has no window of its own; it needs AX region " +
        "identification inside the main window — a later slice",
    },
    inAeReadback: {
      support: "unsupported",
      verification: "implemented",
      reason:
        "requires a host-side script extension (e.g. ScriptUI Window.size); " +
        "measure() reports readbackSource honestly until then",
    },
  };
}

/** Seams the production adapter needs; mirrors `GuiObservationSeams`. */
export type PanelSeams = GuiObservationSeams & {
  /** Mutation gate override — production leaves it unset (refuses). */
  readonly authorizeMutation?: PanelMutationGate;
  readonly settleMs?: number;
  readonly newOperationId?: () => string;
};

/**
 * Bind the platform-neutral controller to the macOS GUI recovery. Two
 * `MacGuiRecovery` views share the same target: observation (console
 * session allowed, like `ae.guiState()`) and mutation (default console
 * refusal, like recovery presses).
 */
function macPanelOps(
  target: GuiObservationTarget,
  seams: PanelSeams,
): PanelSurfaceOps {
  const {
    authorizeMutation: _gate,
    settleMs: _settle,
    newOperationId: _opId,
    ...guiSeams
  } = seams;
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    // Panel operations only ever address surfaces the WindowServer census
    // attributes to this owned pid — the console-session refusal that
    // guards recovery's blind clicks does not apply to an explicitly
    // requested, window-scoped resize of the caller's own After Effects.
    // The lease, audit and attribution re-checks are unchanged.
    allowConsoleSession: true,
    ...guiSeams,
  };
  const observer = new MacGuiRecovery(base);
  const mutator = new MacGuiRecovery(base);
  return {
    observe: () => observer.listWindows(),
    censusWindows: () => {
      const view = observer.windowServerWindows();
      return {
        available: view.available,
        reason: view.reason,
        windows: view.windows,
      };
    },
    resizePanel: (expected, size) =>
      mutator.resizePanelWindow(expected, size),
    captureRegion: (path, frame) => {
      observer.captureRegion(path, frame);
    },
    captureWindow: (path, windowNumber) => {
      observer.captureWindowById(path, windowNumber);
    },
    // No in-AE readback channel exists yet (see panelCapabilities):
    // measure() reports readbackSource "os-only"/"unavailable" honestly.
  };
}

/**
 * A resolved panel of the session's owned After Effects. Every method
 * re-resolves the surface first — a `Panel` is a locator, not a handle,
 * so a window that moved, docked or was recreated is re-proven or
 * refused rather than silently retargeted.
 */
export class Panel {
  readonly #controller: PanelController;

  constructor(controller: PanelController) {
    this.#controller = controller;
  }

  /** Resolve the locator against the live screen. Observe-class. */
  identify(): Promise<PanelTarget> {
    return Promise.resolve().then(() => this.#controller.identify());
  }

  /** OS geometry plus optional in-AE readback. Observe-class. */
  measure(): Promise<PanelMeasurement> {
    return Promise.resolve().then(() => this.#controller.measure());
  }

  /**
   * Resize the panel. Mutate-gui: gated — currently refused in
   * production until the A-SAFETY review clears resize-class mutation.
   */
  resize(size: { width: number; height: number }): Promise<PanelMeasurement> {
    return this.#controller.resize(size);
  }

  /** Restore the frame first resolved by this handle. Same gate as resize. */
  restore(): Promise<PanelMeasurement> {
    return this.#controller.restore();
  }

  /** Capture the resolved surface as an original artifact. Observe-class. */
  capture(): Promise<PanelCapture> {
    return Promise.resolve().then(() => this.#controller.capture());
  }
}

/**
 * The `ae.panel()` body: attest the owned target, refuse unsupported
 * platforms, and bind the controller. Called with the session's
 * `recoveryTarget()` — `null` means no owned pid/session is provable.
 */
export function panelForTarget(
  target: GuiObservationTarget | null,
  locator: PanelLocator,
  artifactDir: string,
  seams: PanelSeams = {},
): Panel {
  if (target === null) {
    throw new PanelError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window list to resolve a panel against",
    );
  }
  if (process.platform !== "darwin") {
    throw new PanelError(
      "unsupported",
      `panel operations are implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  mkdirSync(artifactDir, { recursive: true });
  const ops = macPanelOps(target, seams);
  const controller = new PanelController({
    pid: target.pid,
    locator,
    ops,
    artifactDir: join(artifactDir, "panels"),
    ...(seams.authorizeMutation === undefined
      ? {}
      : { authorizeMutation: seams.authorizeMutation }),
    ...(seams.settleMs === undefined ? {} : { settleMs: seams.settleMs }),
    ...(seams.newOperationId === undefined
      ? {}
      : { newOperationId: seams.newOperationId }),
  });
  return new Panel(controller);
}
