/**
 * Public Effect Controls API (#367,
 * `specs/workspace-editing/spec.md` §12 W4+ deferred list "effect
 * controls", §3 W2 boundary rule, parent #345 / program #337).
 *
 * `ae.effectControls(locator)` resolves the Effect Controls docked pane
 * of the owned After Effects instance and returns an
 * `EffectControls` handle whose ops run the contract: GUI act (click
 * inside a re-verified pane frame, plus an authorized session-stream
 * type+commit for value entry) + oracle (pane row delta for fold;
 * DOM `effect.getParameter` for parameter values).
 *
 * The boundary rule is structural here: this surface can only *read*
 * parameter values — `effect.setParameter` is setup-only per spec §2
 * and is never reachable as an asserted act.
 *
 * Honesty rules carried from `ae.timeline()`/`ae.dockedPane()`:
 *
 *   - No owned, attested target → construction throws
 *     `EffectControlsError` `unavailable`.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Every act is `mutate-gui` and stays gated: the production gate
 *     refuses until the A-SAFETY review
 *     (`docs/gui-supervision-safety-gates.md`) clears the class — see
 *     `effectControlsCapabilities()`.
 *   - `setParameter` additionally needs the session-stream poster and
 *     a `GlobalInputAuthorization` grant; neither exists in production
 *     today, so it refuses `unsupported`/`unavailable` honestly even
 *     if the gate were opened.
 */

import { DockedPaneObserver } from "../panels/docked/index.js";
import type { DockedPaneLocator } from "../panels/docked/index.js";
import {
  EffectControlsController,
  type EffectControlsControllerOptions,
  type EffectControlsMutationGate,
  type EffectControlsOperation,
  type EffectControlsPostcondition,
} from "../effect-controls/controller.js";
import { effectControlsMutationGate } from "../effect-controls/gate.js";
import {
  EffectControlsError,
  type EffectControlsMouseOps,
  type EffectControlsReadback,
  type SetFoldedRequest,
  type SetFoldedResult,
  type SetParameterRequest,
  type SetParameterResult,
} from "../effect-controls/types.js";
import type { PropertyInfo } from "./types.js";
import type { GuiObservationTarget } from "./gui-state.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import type { Session } from "./session.js";
import {
  macDockedPaneOps,
  type DockedPaneSeams,
} from "./docked-pane.js";
import type { SessionStreamPoster } from "../input/session-stream.js";

export type {
  EffectControlsErrorCode,
  EffectControlsMouseOps,
  EffectControlsOpRecord,
  EffectControlsReadback,
  EffectControlsRowLocator,
  EffectControlsVerdict,
  SetFoldedRequest,
  SetFoldedResult,
  SetParameterRequest,
  SetParameterResult,
} from "../effect-controls/types.js";
export { EffectControlsError } from "../effect-controls/types.js";
export { formatParameterValue, parameterValueMatches } from "../effect-controls/controller.js";
export type {
  EffectControlsMutationGate,
  EffectControlsOperation,
  EffectControlsPostcondition,
};

/** Per-capability honesty record for `ae.effectControlsCapabilities()`. */
export type EffectControlsCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  /** Strongest evidence level, in the repo's verification taxonomy. */
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with Effect Controls on this platform. */
export type EffectControlsCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly setFolded: EffectControlsCapability;
  readonly setParameter: EffectControlsCapability;
};

const VERIFICATION: EffectControlsCapability["verification"] = "automated test";

/**
 * What this build supports for Effect Controls ops on `platform`.
 * Windows is deliberately all-unsupported; on macOS every mutate-gui
 * act reports `unavailable` behind the A-SAFETY gate, and
 * `setParameter` is additionally blocked on the session-stream vehicle
 * and global-input authorization.
 */
export function effectControlsCapabilities(
  platform: NodeJS.Platform,
): EffectControlsCapabilities {
  if (platform !== "darwin") {
    const unsupported: EffectControlsCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "Effect Controls operations are implemented for macOS only in this slice; " +
        "no Windows Effect Controls vehicle exists or is verified",
    };
    return {
      platform: platform === "win32" ? "win32" : "darwin",
      setFolded: unsupported,
      setParameter: unsupported,
    };
  }
  return {
    platform: "darwin",
    setFolded: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by effectControlsMutationGate() per " +
        "the A-SAFETY audit; additionally the Effect Controls panel's AX " +
        "fidelity (disclosure triangles, header rows) is unverified on a " +
        "real host (spec §11)",
    },
    setParameter: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by effectControlsMutationGate() per " +
        "the A-SAFETY audit; additionally value entry is session-stream " +
        "input requiring a B-IME poster, focus proof and a " +
        "GlobalInputAuthorization grant — none exists in production yet — " +
        "and the value-field geometry is unverified",
    },
  };
}

/** Seams the production adapter needs; mirrors `DockedPaneSeams`. */
export type EffectControlsSeams = DockedPaneSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: EffectControlsMutationGate;
  readonly postcondition?: EffectControlsPostcondition;
  /**
   * Session-stream poster override — production leaves it absent (the
   * B-IME vehicle is a separate lane), so `setParameter` refuses
   * `unsupported`/`unavailable` honestly.
   */
  readonly sessionStream?: SessionStreamPoster;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

/**
 * Bind the platform-neutral controller to the macOS GUI recovery and
 * the session's DOM readback. Two `MacGuiRecovery` views share the
 * target: observation (console session allowed, like
 * `ae.dockedPane()`) for pane walks and row enumeration, and mutation
 * (same allow-console posture as `ae.panel()`/`ae.timeline()`) for
 * clicks — the lease, audit and attribution re-checks are unchanged,
 * and the gate refuses before either is reached today.
 */
function macEffectControlsOps(
  target: GuiObservationTarget,
  session: Session,
  seams: EffectControlsSeams,
): {
  pane: DockedPaneObserver;
  mouse: EffectControlsMouseOps;
  readback: EffectControlsReadback;
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
    // lease.
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
      click: (x, y) => mutator.clickAt(x, y),
    },
    readback: {
      // `effect.getParameter` — observe channel only. `setParameter`
      // is deliberately absent: it is setup-only per the spec boundary
      // and unreachable from this surface.
      parameter: (comp, layer, effect, parameter) =>
        session.call<PropertyInfo>("effect.getParameter", "effect.getParameter", {
          comp,
          layer,
          effect,
          parameter,
        }),
    },
    // No session-stream poster is wired in production yet: the B-IME
    // poster/focus vehicle and the global-input authorization grant
    // path do not exist. `setParameter` therefore refuses honestly.
    sessionStream: seams.sessionStream,
  };
}

/**
 * A resolved Effect Controls pane of the session's owned After Effects.
 * Every op re-resolves the pane and re-verifies attribution — an
 * `EffectControls` is a locator, not a handle.
 */
export class EffectControls {
  readonly #controller: EffectControlsController;

  constructor(controller: EffectControlsController) {
    this.#controller = controller;
  }

  /**
   * Fold or unfold an effect's parameter section. Mutate-gui + gated;
   * the oracle is the pane's visible-row delta.
   */
  setFolded(request: SetFoldedRequest): Promise<SetFoldedResult> {
    return this.#controller.setFolded(request);
  }

  /**
   * Set an effect parameter's value through the GUI — click the value
   * control, then an authorized session-stream type+commit. Mutate-gui
   * + gated; the oracle is `effect.getParameter`.
   */
  setParameter(request: SetParameterRequest): Promise<SetParameterResult> {
    return this.#controller.setParameter(request);
  }
}

/**
 * The `ae.effectControls()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller. `target === null`
 * means no owned pid/session is provable.
 */
export function effectControlsForTarget(
  target: GuiObservationTarget | null,
  session: Session,
  locator: DockedPaneLocator,
  seams: EffectControlsSeams = {},
): EffectControls {
  if (target === null) {
    throw new EffectControlsError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven pane to resolve Effect Controls against",
    );
  }
  if (process.platform !== "darwin") {
    throw new EffectControlsError(
      "unsupported",
      `Effect Controls operations are implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const ops = macEffectControlsOps(target, session, seams);
  const options: EffectControlsControllerOptions = {
    pane: ops.pane,
    paneLocator: locator,
    mouse: ops.mouse,
    readback: ops.readback,
    ...(ops.sessionStream === undefined ? {} : { sessionStream: ops.sessionStream }),
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: `docs/gui-supervision-safety-gates.md` is the
    // policy source and `src/effect-controls/gate.ts` its single code
    // flip point.
    authorizeMutation: seams.authorizeMutation ?? effectControlsMutationGate(),
    ...(seams.postcondition === undefined
      ? {}
      : { postcondition: seams.postcondition }),
    ...(seams.sleep === undefined ? {} : { sleep: seams.sleep }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
    ...(seams.newOperationId === undefined
      ? {}
      : { newOperationId: seams.newOperationId }),
  };
  return new EffectControls(new EffectControlsController(options));
}
