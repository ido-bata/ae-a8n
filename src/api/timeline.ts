/**
 * Public timeline API (#364, `specs/workspace-editing/spec.md` §3 W2).
 *
 * `ae.timeline(locator)` resolves the Timeline docked pane of the owned
 * After Effects instance and returns a `Timeline` handle whose ops run
 * the W2 contract: GUI act (mouse drag/click delivered to a re-verified
 * pane frame) + DOM readback oracle (`comp.time`, `LayerInfo.selected`,
 * `PropertyInfo.selected`/`keyframes` — the #359 host readbacks).
 *
 * Honesty rules carried from `ae.panel()`/`ae.dockedPane()`:
 *
 *   - No owned, attested target → construction throws `TimelineError`
 *     `unavailable`; there is no honest pane to act on.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Every act is `mutate-gui` and stays gated: the production gate
 *     refuses until the A-SAFETY review
 *     (`docs/gui-supervision-safety-gates.md`) clears the class — see
 *     `timelineCapabilities()`.
 *   - `scrub` additionally needs the mouse-drag vehicle, which lands
 *     with the B-IME helpers (#372/#373); until then it reports
 *     `unsupported` at preflight even if the gate were opened.
 *   - `rows()` is observe-class and runs wherever an owned target is
 *     attested.
 */

import { DockedPaneObserver } from "../panels/docked/index.js";
import type { DockedPaneLocator } from "../panels/docked/index.js";
import {
  TimelineController,
  type TimelineControllerOptions,
  type TimelineMutationGate,
  type TimelineOperation,
  type TimelinePostcondition,
} from "../timeline/controller.js";
import { timelineMutationGate } from "../timeline/gate.js";
import {
  TimelineError,
  type NavigateKeyframeRequest,
  type NavigateKeyframeResult,
  type ScrubRequest,
  type ScrubResult,
  type SelectRowRequest,
  type SelectRowResult,
  type TimelineMouseOps,
  type TimelineReadback,
} from "../timeline/types.js";
import type { DockedPaneRow } from "../panels/docked/index.js";
import type { CompInfo, CompTime, LayerInfo, PropertyInfo } from "./types.js";
import type { GuiObservationTarget } from "./gui-state.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import type { Session } from "./session.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";
import {
  macDockedPaneOps,
  type DockedPaneSeams,
} from "./docked-pane.js";

export type {
  NavigateKeyframeRequest,
  NavigateKeyframeResult,
  ScrubRequest,
  ScrubResult,
  SelectRowRequest,
  SelectRowResult,
  TimelineErrorCode,
  TimelineKeyTarget,
  TimelineKeyframeVia,
  TimelineMouseOps,
  TimelineOpRecord,
  TimelinePoint,
  TimelineRulerGeometry,
  TimelineRowLocator,
  TimelineRowVerify,
  TimelineVerdict,
} from "../timeline/types.js";
export { TimelineError } from "../timeline/types.js";
export type { TimelineMutationGate, TimelineOperation, TimelinePostcondition };

/** Per-capability honesty record for `ae.timelineCapabilities()`. */
export type TimelineCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  /** Strongest evidence level, in the repo's verification taxonomy. */
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with the timeline on this platform. */
export type TimelineCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly rows: TimelineCapability;
  readonly scrub: TimelineCapability;
  readonly selectRow: TimelineCapability;
  readonly navigateKeyframe: TimelineCapability;
};

const VERIFICATION: TimelineCapability["verification"] = "automated test";

/**
 * What this build supports for timeline ops on `platform`. Windows is
 * deliberately all-unsupported; on macOS the observe surface is
 * implemented while every mutate-gui act reports `unavailable` behind
 * the A-SAFETY gate (and `scrub` is additionally `partial`-blocked on
 * the not-yet-landed drag vehicle).
 */
export function timelineCapabilities(platform: NodeJS.Platform): TimelineCapabilities {
  if (platform !== "darwin") {
    const unsupported: TimelineCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "timeline operations are implemented for macOS only in this slice; " +
        "no Windows timeline vehicle exists or is verified",
    };
    return {
      platform: platform === "win32" ? "win32" : "darwin",
      rows: unsupported,
      scrub: unsupported,
      selectRow: unsupported,
      navigateKeyframe: unsupported,
    };
  }
  return {
    platform: "darwin",
    rows: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "observe-class pane row enumeration via the #361 bounded AX walk; " +
        "real-host AX fidelity of timeline rows is unverified (spec §11)",
    },
    scrub: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by timelineMutationGate() per the " +
        "A-SAFETY audit; additionally the mouse-drag vehicle lands with " +
        "B-IME (#372/#373) and comp.time tracking a real GUI scrub is an " +
        "unverified real-host assumption (spec §11)",
    },
    selectRow: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by timelineMutationGate() per the " +
        "A-SAFETY audit; the click vehicle exists (MacGuiRecovery.clickAt) " +
        "but row geometry fidelity on AE's timeline is unverified",
    },
    navigateKeyframe: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by timelineMutationGate() per the " +
        "A-SAFETY audit; keyframe diamond/navigator AX fidelity is " +
        "unverified on a real host",
    },
  };
}

/** Seams the production adapter needs; mirrors `DockedPaneSeams`. */
export type TimelineSeams = DockedPaneSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: TimelineMutationGate;
  readonly postcondition?: TimelinePostcondition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

/**
 * Bind the platform-neutral controller to the macOS GUI recovery and the
 * session's DOM readback. Two `MacGuiRecovery` views share the target:
 * observation (console session allowed, like `ae.dockedPane()`) and
 * mutation (same allow-console posture as `ae.panel()` — the lease,
 * audit and attribution re-checks are unchanged, and the gate refuses
 * before either is reached today).
 */
function macTimelineOps(
  target: GuiObservationTarget,
  session: Session,
  seams: TimelineSeams,
): {
  pane: DockedPaneObserver;
  mouse: TimelineMouseOps;
  readback: TimelineReadback;
} {
  const {
    authorizeMutation: _gate,
    postcondition: _post,
    sleep: _sleep,
    now: _now,
    newOperationId: _opId,
    ...guiSeams
  } = seams;
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    // Same posture as ae.panel(): ops only ever address surfaces the
    // census attributes to this owned pid, inside the GUI lease. The
    // console-session refusal guards blind recovery clicks, not an
    // explicitly requested, pane-scoped input op.
    allowConsoleSession: true,
    ...guiSeams,
  };
  const mutator = new MacGuiRecovery(base);
  return {
    pane: new DockedPaneObserver({
      pid: target.pid,
      ops: macDockedPaneOps(target, { ...guiSeams }),
      ...(seams.bounds === undefined ? {} : { bounds: seams.bounds }),
    }),
    mouse: {
      // clickAt returns false on a provable non-post; the controller
      // maps that to `refused`. `drag` is deliberately absent: the
      // CGEvent drag vehicle is B-IME's (#372/#373), so scrub reports
      // `unsupported` until it lands — never a fake drag.
      click: (x, y) => mutator.clickAt(x, y),
    },
    readback: {
      comp: (name) =>
        session.call<CompInfo>("comp.info", "comp.info", { name }),
      compTime: (name) =>
        session.call<CompTime>("comp.time", "comp.time", { name }),
      layers: (name) =>
        session.call<LayerInfo[]>("comp.layers", "comp.layers", { name }),
      property: (comp, layer, path) =>
        session.call<PropertyInfo>("layer.property", "layer.property", {
          comp,
          layer,
          path: [...path],
        }),
    },
  };
}

/**
 * A resolved timeline pane of the session's owned After Effects. Every
 * op re-resolves the pane and re-verifies attribution — a `Timeline` is
 * a locator, not a handle, matching the panel/docked-pane contract.
 */
export class Timeline {
  readonly #controller: TimelineController;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(controller: TimelineController, telemetry?: OpTelemetry) {
    this.#controller = controller;
    this.#telemetry = telemetry;
  }

  /**
   * Scrub the timeline to `frame` (comp frames) by dragging on the
   * ruler. Mutate-gui + gated; the oracle is `comp.time` within ±1
   * frame. Bounded wait — deadline reports `indeterminate`, never resend.
   */
  scrub(request: ScrubRequest): Promise<ScrubResult> {
    return observeOp(this.#telemetry, "timeline.scrub", { request }, () =>
      this.#controller.scrub(request),
    );
  }

  /**
   * Click a visible layer/property row. The row locator is text +
   * optional ordinal; `verify` names the DOM readback that must report
   * the selection. Mutate-gui + gated.
   */
  selectRow(request: SelectRowRequest): Promise<SelectRowResult> {
    return observeOp(this.#telemetry, "timeline.selectRow", { request }, () =>
      this.#controller.selectRow(request),
    );
  }

  /**
   * Navigate to a keyframe — diamond click or navigator arrow. Mutate-gui
   * + gated; the oracle is `comp.time` landing on the expected key.
   */
  navigateToKeyframe(request: NavigateKeyframeRequest): Promise<NavigateKeyframeResult> {
    return observeOp(this.#telemetry, "timeline.navigateToKeyframe", { request }, () =>
      this.#controller.navigateToKeyframe(request),
    );
  }

  /**
   * The pane's visible row identities — observe-class, for building
   * `TimelineRowLocator`s. Never mutates.
   */
  rows(): Promise<DockedPaneRow[]> {
    return observeOp(this.#telemetry, "timeline.rows", undefined, () =>
      Promise.resolve().then(() => this.#controller.rows()),
    );
  }
}

/**
 * The `ae.timeline()` body: attest the owned target, refuse unsupported
 * platforms, and bind the controller. Called with the session's
 * `recoveryTarget()` and `Session` — `target === null` means no owned
 * pid/session is provable.
 */
export function timelineForTarget(
  target: GuiObservationTarget | null,
  session: Session,
  locator: DockedPaneLocator,
  seams: TimelineSeams = {},
): Timeline {
  if (target === null) {
    throw new TimelineError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven pane to resolve a timeline against",
    );
  }
  if (process.platform !== "darwin") {
    throw new TimelineError(
      "unsupported",
      `timeline operations are implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const ops = macTimelineOps(target, session, seams);
  const options: TimelineControllerOptions = {
    pane: ops.pane,
    paneLocator: locator,
    mouse: ops.mouse,
    readback: ops.readback,
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: `docs/gui-supervision-safety-gates.md` is the
    // policy source and `src/timeline/gate.ts` its single code flip point.
    authorizeMutation: seams.authorizeMutation ?? timelineMutationGate(),
    ...(seams.postcondition === undefined
      ? {}
      : { postcondition: seams.postcondition }),
    ...(seams.sleep === undefined ? {} : { sleep: seams.sleep }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
    ...(seams.newOperationId === undefined
      ? {}
      : { newOperationId: seams.newOperationId }),
  };
  return new Timeline(new TimelineController(options), session.telemetry);
}
