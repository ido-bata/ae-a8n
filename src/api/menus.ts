/**
 * Public menu-bar API (#360, `specs/workspace-editing/spec.md` §5–§7).
 *
 * `ae.menuBar()` returns a handle whose operations run the workspace
 * spec's menu contract: enumerate the Accessibility menu-bar tree,
 * read an item's checkmark state, and invoke a menu item — all
 * addressed by the titles AE actually shows (localized), never by
 * coordinate and never through `app.findMenuCommandId` (that stays a
 * `scripting-direct` discovery aid).
 *
 * Honesty rules carried from `ae.panel()`/`ae.guiState()`:
 *
 *   - No owned, attested target → every operation reports `unavailable`.
 *   - macOS only in this slice. Windows reports `unsupported` — the
 *     UIA MenuBar/MenuItem path is a separate ticket.
 *   - `enumerate`/`readCheckState` are observe-class. `invoke` is
 *     mutate-gui and stays gated: the production gate refuses it until
 *     the A-SAFETY review clears a menu-invoke class — see
 *     `menuCapabilities()` for the current answer.
 *   - AE's menu-bar AX fidelity (subroles, checkmark exposure) is
 *     unverified on a real host; every capability reports its level.
 */

import { MenuController, type MenuMutationGate } from "../menus/controller.js";
import { MacMenuSurface, type MacMenuSurfaceOptions } from "../menus/darwin.js";
import { menuInvokeGate } from "../menus/gate.js";
import {
  MenuError,
  type MenuBarSnapshot,
  type MenuCapabilities,
  type MenuCapability,
  type MenuCheckReading,
  type MenuInvokeResult,
  type MenuItemLocator,
  type ResolvedMenuItem,
} from "../menus/types.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import type { GuiRecoveryOptions } from "../driver/gui-recovery.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";

export type {
  MenuBarItemInfo,
  MenuBarSnapshot,
  MenuCapabilities,
  MenuCapability,
  MenuCheckReading,
  MenuCheckState,
  MenuErrorCode,
  MenuInvokeResult,
  MenuItemLocator,
  MenuItemNode,
  ResolvedMenuItem,
} from "../menus/types.js";
export { MenuError } from "../menus/types.js";

/** The verification level every menu claim carries until real-host proof. */
const VERIFICATION: MenuCapability["verification"] = "automated test";

/**
 * What this build supports for the menu-bar surface on `platform`.
 * Windows is deliberately all-unsupported: no UIA menu vehicle is
 * implemented or verified there, and nothing here may imply otherwise.
 */
export function menuCapabilities(platform: NodeJS.Platform): MenuCapabilities {
  if (platform !== "darwin") {
    const unsupported: MenuCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "the menu-bar surface is implemented for macOS only in this slice; " +
        "the Windows UIA MenuBar/MenuItem path is a separate ticket",
    };
    return { platform: "win32", enumerate: unsupported, checkState: unsupported, invoke: unsupported };
  }
  return {
    platform: "darwin",
    enumerate: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "System Events menu-bar walk is wired but AE's menu AX fidelity " +
        "(subroles, checkmark exposure) is unverified on a real host",
    },
    checkState: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "AXMenuItemMarkChar readback is contracted; whether AE exposes " +
        "checkmarks through it is unverified on a real host — \"unknown\" " +
        "is a real answer, not a guessed unchecked",
    },
    invoke: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by menuInvokeGate() per the A-SAFETY " +
        "audit (docs/gui-supervision-safety-gates.md) and the workspace " +
        "spec §13; the code path exists and is contract-tested but " +
        "refuses until the audit clears it",
    },
  };
}

/** Seams the production adapter needs; mirrors `PanelSeams`. */
export type MenuSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: MenuMutationGate;
  readonly ownerId?: string;
  /** Pid-identity re-check, forwarded to `MacMenuSurface`. */
  readonly verifyProcess?: GuiRecoveryOptions["verifyProcess"];
};

function surfaceOptions(
  target: GuiObservationTarget,
  seams: MenuSeams,
  allowConsoleSession: boolean,
): MacMenuSurfaceOptions {
  return {
    session: target.session,
    pid: target.pid,
    allowConsoleSession,
    ...(seams.stateRoot === undefined ? {} : { stateRoot: seams.stateRoot }),
    ...(seams.ownerId === undefined ? {} : { ownerId: seams.ownerId }),
    ...(seams.lease === undefined ? {} : { lease: seams.lease }),
    ...(seams.runSession === undefined ? {} : { runSession: seams.runSession }),
    ...(seams.verifyProcess === undefined
      ? {}
      : { verifyProcess: seams.verifyProcess }),
    ...(seams.readTargetSession === undefined
      ? {}
      : { readTargetSession: seams.readTargetSession }),
    ...(seams.consoleUid === undefined ? {} : { consoleUid: seams.consoleUid }),
  };
}

/**
 * A handle to one After Effects instance's menu bar. Every operation
 * re-observes and re-resolves — a `MenuBar` is a locator, not a handle,
 * so a menu that changed is re-proven or refused rather than silently
 * retargeted.
 */
export class MenuBar {
  readonly #controller: MenuController;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(controller: MenuController, telemetry?: OpTelemetry) {
    this.#controller = controller;
    this.#telemetry = telemetry;
  }

  /** Enumerate the menu-bar tree. Observe-class. */
  list(): Promise<MenuBarSnapshot> {
    return observeOp(this.#telemetry, "menuBar.list", undefined, () =>
      Promise.resolve().then(() => this.#controller.listMenuBar()),
    );
  }

  /** Resolve a locator against the live menu bar. Observe-class. */
  find(locator: MenuItemLocator): Promise<ResolvedMenuItem & { observedAt: string }> {
    return observeOp(this.#telemetry, "menuBar.find", { locator }, () =>
      Promise.resolve().then(() => this.#controller.findMenuItem(locator)),
    );
  }

  /**
   * Read the item's checkmark state (`AXMenuItemMarkChar`). Observe-class;
   * `"unknown"` means the attribute could not be read — never a guessed
   * "unchecked".
   */
  checkState(locator: MenuItemLocator): Promise<MenuCheckReading & { observedAt: string }> {
    return observeOp(this.#telemetry, "menuBar.checkState", { locator }, () =>
      Promise.resolve().then(() => this.#controller.readCheckState(locator)),
    );
  }

  /**
   * Invoke the menu item. Mutate-gui: gated — currently refused in
   * production until the A-SAFETY review clears a menu-invoke class.
   * Re-resolves immediately before the act; the platform vehicle
   * re-verifies every title inside the session.
   */
  invoke(locator: MenuItemLocator): Promise<MenuInvokeResult> {
    return observeOp(this.#telemetry, "menuBar.invoke", { locator }, () =>
      this.#controller.invoke(locator),
    );
  }
}

/**
 * The `ae.menuBar()` body: attest the owned target, refuse unsupported
 * platforms, and bind the controller. Called with the session's
 * `recoveryTarget()` — `null` means no owned pid/session is provable.
 */
export function menuBarForTarget(
  target: GuiObservationTarget | null,
  seams: MenuSeams = {},
  telemetry?: OpTelemetry,
): MenuBar {
  if (target === null) {
    throw new MenuError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven menu bar to observe",
    );
  }
  if (process.platform !== "darwin") {
    throw new MenuError(
      "unsupported",
      `the menu-bar surface is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  // Two surface views share the target, like macPanelOps: the observer
  // may run in the console session (read-only, same rule as guiState);
  // the mutator keeps the default console refusal — a menu press is a
  // real GUI mutation on the screen the user may be watching.
  let mutator: MacMenuSurface | null = null;
  const ops = {
    observeMenuBar: () =>
      new MacMenuSurface(surfaceOptions(target, seams, true)).listMenuBar(),
    invokeMenuItem: (invoke: { path: readonly number[]; titles: readonly string[] }) => {
      if (mutator === null) {
        // Construction can refuse (console session, unreadable console
        // owner) — that refusal is a provable non-mutation.
        mutator = new MacMenuSurface(surfaceOptions(target, seams, false));
      }
      return mutator.invokeMenuItem(invoke);
    },
  };
  const controller = new MenuController({
    pid: target.pid,
    ops,
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: docs/gui-supervision-safety-gates.md is the
    // policy source and src/menus/gate.ts its single code flip point.
    authorizeMutation: seams.authorizeMutation ?? menuInvokeGate(),
  });
  return new MenuBar(controller, telemetry);
}
