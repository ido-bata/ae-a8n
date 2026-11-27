/**
 * Context-menu orchestration (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5, §6, §10).
 *
 * Platform-neutral, mirroring `FileDialogController`/`MenuController`:
 * every OS touch arrives through injected `ContextMenuOps`, so the
 * contract — gated right-click inside a re-verified frame, bounded
 * new-window wait, dialog-class refusal on unmatched modals,
 * re-resolution before press — is identical on macOS, Windows (when it
 * lands) and in tests.
 *
 *   - `open` is `mutate-gui`: it requires the injected gate
 *     (fail-closed when absent), resolves the target surface against a
 *     fresh observation, posts ONE right-click at a point proven inside
 *     the re-verified frame, then bounded-waits for the menu surface.
 *     The post is never resent — a `failed`/thrown vehicle is
 *     `indeterminate`, deadline expiry is `indeterminate`.
 *   - The wait is observe-class: it polls `observe()` for a window that
 *     was NOT in the pre-click listing and classifies as the declared
 *     menu. A new blocking dialog that does not match refuses — the
 *     right-click may have raised a modal, and its items are never
 *     pressed.
 *   - `items`/`invokeItem` re-resolve the menu window immediately
 *     before acting: same listing index, same title/subrole/frame, and
 *     the window must still classify as the declared menu. `invokeItem`
 *     is `mutate-gui` and gated like `open`.
 */

import {
  GuiMutationError,
  GuiRecoveryError,
  isPidAttributedWindow,
  MacSessionError,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import {
  contextMenuItems,
  contextMenuWindowKey,
  matchContextMenu,
} from "./classify.js";
import {
  ContextMenuError,
  type ContextMenuActResult,
  type ContextMenuItem,
  type ContextMenuResolution,
  type ContextMenuSurface,
  type ContextMenuTargetLocator,
  type ContextMenuTitles,
} from "./types.js";

/** The raw verdict a right-click/item-press vehicle reports. */
export type ContextMenuPostVerdict =
  | "clicked"
  | "not-found"
  | "changed"
  | "failed"
  | "missing";

/**
 * Every OS touch the controller needs, injected. The production adapter
 * (`src/api/context-menu.ts`) binds these to `MacGuiRecovery` +
 * `input-mouse`; tests bind fakes.
 */
export type ContextMenuOps = {
  /** One Accessibility+WindowServer observation of the target pid. */
  observe(): GuiAppState;
  /**
   * Post ONE right-button click at `point`, after the vehicle has had
   * the chance to re-verify `expected`'s identity in-session. Mutate-
   * class: runs under whatever lease the platform requires. Returns the
   * vehicle's verdict; throws `GuiMutationError` when the outcome is
   * unknown. Optional: absent means this build has no right-click
   * vehicle and `open` refuses `unsupported` before anything posts.
   */
  rightClick?(request: {
    readonly windowIndex: number;
    readonly expected: GuiWindowInfo;
    readonly point: { readonly x: number; readonly y: number };
  }): ContextMenuPostVerdict | Promise<ContextMenuPostVerdict>;
  /**
   * Press `title` inside the window at `windowIndex`, after the vehicle
   * re-verifies `expected`'s identity in-session. Mutate-class. Optional:
   * absent means `invokeItem` refuses `unsupported`.
   */
  pressItem?(request: {
    readonly windowIndex: number;
    readonly title: string;
    readonly expected: GuiWindowInfo;
  }): ContextMenuPostVerdict | Promise<ContextMenuPostVerdict>;
};

export type ContextMenuMutationOp = "open" | "invoke-item";

export type ContextMenuMutationGate = (
  op: ContextMenuMutationOp,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type ContextMenuControllerOptions = {
  readonly pid: number;
  readonly ops: ContextMenuOps;
  /**
   * The mutate-gui gate. Fail-closed: absent means every act refuses.
   * Production wires the A-SAFETY gate state; tests inject allow/deny.
   */
  readonly authorizeMutation?: ContextMenuMutationGate;
  readonly now?: () => Date;
  /** Millisecond clock seam for deadline math; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Millisecond sleep seam; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type OpenContextMenuOptions = {
  /** The localized titles the menu is expected to show (≥1 must appear). */
  readonly titles: ContextMenuTitles;
  /** Bounded wait for the menu surface; default 5s. */
  readonly timeoutMs?: number;
  /** Poll interval inside the wait; default 150ms. */
  readonly pollIntervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
/** Points of slack allowed when checking `at` sits inside the frame. */
const POINT_TOLERANCE = 1;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function framesEqual(a: GuiFrame | null | undefined, b: GuiFrame | null | undefined): boolean {
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

function pointInsideFrame(
  point: { readonly x: number; readonly y: number },
  frame: GuiFrame,
): boolean {
  return (
    point.x >= frame.x - POINT_TOLERANCE &&
    point.x <= frame.x + frame.width + POINT_TOLERANCE &&
    point.y >= frame.y - POINT_TOLERANCE &&
    point.y <= frame.y + frame.height + POINT_TOLERANCE
  );
}

/**
 * Map a platform/transport failure onto the public codes: observation
 * failures are `unavailable`; a mutation whose outcome is unknown is
 * `indeterminate`; coded `GuiRecoveryError`s are provable non-mutations.
 */
function asContextMenuError(error: unknown, duringAct: boolean): ContextMenuError {
  if (error instanceof ContextMenuError) {
    return error;
  }
  if (error instanceof GuiMutationError) {
    return new ContextMenuError("indeterminate", errorText(error), { cause: error });
  }
  if (error instanceof MacSessionError || error instanceof GuiRecoveryError) {
    return new ContextMenuError("unavailable", errorText(error), { cause: error });
  }
  return new ContextMenuError(duringAct ? "indeterminate" : "unavailable", errorText(error), {
    cause: error,
  });
}

/** Map a post/press vehicle verdict onto the contract's outcome. */
function verdictError(
  verdict: ContextMenuPostVerdict,
  what: string,
): ContextMenuError | null {
  switch (verdict) {
    case "clicked":
      return null;
    case "missing":
      return new ContextMenuError(
        "unavailable",
        `the ${what} reported "missing": the target process or its window ` +
          "listing is gone — re-observe before retrying",
      );
    case "changed":
    case "not-found":
      return new ContextMenuError(
        "stale-locator",
        `the ${what} reported "${verdict}": the surface moved between ` +
          "resolution and act; nothing was posted — re-resolve and retry",
      );
    case "failed":
      return new ContextMenuError(
        "indeterminate",
        `the ${what} was attempted but the platform reported failure; ` +
          "the outcome is unknown — re-observe before any retry",
      );
    default: {
      const exhaustive: never = verdict;
      return new ContextMenuError("unavailable", `unknown verdict ${String(exhaustive)}`);
    }
  }
}

export class ContextMenuController {
  readonly #ops: ContextMenuOps;
  readonly #authorizeMutation: ContextMenuMutationGate | undefined;
  readonly #now: () => Date;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ContextMenuControllerOptions) {
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#now = options.now ?? (() => new Date());
    this.#clock = options.clock ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  #observe(): GuiAppState {
    try {
      return this.#ops.observe();
    } catch (error) {
      throw asContextMenuError(error, false);
    }
  }

  #requireMutationAllowed(op: ContextMenuMutationOp): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for context-menu operations; every act is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new ContextMenuError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Resolve the right-click target against a fresh observation: the
   * window at `locator.windowIndex` must still carry the declared
   * title/subrole/frame, be pid-attributed, and contain the post point.
   */
  #resolveSurface(locator: ContextMenuTargetLocator): ContextMenuSurface {
    if (!Number.isInteger(locator.windowIndex) || locator.windowIndex < 1) {
      throw new ContextMenuError(
        "invalid-locator",
        `windowIndex must be a positive integer, got ${String(locator.windowIndex)}`,
      );
    }
    const state = this.#observe();
    const window = state.windows[locator.windowIndex - 1];
    if (window === undefined) {
      throw new ContextMenuError(
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
      framesEqual(window.frame ?? null, expected.frame);
    if (!same) {
      throw new ContextMenuError(
        "stale-locator",
        `the window at listing index ${locator.windowIndex} changed since ` +
          `resolution ("${expected.title}" → "${window.title}"); nothing was posted`,
      );
    }
    if (!isPidAttributedWindow(window) || window.frame == null) {
      throw new ContextMenuError(
        "unproven",
        `the surface at listing index ${locator.windowIndex} cannot be proven ` +
          'to belong to this After Effects instance (attribution ' +
          `${window.censusAttribution ?? "unproven"}); refusing the right-click`,
      );
    }
    const frame = window.frame;
    const at = locator.at;
    const point =
      at === undefined
        ? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
        : { x: at.x, y: at.y };
    if (!pointInsideFrame(point, frame)) {
      throw new ContextMenuError(
        "invalid-locator",
        `the post point ${point.x},${point.y} lies outside the re-verified ` +
          `frame ${JSON.stringify(frame)}; coordinates inside the proven ` +
          "frame only — there is no remembered-position fallback",
      );
    }
    return {
      windowIndex: locator.windowIndex,
      window,
      point,
      resolvedAt: this.#now().toISOString(),
    };
  }

  /**
   * Scan one observation for the declared context menu among windows
   * that were NOT in the pre-click listing. Returns the resolution, or
   * a coded refusal when a *different* new blocking dialog is what the
   * right-click raised — its items are never pressed.
   */
  #scanNewWindows(
    state: GuiAppState,
    titles: ContextMenuTitles,
    baselineKeys: ReadonlySet<string>,
  ): {
    readonly resolution: ContextMenuResolution | null;
    readonly refusal: ContextMenuError | null;
  } {
    const matches: { index: number; window: GuiWindowInfo }[] = [];
    for (let i = 0; i < state.windows.length; i += 1) {
      const window = state.windows[i];
      if (window === undefined) continue;
      if (baselineKeys.has(contextMenuWindowKey(window))) {
        continue;
      }
      const match = matchContextMenu(window, titles);
      switch (match.kind) {
        case "not-a-window":
        case "not-a-menu":
          continue;
        case "human-only":
          return {
            resolution: null,
            refusal: new ContextMenuError(
              "refused",
              `new window ${i + 1} "${window.title}" is a human-only surface ` +
                "(sign-in/licence class); the context-menu flow refuses to interact with it",
            ),
          };
        case "unrecognized-dialog":
          return {
            resolution: null,
            refusal: new ContextMenuError(
              "refused",
              `new window ${i + 1} "${window.title}" is a blocking dialog whose ` +
                "titles do not match the declared context-menu items; the " +
                "right-click may have raised a modal — refusing rather than " +
                "pressing an unclassified surface",
            ),
          };
        case "context-menu":
          matches.push({ index: i + 1, window });
      }
    }
    if (matches.length === 0) {
      return { resolution: null, refusal: null };
    }
    if (matches.length > 1) {
      return {
        resolution: null,
        refusal: new ContextMenuError(
          "ambiguous-target",
          `${matches.length} new windows match the context-menu titles; ` +
            "refusing to guess which is the menu",
          {
            candidates: matches.map(
              (m) => `#${m.index} "${m.window.title}" role=${m.window.role}`,
            ),
          },
        ),
      };
    }
    const only = matches[0];
    if (only === undefined) {
      return { resolution: null, refusal: null };
    }
    return {
      resolution: {
        index: only.index,
        window: only.window,
        items: contextMenuItems(only.window),
        baselineKeys: [...baselineKeys],
        observedAt: this.#now().toISOString(),
      },
      refusal: null,
    };
  }

  /**
   * Right-click the resolved surface and bounded-wait for the menu.
   * Mutate-gui end to end: gated, single post, never resent.
   */
  async open(
    locator: ContextMenuTargetLocator,
    options: OpenContextMenuOptions,
  ): Promise<ContextMenuResolution> {
    this.#requireMutationAllowed("open");
    if (this.#ops.rightClick === undefined) {
      throw new ContextMenuError(
        "unsupported",
        "no right-click vehicle is available on this build (the CGEvent " +
          "right-button poster lands with the platform input helpers); " +
          "refusing before anything posts",
      );
    }
    if (options.titles.items.length === 0) {
      throw new ContextMenuError(
        "unsupported-locale",
        "the declared context-menu titles are empty; a menu that cannot be " +
          "named by its observed items can never be classified — there is " +
          "no coordinate fallback",
      );
    }

    // Resolve + baseline come from ONE observation so the diff is exact:
    // the menu must be a window this listing did not already contain.
    const surface = this.#resolveSurface(locator);
    const baselineState = this.#observe();
    const baselineKeys = new Set(baselineState.windows.map(contextMenuWindowKey));

    let verdict: ContextMenuPostVerdict;
    try {
      verdict = await this.#ops.rightClick({
        windowIndex: surface.windowIndex,
        expected: surface.window,
        point: surface.point,
      });
    } catch (error) {
      throw asContextMenuError(error, true);
    }
    const postError = verdictError(verdict, "right-click");
    if (postError !== null) {
      throw postError;
    }

    // Bounded wait for the menu surface — observe-class polling, the
    // same shape as FileDialogController.awaitFileDialog.
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const deadline = this.#clock() + timeoutMs;
    for (;;) {
      const state = this.#observe();
      const { resolution, refusal } = this.#scanNewWindows(
        state,
        options.titles,
        baselineKeys,
      );
      if (refusal !== null) {
        throw refusal;
      }
      if (resolution !== null) {
        return resolution;
      }
      if (this.#clock() >= deadline) {
        throw new ContextMenuError(
          "indeterminate",
          `no context-menu window matching the declared titles appeared ` +
            `within ${timeoutMs}ms of the right-click; the menu may still ` +
            "be opening or the post may not have landed — re-observe before " +
            "retrying and never resend automatically",
        );
      }
      await this.#sleep(Math.min(pollIntervalMs, Math.max(1, deadline - this.#clock())));
    }
  }

  /**
   * The menu's observed item candidates — observe-class. Re-resolves the
   * window at `resolution.index` and refuses `stale-locator` when it no
   * longer carries the recorded identity.
   */
  items(
    resolution: ContextMenuResolution,
    titles: ContextMenuTitles,
  ): { readonly items: readonly ContextMenuItem[]; readonly observedAt: string } {
    const current = this.#reresolveMenu(resolution, titles);
    return {
      items: contextMenuItems(current.window),
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Re-resolve a previously returned menu immediately before an act:
   * same listing index, same title/subrole/frame, still classified as
   * the declared menu, still pid-attributed. Anything else is
   * `stale-locator` — the menu the caller saw is gone or replaced, and
   * pressing by index alone could hit a different window.
   */
  #reresolveMenu(
    resolution: ContextMenuResolution,
    titles: ContextMenuTitles,
  ): ContextMenuResolution {
    const state = this.#observe();
    const window = state.windows[resolution.index - 1];
    if (window === undefined) {
      throw new ContextMenuError(
        "stale-locator",
        `the menu window at listing index ${resolution.index} is gone; ` +
          "it was dismissed or the listing drifted — re-run open",
      );
    }
    const same =
      window.title === resolution.window.title &&
      window.subrole === resolution.window.subrole &&
      framesEqual(window.frame ?? null, resolution.window.frame ?? null);
    if (!same) {
      throw new ContextMenuError(
        "stale-locator",
        `the window at listing index ${resolution.index} changed since ` +
          `resolution ("${resolution.window.title}" → "${window.title}"); ` +
          "re-run open",
      );
    }
    // The window must still be NEW relative to the recorded baseline —
    // a same-shaped window that was always there is not the menu.
    const baseline = new Set(resolution.baselineKeys);
    if (baseline.has(contextMenuWindowKey(window))) {
      throw new ContextMenuError(
        "stale-locator",
        `the window at listing index ${resolution.index} was present before ` +
          "the right-click; it is not the context menu that was resolved",
      );
    }
    const match = matchContextMenu(window, titles);
    if (match.kind !== "context-menu" || !isPidAttributedWindow(window)) {
      throw new ContextMenuError(
        "unproven",
        "the resolved menu no longer proves pid attribution or " +
          "context-menu shape at act time; refusing the press",
      );
    }
    return {
      ...resolution,
      window,
      items: contextMenuItems(window),
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Press one item inside the resolved menu. Mutate-gui: gated,
   * re-resolved immediately before the press, and the item title must
   * still be exposed by the window — a title that vanished is
   * `not-found`, never a nearest-match press.
   */
  async invokeItem(
    resolution: ContextMenuResolution,
    titles: ContextMenuTitles,
    itemTitle: string,
  ): Promise<ContextMenuActResult> {
    this.#requireMutationAllowed("invoke-item");
    if (this.#ops.pressItem === undefined) {
      throw new ContextMenuError(
        "unsupported",
        "no menu-item press vehicle is available on this build; " +
          "refusing before anything posts",
      );
    }
    const current = this.#reresolveMenu(resolution, titles);
    const exposed = contextMenuItems(current.window).map((item) => item.title);
    if (!exposed.includes(itemTitle)) {
      throw new ContextMenuError(
        "not-found",
        `the resolved menu exposes no item titled ${JSON.stringify(itemTitle)}; ` +
          "observed candidates: " +
          (exposed.length === 0 ? "(none)" : exposed.map((t) => JSON.stringify(t)).join(", ")),
      );
    }
    let verdict: ContextMenuPostVerdict;
    try {
      verdict = await this.#ops.pressItem({
        windowIndex: current.index,
        title: itemTitle,
        expected: current.window,
      });
    } catch (error) {
      throw asContextMenuError(error, true);
    }
    const pressError = verdictError(verdict, "menu-item press");
    if (pressError !== null) {
      throw pressError;
    }
    return {
      action: "invoke-item",
      detail: `pressed "${itemTitle}"`,
      actedAt: this.#now().toISOString(),
    };
  }
}

export type { ContextMenuActResult };
