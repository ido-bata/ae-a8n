/**
 * Menu-driven Render Queue add (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3, §10).
 *
 * The scenario: Composition > Add to Render Queue through the real AX
 * menu path (#360 invoke — itself `mutate-gui` and gate-pending), then
 * verify a new item appeared in the Render Queue pane's AX rows.
 *
 * Safety shape, per spec §10 (wait vs resend):
 *
 *   - The menu invoke runs once, through the injected invoker — this
 *     module never calls `menu.execute`/`app.executeCommand`, which are
 *     `scripting-direct` and never GUI-pass evidence (spec §2).
 *   - The postcondition is a bounded wait: poll the pane's row count
 *     until it grows past the pre-invoke snapshot or the deadline
 *     expires. Deadline → `indeterminate` — the invoke may still be in
 *     flight inside AE and is NEVER resent; a fresh caller-initiated
 *     attempt after re-observation is the only retry.
 *   - Observation failures mid-wait propagate — a pane that cannot be
 *     re-walked is reported, not smoothed over.
 */

import type { DockedPaneLocator } from "../panels/docked/index.js";
import type { MenuItemLocator } from "../menus/types.js";
import type { RenderQueueObserver } from "./observer.js";
import {
  RenderQueueError,
  type RenderQueueAddResult,
  type RenderQueueItem,
  type RenderQueueSnapshot,
} from "./types.js";

/** The menu invoke seam — production binds `MenuBar.invoke`. */
export type RenderQueueMenuInvoker = (
  locator: MenuItemLocator,
) => Promise<unknown>;

export type AddToRenderQueueOptions = {
  /**
   * The localized menu locator, e.g.
   * `{ menuPath: ["Composition"], itemTitle: "Add to Render Queue" }`.
   * Resolved against a fresh menu-bar observation by the invoker.
   */
  readonly menu: MenuItemLocator;
  /** Bounded postcondition wait; default 10s. */
  readonly timeoutMs?: number;
  /** Poll interval inside the wait; default 250ms. */
  readonly pollIntervalMs?: number;
};

export type AddToRenderQueueDeps = {
  readonly observer: RenderQueueObserver;
  /** The Render Queue pane locator the snapshots resolve against. */
  readonly pane: DockedPaneLocator;
  readonly invokeMenu: RenderQueueMenuInvoker;
  /** Millisecond sleep seam — tests inject a fake clock driver. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rows present in `after` whose axPath+text were not in `before`. */
function addedRows(
  before: readonly RenderQueueItem[],
  after: readonly RenderQueueItem[],
): RenderQueueItem[] {
  const seen = new Set(before.map((row) => `${row.axPath}${row.text}`));
  return after.filter((row) => !seen.has(`${row.axPath}${row.text}`));
}

/**
 * Add the active composition to the render queue through the real menu
 * path and verify the pane gained rows — the W3 act+observe pair.
 *
 * Throws `RenderQueueError("indeterminate")` when the bounded wait
 * expires: the menu press may still be landing inside AE, so the honest
 * report is "unknown", never a resend and never a guessed success. Menu
 * invoke refusals (`MenuError` `refused`/`unsupported-locale`/…) and
 * pane resolution failures propagate unchanged — they are already
 * typed, coded answers.
 */
export async function addCompositionToRenderQueue(
  deps: AddToRenderQueueDeps,
  options: AddToRenderQueueOptions,
): Promise<RenderQueueAddResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  // Pre-invoke snapshot: the postcondition is a *delta*, so the "before"
  // must be observed immediately before the act, inside the same call.
  const beforeSnapshot: RenderQueueSnapshot = deps.observer.snapshot(deps.pane);

  // The act: one menu invoke, gated inside the invoker (mutate-gui).
  // Its errors propagate — a refused invoke is a provable non-mutation.
  await deps.invokeMenu(options.menu);

  const deadline = now() + timeoutMs;
  let afterSnapshot: RenderQueueSnapshot = beforeSnapshot;
  for (;;) {
    afterSnapshot = deps.observer.snapshot(deps.pane);
    if (afterSnapshot.items.length > beforeSnapshot.items.length) {
      return {
        before: beforeSnapshot.items.length,
        after: afterSnapshot.items.length,
        added: addedRows(beforeSnapshot.items, afterSnapshot.items),
        beforeSnapshot,
        afterSnapshot,
        oracle: afterSnapshot.oracle,
      };
    }
    if (now() >= deadline) {
      throw new RenderQueueError(
        "indeterminate",
        `the render-queue pane showed no new rows within ${timeoutMs}ms of the ` +
          "menu invoke; the click may still be in flight inside After Effects — " +
          "re-observe before any retry and never resend the invoke automatically",
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}
