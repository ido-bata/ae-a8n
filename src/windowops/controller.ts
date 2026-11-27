/**
 * Window ops orchestration (#366, W4+ of
 * `specs/workspace-editing/spec.md` §9). Platform-neutral: every OS
 * touch arrives through the injected `WindowOpsSurfaceOps`, so the
 * contract — resolve → authorize → act → bounded postcondition wait →
 * re-observe — is identical on macOS, Windows (when it lands) and in
 * tests.
 *
 * Safety shape, mirroring `PanelController`/`WorkspaceController`:
 *
 *   - Every operation re-resolves against a fresh observation; a
 *     `WindowOpsState` is a locator, not a handle — nothing about the
 *     window is cached across calls (spec §6).
 *   - `state` is observe-class: no gate, but an unavailable channel is
 *     an `unavailable` error, never an empty guess.
 *   - `move`/`resize`/`minimize`/`restore`/`maximize`/`focus` are
 *     `mutate-gui`, target-scoped: they require the injected gate
 *     (fail-closed when absent), re-resolve immediately before the
 *     act, refuse anything the census cannot attribute `"owned"`, and
 *     never auto-resend — spec §10: a resent AX set has no undo. A
 *     bounded postcondition wait that expires is `indeterminate`, not
 *     a retry cue.
 *   - Each act is a *single* in-session command — there is no
 *     multi-segment drag to abort mid-way. The abort boundary is the
 *     identity re-verification inside the session immediately before
 *     the AX set (a moved/replaced window is `not-found`/`ambiguous`,
 *     provably untouched); a post-act identity that can no longer be
 *     proven makes the postcondition unholdable, which expires as
 *     `indeterminate` — never a guessed pass, never a resend.
 *   - `focus` additionally runs the B-IME §5.3 three-step shape:
 *     focus-holder readback before the act, the AXMain/AXFocused/raise
 *     act, then a bounded poll proving the holder is the target pid —
 *     pid-level proof (`element: null`), recorded as such.
 *   - Postconditions read the *listing*, not the panel resolution: a
 *     minimized window can lose the AX frame resolution requires, and
 *     the postcondition must still be provable. Identity for the
 *     post-act read is title+subrole (narrowed by the expected
 *     post-frame when the op defines one); ambiguity or a lost match
 *     keeps the poll running until `indeterminate`.
 */

import {
  PanelError,
  type PanelFrame,
  type PanelLocator,
  type PanelTarget,
} from "../panels/types.js";
import type { GuiWindowInfo } from "../driver/gui-recovery.js";
import { attributePanelWindow } from "../panels/resolve.js";
import type { FocusHolder } from "../input/types.js";
import { resolveWindowTarget } from "./resolve.js";
import {
  DEFAULT_WINDOW_OPS_POLL,
  WindowOpsError,
  type WindowOpsActRequest,
  type WindowOpsActResult,
  type WindowOpsCensusView,
  type WindowOpsListing,
  type WindowOpsMutationGate,
  type WindowOpsOp,
  type WindowOpsPollOptions,
  type WindowOpsState,
  type WindowOpsSurfaceOps,
  type WindowOpsWindowInfo,
  type WindowOpResult,
} from "./types.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `PanelError`-shaped codes map onto the window-ops vocabulary. */
function asWindowOpsError(error: unknown, duringMutation: boolean): WindowOpsError {
  if (error instanceof WindowOpsError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code =
      error.code === "ambiguous"
        ? "ambiguous-target"
        : error.code === "not-found"
          ? "not-found"
          : error.code === "unproven"
            ? "unproven"
            : error.code === "unsupported"
              ? "unsupported"
              : error.code === "stale-locator"
                ? "stale-locator"
                : error.code === "refused"
                  ? "refused"
                  : error.code === "indeterminate"
                    ? "indeterminate"
                    : "unavailable";
    return new WindowOpsError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new WindowOpsError(
    duringMutation ? "indeterminate" : "unavailable",
    errorText(error),
    { cause: error },
  );
}

/** Per-coordinate frame equality within `tolerance` points. */
export function windowOpsFramesMatch(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tolerance: number,
): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

export type WindowOpsControllerOptions = {
  readonly pid: number;
  readonly locator: PanelLocator;
  readonly ops: WindowOpsSurfaceOps;
  /** The mutate-gui gate. Fail-closed: absent means every mutation refuses. */
  readonly authorizeMutation?: WindowOpsMutationGate;
  readonly poll?: WindowOpsPollOptions;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

/** The census view, degraded honestly when the probe cannot run. */
function censusOrDegraded(
  ops: WindowOpsSurfaceOps,
): WindowOpsCensusView {
  try {
    return ops.censusWindows();
  } catch (error) {
    return {
      available: false,
      reason: `window census failed: ${errorText(error)}`,
      windows: [],
    };
  }
}

/** The `GuiWindowInfo` shape `attributePanelWindow` consumes. */
function toGuiWindow(info: WindowOpsWindowInfo): GuiWindowInfo {
  return {
    title: info.title,
    role: info.role,
    subrole: info.subrole,
    buttons: [],
    texts: [],
    ...(info.frame === null
      ? {}
      : {
          frame: {
            x: info.frame.x,
            y: info.frame.y,
            width: info.frame.width,
            height: info.frame.height,
          },
        }),
  };
}

export class WindowOpsController {
  readonly #pid: number;
  readonly #locator: PanelLocator;
  readonly #ops: WindowOpsSurfaceOps;
  readonly #authorizeMutation: WindowOpsMutationGate | undefined;
  readonly #poll: Required<WindowOpsPollOptions>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: WindowOpsControllerOptions) {
    this.#pid = options.pid;
    this.#locator = options.locator;
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#poll = { ...DEFAULT_WINDOW_OPS_POLL, ...options.poll };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------
  // Observation plumbing
  // ------------------------------------------------------------------

  /** One listing observation; observe-class, throws on channel failure. */
  #listing(): WindowOpsListing {
    try {
      return this.#ops.observeWindows();
    } catch (error) {
      throw asWindowOpsError(error, false);
    }
  }

  /**
   * Find the post-act window inside a fresh listing by title+subrole,
   * narrowed by `hintFrame` when the op defines an expected post-frame.
   * Returns null on zero or ambiguous matches — the caller treats that
   * as "postcondition unproven", never a guess.
   */
  #findObserved(
    listing: WindowOpsListing,
    expected: { readonly title: string; readonly subrole: string | null },
    hintFrame: PanelFrame | null,
  ): WindowOpsWindowInfo | null {
    let candidates = listing.windows.filter(
      (w) => w.title === expected.title && w.subrole === expected.subrole,
    );
    if (candidates.length > 1 && hintFrame !== null) {
      const tol = this.#poll.frameTolerance;
      candidates = candidates.filter(
        (w) => w.frame !== null && windowOpsFramesMatch(w.frame, hintFrame, tol),
      );
    }
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  /**
   * Build the public state for one listing row: census attribution via
   * the same `attributePanelWindow` the panel resolver uses ("owned" is
   * the only mutation-grade answer), plus the app-level focus fields.
   */
  #stateFromInfo(
    listing: WindowOpsListing,
    info: WindowOpsWindowInfo,
    census: WindowOpsCensusView,
  ): WindowOpsState {
    let attribution: WindowOpsState["attribution"] = "unproven";
    let windowNumber: number | null = null;
    if (info.frame !== null) {
      const { attribution: at, censusWindow } = attributePanelWindow(
        toGuiWindow(info),
        this.#pid,
        census.available ? census.windows : [],
      );
      attribution = at;
      windowNumber = censusWindow?.windowNumber ?? null;
    }
    return {
      pid: this.#pid,
      window: info,
      app: {
        frontmost: listing.frontmostPid === this.#pid,
        frontmostPid: listing.frontmostPid,
      },
      attribution,
      windowNumber,
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * The pre-act resolution: full panel resolution (frame required) so
   * the vehicle gets a provable identity and the owned-attribution
   * check is the same one every sibling surface applies.
   */
  #resolve(): { target: PanelTarget; info: WindowOpsWindowInfo; listing: WindowOpsListing } {
    const listing = this.#listing();
    const census = censusOrDegraded(this.#ops);
    try {
      const resolution = resolveWindowTarget({
        pid: this.#pid,
        listing,
        census,
        locator: this.#locator,
        now: this.#now,
      });
      if (resolution.info === null) {
        throw new WindowOpsError(
          "not-found",
          "the resolved window has no window-ops state row; it cannot be " +
            "addressed for a window op",
        );
      }
      return { target: resolution.target, info: resolution.info, listing };
    } catch (error) {
      throw asWindowOpsError(error, false);
    }
  }

  /**
   * The resolved window's current state — observe-class. Every call
   * re-observes; the answer is a fresh proof, not a cache.
   */
  state(): WindowOpsState {
    const { info, listing } = this.#resolve();
    const census = censusOrDegraded(this.#ops);
    return this.#stateFromInfo(listing, info, census);
  }

  // ------------------------------------------------------------------
  // Mutate-gui
  // ------------------------------------------------------------------

  #requireMutationAllowed(op: WindowOpsOp): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for window operations; window ops are a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new WindowOpsError(
        "refused",
        `window ${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /** Focus-holder readback that never throws — evidence, not a gate. */
  #focusHolder(): FocusHolder | null {
    try {
      return this.#ops.readFocusHolder();
    } catch {
      return null;
    }
  }

  /**
   * Bounded postcondition wait (spec §10): poll `predicate` until it
   * holds or the deadline expires. Expiry is `indeterminate` — the act
   * already happened and its outcome is unproven; nothing is resent.
   */
  async #pollUntil(
    predicate: () => boolean,
    describe: string,
  ): Promise<void> {
    const deadline = Date.now() + this.#poll.timeoutMs;
    for (;;) {
      let holds = false;
      try {
        holds = predicate();
      } catch {
        holds = false;
      }
      if (holds) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new WindowOpsError(
          "indeterminate",
          `the postcondition was not observed within ${this.#poll.timeoutMs}ms ` +
            `(${describe}); the mutation was attempted and its outcome is ` +
            "unknown — re-observe before any retry, never resend",
        );
      }
      await this.#sleep(this.#poll.intervalMs);
    }
  }

  /** The expected post-frame an op defines, for identity narrowing. */
  #hintFrame(
    op: WindowOpsOp,
    request: WindowOpsActRequest,
    before: WindowOpsWindowInfo,
    displayFrame: PanelFrame | null,
  ): PanelFrame | null {
    switch (op) {
      case "move": {
        const p = request.position;
        if (p === undefined || before.frame === null) return null;
        return {
          x: p.x,
          y: p.y,
          width: before.frame.width,
          height: before.frame.height,
        };
      }
      case "resize": {
        const s = request.size;
        if (s === undefined || before.frame === null) return null;
        return { x: before.frame.x, y: before.frame.y, width: s.width, height: s.height };
      }
      case "maximize":
        return displayFrame;
      default:
        return null;
    }
  }

  /** The postcondition each op proves by fresh observation. */
  #postcondition(
    op: WindowOpsOp,
    request: WindowOpsActRequest,
    displayFrame: PanelFrame | null,
  ): (info: WindowOpsWindowInfo | null) => boolean {
    const tol = this.#poll.frameTolerance;
    switch (op) {
      case "move": {
        const p = request.position;
        if (p === undefined) return () => false;
        return (w) =>
          w?.frame != null &&
          Math.abs(w.frame.x - p.x) <= tol &&
          Math.abs(w.frame.y - p.y) <= tol;
      }
      case "resize": {
        const s = request.size;
        if (s === undefined) return () => false;
        return (w) =>
          w?.frame != null &&
          Math.abs(w.frame.width - s.width) <= tol &&
          Math.abs(w.frame.height - s.height) <= tol;
      }
      case "minimize":
        return (w) => w?.miniaturized === true;
      case "restore":
        return (w) => w?.miniaturized === false;
      case "maximize":
        // The display frame the vehicle reported is the contract; when
        // it is absent the postcondition cannot be proven — the poll
        // expires as `indeterminate`, never a guessed pass.
        return displayFrame === null
          ? () => false
          : (w) =>
              w?.frame != null && windowOpsFramesMatch(w.frame, displayFrame, tol);
      case "focus":
        // Pid-level focus proof (B-IME §5.3): the holder must be the
        // target pid. The window row is irrelevant to this predicate —
        // focus is app-level evidence.
        return () => this.#focusHolder()?.pid === this.#pid;
    }
  }

  /**
   * One mutate-gui op: gate → resolve → owned check → act → bounded
   * postcondition wait → re-observe. The vehicle verdicts map onto the
   * window-ops vocabulary; `failed` means the AX set errored after
   * identity checks passed — `indeterminate`, re-observe first.
   */
  async #mutate(
    op: WindowOpsOp,
    params: Pick<WindowOpsActRequest, "position" | "size">,
  ): Promise<WindowOpResult> {
    this.#requireMutationAllowed(op);

    const { target, info: beforeInfo, listing: beforeListing } = this.#resolve();
    if (target.surface.attribution !== "owned") {
      throw new WindowOpsError(
        "unproven",
        `the resolved window's pid attribution is "${target.surface.attribution}", ` +
          'not "owned"; window ops never act on an unproven surface — a ' +
          "foreign or unmatched window is refused before any mutation",
      );
    }
    if (beforeInfo.frame === null) {
      throw new WindowOpsError(
        "not-found",
        "the resolved window has no readable AX frame; the vehicle cannot " +
          "verify its identity — nothing was mutated",
      );
    }
    const beforeCensus = censusOrDegraded(this.#ops);
    const before = this.#stateFromInfo(beforeListing, beforeInfo, beforeCensus);

    const request: WindowOpsActRequest = {
      op,
      expected: {
        title: beforeInfo.title,
        subrole: beforeInfo.subrole,
        frame: beforeInfo.frame,
      },
      ...params,
    };

    // Focus evidence before the act (B-IME §5.3 readback half).
    const focusBefore = this.#focusHolder();

    let result: WindowOpsActResult;
    try {
      result = this.#ops.act(request);
    } catch (error) {
      throw asWindowOpsError(error, true);
    }

    switch (result.verdict) {
      case "performed":
        break;
      case "not-found":
        throw new WindowOpsError(
          "stale-locator",
          `the window moved or was replaced between resolution and act ` +
            `(${result.detail ?? "identity no longer matches"}); nothing was ` +
            "mutated — re-resolve and retry",
        );
      case "ambiguous":
        throw new WindowOpsError(
          "ambiguous-target",
          `the window identity matched more than one window inside the ` +
            `session (${result.detail ?? "multiple candidates"}); nothing ` +
            "was mutated",
        );
      case "missing":
        throw new WindowOpsError(
          "unavailable",
          `the window-ops vehicle could not enter the target session ` +
            `(${result.detail ?? "process or session gone"}); nothing was ` +
            "mutated — re-observe before retrying",
        );
      case "failed":
        throw new WindowOpsError(
          "indeterminate",
          `the ${op} act was attempted but the vehicle reported failure ` +
            `(${result.detail ?? "unknown"}); the outcome is unknown — ` +
            "re-observe before any retry, never resend",
        );
      default: {
        const exhaustive: never = result.verdict;
        throw new WindowOpsError(
          "indeterminate",
          `unknown act verdict ${String(exhaustive)}`,
        );
      }
    }

    const hintFrame = this.#hintFrame(op, request, beforeInfo, result.displayFrame);
    const expected = {
      title: beforeInfo.title,
      subrole: beforeInfo.subrole,
    };
    const predicate = this.#postcondition(op, request, result.displayFrame);

    // Bounded postcondition wait. Geometry/state ops re-list and
    // re-match the window by identity on every poll; `focus` proves
    // itself on the focus holder alone (B-IME §5.3 pid-level proof).
    let afterInfo: WindowOpsWindowInfo | null = null;
    await this.#pollUntil(
      () => {
        if (op === "focus") {
          return predicate(null);
        }
        const listing = this.#listing();
        const found = this.#findObserved(listing, expected, hintFrame);
        afterInfo = found;
        return predicate(found);
      },
      `window ${op} postcondition`,
    );

    // Post-act state for evidence: prefer the row the postcondition
    // proved; when the poll matched nothing further (focus), take one
    // more honest read.
    let afterListing: WindowOpsListing;
    try {
      afterListing = this.#listing();
    } catch {
      afterListing = beforeListing;
    }
    const afterRow =
      afterInfo ??
      this.#findObserved(afterListing, expected, hintFrame) ??
      result.window;
    const afterCensus = censusOrDegraded(this.#ops);
    const after =
      afterRow === null
        ? null
        : this.#stateFromInfo(afterListing, afterRow, afterCensus);
    const focusAfter = this.#focusHolder();
    return {
      op,
      before,
      after,
      verdict: result.verdict,
      focus: { before: focusBefore, after: focusAfter },
      observedAt: this.#now().toISOString(),
    };
  }

  /** Move the window: AX `set position`. Mutate-gui + gated. */
  move(position: { readonly x: number; readonly y: number }): Promise<WindowOpResult> {
    return this.#mutate("move", { position });
  }

  /** Resize the window: AX `set size`. Mutate-gui + gated. */
  resize(size: { readonly width: number; readonly height: number }): Promise<WindowOpResult> {
    return this.#mutate("resize", { size });
  }

  /** Minimize: AX `set miniaturized` true. Mutate-gui + gated. */
  minimize(): Promise<WindowOpResult> {
    return this.#mutate("minimize", {});
  }

  /** Un-minimize: AX `set miniaturized` false. Mutate-gui + gated. */
  restore(): Promise<WindowOpResult> {
    return this.#mutate("restore", {});
  }

  /**
   * Maximize: frame = the containing display's bounds. Mutate-gui +
   * gated. `before.window.frame` is the honest pre-maximize frame —
   * restore it with `move` + `resize` (there is no AX "unmaximize").
   */
  maximize(): Promise<WindowOpResult> {
    return this.#mutate("maximize", {});
  }

  /**
   * Focus/activate the window: app activate + AXMain + AXFocused +
   * AXRaise, proven by the B-IME §5.3 focus-holder readback (pid-level).
   * Mutate-gui + gated.
   */
  focus(): Promise<WindowOpResult> {
    return this.#mutate("focus", {});
  }
}
