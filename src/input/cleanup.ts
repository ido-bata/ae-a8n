/**
 * The cleanup contract logic (spec §5.5, #371).
 *
 * Every input op runs under a `finally` that guarantees:
 *
 *   - **Key/button residue** — every `keyDown` is paired with `keyUp`
 *     in the same lease scope; the pressed-set is released in reverse
 *     order; modifier flags are cleared; no stuck-key state may
 *     survive an exception, timeout, or cancellation.
 *   - **Composition residue** — a pending composition is resolved
 *     explicitly (commit or cancel per declared semantics) and the
 *     resulting state reported.
 *   - **Shared state** — clipboard prior contents and prior IME mode
 *     are restored; restore failure is reported, not hidden.
 *   - **Focus** — focus/frontmost state we changed is restored where
 *     practical; where restore fails it is reported as evidence.
 *   - **Bounded waits** — every step has a deadline; timeout →
 *     `indeterminate`, never retried blind (UNKNOWN non-resend).
 *
 * This module is the *logic* half: it tracks what was pressed, builds
 * the guaranteed cleanup plan in reverse order, and records each
 * action's outcome. The actual posting of cleanup events goes through
 * the same `InputPoster` port as the plan itself.
 */

import { createHash } from "node:crypto";

import type {
  ClipboardSnapshot,
  FocusHolder,
  InputCleanupAction,
  InputCleanupReport,
  InputCleanupResult,
  InputPoster,
} from "./types.js";

/** Canonical modifier names, sorted so evidence is deterministic. */
export function normalizeModifiers(
  modifiers: readonly string[] | undefined,
): string[] {
  return [...new Set(modifiers ?? [])].sort();
}

/**
 * Tracks pressed keys for the duration of one op. Insertion-ordered:
 * `pendingReleases()` returns key-ups in reverse press order, which is
 * the order that unwinds modifier+key combinations correctly.
 */
export class PressedKeySet {
  private readonly order: string[] = [];
  private readonly modifiers = new Map<string, readonly string[]>();

  /** Record a key-down. Re-pressing an already-pressed key is a no-op. */
  press(key: string, modifiers?: readonly string[]): void {
    if (this.order.includes(key)) return;
    this.order.push(key);
    this.modifiers.set(key, normalizeModifiers(modifiers));
  }

  /** Record a key-up. Unknown keys are ignored (idempotent cleanup). */
  release(key: string): void {
    const at = this.order.indexOf(key);
    if (at === -1) return;
    this.order.splice(at, 1);
    this.modifiers.delete(key);
  }

  /**
   * Key-up actions for every still-pressed key, in reverse press
   * order, each carrying the modifiers that were held with it.
   */
  pendingReleases(): InputCleanupAction[] {
    const actions: InputCleanupAction[] = [];
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const key = this.order[i];
      if (key === undefined) continue;
      actions.push({
        type: "key-up",
        key,
        modifiers: this.modifiers.get(key) ?? [],
        residue: true,
      });
    }
    return actions;
  }

  /** Modifier names still held by any pressed key, for the release sweep. */
  heldModifiers(): string[] {
    const held = new Set<string>();
    for (const mods of this.modifiers.values()) {
      for (const mod of mods) held.add(mod);
    }
    return [...held].sort();
  }

  get size(): number {
    return this.order.length;
  }

  /** True when nothing is left pressed — the cleanup invariant. */
  get clean(): boolean {
    return this.order.length === 0;
  }
}

/**
 * Everything one op must restore, accumulated during the run and
 * discharged in `finally`. Records — not payloads — for shared state.
 */
export type CleanupPlan = {
  readonly pressed: PressedKeySet;
  clipboardPrior: ClipboardSnapshot | null;
  imePrior: { readonly mode: string | null } | null;
  /** Focus holder before we requested focus, when changed by us. */
  focusPrior: FocusHolder | null;
  /** Declared composition resolution, when the op set one. */
  compositionResolution: "commit" | "cancel" | null;
};

export function newCleanupPlan(): CleanupPlan {
  return {
    pressed: new PressedKeySet(),
    clipboardPrior: null,
    imePrior: null,
    focusPrior: null,
    compositionResolution: null,
  };
}

/**
 * Build the ordered cleanup action list (spec §5.5): residue key-ups
 * in reverse order, modifier release, then shared-state restores,
 * composition resolution, and focus restore last.
 */
export function cleanupActions(plan: CleanupPlan): InputCleanupAction[] {
  const actions: InputCleanupAction[] = [...plan.pressed.pendingReleases()];

  const modifiers = plan.pressed.heldModifiers();
  if (modifiers.length > 0) {
    actions.push({ type: "release-modifiers", modifiers });
  }
  if (plan.clipboardPrior !== null) {
    actions.push({ type: "restore-clipboard", snapshot: plan.clipboardPrior });
  }
  if (plan.imePrior !== null) {
    actions.push({ type: "restore-ime-mode", snapshot: plan.imePrior });
  }
  if (plan.compositionResolution !== null) {
    actions.push({
      type: "resolve-composition",
      resolution: plan.compositionResolution,
    });
  }
  if (plan.focusPrior !== null) {
    actions.push({ type: "restore-focus", holder: plan.focusPrior });
  }
  return actions;
}

/**
 * Execute the cleanup plan against the poster/ops and record every
 * outcome. A failing action is recorded `failed` with its error —
 * restore failure is reported, never hidden — and does not stop the
 * remaining actions: a stuck modifier is worse than a skipped restore.
 */
export async function runCleanup(
  plan: CleanupPlan,
  deps: {
    readonly poster: InputPoster;
    readonly clipboardRestore?: (snapshot: ClipboardSnapshot) => void | Promise<void>;
    readonly imeRestore?: (mode: string | null) => void | Promise<void>;
    readonly compositionResolve?: (resolution: "commit" | "cancel") => void | Promise<void>;
    readonly focusRestore?: (holder: FocusHolder) => void | Promise<void>;
  },
): Promise<InputCleanupReport> {
  const results: InputCleanupResult[] = [];

  const attempt = async (
    action: InputCleanupAction,
    run: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await run();
      results.push({ action, outcome: "performed", detail: null });
    } catch (error) {
      results.push({
        action,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const action of cleanupActions(plan)) {
    switch (action.type) {
      case "key-up":
        await attempt(action, () => deps.poster.keyUp(action.key, action.modifiers));
        plan.pressed.release(action.key);
        break;
      case "release-modifiers":
        // Modifiers are keys too: release each through the poster so
        // the pressed-set and the OS stay consistent.
        for (const mod of action.modifiers) {
          await attempt(
            { type: "key-up", key: mod, modifiers: [], residue: true },
            () => deps.poster.keyUp(mod, []),
          );
          plan.pressed.release(mod);
        }
        break;
      case "restore-clipboard":
        if (deps.clipboardRestore === undefined) {
          results.push({
            action,
            outcome: "skipped",
            detail: "no clipboard restore channel wired",
          });
        } else {
          await attempt(action, () => deps.clipboardRestore!(action.snapshot));
        }
        break;
      case "restore-ime-mode":
        if (deps.imeRestore === undefined) {
          results.push({
            action,
            outcome: "skipped",
            detail: "no IME restore channel wired",
          });
        } else {
          await attempt(action, () => deps.imeRestore!(action.snapshot.mode));
        }
        break;
      case "resolve-composition":
        if (deps.compositionResolve === undefined) {
          results.push({
            action,
            outcome: "skipped",
            detail: "no composition-resolution channel wired",
          });
        } else {
          await attempt(action, () => deps.compositionResolve!(action.resolution));
        }
        break;
      case "restore-focus":
        if (deps.focusRestore === undefined) {
          results.push({
            action,
            outcome: "skipped",
            detail: "no focus-restore channel wired",
          });
        } else {
          await attempt(action, () => deps.focusRestore!(action.holder));
        }
        break;
    }
  }

  const allRestored = results.every(
    (r) => r.outcome === "performed" || r.outcome === "skipped",
  );
  return { actions: results, allRestored };
}

/** Digest a text payload for evidence without storing it raw. */
export function payloadDigest(text: string): {
  readonly length: number;
  readonly sha256: string;
} {
  return {
    length: text.length,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
