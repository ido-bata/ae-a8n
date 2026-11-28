/**
 * Comp-view operation orchestration (#367,
 * `specs/workspace-editing/spec.md` §12 W4+ deferred list "comp-view
 * pan/zoom"). Platform-neutral: pane resolution arrives through the
 * injected `DockedPaneObserver` (#361), mouse delivery through
 * `CompViewMouseOps`, the evidence oracle through `CompViewCaptureOps`,
 * and session-stream chords through `SessionStreamPoster` — so the
 * contract is identical on macOS, Windows (when it lands) and in tests.
 *
 * Safety shape, mirroring `TimelineController`:
 *
 *   - Every op re-resolves the pane locator against a fresh AX walk +
 *     census; nothing caches a pane, control or coordinate across
 *     calls. A recorded `axPath` that drifted is `stale-locator`.
 *   - Every act is `mutate-gui`: the injected gate is fail-closed
 *     (absent means refuse), `attribution !== "owned"` refuses before
 *     anything posts, and mouse/session-stream channels are preflighted
 *     — a missing vehicle refuses `unsupported`/`unavailable` rather
 *     than posting half an op.
 *   - Coordinates come only from re-verified frames: the viewport rect
 *     must still sit inside the resolved pane frame, and every click
 *     target is an AX node's own frame inside the walked tree. There is
 *     no remembered-position fallback (spec §6).
 *   - The oracle is capture diff + panel geometry (spec §4): there is
 *     no DOM readback for view state, so a capture that cannot be
 *     obtained, or a pane frame that cannot be re-verified, leaves the
 *     outcome `indeterminate` — never claimed from one channel alone.
 *   - Shortcut chords are session-stream input: they pass
 *     `inputAuthorizationVerdict` (B-IME §5.4) before the poster runs,
 *     and the poster's own audit is the authorization evidence.
 *   - Postcondition waits are bounded (spec §10): poll the capture
 *     until the deadline, then report `indeterminate` with the last
 *     observed state. Resend is prohibited — a second drag pans twice;
 *     the only retry is a fresh caller-initiated op.
 *
 * Verification level of everything here: `automated test` against
 * fakes. Whether AE's comp viewer honors CGEvent drags and what its
 * zoom dropdown exposes in AX are the spec's real-host questions (§11)
 * — unverified until the real-host lane runs.
 */

import { randomUUID } from "node:crypto";

import { PanelError } from "../panels/types.js";
import type { DockedPaneObserver } from "../panels/docked/index.js";
import type {
  DockedPaneLocator,
  DockedPaneResolution,
} from "../panels/docked/index.js";
import { resolveAxPath } from "../panels/docked/index.js";
import type { DockedAxNode } from "../panels/docked/index.js";
import type { PanelFrame } from "../panels/types.js";
import { inputAuthorizationVerdict } from "../input/gate.js";
import { INPUT_OPERATION_GATES } from "../input/types.js";
import type { SessionStreamPoster } from "../input/session-stream.js";
import {
  CompViewError,
  type CompViewAxLocator,
  type CompViewCapture,
  type CompViewCaptureDelta,
  type CompViewCaptureOps,
  type CompViewErrorCode,
  type CompViewMouseOps,
  type CompViewOpRecord,
  type CompViewPanRequest,
  type CompViewVerdict,
  type CompViewZoomRequest,
  type PanResult,
  type ZoomResult,
} from "./types.js";

/** The mutate-gui gate row for one comp-view op (fail-closed when absent). */
export type CompViewOperation = "pan" | "zoom";

export type CompViewMutationGate = (
  op: CompViewOperation,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Bounded postcondition wait + settle delays (spec §10). */
export type CompViewPostcondition = {
  /** Total wait budget for the capture-diff oracle, ms. Default 3000. */
  readonly timeoutMs?: number;
  /** Poll interval, ms. Default 150. */
  readonly intervalMs?: number;
  /** Settle delay after the act before the first post-capture, ms. Default 250. */
  readonly settleMs?: number;
  /**
   * Pane-frame containment slack when comparing geometry before/after,
   * in points. Default 2 — the same slack the AX↔census reconciliation
   * uses.
   */
  readonly frameTolerance?: number;
};

export type CompViewControllerOptions = {
  /** The docked-pane observer bound to the target pid (observe-class). */
  readonly pane: DockedPaneObserver;
  /** The pane locator every op re-resolves — a locator, not a handle. */
  readonly paneLocator: DockedPaneLocator;
  /** Mouse delivery; absent channels refuse `unsupported` at preflight. */
  readonly mouse: CompViewMouseOps;
  /**
   * The capture oracle — required: the spec's only verification
   * channel for view state. Production binds a region capture scoped
   * to the pane frame.
   */
  readonly capture: CompViewCaptureOps;
  /**
   * Session-stream delivery for `via: "shortcut"` zoom. Absent means
   * the shortcut path refuses `unsupported` at preflight — the B-IME
   * poster/focus vehicle is a separate lane.
   */
  readonly sessionStream?: SessionStreamPoster;
  /**
   * The mutate-gui gate. Fail-closed: absent means every op refuses.
   * Production wires `compViewMutationGate()`; tests inject allow/deny.
   */
  readonly authorizeMutation?: CompViewMutationGate;
  readonly postcondition?: CompViewPostcondition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 150;
const DEFAULT_SETTLE_MS = 250;
const DEFAULT_FRAME_TOLERANCE = 2;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map the panel contract's codes onto this module's vocabulary. */
function asCompViewError(error: unknown): CompViewError {
  if (error instanceof CompViewError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code: CompViewErrorCode =
      error.code === "ambiguous" ? "ambiguous-target" : error.code;
    return new CompViewError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new CompViewError("unavailable", errorText(error), { cause: error });
}

/** `inner` must sit inside `outer`, within `tolerance` points. */
function frameContains(
  outer: PanelFrame,
  inner: PanelFrame,
  tolerance: number,
): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance &&
    inner.width > 0 &&
    inner.height > 0
  );
}

/** Two frames are "the same pane" when position and size agree within tolerance. */
function framesMatch(a: PanelFrame, b: PanelFrame, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function centerOf(frame: PanelFrame): { readonly x: number; readonly y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

function clampPoint(
  frame: PanelFrame,
  point: { x: number; y: number },
): { readonly x: number; readonly y: number } {
  return {
    x: Math.min(Math.max(point.x, frame.x), frame.x + frame.width),
    y: Math.min(Math.max(point.y, frame.y), frame.y + frame.height),
  };
}

export class CompViewController {
  readonly #pane: DockedPaneObserver;
  readonly #paneLocator: DockedPaneLocator;
  readonly #mouse: CompViewMouseOps;
  readonly #capture: CompViewCaptureOps;
  readonly #sessionStream: SessionStreamPoster | undefined;
  readonly #authorizeMutation: CompViewMutationGate | undefined;
  readonly #postcondition: {
    timeoutMs: number;
    intervalMs: number;
    settleMs: number;
    frameTolerance: number;
  };
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;

  constructor(options: CompViewControllerOptions) {
    this.#pane = options.pane;
    this.#paneLocator = options.paneLocator;
    this.#mouse = options.mouse;
    this.#capture = options.capture;
    this.#sessionStream = options.sessionStream;
    this.#authorizeMutation = options.authorizeMutation;
    this.#postcondition = {
      timeoutMs: options.postcondition?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      intervalMs: options.postcondition?.intervalMs ?? DEFAULT_INTERVAL_MS,
      settleMs: options.postcondition?.settleMs ?? DEFAULT_SETTLE_MS,
      frameTolerance:
        options.postcondition?.frameTolerance ?? DEFAULT_FRAME_TOLERANCE,
    };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
    this.#newOperationId = options.newOperationId ?? (() => randomUUID());
  }

  /**
   * One fresh pane resolution; `PanelError` codes map onto
   * `CompViewError` so callers see one vocabulary.
   */
  #resolve(): DockedPaneResolution {
    try {
      return this.#pane.identify(this.#paneLocator);
    } catch (error) {
      throw asCompViewError(error);
    }
  }

  #requireOwned(resolution: DockedPaneResolution, op: CompViewOperation): void {
    const attribution = resolution.target.surface.attribution;
    if (attribution !== "owned") {
      throw new CompViewError(
        "unproven",
        `${op} refused: the resolved pane's pid attribution is "${attribution}", ` +
          'not "owned"; acting on it could drive another After Effects instance',
      );
    }
  }

  #requireMutationAllowed(op: CompViewOperation): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for comp-view operations; every act is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new CompViewError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /** Fail-closed channel preflight: a missing vehicle refuses before gating effects. */
  #requireChannel(
    op: CompViewOperation,
    channel: "click" | "drag",
  ): void {
    const present =
      channel === "click" ? "click" in this.#mouse : "drag" in this.#mouse;
    if (!present) {
      throw new CompViewError(
        "unsupported",
        `${op} requires the "${channel}" mouse vehicle, which this build does ` +
          "not provide (the B-IME mouse helpers are a separate ticket); " +
          "refusing before anything posts",
      );
    }
  }

  #record(
    operation: CompViewOpRecord["operation"],
    channel: CompViewOpRecord["channel"],
    resolution: DockedPaneResolution,
    aimedAt: CompViewOpRecord["aimedAt"],
    verdict: CompViewVerdict,
    refusal: CompViewOpRecord["refusal"],
  ): CompViewOpRecord {
    return {
      operationId: this.#newOperationId(),
      operation,
      operationClass: "mutate-gui",
      target: resolution.target,
      channel,
      aimedAt,
      verdict,
      refusal,
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Post one mouse event. `false` is a provable non-post → `refused`;
   * a thrown error means the outcome is unknown → `indeterminate`.
   * Nothing is ever resent here (spec §10).
   */
  async #post(
    channel: "click" | "drag",
    run: () => boolean | void | Promise<boolean | void>,
  ): Promise<void> {
    let outcome: boolean | void;
    try {
      outcome = await run();
    } catch (error) {
      throw new CompViewError(
        "indeterminate",
        `the ${channel} was attempted but the delivery channel failed: ${errorText(error)}; ` +
          "the outcome is unknown — re-observe before any retry",
        { cause: error },
      );
    }
    if (outcome === false) {
      throw new CompViewError(
        "refused",
        `the platform ${channel} reported it did not land; nothing was posted — ` +
          "re-resolve and retry",
      );
    }
  }

  /**
   * Pre-act capture. A capture that cannot run before anything posts is
   * `unavailable` — the op refuses rather than act unverifiably.
   */
  async #captureBefore(resolution: DockedPaneResolution): Promise<CompViewCapture> {
    try {
      return await this.#capture.capture(resolution.target.surface.frame);
    } catch (error) {
      throw new CompViewError(
        "unavailable",
        `the pre-act capture of the comp pane failed: ${errorText(error)}; ` +
          "without the capture-diff oracle the op cannot verify its outcome",
        { cause: error },
      );
    }
  }

  /**
   * The bounded post-act capture wait (spec §10). When
   * `expectChange` is true the capture is polled until it differs from
   * `before` or the deadline expires; when false a single post-act
   * sample is taken and `changed` is reported as evidence only.
   * Returns `met:false` on deadline — the caller reports
   * `indeterminate`, never a resend. A capture that never answers once
   * is `met:false` with `after:null` — the act already posted, so this
   * is evidence, not a thrown refusal.
   */
  async #waitForCaptureDelta(
    before: CompViewCapture,
    expectChange: boolean,
    frame: PanelFrame,
  ): Promise<{ met: boolean; after: CompViewCapture | null; changed: boolean | null }> {
    const deadline = this.#now().getTime() + this.#postcondition.timeoutMs;
    let answered = false;
    for (;;) {
      try {
        // Every post-act capture is scoped to the pane frame the op
        // resolved — the oracle compares like for like even if the
        // pane later moves.
        const after = await this.#capture.capture(frame);
        answered = true;
        const changed = after.sha256 !== before.sha256;
        if (!expectChange || changed) {
          return { met: true, after, changed };
        }
      } catch {
        // A transient capture failure is a poll miss, not a verdict —
        // the deadline decides.
      }
      if (this.#now().getTime() >= deadline) {
        break;
      }
      await this.#sleep(this.#postcondition.intervalMs);
    }
    if (!answered) {
      return { met: false, after: null, changed: null };
    }
    return { met: false, after: null, changed: false };
  }

  /**
   * Post-act pane re-resolution for the geometry half of the oracle.
   * Returns the fresh frame, or `null` fields when the pane can no
   * longer be proven — the caller folds that into `indeterminate`.
   */
  #postActGeometry(
    frameBefore: PanelFrame,
  ): { frame: PanelFrame | null; stable: boolean | null } {
    try {
      const after = this.#resolve();
      const frame = after.target.surface.frame;
      return {
        frame,
        stable: framesMatch(frameBefore, frame, this.#postcondition.frameTolerance),
      };
    } catch {
      return { frame: null, stable: null };
    }
  }

  /** Resolve an axPath locator inside a walked tree with drift checks. */
  #resolveControl(
    resolution: DockedPaneResolution,
    locator: CompViewAxLocator,
    what: string,
  ): DockedAxNode {
    const node = resolveAxPath(resolution.tree, locator.axPath);
    if (node === null || node.path === resolution.tree.path) {
      throw new CompViewError(
        "stale-locator",
        `the recorded axPath "${locator.axPath}" (${what}) no longer resolves ` +
          "inside the walked pane tree; re-walk",
      );
    }
    if (locator.title !== undefined && node.title !== locator.title) {
      throw new CompViewError(
        "stale-locator",
        `axPath "${locator.axPath}" resolves but its title is ` +
          `${JSON.stringify(node.title)}, not ${JSON.stringify(locator.title)}; ` +
          "the pane's AX tree drifted — re-walk",
      );
    }
    if (node.frame === null) {
      throw new CompViewError(
        "unproven",
        `${what} (axPath ${node.path}) exposes no AX frame; a control ` +
          "without geometry cannot be clicked honestly — reported, not guessed",
      );
    }
    return node;
  }

  /**
   * Pan the comp view: drag inside `request.viewport` by `request.delta`
   * points. GUI act (`mouse-drag`) + oracle (capture diff + pane
   * geometry). Bounded wait; deadline → `indeterminate` record, never a
   * resend.
   */
  async pan(request: CompViewPanRequest): Promise<PanResult> {
    const op: CompViewOperation = "pan";
    this.#requireMutationAllowed(op);
    this.#requireChannel(op, "drag");
    if (!Number.isFinite(request.delta.dx) || !Number.isFinite(request.delta.dy)) {
      throw new TypeError("pan delta components must be finite numbers");
    }
    if (request.delta.dx === 0 && request.delta.dy === 0) {
      throw new TypeError("pan delta is zero — there is nothing to drag");
    }

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);
    const paneFrame = resolution.target.surface.frame;
    const tolerance = this.#postcondition.frameTolerance;
    if (!frameContains(paneFrame, request.viewport, tolerance)) {
      throw new CompViewError(
        "stale-locator",
        "the viewport no longer sits inside the resolved pane frame " +
          `(${JSON.stringify(request.viewport)} vs pane ${JSON.stringify(paneFrame)}); ` +
          "the comp layout drifted — re-measure and retry",
      );
    }

    const before = await this.#captureBefore(resolution);

    const from = clampPoint(request.viewport, centerOf(request.viewport));
    const to = clampPoint(request.viewport, {
      x: from.x + request.delta.dx,
      y: from.y + request.delta.dy,
    });
    if (to.x === from.x && to.y === from.y) {
      throw new CompViewError(
        "unavailable",
        "the requested delta clamps to a zero-length drag inside the " +
          "viewport; adjust delta or enlarge the viewport",
      );
    }

    await this.#post("drag", () => this.#mouse.drag!(from, to));
    if (this.#postcondition.settleMs > 0) {
      await this.#sleep(this.#postcondition.settleMs);
    }

    const expectChange = request.expectCaptureChange ?? true;
    const wait = await this.#waitForCaptureDelta(before, expectChange, paneFrame);
    const geometry = this.#postActGeometry(paneFrame);

    const captureDelta: CompViewCaptureDelta | null =
      wait.after === null
        ? null
        : { before, after: wait.after, changed: wait.changed ?? false };
    const met =
      wait.met &&
      geometry.stable === true &&
      (expectChange ? wait.changed === true : true);

    const record = this.#record(
      "comp-view.pan",
      "gui-act+capture-diff+geometry",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        controlAxPath: null,
        points: [from, to],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the drag was posted but the oracle did not confirm the pan ` +
              `(capture ${wait.after === null ? "never answered" : wait.changed ? "changed" : "unchanged"}, ` +
              `geometry ${geometry.stable === null ? "unreadable" : geometry.stable ? "stable" : "moved"}) ` +
              `within ${this.#postcondition.timeoutMs}ms; no resend was attempted`,
          },
    );
    return {
      ...record,
      viewport: request.viewport,
      delta: request.delta,
      paneFrameBefore: paneFrame,
      paneFrameAfter: geometry.frame,
      geometryStable: geometry.stable,
      captureDelta,
    };
  }

  /**
   * Zoom the comp view. `via: "dropdown"` clicks the recorded control,
   * re-walks, and clicks the recorded item; `via: "shortcut"` posts an
   * authorized session-stream chord. Both verify through the same
   * capture-diff + geometry oracle.
   */
  async zoom(request: CompViewZoomRequest): Promise<ZoomResult> {
    const op: CompViewOperation = "zoom";
    this.#requireMutationAllowed(op);
    if (!Number.isFinite(request.percent) || request.percent <= 0) {
      throw new TypeError("zoom percent must be a positive finite number");
    }

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);
    const paneFrame = resolution.target.surface.frame;
    const expectChange = request.expectCaptureChange ?? true;

    let channel: CompViewOpRecord["channel"];
    let aimedControl: string | null = null;
    let points: { x: number; y: number }[] = [];
    let sessionStream:
      | { verdict: string; code: string | null; reason: string | null }
      | null = null;

    if (request.via === "dropdown") {
      this.#requireChannel(op, "click");
      channel = "gui-act+capture-diff+geometry";

      const control = this.#resolveControl(
        resolution,
        request.control,
        "the zoom dropdown control",
      );
      aimedControl = control.path;
      const controlPoint = centerOf(control.frame!);

      const before = await this.#captureBefore(resolution);

      // Act 1: open the dropdown.
      await this.#post("click", () => this.#mouse.click!(controlPoint.x, controlPoint.y));
      if (this.#postcondition.settleMs > 0) {
        await this.#sleep(this.#postcondition.settleMs);
      }

      // Act 2: the item is resolved against a FRESH walk — the popup's
      // tree only exists after the control opened, and a stale item
      // path is `stale-locator`, never a guessed coordinate. The first
      // click already posted, so a resolution failure here is an
      // `indeterminate` record — the dropdown may be open — never a
      // clean refusal.
      let item: DockedAxNode | null = null;
      let itemError: CompViewError | null = null;
      try {
        const reopened = this.#resolve();
        this.#requireOwned(reopened, op);
        item = this.#resolveControl(reopened, request.item, "the zoom dropdown item");
      } catch (error) {
        itemError = asCompViewError(error);
      }
      if (item === null || itemError !== null) {
        const reason = itemError?.message ?? "unknown resolution failure";
        const record = this.#record(
          "comp-view.zoom",
          channel,
          resolution,
          {
            paneAxPath: resolution.pane.path,
            controlAxPath: aimedControl,
            points: [controlPoint],
          },
          "indeterminate",
          {
            code: "indeterminate",
            reason:
              `the zoom control was clicked but the dropdown item could not ` +
              `be resolved (${reason}); the popup's AX tree is unverified ` +
              "— re-walk and retry, no resend was attempted",
          },
        );
        return {
          ...record,
          percent: request.percent,
          via: "dropdown",
          paneFrameBefore: paneFrame,
          paneFrameAfter: null,
          geometryStable: null,
          captureDelta: null,
          sessionStream: null,
        };
      }
      const itemPoint = centerOf(item.frame!);
      points = [controlPoint, itemPoint];

      await this.#post("click", () => this.#mouse.click!(itemPoint.x, itemPoint.y));
      if (this.#postcondition.settleMs > 0) {
        await this.#sleep(this.#postcondition.settleMs);
      }

      const wait = await this.#waitForCaptureDelta(before, expectChange, paneFrame);
      const geometry = this.#postActGeometry(paneFrame);
      const captureDelta: CompViewCaptureDelta | null =
        wait.after === null
          ? null
          : { before, after: wait.after, changed: wait.changed ?? false };
      const met =
        wait.met &&
        geometry.stable === true &&
        (expectChange ? wait.changed === true : true);

      const record = this.#record(
        "comp-view.zoom",
        channel,
        resolution,
        {
          paneAxPath: resolution.pane.path,
          controlAxPath: aimedControl,
          points,
        },
        met ? "performed" : "indeterminate",
        met
          ? null
          : {
              code: "indeterminate",
              reason:
                `the dropdown act completed but the oracle did not confirm ` +
                `the zoom (capture ${wait.after === null ? "never answered" : wait.changed ? "changed" : "unchanged"}, ` +
                `geometry ${geometry.stable === null ? "unreadable" : geometry.stable ? "stable" : "moved"}) ` +
                `within ${this.#postcondition.timeoutMs}ms; no resend was attempted`,
            },
      );
      return {
        ...record,
        percent: request.percent,
        via: "dropdown",
        paneFrameBefore: paneFrame,
        paneFrameAfter: geometry.frame,
        geometryStable: geometry.stable,
        captureDelta,
        sessionStream: null,
      };
    }

    // via === "shortcut": session-stream chord — authorization first.
    channel = "gui-act+session-stream+capture-diff";
    const gateRow = INPUT_OPERATION_GATES.key;
    const authz = inputAuthorizationVerdict(request.authorization, {
      operation: "key",
      operationClass: gateRow.class,
      target: resolution.target,
      sessionKind: request.sessionKind,
      sessionId: request.sessionId,
    });
    if (authz.status !== "granted") {
      throw new CompViewError(
        authz.status === "unavailable" ? "unavailable" : "refused",
        `the zoom shortcut requires global input authorization and none ` +
          `covers it: ${authz.reason}`,
      );
    }
    if (this.#sessionStream === undefined) {
      throw new CompViewError(
        "unsupported",
        'zoom via "shortcut" requires a session-stream poster, which this ' +
          "build does not provide (the B-IME poster/focus vehicle is a " +
          "separate lane); refusing before anything posts",
      );
    }

    const before = await this.#captureBefore(resolution);

    const posted = await this.#sessionStream({
      operation: "key",
      steps: [{ type: "key", key: request.key, modifiers: request.modifiers }],
      summary: `comp-view zoom shortcut ${request.key}`,
    });
    sessionStream = {
      verdict: posted.verdict,
      code: posted.code ?? null,
      reason: posted.reason ?? null,
    };
    if (posted.verdict !== "performed") {
      throw new CompViewError(
        posted.verdict === "refused" ? "refused" : "indeterminate",
        `the session-stream zoom chord was ${posted.verdict}` +
          `${posted.code ? ` (${posted.code})` : ""}` +
          `${posted.reason ? `: ${posted.reason}` : ""}; ` +
          "the outcome is not a clean perform — re-observe before any retry",
      );
    }
    if (this.#postcondition.settleMs > 0) {
      await this.#sleep(this.#postcondition.settleMs);
    }

    const wait = await this.#waitForCaptureDelta(before, expectChange, paneFrame);
    const geometry = this.#postActGeometry(paneFrame);
    const captureDelta: CompViewCaptureDelta | null =
      wait.after === null
        ? null
        : { before, after: wait.after, changed: wait.changed ?? false };
    const met =
      wait.met &&
      geometry.stable === true &&
      (expectChange ? wait.changed === true : true);

    const record = this.#record(
      "comp-view.zoom",
      channel,
      resolution,
      {
        paneAxPath: resolution.pane.path,
        controlAxPath: null,
        points: [],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the authorized chord posted but the oracle did not confirm ` +
              `the zoom (capture ${wait.after === null ? "never answered" : wait.changed ? "changed" : "unchanged"}, ` +
              `geometry ${geometry.stable === null ? "unreadable" : geometry.stable ? "stable" : "moved"}) ` +
              `within ${this.#postcondition.timeoutMs}ms; no resend was attempted`,
          },
    );
    return {
      ...record,
      percent: request.percent,
      via: "shortcut",
      paneFrameBefore: paneFrame,
      paneFrameAfter: geometry.frame,
      geometryStable: geometry.stable,
      captureDelta,
      sessionStream,
    };
  }
}
