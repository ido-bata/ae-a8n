/**
 * Public comp-view API (#367, `specs/workspace-editing/spec.md` §12 W4+
 * deferred list "comp-view pan/zoom", parent #345 / program #337).
 *
 * `ae.compView(locator)` resolves the Comp viewer docked pane of the
 * owned After Effects instance and returns a `CompView` handle whose
 * ops run the contract: GUI act (mouse drag/click or an authorized
 * session-stream chord, delivered to a re-verified pane frame) +
 * oracle (capture artifact diff + pane geometry — there is no DOM
 * readback for view state, spec §4).
 *
 * Honesty rules carried from `ae.timeline()`/`ae.dockedPane()`:
 *
 *   - No owned, attested target → construction throws `CompViewError`
 *     `unavailable`; there is no honest pane to act on.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Every act is `mutate-gui` and stays gated: the production gate
 *     refuses until the A-SAFETY review
 *     (`docs/gui-supervision-safety-gates.md`) clears the class — see
 *     `compViewCapabilities()`.
 *   - `pan` additionally needs the mouse-drag vehicle, which lands
 *     with the B-IME helpers; until then it reports `unsupported` at
 *     preflight even if the gate were opened.
 *   - `zoom` via `"shortcut"` is session-stream input: it requires a
 *     `GlobalInputAuthorization` grant AND a wired session-stream
 *     poster. Neither exists in production today, so the honest
 *     answers are `unavailable` (no grant) / `unsupported` (no
 *     poster).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DockedPaneObserver } from "../panels/docked/index.js";
import type { DockedPaneLocator } from "../panels/docked/index.js";
import {
  CompViewController,
  type CompViewControllerOptions,
  type CompViewMutationGate,
  type CompViewOperation,
  type CompViewPostcondition,
} from "../comp-view/controller.js";
import { compViewMutationGate } from "../comp-view/gate.js";
import {
  CompViewError,
  type CompViewCapture,
  type CompViewCaptureOps,
  type CompViewMouseOps,
  type CompViewPanRequest,
  type CompViewZoomRequest,
  type PanResult,
  type ZoomResult,
} from "../comp-view/types.js";
import type { PanelFrame } from "../panels/types.js";
import type { SessionStreamPoster } from "../input/session-stream.js";
import type { GuiObservationTarget } from "./gui-state.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import {
  macDockedPaneOps,
  type DockedPaneSeams,
} from "./docked-pane.js";

export type {
  CompViewAxLocator,
  CompViewCapture,
  CompViewCaptureDelta,
  CompViewCaptureOps,
  CompViewErrorCode,
  CompViewMouseOps,
  CompViewOpRecord,
  CompViewPanRequest,
  CompViewVerdict,
  CompViewZoomRequest,
  PanResult,
  ZoomResult,
} from "../comp-view/types.js";
export { CompViewError } from "../comp-view/types.js";
export type {
  CompViewMutationGate,
  CompViewOperation,
  CompViewPostcondition,
};

/** Per-capability honesty record for `ae.compViewCapabilities()`. */
export type CompViewCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  /** Strongest evidence level, in the repo's verification taxonomy. */
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with the comp viewer on this platform. */
export type CompViewCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly pan: CompViewCapability;
  readonly zoom: CompViewCapability;
};

const VERIFICATION: CompViewCapability["verification"] = "automated test";

/**
 * What this build supports for comp-view ops on `platform`. Windows is
 * deliberately all-unsupported; on macOS every mutate-gui act reports
 * `unavailable` behind the A-SAFETY gate, and `pan` is additionally
 * blocked on the not-yet-landed drag vehicle.
 */
export function compViewCapabilities(platform: NodeJS.Platform): CompViewCapabilities {
  if (platform !== "darwin") {
    const unsupported: CompViewCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "comp-view operations are implemented for macOS only in this slice; " +
        "no Windows comp-view vehicle exists or is verified",
    };
    return { platform: platform === "win32" ? "win32" : "darwin", pan: unsupported, zoom: unsupported };
  }
  return {
    platform: "darwin",
    pan: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by compViewMutationGate() per the " +
        "A-SAFETY audit; additionally the mouse-drag vehicle lands with " +
        "B-IME and the comp viewer's custom-drawn pan semantics are " +
        "unverified on a real host (spec §11)",
    },
    zoom: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by compViewMutationGate() per the " +
        "A-SAFETY audit; the dropdown path needs verified AX fidelity of " +
        "the zoom control (unverified) and the shortcut path needs a " +
        "session-stream poster plus global-input authorization — neither " +
        "exists in production yet",
    },
  };
}

/** Seams the production adapter needs; mirrors `DockedPaneSeams`. */
export type CompViewSeams = DockedPaneSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: CompViewMutationGate;
  readonly postcondition?: CompViewPostcondition;
  /**
   * Session-stream poster override — production leaves it absent (the
   * B-IME vehicle is a separate lane), so `via: "shortcut"` refuses
   * `unsupported`/`unavailable` honestly.
   */
  readonly sessionStream?: SessionStreamPoster;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Bind the platform-neutral controller to the macOS GUI recovery. Two
 * `MacGuiRecovery` views share the target: observation (console session
 * allowed, like `ae.dockedPane()`) for pane walks and region captures,
 * and mutation (same allow-console posture as `ae.panel()`/`ae.timeline()`)
 * for clicks — the lease, audit and attribution re-checks are
 * unchanged, and the gate refuses before either is reached today.
 */
function macCompViewOps(
  target: GuiObservationTarget,
  artifactDir: string,
  seams: CompViewSeams,
): {
  pane: DockedPaneObserver;
  mouse: CompViewMouseOps;
  capture: CompViewCaptureOps;
  sessionStream: SessionStreamPoster | undefined;
} {
  const {
    authorizeMutation: _gate,
    postcondition: _post,
    sessionStream: _stream,
    sleep: _sleep,
    now: _now,
    newOperationId: _opId,
    ...guiSeams
  } = seams;
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    // Same posture as ae.panel()/ae.timeline(): ops only ever address
    // surfaces the census attributes to this owned pid, inside the GUI
    // lease. The console-session refusal guards blind recovery clicks,
    // not an explicitly requested, pane-scoped input op.
    allowConsoleSession: true,
    ...guiSeams,
  };
  const observer = new MacGuiRecovery(base);
  const mutator = new MacGuiRecovery(base);
  const captureDir = join(artifactDir, "comp-view");
  mkdirSync(captureDir, { recursive: true });
  return {
    pane: new DockedPaneObserver({
      pid: target.pid,
      ops: macDockedPaneOps(target, { ...guiSeams }),
      ...(seams.bounds === undefined ? {} : { bounds: seams.bounds }),
    }),
    mouse: {
      // clickAt returns false on a provable non-post; the controller
      // maps that to `refused`. `drag` is deliberately absent: the
      // CGEvent drag vehicle is B-IME's, so pan reports `unsupported`
      // until it lands — never a fake drag.
      click: (x, y) => mutator.clickAt(x, y),
    },
    capture: {
      capture: (frame: PanelFrame): CompViewCapture => {
        const path = join(captureDir, `${randomUUID()}.png`);
        observer.captureRegion(path, frame);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (stat === undefined || !stat.isFile()) {
          throw new CompViewError(
            "unavailable",
            `the capture reported success but ${path} does not exist`,
          );
        }
        return { path, sha256: sha256File(path), bytes: stat.size };
      },
    },
    // No session-stream poster is wired in production yet: the B-IME
    // poster/focus vehicle (#372 ships readback only) and the
    // global-input authorization grant path do not exist. `via:
    // "shortcut"` therefore refuses honestly.
    sessionStream: seams.sessionStream,
  };
}

/**
 * A resolved comp-view pane of the session's owned After Effects. Every
 * op re-resolves the pane and re-verifies attribution — a `CompView` is
 * a locator, not a handle, matching the panel/docked-pane contract.
 */
export class CompView {
  readonly #controller: CompViewController;

  constructor(controller: CompViewController) {
    this.#controller = controller;
  }

  /**
   * Pan the comp view by `delta` points inside `viewport`. Mutate-gui +
   * gated; the oracle is the capture diff plus pane geometry. Bounded
   * wait — deadline reports `indeterminate`, never resend.
   */
  pan(request: CompViewPanRequest): Promise<PanResult> {
    return this.#controller.pan(request);
  }

  /**
   * Zoom the comp view — dropdown selection or an authorized
   * session-stream shortcut. Mutate-gui + gated; the oracle is the
   * capture diff plus pane geometry.
   */
  zoom(request: CompViewZoomRequest): Promise<ZoomResult> {
    return this.#controller.zoom(request);
  }
}

/**
 * The `ae.compView()` body: attest the owned target, refuse unsupported
 * platforms, and bind the controller. `target === null` means no owned
 * pid/session is provable — same fail-closed shape as
 * `timelineForTarget`.
 */
export function compViewForTarget(
  target: GuiObservationTarget | null,
  locator: DockedPaneLocator,
  artifactDir: string,
  seams: CompViewSeams = {},
): CompView {
  if (target === null) {
    throw new CompViewError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven pane to resolve a comp view against",
    );
  }
  if (process.platform !== "darwin") {
    throw new CompViewError(
      "unsupported",
      `comp-view operations are implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const ops = macCompViewOps(target, artifactDir, seams);
  const options: CompViewControllerOptions = {
    pane: ops.pane,
    paneLocator: locator,
    mouse: ops.mouse,
    capture: ops.capture,
    ...(ops.sessionStream === undefined ? {} : { sessionStream: ops.sessionStream }),
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: `docs/gui-supervision-safety-gates.md` is the
    // policy source and `src/comp-view/gate.ts` its single code flip point.
    authorizeMutation: seams.authorizeMutation ?? compViewMutationGate(),
    ...(seams.postcondition === undefined
      ? {}
      : { postcondition: seams.postcondition }),
    ...(seams.sleep === undefined ? {} : { sleep: seams.sleep }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
    ...(seams.newOperationId === undefined
      ? {}
      : { newOperationId: seams.newOperationId }),
  };
  return new CompView(new CompViewController(options));
}
