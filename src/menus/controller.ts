/**
 * Menu-bar operation orchestration (#360,
 * `specs/workspace-editing/spec.md` §5/§6). Platform-neutral: every
 * OS-specific action arrives through the injected `MenuSurfaceOps`, so
 * enumeration, checkmark readback and invoke behave identically on
 * macOS, Windows (when it lands) and in tests.
 *
 * Safety shape, mirroring `PanelController`:
 *
 *   - Every operation re-resolves the locator against a fresh
 *     observation; nothing caches a menu item across calls.
 *   - `enumerate`/`readCheckState` are `observe`: no lease, but an
 *     unavailable observation is reported, never an empty tree.
 *   - `invoke` is `mutate-gui`: it requires the injected mutation gate
 *     (fail-closed when absent), resolves again immediately before the
 *     act, and lets the platform vehicle re-verify every title inside
 *     the target session. A `CHANGED`/`NOT_FOUND` answer is a provable
 *     non-mutation (`stale-locator`); a `FAILED` press or a thrown
 *     mutation error is `indeterminate` — re-observe, never auto-resend
 *     (spec §10).
 */

import {
  GuiMutationError,
  GuiRecoveryError,
  MacSessionError,
} from "../driver/gui-recovery.js";
import { resolveMenuItem } from "./resolve.js";
import {
  MenuError,
  type MenuBarSnapshot,
  type MenuCapabilities,
  type MenuCheckReading,
  type MenuInvokeResult,
  type MenuItemLocator,
} from "./types.js";

/**
 * Every OS touch the controller needs, injected. The production adapter
 * (`src/api/menus.ts`) binds these to `MacMenuSurface`; tests bind fakes.
 */
export type MenuSurfaceOps = {
  /** One menu-bar observation of the target pid (observe-class). */
  observeMenuBar(): MenuBarSnapshot;
  /**
   * Press the menu item at `path`, after re-verifying `titles` inside
   * the target session. Runs under whatever lease/identity checks the
   * platform requires. Returns the script's verdict; throws
   * `GuiMutationError` when the outcome is unknown.
   */
  invokeMenuItem(target: {
    readonly path: readonly number[];
    readonly titles: readonly string[];
  }): Promise<MenuInvokeVerdict> | MenuInvokeVerdict;
};

/** The raw verdict the platform invoke vehicle reports. */
export type MenuInvokeVerdict =
  | "clicked"
  | "not-found"
  | "changed"
  | "failed"
  | "missing"
  | "nomenubar";

export type MenuMutationGate = (
  op: "invoke",
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type MenuControllerOptions = {
  readonly pid: number;
  readonly ops: MenuSurfaceOps;
  /**
   * The mutate-gui gate. Fail-closed: absent means every invoke refuses.
   * Production wires the A-SAFETY gate state; tests inject allow/deny.
   */
  readonly authorizeMutation?: MenuMutationGate;
  readonly now?: () => Date;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map a platform/transport failure onto the public error codes:
 * observation failures are `unavailable`; a mutation whose outcome is
 * unknown is `indeterminate`; coded `GuiRecoveryError`s are refusals.
 */
function asMenuError(error: unknown, duringInvoke: boolean): MenuError {
  if (error instanceof MenuError) {
    return error;
  }
  if (error instanceof GuiMutationError) {
    return new MenuError("indeterminate", errorText(error), { cause: error });
  }
  if (error instanceof MacSessionError || error instanceof GuiRecoveryError) {
    // Session-entry failures and coded pre-mutation refusals are provable
    // non-mutations: nothing was sent to the screen.
    return new MenuError("unavailable", errorText(error), { cause: error });
  }
  // Anything else during an invoke may have partially reached the screen.
  return new MenuError(duringInvoke ? "indeterminate" : "unavailable", errorText(error), {
    cause: error,
  });
}

export class MenuController {
  readonly #ops: MenuSurfaceOps;
  readonly #authorizeMutation: MenuMutationGate | undefined;
  readonly #now: () => Date;

  constructor(options: MenuControllerOptions) {
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#now = options.now ?? (() => new Date());
  }

  /** One fresh observation; observe-class, never leased. */
  listMenuBar(): MenuBarSnapshot {
    try {
      return this.#ops.observeMenuBar();
    } catch (error) {
      throw asMenuError(error, false);
    }
  }

  /** Resolve a locator against a fresh observation. Observe-class. */
  findMenuItem(locator: MenuItemLocator) {
    const snapshot = this.listMenuBar();
    const resolved = resolveMenuItem(snapshot, locator);
    return {
      ...resolved,
      observedAt: snapshot.observedAt,
    };
  }

  /**
   * The checkmark readback W1 needs: resolve, then report the observed
   * `AXMenuItemMarkChar` state verbatim. `"unknown"` is a real answer —
   * callers must not treat it as "unchecked".
   */
  readCheckState(locator: MenuItemLocator): MenuCheckReading & {
    readonly observedAt: string;
  } {
    const found = this.findMenuItem(locator);
    return {
      resolved: found,
      check: found.node.check,
      markChar: found.node.markChar,
      observedAt: found.observedAt,
    };
  }

  #requireMutationAllowed(): void {
    const gate = this.#authorizeMutation?.("invoke") ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for menu operations; menu invoke is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new MenuError(
        "refused",
        `menu invoke refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Invoke the resolved menu item. Mutate-gui: gated, re-resolved
   * immediately before the act, and the platform vehicle re-verifies
   * every title inside the session. Never auto-resends — a `stale` or
   * `indeterminate` outcome requires a fresh caller-initiated attempt.
   */
  async invoke(locator: MenuItemLocator): Promise<MenuInvokeResult> {
    this.#requireMutationAllowed();
    // Re-resolution immediately before the act (spec §6): the locator
    // is proven against a fresh observation, not a cached one.
    const resolved = this.findMenuItem(locator);
    let verdict: MenuInvokeVerdict;
    try {
      verdict = await this.#ops.invokeMenuItem({
        path: resolved.node.path,
        titles: resolved.titles,
      });
    } catch (error) {
      throw asMenuError(error, true);
    }
    switch (verdict) {
      case "clicked":
        return { resolved, invokedAt: this.#now().toISOString() };
      case "missing":
      case "nomenubar":
        throw new MenuError(
          "unavailable",
          `the menu invoke reported "${verdict}": the target process or its menu bar ` +
            "is gone — re-observe before retrying",
        );
      case "changed":
      case "not-found":
        throw new MenuError(
          "stale-locator",
          `the menu item moved between resolution and invoke (verdict "${verdict}"); ` +
            "nothing was clicked — re-resolve and retry",
        );
      case "failed":
        throw new MenuError(
          "indeterminate",
          "the menu press was attempted but the platform reported failure; " +
            "the outcome is unknown — re-observe before any retry",
        );
      default: {
        const exhaustive: never = verdict;
        throw new MenuError("unavailable", `unknown invoke verdict ${String(exhaustive)}`);
      }
    }
  }
}

export type { MenuCapabilities };
