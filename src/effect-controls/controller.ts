/**
 * Effect Controls operation orchestration (#367,
 * `specs/workspace-editing/spec.md` §12 W4+ deferred list "effect
 * controls"). Platform-neutral: pane resolution and row enumeration
 * arrive through the injected `DockedPaneObserver` (#361), clicks
 * through `EffectControlsMouseOps`, the DOM oracle through
 * `EffectControlsReadback` (`effect.getParameter`, #359-era host
 * readback), and value entry through `SessionStreamPoster` — so the
 * contract is identical on macOS, Windows (when it lands) and in tests.
 *
 * Safety shape, mirroring `TimelineController`/`CompViewController`:
 *
 *   - Every op re-resolves the pane locator against a fresh AX walk +
 *     census; nothing caches a pane, row or coordinate across calls.
 *     A recorded `axPath` that drifted is `stale-locator`.
 *   - Every act is `mutate-gui`: the injected gate is fail-closed
 *     (absent means refuse), `attribution !== "owned"` refuses before
 *     anything posts, and the click/session-stream channels are
 *     preflighted — a missing vehicle refuses `unsupported`/
 *     `unavailable` rather than posting half an op.
 *   - Coordinates come only from re-verified frames: the matched
 *     row/control node's own AX frame, or the documented value-gutter
 *     inset inside it. There is no remembered-position fallback
 *     (spec §6).
 *   - The boundary rule is enforced structurally: the readback seam
 *     exposes `effect.getParameter` only — `effect.setParameter` is
 *     setup-only and cannot be reached from this module.
 *   - Value entry is session-stream input: it passes
 *     `inputAuthorizationVerdict` (B-IME §5.4) BEFORE the focusing
 *     click posts, because keystrokes land on whatever holds focus.
 *   - Postcondition waits are bounded (spec §10): poll the DOM
 *     readback until the deadline, then report `indeterminate` with
 *     the last observed value. Resend is prohibited.
 *
 * Verification level of everything here: `automated test` against
 * fakes. Whether AE's Effect Controls panel exposes enough AX fidelity
 * to locate headers, disclosure triangles and value fields — and
 * whether a session-stream chord actually lands in the focused field —
 * are unverified real-host questions (spec §11).
 */

import { randomUUID } from "node:crypto";

import { PanelError } from "../panels/types.js";
import type { DockedPaneObserver } from "../panels/docked/index.js";
import type {
  DockedPaneLocator,
  DockedPaneResolution,
} from "../panels/docked/index.js";
import {
  collectDescendants,
  nodeText,
  resolveAxPath,
} from "../panels/docked/index.js";
import type { DockedAxNode } from "../panels/docked/index.js";
import type { GuiFrame } from "../driver/gui-recovery.js";
import type { ParameterValue, PropertyInfo } from "../api/types.js";
import { inputAuthorizationVerdict } from "../input/gate.js";
import { INPUT_OPERATION_GATES } from "../input/types.js";
import type { SessionStreamPoster } from "../input/session-stream.js";
import {
  EffectControlsError,
  type EffectControlsErrorCode,
  type EffectControlsMouseOps,
  type EffectControlsOpRecord,
  type EffectControlsReadback,
  type EffectControlsRowLocator,
  type EffectControlsVerdict,
  type SetFoldedRequest,
  type SetFoldedResult,
  type SetParameterRequest,
  type SetParameterResult,
} from "./types.js";

/** The mutate-gui gate row for one Effect Controls op (fail-closed when absent). */
export type EffectControlsOperation = "set-folded" | "set-parameter";

export type EffectControlsMutationGate = (
  op: EffectControlsOperation,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Bounded postcondition wait + settle delays (spec §10). */
export type EffectControlsPostcondition = {
  /** Total wait budget for the DOM readback, ms. Default 3000. */
  readonly timeoutMs?: number;
  /** Poll interval, ms. Default 100. */
  readonly intervalMs?: number;
  /** Settle delay after a click before typing/readback, ms. Default 150. */
  readonly settleMs?: number;
  /** Default `valueTolerance` for `setParameter`, absolute. Default 1e-6. */
  readonly valueTolerance?: number;
};

export type EffectControlsControllerOptions = {
  /** The docked-pane observer bound to the target pid (observe-class). */
  readonly pane: DockedPaneObserver;
  /** The pane locator every op re-resolves — a locator, not a handle. */
  readonly paneLocator: DockedPaneLocator;
  /** Click delivery; absent refuses `unsupported` at preflight. */
  readonly mouse: EffectControlsMouseOps;
  /** The DOM readback oracle (`effect.getParameter`). */
  readonly readback: EffectControlsReadback;
  /**
   * Session-stream delivery for the type+commit leg of `setParameter`.
   * Absent means the op refuses `unsupported` at preflight — the B-IME
   * poster/focus vehicle is a separate lane.
   */
  readonly sessionStream?: SessionStreamPoster;
  /**
   * The mutate-gui gate. Fail-closed: absent means every op refuses.
   * Production wires `effectControlsMutationGate()`; tests inject
   * allow/deny.
   */
  readonly authorizeMutation?: EffectControlsMutationGate;
  readonly postcondition?: EffectControlsPostcondition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly newOperationId?: () => string;
};

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_SETTLE_MS = 150;
const DEFAULT_VALUE_TOLERANCE = 1e-6;
/** Inset from a row's right edge used by the value-gutter fallback, points. */
const VALUE_GUTTER_INSET = 24;
/** Inset from a header's left edge used by the header-gutter fallback, points. */
const HEADER_GUTTER_INSET = 10;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map the panel contract's codes onto this module's vocabulary. */
function asEffectControlsError(error: unknown): EffectControlsError {
  if (error instanceof EffectControlsError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code: EffectControlsErrorCode =
      error.code === "ambiguous" ? "ambiguous-target" : error.code;
    return new EffectControlsError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new EffectControlsError("unavailable", errorText(error), { cause: error });
}

function centerOf(frame: GuiFrame): { readonly x: number; readonly y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

/** Format a `ParameterValue` as the text a value field would receive. */
export function formatParameterValue(value: ParameterValue): string {
  return Array.isArray(value) ? value.join(" ") : String(value);
}

/**
 * Compare an observed `PropertyInfo.value` against the requested value
 * elementwise within `tolerance`. `undefined`/non-scalar shapes never
 * match — an unreadable oracle is not a pass.
 */
export function parameterValueMatches(
  observed: ParameterValue | readonly number[] | number | undefined,
  expected: ParameterValue,
  tolerance: number,
): boolean {
  if (observed === undefined || observed === null) {
    return false;
  }
  const obs = Array.isArray(observed) ? observed : [observed];
  const exp = Array.isArray(expected) ? expected : [expected];
  if (obs.length !== exp.length) {
    return false;
  }
  return exp.every((want, i) => {
    const got = obs[i];
    return typeof got === "number" && Math.abs(got - want) <= tolerance;
  });
}

export class EffectControlsController {
  readonly #pane: DockedPaneObserver;
  readonly #paneLocator: DockedPaneLocator;
  readonly #mouse: EffectControlsMouseOps;
  readonly #readback: EffectControlsReadback;
  readonly #sessionStream: SessionStreamPoster | undefined;
  readonly #authorizeMutation: EffectControlsMutationGate | undefined;
  readonly #postcondition: {
    timeoutMs: number;
    intervalMs: number;
    settleMs: number;
    valueTolerance: number;
  };
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;

  constructor(options: EffectControlsControllerOptions) {
    this.#pane = options.pane;
    this.#paneLocator = options.paneLocator;
    this.#mouse = options.mouse;
    this.#readback = options.readback;
    this.#sessionStream = options.sessionStream;
    this.#authorizeMutation = options.authorizeMutation;
    this.#postcondition = {
      timeoutMs: options.postcondition?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      intervalMs: options.postcondition?.intervalMs ?? DEFAULT_INTERVAL_MS,
      settleMs: options.postcondition?.settleMs ?? DEFAULT_SETTLE_MS,
      valueTolerance:
        options.postcondition?.valueTolerance ?? DEFAULT_VALUE_TOLERANCE,
    };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
    this.#newOperationId = options.newOperationId ?? (() => randomUUID());
  }

  /**
   * One fresh pane resolution; `PanelError` codes map onto
   * `EffectControlsError` so callers see one vocabulary.
   */
  #resolve(): DockedPaneResolution {
    try {
      return this.#pane.identify(this.#paneLocator);
    } catch (error) {
      throw asEffectControlsError(error);
    }
  }

  #requireOwned(resolution: DockedPaneResolution, op: EffectControlsOperation): void {
    const attribution = resolution.target.surface.attribution;
    if (attribution !== "owned") {
      throw new EffectControlsError(
        "unproven",
        `${op} refused: the resolved pane's pid attribution is "${attribution}", ` +
          'not "owned"; acting on it could drive another After Effects instance',
      );
    }
  }

  #requireMutationAllowed(op: EffectControlsOperation): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for Effect Controls operations; every " +
        "act is a mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new EffectControlsError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /** Fail-closed channel preflight: a missing vehicle refuses before gating effects. */
  #requireChannel(op: EffectControlsOperation): void {
    if (!("click" in this.#mouse)) {
      throw new EffectControlsError(
        "unsupported",
        `${op} requires the "click" mouse vehicle, which this build does ` +
          "not provide; refusing before anything posts",
      );
    }
  }

  #record(
    operation: EffectControlsOpRecord["operation"],
    channel: EffectControlsOpRecord["channel"],
    resolution: DockedPaneResolution,
    aimedAt: EffectControlsOpRecord["aimedAt"],
    verdict: EffectControlsVerdict,
    refusal: EffectControlsOpRecord["refusal"],
  ): EffectControlsOpRecord {
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
   * Post one click. `false` is a provable non-post → `refused`; a
   * thrown error means the outcome is unknown → `indeterminate`.
   * Nothing is ever resent here (spec §10).
   */
  async #post(run: () => boolean | void | Promise<boolean | void>): Promise<void> {
    let outcome: boolean | void;
    try {
      outcome = await run();
    } catch (error) {
      throw new EffectControlsError(
        "indeterminate",
        `the click was attempted but the delivery channel failed: ${errorText(error)}; ` +
          "the outcome is unknown — re-observe before any retry",
        { cause: error },
      );
    }
    if (outcome === false) {
      throw new EffectControlsError(
        "refused",
        "the platform click reported it did not land; nothing was posted — " +
          "re-resolve and retry",
      );
    }
  }

  /**
   * The bounded postcondition wait (spec §10). Polls `read` until
   * `accept` passes or the deadline expires. Deadline expiry is
   * `met:false` — the caller reports `indeterminate`, never a resend.
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
        // the deadline decides.
      }
      if (this.#now().getTime() >= deadline) {
        break;
      }
      await this.#sleep(this.#postcondition.intervalMs);
    }
    if (!answered) {
      throw new EffectControlsError(
        "unavailable",
        "the DOM readback oracle never answered during the postcondition " +
          "wait; the act's outcome cannot be verified",
      );
    }
    return { met: false, last };
  }

  /**
   * Match a visible node by text + optional ordinal among the
   * text-matching candidates in walk order; never nearest-match.
   * Only nodes exposing a frame are candidates — geometry is required
   * for an honest click.
   */
  #matchTextNode(
    tree: DockedAxNode,
    locator: EffectControlsRowLocator,
    what: string,
  ): DockedAxNode {
    const want = locator.text.trim();
    const byText = collectDescendants(tree).filter(
      (node) => nodeText(node)?.trim() === want && node.frame !== null,
    );
    if (byText.length === 0) {
      throw new EffectControlsError(
        "not-found",
        `no framed node in the Effect Controls pane has text ${JSON.stringify(locator.text)}`,
      );
    }
    let candidates = byText;
    if (locator.ordinal !== undefined) {
      candidates = byText.filter((_, index) => index + 1 === locator.ordinal);
      if (candidates.length === 0) {
        throw new EffectControlsError(
          "stale-locator",
          `ordinal ${locator.ordinal} does not name a ${JSON.stringify(locator.text)} ` +
            `candidate (${byText.length} text-matching node(s) walked); ` +
            "the pane's listing drifted — re-resolve",
        );
      }
    }
    if (candidates.length > 1) {
      throw new EffectControlsError(
        "ambiguous-target",
        `${candidates.length} framed nodes have text ${JSON.stringify(locator.text)}; ` +
          "pass row.ordinal to disambiguate — nearest-match is prohibited",
        {
          candidates: candidates.map(
            (node) => `${node.path} role=${node.role} "${nodeText(node)?.trim()}"`,
          ),
        },
      );
    }
    const only = candidates[0];
    if (only === undefined) {
      throw new EffectControlsError("not-found", `${what} matching produced no candidate`);
    }
    return only;
  }

  /** The first framed disclosure-ish descendant of `header`, BFS order. */
  #findDisclosure(header: DockedAxNode): DockedAxNode | null {
    const queue: DockedAxNode[] = [...header.children];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) {
        break;
      }
      if (
        node.frame !== null &&
        /disclosure|button|checkbox|radio|toggle/i.test(node.role)
      ) {
        return node;
      }
      queue.push(...node.children);
    }
    return null;
  }

  /**
   * Fold or unfold an effect's parameter section. The act is a click on
   * the header's disclosure control (or the documented header gutter
   * when the walked tree exposes no disclosure node — the real-host
   * AX fidelity question, spec §11). The oracle is the pane's visible
   * row delta: folding must remove rows, unfolding must add them.
   */
  async setFolded(request: SetFoldedRequest): Promise<SetFoldedResult> {
    const op: EffectControlsOperation = "set-folded";
    this.#requireMutationAllowed(op);
    this.#requireChannel(op);
    if (request.effect.trim().length === 0) {
      throw new TypeError("setFolded effect name must be non-empty");
    }

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);

    const header = this.#matchTextNode(
      resolution.tree,
      { text: request.effect, ...(request.ordinal === undefined ? {} : { ordinal: request.ordinal }) },
      `effect header ${JSON.stringify(request.effect)}`,
    );
    if (header.frame === null) {
      throw new EffectControlsError(
        "unproven",
        `the effect header (axPath ${header.path}) exposes no AX frame; ` +
          "it cannot be clicked honestly",
      );
    }

    const disclosure = this.#findDisclosure(header);
    let point: { readonly x: number; readonly y: number };
    let control: SetFoldedResult["aimedAt"]["control"];
    if (disclosure !== null) {
      point = centerOf(disclosure.frame!);
      control = "disclosure-node";
    } else {
      // Documented fallback: the disclosure gutter at the header's left
      // edge — inside the re-verified frame, never a remembered point.
      point = {
        x: header.frame.x + Math.min(HEADER_GUTTER_INSET, header.frame.width * 0.05),
        y: header.frame.y + header.frame.height / 2,
      };
      control = "header-gutter";
    }

    // Observe-class precondition: the row listing the oracle diffs.
    let rowsBefore: number | null = null;
    try {
      rowsBefore = this.#pane.rows(this.#paneLocator).length;
    } catch {
      rowsBefore = null;
    }

    await this.#post(() => this.#mouse.click!(point.x, point.y));
    if (this.#postcondition.settleMs > 0) {
      await this.#sleep(this.#postcondition.settleMs);
    }

    let rowsAfter: number | null = null;
    try {
      rowsAfter = this.#pane.rows(this.#paneLocator).length;
    } catch {
      rowsAfter = null;
    }
    const rowDeltaMatches =
      rowsBefore === null || rowsAfter === null
        ? null
        : request.folded
          ? rowsAfter < rowsBefore
          : rowsAfter > rowsBefore;
    const met = rowsAfter !== null && rowDeltaMatches === true;

    const record = this.#record(
      "effect-controls.set-folded",
      "gui-act+row-delta",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        rowAxPath: header.path,
        control,
        points: [point],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the fold click was posted but the row delta did not confirm ` +
              `the ${request.folded ? "fold" : "unfold"} ` +
              `(rows ${rowsBefore ?? "unreadable"} → ${rowsAfter ?? "unreadable"}) ` +
              `within ${this.#postcondition.timeoutMs}ms; no resend was attempted`,
          },
    );
    return {
      ...record,
      effect: request.effect,
      folded: request.folded,
      rowsBefore,
      rowsAfter,
      rowDeltaMatches,
    };
  }

  /**
   * Set an effect parameter's value through the GUI: click the value
   * control, then commit the formatted value plus Enter through the
   * authorized session-stream leg. The oracle is the DOM
   * `effect.getParameter` readback — the act channel and the read
   * channel are recorded separately (spec §2).
   */
  async setParameter(request: SetParameterRequest): Promise<SetParameterResult> {
    const op: EffectControlsOperation = "set-parameter";
    this.#requireMutationAllowed(op);
    this.#requireChannel(op);

    const resolution = this.#resolve();
    this.#requireOwned(resolution, op);

    // Observe-class precondition: the parameter must exist and hold a
    // scalar value before any GUI act is considered. `setParameter`
    // itself is never called — setup-only per the spec boundary.
    let info: PropertyInfo;
    try {
      info = await this.#readback.parameter(
        request.comp,
        request.layer,
        request.effect,
        request.parameter,
      );
    } catch (error) {
      const wrapped = asEffectControlsError(error);
      if (
        wrapped.code === "unavailable" &&
        error instanceof Error &&
        error.name === "NotFoundError"
      ) {
        throw new EffectControlsError(
          "not-found",
          `parameter ${JSON.stringify(request.parameter)} on effect ` +
            `${JSON.stringify(request.effect)} was not found: ${errorText(error)}`,
          { cause: error },
        );
      }
      throw wrapped;
    }
    if (info.kind !== "value") {
      throw new EffectControlsError(
        "unsupported",
        `parameter ${JSON.stringify(request.parameter)} has kind "${info.kind}"; ` +
          "only scalar value properties can be edited through a single " +
          "GUI value field in this slice",
      );
    }

    // Locate the parameter row in the walked tree.
    const locator: EffectControlsRowLocator = request.row ?? { text: info.name };
    const row = this.#matchTextNode(resolution.tree, locator, "parameter row");
    const rowFrame = row.frame;
    if (rowFrame === null) {
      throw new EffectControlsError(
        "unproven",
        `the parameter row (axPath ${row.path}) exposes no AX frame; ` +
          "it cannot be clicked honestly",
      );
    }

    // The value-entry point: a recorded control node, or the row's
    // value gutter — the documented unverified assumption.
    let point: { readonly x: number; readonly y: number };
    let control: SetParameterResult["aimedAt"]["control"];
    if (request.control !== undefined) {
      const node = resolveAxPath(resolution.tree, request.control.axPath);
      if (node === null || node.path === resolution.tree.path) {
        throw new EffectControlsError(
          "stale-locator",
          `the recorded control axPath "${request.control.axPath}" no longer ` +
            "resolves inside the walked pane tree; re-walk",
        );
      }
      if (
        request.control.title !== undefined &&
        node.title !== request.control.title
      ) {
        throw new EffectControlsError(
          "stale-locator",
          `control axPath "${request.control.axPath}" resolves but its title is ` +
            `${JSON.stringify(node.title)}, not ${JSON.stringify(request.control.title)}; ` +
            "the pane's AX tree drifted — re-walk",
        );
      }
      if (node.frame === null) {
        throw new EffectControlsError(
          "unproven",
          `the value control (axPath ${node.path}) exposes no AX frame; ` +
            "it cannot be clicked honestly",
        );
      }
      point = centerOf(node.frame);
      control = "value-control";
    } else {
      point = {
        x: rowFrame.x + rowFrame.width - Math.min(VALUE_GUTTER_INSET, rowFrame.width * 0.1),
        y: rowFrame.y + rowFrame.height / 2,
      };
      control = "value-gutter";
    }

    // Session-stream authorization BEFORE the focusing click: the
    // type+commit leg is keystroke delivery with no address, so a
    // missing grant or poster refuses before anything posts.
    const enteredText = formatParameterValue(request.value);
    const authz = inputAuthorizationVerdict(request.authorization, {
      operation: "type-sequential",
      operationClass: INPUT_OPERATION_GATES["type-sequential"].class,
      target: resolution.target,
      sessionKind: request.sessionKind ?? "unknown",
      sessionId: request.sessionId,
    });
    if (authz.status !== "granted") {
      throw new EffectControlsError(
        authz.status === "unavailable" ? "unavailable" : "refused",
        `parameter entry requires global input authorization and none ` +
          `covers it: ${authz.reason}`,
      );
    }
    if (this.#sessionStream === undefined) {
      throw new EffectControlsError(
        "unsupported",
        "parameter entry requires a session-stream poster, which this " +
          "build does not provide (the B-IME poster/focus vehicle is a " +
          "separate lane); refusing before anything posts",
      );
    }

    // Act 1: focus the value field.
    await this.#post(() => this.#mouse.click!(point.x, point.y));
    if (this.#postcondition.settleMs > 0) {
      await this.#sleep(this.#postcondition.settleMs);
    }

    // Act 2: type the value and commit. The payload digest is the
    // vehicle's audit concern; the summary names the parameter only.
    const posted = await this.#sessionStream({
      operation: "type-sequential",
      steps: [
        { type: "text", text: enteredText },
        { type: "key", key: "enter" },
      ],
      summary: `effect parameter "${request.parameter}" value entry`,
    });
    const sessionStream = {
      verdict: posted.verdict,
      code: posted.code ?? null,
      reason: posted.reason ?? null,
    };
    if (posted.verdict !== "performed") {
      throw new EffectControlsError(
        posted.verdict === "refused" ? "refused" : "indeterminate",
        `the session-stream value entry was ${posted.verdict}` +
          `${posted.code ? ` (${posted.code})` : ""}` +
          `${posted.reason ? `: ${posted.reason}` : ""}; ` +
          "the outcome is not a clean perform — re-observe before any retry",
      );
    }

    // Oracle: DOM readback until the value matches or the deadline.
    const tolerance = request.valueTolerance ?? this.#postcondition.valueTolerance;
    const readValue = async (): Promise<ParameterValue | null> => {
      const current = await this.#readback.parameter(
        request.comp,
        request.layer,
        request.effect,
        request.parameter,
      );
      return current.kind === "value" ? (current.value ?? null) : null;
    };
    const wait = await this.#waitForPostcondition(readValue, (value) =>
      parameterValueMatches(value ?? undefined, request.value, tolerance),
    );
    const observedValue = wait.last;
    const withinTolerance =
      observedValue === null
        ? null
        : parameterValueMatches(observedValue, request.value, tolerance);
    const met = wait.met && withinTolerance === true;

    const record = this.#record(
      "effect-controls.set-parameter",
      "gui-act+dom-readback",
      resolution,
      {
        paneAxPath: resolution.pane.path,
        rowAxPath: row.path,
        control,
        points: [point],
      },
      met ? "performed" : "indeterminate",
      met
        ? null
        : {
            code: "indeterminate",
            reason:
              `the GUI value entry posted but effect.getParameter did not ` +
              `match ${JSON.stringify(request.value)} within ${tolerance} ` +
              `within ${this.#postcondition.timeoutMs}ms ` +
              `(last observed ${JSON.stringify(observedValue)}); ` +
              "no resend was attempted",
          },
    );
    return {
      ...record,
      comp: request.comp,
      layer: request.layer,
      effect: request.effect,
      parameter: request.parameter,
      enteredText,
      observedValue,
      valueTolerance: tolerance,
      withinTolerance,
      sessionStream,
    };
  }
}
