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
 *   - `resize`/`restore` are mutate-gui: permitted by the production
 *     gate for owned, census-attributed surfaces since the #358
 *     A-SAFETY class decision (`docs/gui-supervision-safety-gates.md`
 *     §panel mutation) cleared the direct-AX vehicle proven in #357.
 *     `measure`/`identify`/`capture` are observe-class and run wherever
 *     an owned target is attested.
 *   - `capture` photographs only the resolved surface's frame or window —
 *     never the whole screen by default — and records leakage honestly.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { PanelController, type PanelSurfaceOps } from "../panels/controller.js";
import { panelMutationGate } from "../panels/gate.js";
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
import {
  assessGuiObservation,
  MacGuiRecovery,
  type GuiRecoveryOptions,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { runInSession } from "../driver/mac-session.js";
import type { WindowCensus } from "../platform/darwin/window-census.js";
import {
  darwinWindowOpsOps,
  sessionWindowCensus,
  type DarwinWindowOpsExec,
} from "../windowops/darwin.js";
import type { WindowOpsSurfaceOps } from "../windowops/types.js";
import { ensureDarwinWindowOpsHelpers } from "./window-ops.js";
import {
  captureWithStillEvidence,
  type StillEvidenceContext,
} from "../evidence/stills.js";

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
      verification: "verified on real host",
      reason:
        "resolves through the window-ops AXUIElement enumeration " +
        "(AXWindows/AXChildren + census attribution), the path #357 " +
        "proved reaches real AE panels — the System Events enumeration " +
        "this replaced returned almost nothing on AE. Requires the app " +
        "to have been frontmost at least once for AX windows to vend " +
        "(#406); a never-activated instance honestly reports not-found",
    },
    measure: {
      support: "implemented",
      verification: "verified on real host",
      reason:
        "OS geometry readback verified on real host (#358); the in-AE " +
        "channel (ScriptUI Window.size) needs a host-side extension and " +
        "is not wired yet — readbackSource reports that honestly",
    },
    resize: {
      support: "implemented",
      verification: "verified on real host",
      reason:
        "mutate-gui class permitted by panelMutationGate() under the " +
        "#358 A-SAFETY class decision (docs/gui-supervision-safety-gates.md " +
        "§panel mutation): the direct-AX `AXUIElementSetAttributeValue` " +
        "vehicle via the window-ops `act` path, behind owned attribution + " +
        "GUI lease + in-session identity re-verify. Verified end-to-end on " +
        "owned AE 2027 (docs/evidence/realhost-2026-11-27/): " +
        "resize → measure → restore on a real ScriptUI palette. " +
        "Requires the AX window enumeration, which AE only vends after the " +
        "app has been frontmost at least once (#406/#357)",
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
      support: "partial",
      verification: VERIFICATION,
      reason:
        "observe-class pane walk is implemented for macOS (#361, " +
        "ae.dockedPane): bounded AX subtree walk, axPath re-resolution " +
        "and row enumeration. What AE's AX tree actually exposes for " +
        "docked panes is unverified on a real host; resize/capture of a " +
        "docked region remain unsupported because it is not a window",
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
  /** Mutation gate override — production falls back to the A-SAFETY gate. */
  readonly authorizeMutation?: PanelMutationGate;
  /**
   * Directory containing the compiled `window-ops` helper (and
   * `input-focus`, which the same build produces). Production
   * auto-builds from `scripts/isolated-session/*.swift` when absent —
   * a repo checkout or packaged helpers; `null`-equivalent absence
   * (no swiftc / no sources) degrades every panel op to `unavailable`,
   * never to the disproved System Events path.
   */
  readonly helpersDir?: string | undefined;
  readonly settleMs?: number;
  readonly newOperationId?: () => string;
};

/**
 * Bind the platform-neutral controller to the proven macOS channels
 * (#358):
 *
 *   - Observation is the window-ops `state` listing — the compiled
 *     helper's `AXUIElement` walk of `AXWindows`/`AXChildren` plus
 *     `AXFocusedWindow`/`AXIsProcessTrusted` — converted into the
 *     `GuiAppState` `resolvePanelTarget` arbitrates, with the REAL
 *     WindowServer census so `censusAttribution` is computed exactly
 *     like the supervision path. The System Events `UI elements`
 *     enumeration this replaced returns almost nothing on After
 *     Effects (#357), which is why `ae.panel().identify()` could never
 *     resolve a real panel.
 *   - Mutation is `MacGuiRecovery.resizePanelWindow` — the same
 *     lease + audit + identity re-checks every GUI mutation gets,
 *     driving the window-ops helper's `act --op resize`
 *     (`AXUIElementSetAttributeValue`), the vehicle #357 proved on a
 *     real ScriptUI palette.
 *   - Capture stays on `screencapture` inside the target session.
 *
 * Two `MacGuiRecovery` views share the same target options: the
 * observer audits reads; the mutator holds the lease path. Both allow
 * the console session — the target is an explicitly requested,
 * census-attributed window of the caller's own After Effects.
 */
function macPanelOps(
  target: GuiObservationTarget,
  seams: PanelSeams,
): PanelSurfaceOps {
  const {
    authorizeMutation: _gate,
    helpersDir: seamHelpersDir,
    settleMs: _settle,
    newOperationId: _opId,
    ...guiSeams
  } = seams;
  const helpersDir = seamHelpersDir ?? ensureDarwinWindowOpsHelpers();
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    // Panel operations only ever address surfaces the WindowServer census
    // attributes to this owned pid — the console-session refusal that
    // guards recovery's blind clicks does not apply to an explicitly
    // requested, window-scoped resize of the caller's own After Effects.
    // The lease, audit and attribution re-checks are unchanged.
    allowConsoleSession: true,
    ...(helpersDir === null
      ? {}
      : { windowOpsHelpersDir: helpersDir }),
    ...guiSeams,
  };
  const observer = new MacGuiRecovery(base);
  const mutator = new MacGuiRecovery(base);

  // The window-ops observation/vehicle binding. `null` when the helpers
  // cannot be built — every op then reports `unavailable` honestly
  // rather than falling back to a disproved enumeration.
  const windowOps: WindowOpsSurfaceOps | null =
    helpersDir === null
      ? null
      : (() => {
          const runSession = guiSeams.runSession ?? runInSession;
          const exec: DarwinWindowOpsExec = (helper, args) =>
            runSession(target.session, join(helpersDir, helper), [...args], {
              timeoutMs: 30_000,
            });
          return darwinWindowOpsOps({
            pid: target.pid,
            exec,
            census: sessionWindowCensus({
              session: target.session,
              ...(guiSeams.censusRun !== undefined
                ? { censusRun: guiSeams.censusRun }
                : {}),
              ...(guiSeams.runSession !== undefined
                ? { runSession: guiSeams.runSession }
                : {}),
            }),
          });
        })();

  const censusView = (): WindowCensus => {
    if (windowOps === null) {
      return {
        available: false,
        reason:
          "the window-ops helpers are not available on this host, so " +
          "neither the AX window listing nor the full WindowServer " +
          "census can be produced",
      };
    }
    const view = windowOps.censusWindows();
    return view.available
      ? { available: true, windows: view.windows }
      : {
          available: false,
          reason: view.reason ?? "the WindowServer census did not run",
        };
  };

  return {
    observe: () => {
      if (windowOps === null) {
        throw new PanelError(
          "unavailable",
          "the window-ops observation helpers could not be built " +
            "(scripts/isolated-session/window-ops + swiftc); panel " +
            "identification has no proven AX enumeration path without them",
        );
      }
      const listing = windowOps.observeWindows();
      const windows: GuiWindowInfo[] = listing.windows.map((w) => ({
        title: w.title,
        role: w.role,
        subrole: w.subrole,
        buttons: [],
        texts: [],
        ...(w.frame === null
          ? {}
          : {
              frame: {
                x: w.frame.x,
                y: w.frame.y,
                width: w.frame.width,
                height: w.frame.height,
              },
            }),
      }));
      return assessGuiObservation(
        target.pid,
        listing.frontmostPid === target.pid,
        windows,
        censusView(),
      );
    },
    censusWindows: () => {
      const census = censusView();
      return census.available
        ? { available: true, reason: null, windows: census.windows }
        : { available: false, reason: census.reason, windows: [] };
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
  readonly #evidence: StillEvidenceContext | undefined;

  constructor(controller: PanelController, evidence?: StillEvidenceContext) {
    this.#controller = controller;
    this.#evidence = evidence;
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
   * Resize the panel. Mutate-gui: permitted by the production gate for
   * owned, census-attributed surfaces on macOS (#358 class decision);
   * still refuses `unproven`/`refused`/`indeterminate` per the contract.
   */
  resize(size: { width: number; height: number }): Promise<PanelMeasurement> {
    return this.#controller.resize(size);
  }

  /** Restore the frame first resolved by this handle. Same gate as resize. */
  restore(): Promise<PanelMeasurement> {
    return this.#controller.restore();
  }

  /**
   * Capture the resolved surface as an original artifact. Observe-class.
   * When the session supplied an evidence context (#380), the capture is
   * bound into the `ae-a8n.gui-evidence/v1` index as a `screen-still`
   * artifact and the `panel.capture` trace row carries
   * `result.evidenceId`; a refused or failed capture lands in the index
   * gaps instead of being silently lost.
   */
  capture(): Promise<PanelCapture> {
    return Promise.resolve().then(() =>
      this.#evidence === undefined
        ? this.#controller.capture()
        : captureWithStillEvidence(() => this.#controller.capture(), this.#evidence),
    );
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
  evidence?: StillEvidenceContext,
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
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: `docs/gui-supervision-safety-gates.md` is the
    // policy source and `src/panels/gate.ts` its single code flip point —
    // flipped for the #358-cleared resize/restore class.
    // A seam override exists for tests only.
    authorizeMutation: seams.authorizeMutation ?? panelMutationGate(),
    ...(seams.settleMs === undefined ? {} : { settleMs: seams.settleMs }),
    ...(seams.newOperationId === undefined
      ? {}
      : { newOperationId: seams.newOperationId }),
  });
  return new Panel(controller, evidence);
}
