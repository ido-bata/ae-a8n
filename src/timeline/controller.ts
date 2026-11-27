/**
 * Timeline operation orchestration (#364, `specs/workspace-editing/spec.md`
 * §3 W2). Platform-neutral: pane resolution and row enumeration arrive
 * through the injected `DockedPaneObserver` (#361), mouse delivery through
 * `TimelineMouseOps`, and every oracle through `TimelineReadback` — so the
 * contract is identical on macOS, Windows (when it lands) and in tests.
 *
 * Safety shape, mirroring `PanelController`/`MenuController`:
 *
 *   - Every op re-resolves the pane locator against a fresh AX walk +
 *     census; nothing caches a pane, row or coordinate across calls.
 *   - Every act is `mutate-gui`: the injected gate is fail-closed (absent
 *     means refuse), `attribution !== "owned"` refuses before anything
 *     posts, and the mouse channel is preflighted — a missing `drag`/`click`
 *     vehicle refuses `unsupported` rather than posting half an op.
 *   - Coordinates come only from re-verified frames: the row's own AX
 *     frame, the navigator node's AX frame, or a `TimelineRulerGeometry`
 *     that must still sit inside the resolved pane frame. Drift is
 *     `stale-locator`; there is no remembered-position fallback (spec §6).
 *   - The oracle is the hybrid pattern: GUI act + DOM readback. The act
 *     channel and the read channel are recorded on every result; nothing
 *     is claimed from one channel alone.
 *   - Postcondition waits are bounded (spec §10): poll `comp.time` /
 *     selection readback until the deadline, then report `indeterminate`
 *     with the last observed value. Resend is prohibited — a second drag
 *     would scrub twice; the only retry is a fresh caller-initiated op.
 *
 * Verification level of everything here: `automated test` against fakes.
 * Whether `comp.time` tracks a real GUI scrub, and whether CGEvent drags
 * land on AE's custom-drawn timeline at all, are the spec's prime
 * real-host questions (§11) — unverified until the real-host lane runs.
 */

import { randomUUID } from "node:crypto";

import { PanelError } from "../panels/types.js";
import type { DockedPaneObserver } from "../panels/docked/index.js";
import type {
  DockedPaneLocator,
  DockedPaneResolution,
} from "../panels/docked/index.js";
import { resolveAxPath } from "../panels/docked/index.js";
import type { PanelFrame } from "../panels/types.js";
import type { CompTime } from "../api/types.js";
import {
  TimelineError,
  type NavigateKeyframeRequest,
  type NavigateKeyframeResult,
  type ScrubRequest,
  type ScrubResult,
  type SelectRowRequest,
  type SelectRowResult,
  type TimelineErrorCode,
  type TimelineMouseOps,
  type TimelineOpRecord,
  type TimelinePoint,
  type TimelineReadback,
  type TimelineRulerGeometry,
  type TimelineRowLocator,
  type TimelineVerdict,
} from "./types.js";

/** The mutate-gui gate row for one timeline op (fail-closed when absent). */
export type TimelineOperation = "scrub" | "select-row" | "navigate-keyframe";

export type TimelineMutationGate = (
  op: TimelineOperation,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Bounded postcondition wait (spec §10). */
export type TimelinePostcondition = {
  /** Total wait budget after the act, ms. Default 3000. */
  readonly timeoutMs?: number;
  /** Poll interval, ms. Default 100. */
  readonly intervalMs?: number;
  /** `comp.time` frame tolerance — spec AC is ±1 frame. Default 1. */
  readonly toleranceFrames?: number;
};

export type TimelineControllerOptions = {
  /** The docked-pane observer bound to the target pid (observe-class). */
  readonly pane: DockedPaneObserver;
  /** The pane locator every op re-resolves — a locator, not a handle. */
  readonly paneLocator: DockedPaneLocator;
  /** Mouse delivery; absent channels refuse `unsupported` at preflight. */
  readonly mouse: TimelineMouseOps;
  /** The DOM readback oracle. */
  readonly readback: TimelineReadback;
  /**
   * The mutate-gui gate. Fail-closed: absent means every op refuses.
   * Production wires `timelineMutationGate()`; tests inject allow/deny.
   */
  readonly authorizeMutation?: TimelineMutationGate;
  readonly postcondition?: TimelinePostcondition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TOLERANCE_FRAMES = 1;
/** Frame-containment slack when checking the ruler sits inside the pane. */
const FRAME_TOLERANCE = 2;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map the panel contract's codes onto this module's vocabulary. */
function asTimelineError(error: unknown): TimelineError {
  if (error instanceof TimelineError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code: TimelineErrorCode =
      error.code === "ambiguous"
        ? "ambiguous-target"
        : error.code;
    return new TimelineError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new TimelineError("unavailable", errorText(error), { cause: error });
}

/** `inner` must sit inside `outer`, within FRAME_TOLERANCE points. */
function frameContains(outer: PanelFrame, inner: PanelFrame): boolean {
  return (
    inner.x >= outer.x - FRAME_TOLERANCE &&
    inner.y >= outer.y - FRAME_TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + FRAME_TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + FRAME_TOLERANCE &&
    inner.width > 0 &&
    inner.height > 0
  );
}

function centerOf(frame: PanelFrame): TimelinePoint {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

function clampX(ruler: TimelineRulerGeometry, x: number): number {
  const lo = ruler.frame.x;
  const hi = ruler.frame.x + ruler.frame.width;
  return Math.min(Math.max(x, lo), hi);
}

export class TimelineController {
  readonly #pane: DockedPaneObserver;
  readonly #paneLocator: DockedPaneLocator;
  readonly #mouse: TimelineMouseOps;
  readonly #readback: TimelineReadback;
  readonly #authorizeMutation: TimelineMutationGate | undefined;
  readonly #postcondition: { timeoutMs: number; intervalMs: number; toleranceFrames: number };
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;

  constructor(options: TimelineControllerOptions) {
    this.#pane = options.pane;
    this.#paneLocator = options.paneLocator;
    this.#mouse = options.mouse;
    this.#readback = options.readback;
    this.#authorizeMutation = options.authorizeMutation;
    this.#postcondition = {
      timeoutMs: options.postcondition?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      intervalMs: options.postcondition?.intervalMs ?? DEFAULT_INTERVAL_MS,
      toleranceFrames:
        options.postcondition?.toleranceFrames ?? DEFAULT_TOLERANCE_FRAMES,
    };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
    this.#newOperationId = options.newOperationId ?? (() => randomUUID());
  }

  /**
   * One fresh pane resolution; `PanelError` codes map onto
   * `TimelineError` so callers see one vocabulary.
   */
  #resolve(): DockedPaneResolution {
    try {
      return this.#pane.identify(this.#paneLocator);
    } catch (error) {
      throw asTimelineError(error);
    }
  }

  #requireOwned(resolution: DockedPaneResolution, op: TimelineOperation): void {
    const attribution = resolution.target.surface.attribution;
    if (attribution !== "owned") {
      throw new TimelineError(
        "unproven",
        `${op} refused: the resolved pane's pid attribution is "${attribution}", ` +
          'not "owned"; acting on it could drive another After Effects instance',
      );
    }
  }

  #requireMutationAllowed(op: TimelineOperation): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for timeline operations; every act is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new TimelineError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /** Fail-closed channel preflight: a missing vehicle refuses before gating effects. */
  #requireChannel(
    op: TimelineOperation,
    channel: "click" | "drag",
  ): void {
    const present =
      channel === "click" ? "click" in this.#mouse : "drag" in this.#mouse;
    if (!present) {
      throw new TimelineError(
        "unsupported",
        `${op} requires the "${channel}" mouse vehicle, which this build does ` +
          "not provide (the B-IME mouse helpers are a separate ticket); " +
          "refusing before anything posts",
      );
    }
  }

  #record(
    operation: TimelineOpRecord["operation"],
    resolution: DockedPaneResolution,
    aimedAt: TimelineOpRecord["aimedAt"],
    verdict: TimelineVerdict,
    refusal: TimelineOpRecord["refusal"],
  ): TimelineOpRecord {
    return {
      operationId: this.#newOperationId(),
      operation,
      operationClass: "mutate-gui",
      target: resolution.target,
      channel: "gui-act+dom-readback",
      aimedAt,
      verdict,
      refusal,
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Post one mouse event. A `false`/void contract: `false` is a provable
   * non-post (the platform reported the click did not land) → `refused`;
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
      throw new TimelineError(
        "indeterminate",
        `the ${channel} was attempted but the delivery channel failed: ${errorText(error)}; ` +
          "the outcome is unknown — re-observe before any retry",
        { cause: error },
      );
    }
    if (outcome === false) {
      throw new TimelineError(
        "refused",
        `the platform ${channel} reported it did not land; nothing was posted — ` +
          "re-resolve and retry",
      );
    }
  }

  /**
   * The bounded postcondition wait (spec §10). Polls `read` until `accept`
   * passes or the deadline expires. A readback that never answers once is
   * `unavailable` — an oracle that cannot be read cannot verify anything.
   * Deadline expiry is `met:false` — the caller reports `indeterminate`,
   * never a resend.
   */
  async #waitForPostcondition<T>(
    read: () => Promise<T> | T,
    accept: (value: T) => boolean,
  ): Promise<{ met: boolean; last: T | null }> {
    const deadline = this.#now().getTime() + this.#postcondition.timeoutMs;
    let last: T | null = null;
    let answered = false;
    for (;;) {
      try {
        const value = await read();
        answered = true;
        last = value;
        if (accept(value)) {
          return { met: true, last };
        }
      } catch {
        // A transient readback failure is a poll miss, not a verdict —
        // the deadline decides. A readback that NEVER answers is caught
        // below as `unavailable`.
      }
      if (this.#now().getTime() >= deadline) {
        break;
      }
      await this.#sleep(this.#postcondition.intervalMs);
    }
    if (!answered) {
      throw new TimelineError(
        "unavailable",
        "the DOM readback oracle never answered during the postcondition " +
          "wait; the act's outcome cannot be verified",
      );
    }
    return { met: false, last };
  }

  /** Match a visible row by text + optional ordinal; never nearest-match. */
  #matchRow(rows: readonly { readonly ordinal: number; readonly text: string; readonly axPath: string; readonly frame: PanelFrame | null }[], locator: TimelineRowLocator): (typeof rows)[number] {
    const want = locator.text.trim();
    const byText = rows.filter((row) => row.text.trim() === want);
    if (byText.length === 0) {
      throw new TimelineError(
        "not-found",
        `no visible row in the timeline pane has text ${JSON.stringify(locator.text)}`,
      );
    }
    let candidates = byText;
    if (locator.ordinal !== undefined) {
      candidates = byText.filter((row) => row.ordinal === locator.ordinal);
      if (candidates.length === 0) {
        const atOrdinal = rows.find((row) => row.ordinal === locator.ordinal);
        throw new TimelineError(
          "stale-locator",
          `row ordinal ${locator.ordinal} does not name a row with text ` +
            `${JSON.stringify(locator.text)}` +
            (atOrdinal === undefined
              ? " (no such ordinal in the current listing)"
              : ` (it is ${JSON.stringify(atOrdinal.text.trim())})`) +
            "; the pane's row listing drifted — re-resolve",
        );
      }
    }
    if (candidates.length > 1) {
      throw new TimelineError(
        "ambiguous-target",
        `${candidates.length} visible rows have text ${JSON.stringify(locator.text)}; ` +
          "pass row.ordinal to disambiguate — nearest-match is prohibited",
        {
          candidates: candidates.map(
            (row) => `#${row.ordinal} axPath=${row.axPath} "${row.text.trim()}"`,
          ),
        },
      );
    }
    const only = candidates[0];
    if (only === undefined) {
      throw new TimelineError("not-found", "row matching produced no candidate");
    }
    return only;
  }

  #requireRowFrame(
    row: { readonly axPath: string; readonly frame: PanelFrame | null },
    what: string,
  ): PanelFrame {
    if (row.frame === null) {
      throw new TimelineError(
        "unproven",
        `${what} (axPath ${row.axPath}) exposes no AX frame; a row without ` +
          "geometry cannot be clicked honestly — reported, not guessed",
      );
    }
    return row.frame;
  }

  /** Map a comp-frame value to a pane-global x inside the ruler rect. */
  #frameToX(ruler: TimelineRulerGeometry, frameValue: number): number {
    const span = ruler.endFrame - ruler.startFrame;
    if (!Number.isFinite(span) || span === 0) {
      throw new TimelineError(
        "unavailable",
        "the ruler geometry has a zero frame span; frame→x mapping is undefined",
      );
    }
    const t = (frameValue - ruler.startFrame) / span;
    return clampX(ruler, ruler.frame.x + t * ruler.frame.width);
  }

  /** The ruler rect must still sit inside the resolved pane frame. */
  #requireRulerInsidePane(
    paneFrame: PanelFrame,
    ruler: TimelineRulerGeometry,
  ): void {
    if (!frameContains(paneFrame, ruler.frame)) {
      throw new TimelineError(
        "stale-locator",
        "the ruler geometry no longer sits inside the resolved pane frame " +
          `(${JSON.stringify(ruler.frame)} vs pane ${JSON.stringify(paneFrame)}); ` +
          "the timeline layout drifted — re-measure and retry",
      );
    }
  }

  /** Enumerate the pane's rows fresh; `PanelError`s map to `TimelineError`. */
  #rows(locator: DockedPaneLocator) {
    try {
      return this.#pane.rows(locator);
    } catch (error) {
      throw asTimelineError(error);
    }
  }

  /**
   * Scrub the timeline: drag on the ruler so the current-time indicator
   * lands on `request.frame`. GUI act (`mouse-drag`) + DOM oracle
   * (`comp.time` within ±toleranceFrames, default ±1 per the spec AC).
   * Bounded wait; deadline → `indeterminate` record, never a resend.
   */
  async scrub(request: ScrubRequest): Promise<ScrubResult> {
    const op: TimelineOperation = "scrub";
    this.#requireMutationAllowed(op);
    this.#requireChannel(op, "drag");
    if (!Number.isFinite(request.frame)) {
      throw new TypeError("scrub frame must be a finite number");
    }

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);
    const paneFrame = resolution.target.surface.frame;
    this.#requireRulerInsidePane(paneFrame, request.ruler);

    const toX = this.#frameToX(request.ruler, request.frame);
    const y = request.ruler.frame.y + request.ruler.frame.height / 2;
    const to: TimelinePoint = { x: toX, y };

    // Drag origin: the indicator's current position when the DOM oracle
    // can name it (hybrid geometry), else a short offset left of the
    // target — the release point is what lands the indicator either way.
    let fromX = toX - Math.min(8, request.ruler.frame.width * 0.02);
    let fromSource: "comp-time-readback" | "target-offset" = "target-offset";
    try {
      const current = await this.#readback.compTime(request.comp);
      fromX = this.#frameToX(request.ruler, current.frame);
      fromSource = "comp-time-readback";
    } catch {
      // No oracle pre-act: the offset drag still lands on release.
    }
    fromX = clampX(request.ruler, fromX);
    if (fromX === toX) {
      // A zero-length drag is a click, not a scrub — nudge inside the ruler.
      fromX = toX > request.ruler.frame.x ? toX - 1 : toX + 1;
      fromX = clampX(request.ruler, fromX);
    }
    const from: TimelinePoint = { x: fromX, y };

    await this.#post("drag", () => this.#mouse.drag!(from, to));

    const tolerance = this.#postcondition.toleranceFrames;
    const wait = await this.#waitForPostcondition(
      () => this.#readback.compTime(request.comp),
      (t: CompTime) => Math.abs(t.frame - request.frame) <= tolerance,
    );
    const observedFrame = wait.last?.frame ?? null;
    const withinTolerance =
      observedFrame === null ? null : Math.abs(observedFrame - request.frame) <= tolerance;
    const met = wait.met && withinTolerance === true;

    const record = this.#record(
      "timeline.scrub",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        rowAxPath: null,
        points: [from, to],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the drag was posted (${fromSource} origin) but comp.time did not ` +
              `reach frame ${request.frame} within ${this.#postcondition.timeoutMs}ms ` +
              `(last observed ${observedFrame === null ? "none" : observedFrame}); ` +
              "no resend was attempted",
          },
    );
    return {
      ...record,
      requestedFrame: request.frame,
      observedFrame,
      toleranceFrames: tolerance,
      withinTolerance,
    };
  }

  /**
   * Click a visible timeline row (layer or property). The row is located
   * by text + optional ordinal — two matches refuse `ambiguous-target`,
   * a drifted ordinal refuses `stale-locator`. The oracle is the DOM
   * selection readback named by `verify` (`LayerInfo.selected` or
   * `PropertyInfo.selected`).
   */
  async selectRow(request: SelectRowRequest): Promise<SelectRowResult> {
    const op: TimelineOperation = "select-row";
    this.#requireMutationAllowed(op);
    this.#requireChannel(op, "click");

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);

    // The oracle channel must exist before the click — a selection act
    // with no readback would be unverifiable GUI mutation.
    const verify = request.verify;
    const readSelection = (): Promise<boolean | null> | boolean | null => {
      if (verify.kind === "layer") {
        return Promise.resolve(this.#readback.layers(verify.comp)).then((layers) => {
          const layer = layers.find((l) => l.name === verify.layer);
          return layer === undefined ? null : layer.selected;
        });
      }
      return Promise.resolve(
        this.#readback.property(verify.comp, verify.layer, verify.path),
      ).then((property) => property.selected ?? null);
    };

    const rows = this.#rows(this.#paneLocator);
    const row = this.#matchRow(rows, request.row);
    const frame = this.#requireRowFrame(row, `row ${JSON.stringify(request.row.text)}`);
    const point = centerOf(frame);

    await this.#post("click", () => this.#mouse.click!(point.x, point.y));

    const wait = await this.#waitForPostcondition(readSelection, (v) => v === true);
    const observedSelected = wait.last ?? null;
    const met = wait.met && observedSelected === true;

    const record = this.#record(
      "timeline.select-row",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        rowAxPath: row.axPath,
        points: [point],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the row click was posted but the selection readback did not ` +
              `report selected within ${this.#postcondition.timeoutMs}ms ` +
              `(last observed ${observedSelected === null ? "unreadable" : observedSelected}); ` +
              "no resend was attempted",
          },
    );
    return {
      ...record,
      row: { text: row.text, ordinal: row.ordinal, axPath: row.axPath },
      observedSelected,
    };
  }

  /**
   * Navigate to a keyframe. `via: "click"` clicks the diamond on the
   * property row at the key's ruler position; `via: "navigator-*"` clicks
   * the recorded navigator arrow and the oracle expects the *adjacent*
   * key relative to the pre-act `comp.time`. The oracle is `comp.time`
   * landing within tolerance of the expected key frame, plus the
   * property/keyframe enumeration taken before the act.
   */
  async navigateToKeyframe(
    request: NavigateKeyframeRequest,
  ): Promise<NavigateKeyframeResult> {
    const op: TimelineOperation = "navigate-keyframe";
    this.#requireMutationAllowed(op);

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);

    // Observe-class precondition: the comp, the property and the key
    // must exist before any GUI act is considered.
    const comp = await this.#readback.comp(request.comp);
    const property = await this.#readback.property(
      request.comp,
      request.layer,
      request.path,
    );
    const keyframes = property.keyframes ?? [];
    if (keyframes.length === 0) {
      throw new TimelineError(
        "not-found",
        `property "${request.path.join(" › ")}" on layer "${request.layer}" ` +
          "has no keyframes to navigate to",
      );
    }

    let key: { readonly index: number; readonly time: number };
    if ("index" in request.key) {
      const index = request.key.index;
      const found = keyframes.find((k) => k.index === index);
      if (found === undefined) {
        throw new TimelineError(
          "not-found",
          `keyframe index ${index} does not exist on the property ` +
            `(${keyframes.length} keyframe(s) enumerated)`,
        );
      }
      key = found;
    } else {
      const targetSeconds = request.key.time;
      const found = keyframes.find(
        (k) => Math.abs(k.time - targetSeconds) <= 1 / comp.frameRate / 2,
      );
      if (found === undefined) {
        throw new TimelineError(
          "not-found",
          `no keyframe at time ${targetSeconds}s on the property ` +
            `(${keyframes.length} keyframe(s) enumerated)`,
        );
      }
      key = found;
    }
    const keyFrame = key.time * comp.frameRate;

    let point: TimelinePoint;
    let aimedRowAxPath: string | null = null;
    let expectedFrame = keyFrame;

    if (request.via === "click") {
      this.#requireChannel(op, "click");
      if (request.ruler === undefined) {
        throw new TypeError('via "click" requires ruler geometry');
      }
      this.#requireRulerInsidePane(
        resolution.target.surface.frame,
        request.ruler,
      );
      // Locate the property row: the caller's locator, or the row whose
      // text is the property's display name.
      const locator: TimelineRowLocator = request.row ?? {
        text: property.name,
      };
      const rows = this.#rows(this.#paneLocator);
      const row = this.#matchRow(rows, locator);
      const frame = this.#requireRowFrame(row, `property row ${JSON.stringify(locator.text)}`);
      aimedRowAxPath = row.axPath;
      const keyX = this.#frameToX(request.ruler, keyFrame);
      point = { x: keyX, y: frame.y + frame.height / 2 };
    } else {
      this.#requireChannel(op, "click");
      if (request.navigator?.axPath === undefined) {
        throw new TypeError(
          `via "${request.via}" requires navigator.axPath — the recorded ` +
            "axPath of the navigator arrow inside the pane's walked tree",
        );
      }
      const node = resolveAxPath(resolution.tree, request.navigator.axPath);
      if (node === null || node === resolution.tree) {
        throw new TimelineError(
          "stale-locator",
          `the recorded navigator axPath "${request.navigator.axPath}" no ` +
            "longer resolves inside the walked pane tree; re-walk",
        );
      }
      if (node.frame === null) {
        throw new TimelineError(
          "unproven",
          `the navigator node (axPath ${node.path}) exposes no AX frame; ` +
            "it cannot be clicked honestly",
        );
      }
      point = centerOf(node.frame);

      // The expected landing is the adjacent key relative to the
      // pre-act current time — computed from the DOM oracle, recorded
      // as requested-vs-observed evidence.
      const before = await this.#readback.compTime(request.comp);
      const currentSeconds = before.time;
      const ordered = [...keyframes].sort((a, b) => a.time - b.time);
      const epsilon = 1 / comp.frameRate / 2;
      const adjacent =
        request.via === "navigator-previous"
          ? [...ordered].reverse().find((k) => k.time < currentSeconds - epsilon)
          : ordered.find((k) => k.time > currentSeconds + epsilon);
      if (adjacent === undefined) {
        throw new TimelineError(
          "not-found",
          `no ${request.via === "navigator-previous" ? "previous" : "next"} ` +
            `keyframe relative to comp time ${currentSeconds}s`,
        );
      }
      key = adjacent;
      expectedFrame = adjacent.time * comp.frameRate;
    }

    await this.#post("click", () => this.#mouse.click!(point.x, point.y));

    const tolerance = this.#postcondition.toleranceFrames;
    const wait = await this.#waitForPostcondition(
      () => this.#readback.compTime(request.comp),
      (t: CompTime) => Math.abs(t.frame - expectedFrame) <= tolerance,
    );
    const observedFrame = wait.last?.frame ?? null;
    const withinTolerance =
      observedFrame === null
        ? null
        : Math.abs(observedFrame - expectedFrame) <= tolerance;
    const met = wait.met && withinTolerance === true;

    const record = this.#record(
      "timeline.navigate-keyframe",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        rowAxPath: aimedRowAxPath,
        points: [point],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the keyframe navigation was posted but comp.time did not land ` +
              `on key ${key.index} (frame ${expectedFrame}) within ` +
              `${this.#postcondition.timeoutMs}ms ` +
              `(last observed ${observedFrame === null ? "none" : observedFrame}); ` +
              "no resend was attempted",
          },
    );
    return {
      ...record,
      key: { index: key.index, time: key.time },
      expectedFrame,
      observedFrame,
      toleranceFrames: tolerance,
      withinTolerance,
    };
  }

  /**
   * The observe-class half: the pane's visible row identities, for
   * callers building `TimelineRowLocator`s. Never mutates.
   */
  rows(): ReturnType<DockedPaneObserver["rows"]> {
    try {
      return this.#pane.rows(this.#paneLocator);
    } catch (error) {
      throw asTimelineError(error);
    }
  }
}
