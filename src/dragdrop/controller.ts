/**
 * Drag-drop operation orchestration (#422,
 * `specs/workspace-editing/spec.md` §5, §9 "File/element drag-drop",
 * §10, §12 W4+). Platform-neutral: every OS/DOM touch arrives through
 * the injected `DragDropOps`, so the contract — resolve → gate →
 * census pre-flight → atomic/segmented post → bounded oracle wait — is
 * identical on macOS, Windows (when it lands) and in tests.
 *
 * Safety shape, mirroring `ContextMenuController`/`TimelineController`:
 *
 *   - Every op re-resolves the surface locator against a fresh
 *     observation; a locator is never a handle (spec §6).
 *   - Both kinds are `mutate-gui`: the injected gate is fail-closed
 *     (absent means refuse), `attribution !== "owned"` refuses before
 *     anything posts, and a missing vehicle channel refuses
 *     `unsupported` at preflight.
 *   - The drop/press points must sit inside the re-verified frame AND
 *     be census-proven topmost-owned immediately before posting —
 *     #411's aux-panel coverage and foreign-drift lessons encoded as a
 *     gate, not a hope.
 *   - `element-drag` is segmented: between moves the topmost census
 *     window at the current point is re-checked; a change aborts —
 *     the button is released at the last verified point and the op
 *     reports honestly. It never "finishes the drag" onto an unproven
 *     surface (spec §10).
 *   - `file-drop` is atomic inside the helper's NSDraggingSession;
 *     its internal segments cannot be re-checked from outside — the
 *     contract records that limitation rather than pretending.
 *   - Postcondition waits are bounded (spec §10): poll the DOM delta
 *     until the deadline, then `indeterminate` — never a resend.
 *
 * Verification level: `automated test` against fakes. The macOS
 * `input-drag` vehicle and the `project.items` oracle are verified on
 * real host (#411 + this ticket's e2e); see
 * `docs/gui-supervision-safety-gates.md`.
 */

import {
  isPidAttributedWindow,
  MacSessionError,
  GuiMutationError,
  GuiRecoveryError,
  type GuiFrame,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import {
  DEFAULT_DRAGDROP_POLL,
  DragDropError,
  type DragDropDelta,
  type DragDropElementRequest,
  type DragDropElementTarget,
  type DragDropFileRequest,
  type DragDropMutationGate,
  type DragDropMutationOp,
  type DragDropOps,
  type DragDropPoint,
  type DragDropPollOptions,
  type DragDropRequest,
  type DragDropResult,
  type DragDropSegmentCheck,
  type DragDropSnapshot,
  type DragDropSurfaceLocator,
  type DragDropTopmost,
  type DragDropVerdict,
  type GuiAppStateLike,
} from "./types.js";

/** Frame slack for "the census window IS the resolved surface". */
const FRAME_MATCH_TOLERANCE = 8;
/** Points of slack when checking a point sits inside the frame. */
const POINT_TOLERANCE = 1;
const DEFAULT_STEPS = 24;
const DEFAULT_STEP_DELAY_MS = 16;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function framesClose(a: GuiFrame, b: GuiFrame, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** Exact identity match (rounded), same rule as ContextMenuController. */
function framesIdentical(
  a: GuiFrame | null | undefined,
  b: GuiFrame | null | undefined,
): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function pointInsideFrame(point: DragDropPoint, frame: GuiFrame): boolean {
  return (
    point.x >= frame.x - POINT_TOLERANCE &&
    point.x <= frame.x + frame.width + POINT_TOLERANCE &&
    point.y >= frame.y - POINT_TOLERANCE &&
    point.y <= frame.y + frame.height + POINT_TOLERANCE
  );
}

/** POSIX basename without importing node:path into the contract layer. */
function baseName(path: string): string {
  const trimmed = path.replace(/\\/g, "/");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function isFinitePoint(point: DragDropPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * Map a platform/transport failure onto the public codes: observation
 * failures are `unavailable`; a mutation whose outcome is unknown is
 * `indeterminate`; coded `GuiRecoveryError`s are provable non-mutations.
 */
function asDragDropError(error: unknown, duringAct: boolean): DragDropError {
  if (error instanceof DragDropError) {
    return error;
  }
  if (error instanceof GuiMutationError) {
    return new DragDropError("indeterminate", errorText(error), { cause: error });
  }
  if (error instanceof MacSessionError || error instanceof GuiRecoveryError) {
    return new DragDropError("unavailable", errorText(error), { cause: error });
  }
  return new DragDropError(duringAct ? "indeterminate" : "unavailable", errorText(error), {
    cause: error,
  });
}

/** Map a vehicle verdict onto the contract's outcome. */
function verdictError(
  verdict: DragDropVerdict,
  what: string,
): DragDropError | null {
  switch (verdict) {
    case "performed":
      return null;
    case "not-performed":
      return new DragDropError(
        "stale-locator",
        `the ${what} proved nothing was dragged (the drag session never ` +
          "began or identity was lost before the first move); nothing was " +
          "posted — re-resolve and retry",
      );
    case "failed":
      return new DragDropError(
        "indeterminate",
        `the ${what} was attempted but the platform reported failure; ` +
          "the outcome is unknown — re-observe before any retry, never resend",
      );
    default: {
      const exhaustive: never = verdict;
      return new DragDropError("unavailable", `unknown verdict ${String(exhaustive)}`);
    }
  }
}

/** Multiset name diff plus order comparison between two snapshots. */
export function dragDropDelta(
  before: DragDropSnapshot | null,
  after: DragDropSnapshot | null,
): DragDropDelta {
  const beforeItems = before?.items ?? null;
  const afterItems = after?.items ?? null;
  const addedNames: string[] = [];
  const removedNames: string[] = [];
  let orderChanged = false;

  if (beforeItems !== null && afterItems !== null) {
    const pool = [...beforeItems];
    for (const item of afterItems) {
      const index = pool.findIndex(
        (candidate) =>
          candidate.name === item.name &&
          (candidate.id === null || item.id === null || candidate.id === item.id),
      );
      if (index === -1) {
        addedNames.push(item.name);
      } else {
        pool.splice(index, 1);
      }
    }
    for (const item of pool) {
      removedNames.push(item.name);
    }
    // Order changed when the surviving names' relative sequence differs.
    const beforeNames = beforeItems.map((item) => item.name);
    const afterNames = afterItems.map((item) => item.name);
    const beforeKept = beforeNames.filter((name) => !removedNames.includes(name));
    const afterKept = afterNames.filter((name) => !addedNames.includes(name));
    orderChanged =
      beforeKept.length !== afterKept.length ||
      beforeKept.some((name, index) => name !== afterKept[index]);
  }

  const countDelta =
    before?.itemCount !== null &&
    before?.itemCount !== undefined &&
    after?.itemCount !== null &&
    after?.itemCount !== undefined
      ? after.itemCount - before.itemCount
      : null;

  return { addedNames, removedNames, orderChanged, countDelta };
}

export type DragDropControllerOptions = {
  readonly pid: number;
  readonly ops: DragDropOps;
  /** The mutate-gui gate. Fail-closed: absent means every op refuses. */
  readonly authorizeMutation?: DragDropMutationGate;
  readonly poll?: DragDropPollOptions;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export class DragDropController {
  readonly #pid: number;
  readonly #ops: DragDropOps;
  readonly #authorizeMutation: DragDropMutationGate | undefined;
  readonly #poll: Required<DragDropPollOptions>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: DragDropControllerOptions) {
    this.#pid = options.pid;
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#poll = { ...DEFAULT_DRAGDROP_POLL, ...options.poll };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  #observe(): GuiAppStateLike {
    try {
      return this.#ops.observe();
    } catch (error) {
      throw asDragDropError(error, false);
    }
  }

  #requireMutationAllowed(
    op: DragDropMutationOp,
    request?: DragDropRequest,
  ): void {
    const gate = this.#authorizeMutation?.(op, request) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for drag-drop operations; every drag is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new DragDropError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Resolve the surface against a fresh observation: the window at
   * `locator.windowIndex` must still carry the declared title/subrole/
   * frame, be pid-attributed, and expose a frame. Same contract as
   * `ContextMenuController.#resolveSurface`.
   */
  #resolveSurface(locator: DragDropSurfaceLocator): {
    windowIndex: number;
    window: GuiWindowInfo;
    frame: GuiFrame;
  } {
    if (!Number.isInteger(locator.windowIndex) || locator.windowIndex < 1) {
      throw new DragDropError(
        "invalid-locator",
        `windowIndex must be a positive integer, got ${String(locator.windowIndex)}`,
      );
    }
    const state = this.#observe();
    const window = state.windows[locator.windowIndex - 1];
    if (window === undefined) {
      throw new DragDropError(
        "not-found",
        `no window at listing index ${locator.windowIndex}; the surface ` +
          "moved or the listing drifted — re-resolve",
        { candidates: state.windows.map((w, i) => `#${i + 1} "${w.title}"`) },
      );
    }
    const expected = locator.expected;
    const same =
      window.title === expected.title &&
      window.subrole === expected.subrole &&
      framesIdentical(window.frame, expected.frame);
    if (!same) {
      throw new DragDropError(
        "stale-locator",
        `the window at listing index ${locator.windowIndex} changed since ` +
          `resolution ("${expected.title}" → "${window.title}"); nothing was posted`,
      );
    }
    if (!isPidAttributedWindow(window) || window.frame == null) {
      throw new DragDropError(
        "unproven",
        `the surface at listing index ${locator.windowIndex} cannot be proven ` +
          'to belong to this After Effects instance (attribution ' +
          `${window.censusAttribution ?? "unproven"}); refusing the drag`,
      );
    }
    return { windowIndex: locator.windowIndex, window, frame: window.frame };
  }

  /**
   * The z-order pre-flight (spec §9 row + #411 lessons): the topmost
   * on-screen app window at `point` must be a census window of THIS pid
   * whose bounds match the resolved surface's frame — proving the drag
   * endpoint lands on the intended owned window and not on a foreign
   * app, a foreign AE, or an owned aux panel covering it.
   */
  #requireTopmostOwned(
    point: DragDropPoint,
    frame: GuiFrame,
    what: string,
  ): DragDropTopmost {
    let top: DragDropTopmost | null;
    try {
      top = this.#ops.topmostAt(point);
    } catch (error) {
      throw asDragDropError(error, false);
    }
    if (top === null) {
      throw new DragDropError(
        "unproven",
        `no on-screen window covers the ${what} point ${point.x},${point.y}; ` +
          "the drop cannot be proven to land on the owned surface",
      );
    }
    if (top.pid !== this.#pid) {
      throw new DragDropError(
        "unproven",
        `the ${what} point ${point.x},${point.y} is covered by pid ${top.pid} ` +
          `(window ${top.windowNumber ?? "?"}), not the owned After Effects ` +
          `pid ${this.#pid}; drops onto foreign apps/windows are refused`,
      );
    }
    if (top.bounds === null || !framesClose(top.bounds, frame, FRAME_MATCH_TOLERANCE)) {
      throw new DragDropError(
        "unproven",
        `the ${what} point is covered by an owned window whose census bounds ` +
          `${JSON.stringify(top.bounds)} do not match the resolved surface ` +
          `frame ${JSON.stringify(frame)} (±${FRAME_MATCH_TOLERANCE}pt) — ` +
          "an aux panel or another owned window sits on top; refusing rather " +
          "than dropping onto the wrong surface",
      );
    }
    return top;
  }

  /**
   * Mid-drag segment re-check: same proof, recorded per segment.
   * `ownedOnly` relaxes the frame-bounds match to a pid-only check —
   * used by `panel-tab` tear-off (#427), where the drag's own floating
   * panel legitimately becomes the topmost owned window mid-gesture.
   * A FOREIGN pid still aborts either way.
   */
  #checkSegment(
    index: number,
    point: DragDropPoint,
    frame: GuiFrame,
    ownedOnly = false,
  ): DragDropSegmentCheck {
    let top: DragDropTopmost | null = null;
    try {
      top = this.#ops.topmostAt(point);
    } catch {
      top = null;
    }
    const ok =
      top !== null &&
      top.pid === this.#pid &&
      (ownedOnly ||
        (top.bounds !== null &&
          framesClose(top.bounds, frame, FRAME_MATCH_TOLERANCE)));
    return {
      index,
      point,
      topmostPid: top?.pid ?? null,
      topmostWindowNumber: top?.windowNumber ?? null,
      ok,
    };
  }

  async #snapshot(
    element?: DragDropElementTarget,
  ): Promise<DragDropSnapshot | null> {
    if (this.#ops.readback === undefined) {
      return null;
    }
    try {
      return await this.#ops.readback(element);
    } catch {
      return null;
    }
  }

  /**
   * The pre-act oracle must answer with a usable snapshot — a drag
   * whose before-state is unknown can never be verified, so the op
   * refuses `unavailable` BEFORE anything posts (fail-closed, spec §10).
   */
  async #requireOracleSnapshot(
    what: string,
    element?: DragDropElementTarget,
  ): Promise<DragDropSnapshot> {
    const snapshot = await this.#snapshot(element);
    if (
      snapshot === null ||
      (snapshot.items === null && snapshot.itemCount === null)
    ) {
      throw new DragDropError(
        "unavailable",
        `the DOM readback oracle produced no usable snapshot for the ${what}; ` +
          "a drag without a before-state cannot be verified — refusing " +
          "before anything posts",
      );
    }
    return snapshot;
  }

  /**
   * Bounded oracle wait (spec §10): poll the readback until `accept`
   * passes on the delta or the deadline expires. Expiry is
   * `indeterminate` — the drag was posted and its outcome is unknown;
   * nothing is resent.
   */
  async #waitForDelta(
    before: DragDropSnapshot | null,
    accept: (delta: DragDropDelta) => boolean,
    element?: DragDropElementTarget,
  ): Promise<{ met: boolean; after: DragDropSnapshot | null; delta: DragDropDelta }> {
    const deadline = this.#now().getTime() + this.#poll.timeoutMs;
    let after: DragDropSnapshot | null = before;
    let delta = dragDropDelta(before, after);
    // `answered` tracks whether the oracle EVER produced a snapshot —
    // a readback that exists but always throws is `unavailable`, not
    // an empty delta.
    let answered = before !== null;
    for (;;) {
      after = await this.#snapshot(element);
      if (after !== null) {
        answered = true;
        delta = dragDropDelta(before, after);
        if (accept(delta)) {
          return { met: true, after, delta };
        }
      }
      if (this.#now().getTime() >= deadline) {
        break;
      }
      await this.#sleep(this.#poll.intervalMs);
    }
    if (!answered) {
      throw new DragDropError(
        "unavailable",
        "the DOM readback oracle never answered during the postcondition " +
          "wait; the drag's outcome cannot be verified",
      );
    }
    return { met: false, after, delta };
  }

  /**
   * Vend `file` in an NSDraggingSession and drop it on the resolved
   * surface — the #411-proven `vend=fileurl` vehicle. Mutate-gui:
   * gated, census-gated, atomic inside the helper, oracle-verified,
   * never resent.
   */
  async dropFile(request: DragDropFileRequest): Promise<DragDropResult> {
    const op: DragDropMutationOp = "drop-file";
    this.#requireMutationAllowed(op, request);
    if (this.#ops.fileDrag === undefined) {
      throw new DragDropError(
        "unsupported",
        "no file-drop vehicle is available on this build (the " +
          "NSDraggingSession helper lands with the darwin input helpers); " +
          "refusing before anything posts",
      );
    }
    if (this.#ops.readback === undefined) {
      throw new DragDropError(
        "unavailable",
        "no DOM readback oracle is wired; a file drop without a " +
          "project.items delta cannot be verified — refusing before " +
          "anything posts",
      );
    }
    if (!isFinitePoint(request.to)) {
      throw new TypeError("dropFile `to` must be a finite point");
    }

    // File payload proof BEFORE anything posts: must exist, be a
    // regular file, and carry a digest for the evidence record.
    const probe = this.#ops.probeFile?.(request.file.path) ?? null;
    if (probe === null || !probe.exists || !probe.isFile) {
      throw new DragDropError(
        "not-found",
        `the drop payload ${JSON.stringify(request.file.path)} does not ` +
          "exist or is not a regular file; drag-drop sources are fixture " +
          "files only (spec §5/§13)",
      );
    }
    const fileName = baseName(request.file.path);

    const surface = this.#resolveSurface(request.surface);
    if (!pointInsideFrame(request.to, surface.frame)) {
      throw new DragDropError(
        "invalid-locator",
        `the drop point ${request.to.x},${request.to.y} lies outside the ` +
          `re-verified frame ${JSON.stringify(surface.frame)}; coordinates ` +
          "inside the proven frame only — there is no remembered-position fallback",
      );
    }
    this.#requireTopmostOwned(request.to, surface.frame, "drop");

    const from = request.from ?? {
      x: request.to.x,
      y: request.to.y - 160 < 0 ? request.to.y + 160 : request.to.y - 160,
    };
    if (!isFinitePoint(from)) {
      throw new TypeError("dropFile `from` must be a finite point");
    }

    // Best-effort frontmost: the census gates remain the authority —
    // activation only reduces the chance the session stream loses the
    // drag to a focus steal (#411's shared-console lesson).
    try {
      await this.#ops.activate?.();
    } catch {
      // Activation is best-effort; the gates decide.
    }

    const before = await this.#requireOracleSnapshot("file drop");

    let posted: { verdict: DragDropVerdict; operation: string | null };
    try {
      // Preflight above proved the channel exists; the ops property
      // narrowing carries it here.
      posted = await this.#ops.fileDrag({
        file: request.file,
        from,
        to: request.to,
        steps: DEFAULT_STEPS,
        stepDelayMs: DEFAULT_STEP_DELAY_MS,
        dwellMs: 0,
      });
    } catch (error) {
      throw asDragDropError(error, true);
    }
    const verdictErrorResult = verdictError(posted.verdict, "file drop");
    if (verdictErrorResult !== null) {
      throw verdictErrorResult;
    }

    // Postcondition: the DOM delta must show the import. Any added item
    // counts (AE may rename on conflict); the delta records the names so
    // the reviewer sees whether it was our fixture. Deadline →
    // indeterminate, never a resend.
    const wait = await this.#waitForDelta(
      before,
      (delta) => delta.addedNames.length > 0,
    );
    if (!wait.met) {
      throw new DragDropError(
        "indeterminate",
        `the file drop was posted (NSDraggingSession operation ` +
          `${posted.operation ?? "unreported"}) but no project item appeared ` +
          `within ${this.#poll.timeoutMs}ms; delta ${JSON.stringify(wait.delta)} ` +
          "— the drop may have been refused by AE or landed elsewhere; " +
          "re-observe before any retry, never resend",
      );
    }

    return {
      kind: "file-drop",
      element: null,
      vehicle: posted.verdict,
      dragOperation: posted.operation,
      delta: wait.delta,
      verified: true,
      file: {
        path: request.file.path,
        name: fileName,
        size: probe.size,
        sha256: probe.sha256,
      },
      segments: [],
      windowCountBefore: null,
      windowCountAfter: null,
      aborted: null,
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Press→move→release inside the owned window for in-app element
   * drags (Project/Timeline reorder — #411 proved the vehicle). The
   * sequence is segmented: between moves the topmost census window at
   * the current point is re-checked and the op aborts — releasing at
   * the last verified point — on any identity change (spec §10).
   * Mutate-gui, gated, oracle-verified, never resent.
   */
  async drag(request: DragDropElementRequest): Promise<DragDropResult> {
    const op: DragDropMutationOp = "element-drag";
    this.#requireMutationAllowed(op, request);
    for (const channel of ["press", "move", "release"] as const) {
      if (this.#ops[channel] === undefined) {
        throw new DragDropError(
          "unsupported",
          `element-drag requires the "${channel}" mouse vehicle, which this ` +
            "build does not provide; refusing before anything posts",
        );
      }
    }
    // `panel-tab` tear-off changes workspace state the DOM cannot see
    // (#427): its oracle is the owned census window count, not
    // project.items/comp.layers. Every other element class keeps the
    // DOM-delta oracle.
    const windowOracle = request.element === "panel-tab";
    if (windowOracle && this.#ops.ownedWindowCount === undefined) {
      throw new DragDropError(
        "unsupported",
        "element-drag panel-tab requires the census window-count " +
          "oracle, which this build does not provide; refusing before " +
          "anything posts",
      );
    }
    if (!windowOracle && this.#ops.readback === undefined) {
      throw new DragDropError(
        "unavailable",
        "no DOM readback oracle is wired; an element drag without a " +
          "project delta cannot be verified — refusing before anything posts",
      );
    }
    if (!isFinitePoint(request.from) || !isFinitePoint(request.to)) {
      throw new TypeError("drag endpoints must be finite points");
    }
    const steps = Math.max(1, Math.floor(request.steps ?? DEFAULT_STEPS));
    const stepDelayMs = Math.max(0, request.stepDelayMs ?? DEFAULT_STEP_DELAY_MS);

    const surface = this.#resolveSurface(request.surface);
    for (const [label, point] of [
      ["from", request.from],
      ["to", request.to],
    ] as const) {
      if (!pointInsideFrame(point, surface.frame)) {
        throw new DragDropError(
          "invalid-locator",
          `the ${label} point ${point.x},${point.y} lies outside the ` +
            `re-verified frame ${JSON.stringify(surface.frame)}; coordinates ` +
            "inside the proven frame only",
        );
      }
    }
    // Both endpoints census-gated pre-act (the #411 `drag` gate shape):
    // pressing on a foreign window would mutate it.
    this.#requireTopmostOwned(request.from, surface.frame, "drag origin");
    this.#requireTopmostOwned(request.to, surface.frame, "drag destination");

    try {
      await this.#ops.activate?.();
    } catch {
      // Best-effort.
    }

    // Pre-act oracle: DOM snapshot for reorder classes, census window
    // count for panel-tab. Either way a drag whose before-state is
    // unknown refuses BEFORE anything posts.
    let before: DragDropSnapshot | null = null;
    let windowsBefore: number | null = null;
    if (windowOracle) {
      try {
        windowsBefore = await this.#ops.ownedWindowCount!();
      } catch (error) {
        throw asDragDropError(error, false);
      }
      if (!Number.isInteger(windowsBefore)) {
        throw new DragDropError(
          "unavailable",
          "the census window-count oracle produced no usable count; " +
            "a panel-tab drag without a before-state cannot be verified",
        );
      }
    } else {
      before = await this.#requireOracleSnapshot("element drag", request.element);
    }
    const segments: DragDropSegmentCheck[] = [];
    let aborted: string | null = null;
    let postedMoves = 0;

    const post = async (
      channel: "press" | "move" | "release",
      point: DragDropPoint,
      what: string,
    ): Promise<void> => {
      let verdict: DragDropVerdict;
      try {
        verdict = await this.#ops[channel]!(point);
      } catch (error) {
        throw asDragDropError(error, true);
      }
      const failure = verdictError(verdict, what);
      if (failure !== null) {
        throw failure;
      }
    };

    try {
      await post("press", request.from, "drag press");
    } catch (error) {
      throw asDragDropError(error, true);
    }

    // Segmented moves with per-segment census re-checks. On a failed
    // check the button is released at the LAST VERIFIED point — never
    // at the failed point (that could drop onto a foreign surface) and
    // never "finished" toward `to`.
    let lastGood = request.from;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const point: DragDropPoint = {
        x: request.from.x + (request.to.x - request.from.x) * t,
        y: request.from.y + (request.to.y - request.from.y) * t,
      };
      // panel-tab: the tear-off's own floating window is the expected
      // mid-drag topmost — pid-only check (foreign still aborts).
      const check = this.#checkSegment(i, point, surface.frame, windowOracle);
      segments.push(check);
      if (!check.ok) {
        aborted =
          `segment ${i} at ${point.x},${point.y}: topmost window is ` +
          `pid ${check.topmostPid ?? "none"} (window ` +
          `${check.topmostWindowNumber ?? "?"}), not the owned surface — ` +
          "aborting the drag instead of finishing it";
        break;
      }
      try {
        await post("move", point, "drag move");
      } catch (error) {
        // A move that throws mid-drag leaves the button down — release
        // at the last verified point before reporting.
        try {
          await this.#ops.release!(lastGood);
        } catch {
          // Release failure is recorded via the thrown error below.
        }
        throw asDragDropError(error, true);
      }
      postedMoves += 1;
      lastGood = point;
      if (i < steps && stepDelayMs > 0) {
        await this.#sleep(stepDelayMs);
      }
    }

    if (aborted !== null) {
      try {
        await this.#ops.release!(lastGood);
      } catch {
        // Best-effort release; the abort verdict stands.
      }
      if (postedMoves === 0) {
        throw new DragDropError(
          "stale-locator",
          `the drag aborted before the first move: ${aborted}; nothing was ` +
            "dragged — re-resolve and retry",
        );
      }
      throw new DragDropError(
        "indeterminate",
        `the drag aborted mid-sequence after ${postedMoves} move(s): ` +
          `${aborted}; a partial drag may have landed — re-observe before ` +
          "any retry, never resend",
      );
    }

    // Dwell at the destination, then release — the #411-proven shape.
    if ((request.dwellMs ?? 0) > 0) {
      await this.#sleep(request.dwellMs ?? 0);
    }
    try {
      await post("release", request.to, "drag release");
    } catch (error) {
      throw asDragDropError(error, true);
    }

    if (windowOracle) {
      // Postcondition: the owned census window count must change within
      // the bounded wait — a tear-off floats a panel (+1), anything
      // else (missed drag, re-dock attempt that cannot start here)
      // leaves it flat. Deadline → indeterminate, never resend.
      const deadline = this.#now().getTime() + this.#poll.timeoutMs;
      let windowsAfter: number | null = null;
      let answered = false;
      for (;;) {
        try {
          const count = await this.#ops.ownedWindowCount!();
          if (Number.isInteger(count)) {
            answered = true;
            windowsAfter = count;
            if (count !== windowsBefore) break;
          }
        } catch {
          // Census hiccup mid-wait: keep polling until the deadline.
        }
        if (this.#now().getTime() >= deadline) break;
        await this.#sleep(this.#poll.intervalMs);
      }
      if (!answered) {
        throw new DragDropError(
          "unavailable",
          "the census window-count oracle never answered during the " +
            "postcondition wait; the tear-off's outcome cannot be verified",
        );
      }
      if (windowsAfter === windowsBefore) {
        throw new DragDropError(
          "indeterminate",
          `the panel-tab drag was posted (${steps} segments) but the ` +
            `owned window count stayed ${windowsBefore} within ` +
            `${this.#poll.timeoutMs}ms — the drag may have missed the ` +
            "tab or AE refused the tear-off; re-observe before any " +
            "retry, never resend",
        );
      }
      return {
        kind: "element-drag",
        element: request.element,
        vehicle: "performed",
        dragOperation: null,
        delta: dragDropDelta(null, null),
        verified: true,
        file: null,
        segments,
        windowCountBefore: windowsBefore,
        windowCountAfter: windowsAfter,
        aborted: null,
        observedAt: this.#now().toISOString(),
      };
    }

    // Postcondition: ANY DOM delta proves the in-app drag landed
    // (reorder or membership change). `countDelta !== null` alone is
    // NOT a delta — it is non-null whenever both snapshots carry an
    // itemCount, including a flat 0; only a NONZERO count change counts.
    // Deadline → indeterminate.
    const wait = await this.#waitForDelta(
      before,
      (delta) =>
        delta.addedNames.length > 0 ||
        delta.removedNames.length > 0 ||
        delta.orderChanged ||
        (delta.countDelta !== null && delta.countDelta !== 0),
      request.element,
    );
    if (!wait.met) {
      throw new DragDropError(
        "indeterminate",
        `the drag was posted (${steps} segments) but no project delta ` +
          `appeared within ${this.#poll.timeoutMs}ms; delta ` +
          `${JSON.stringify(wait.delta)} — the drag may have missed its ` +
          "target row; re-observe before any retry, never resend",
      );
    }

    return {
      kind: "element-drag",
      element: request.element,
      vehicle: "performed",
      dragOperation: null,
      delta: wait.delta,
      verified: true,
      file: null,
      segments,
      windowCountBefore: null,
      windowCountAfter: null,
      aborted: null,
      observedAt: this.#now().toISOString(),
    };
  }

  /** One entry point mirroring the request union. */
  run(request: DragDropRequest): Promise<DragDropResult> {
    return request.kind === "file-drop" ? this.dropFile(request) : this.drag(request);
  }
}
