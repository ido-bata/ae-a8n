/**
 * Public context-menu API (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §6, §7, §9).
 *
 * `ae.contextMenu()` returns a handle whose operations run the W4+
 * context-menu contract: a gated right-click posted inside a
 * re-verified frame (CGEvent right-button via `input-mouse` on macOS),
 * a bounded new-window wait that classifies the raised surface like a
 * dialog, and gated item presses.
 *
 * Honesty rules carried from `ae.fileDialog()`/`ae.menuBar()`:
 *
 *   - No owned, attested target → construction throws
 *     `ContextMenuError` `unavailable`; there is no proven surface to
 *     right-click.
 *   - macOS only in this slice. Windows reports `unsupported` — the
 *     SendInput right-button + UIA context-pattern path is a separate
 *     ticket even though the input helper exists (#373).
 *   - `open`/`invokeItem` are `mutate-gui` and stay gated: the
 *     production gate refuses until the A-SAFETY review clears a
 *     context-menu class — see `contextMenuCapabilities()`.
 *   - Whether a CGEvent right-button post opens AE's context menus,
 *     and whether the menu surface exposes stable AX item titles, is
 *     unverified on a real host (spec §11); every capability reports
 *     its level.
 */

import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";
import {
  ContextMenuController,
  type ContextMenuOps,
} from "../contextmenu/controller.js";
import { contextMenuMutationGate } from "../contextmenu/gate.js";
import {
  ContextMenuError,
  type ContextMenuActResult,
  type ContextMenuCapabilities,
  type ContextMenuItem,
  type ContextMenuMutationGate,
  type ContextMenuResolution,
  type ContextMenuTargetLocator,
  type ContextMenuTitles,
  type OpenContextMenuOptions,
} from "../contextmenu/index.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import {
  darwinMouseClick,
  sessionInputExec,
  type DarwinInputExec,
} from "../input/darwin.js";
import { ensureDarwinInputHelpers } from "./input.js";

export type {
  ContextMenuActResult,
  ContextMenuCapabilities,
  ContextMenuCapability,
  ContextMenuErrorCode,
  ContextMenuItem,
  ContextMenuResolution,
  ContextMenuSurface,
  ContextMenuTargetLocator,
  ContextMenuTitles,
  OpenContextMenuOptions,
} from "../contextmenu/index.js";
export {
  ContextMenuError,
  contextMenuExposedTitles,
  contextMenuItems,
  contextMenuMutationGate,
  contextMenuWindowKey,
  matchContextMenu,
  type ContextMenuMatch,
} from "../contextmenu/index.js";
export type {
  ContextMenuControllerOptions,
  ContextMenuMutationGate,
  ContextMenuMutationOp,
  ContextMenuOps,
  ContextMenuPostVerdict,
} from "../contextmenu/index.js";

/** The verification level every context-menu claim carries until real-host proof. */
const VERIFICATION = "automated test" as const;

/**
 * What this build supports for the context-menu surface on `platform`.
 * Windows is deliberately all-unsupported in this slice.
 */
export function contextMenuCapabilities(platform: NodeJS.Platform): ContextMenuCapabilities {
  if (platform !== "darwin") {
    const unsupported = {
      support: "unsupported" as const,
      verification: "implemented" as const,
      reason:
        "the context-menu surface is implemented for macOS only in this slice; " +
        "the Windows SendInput right-button + UIA context path is a separate ticket",
    };
    return { platform: "win32", open: unsupported, items: unsupported, invokeItem: unsupported };
  }
  return {
    platform: "darwin",
    open: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by contextMenuMutationGate() per the " +
        "A-SAFETY audit; additionally the CGEvent right-button post and " +
        "the context-menu AX surface are unverified on a real host (spec §11)",
    },
    items: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "observe-class item enumeration over the resolved menu window's " +
        "button/text listing; whether AE exposes context-menu items through " +
        "that listing is unverified on a real host",
    },
    invokeItem: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by contextMenuMutationGate() per the " +
        "A-SAFETY audit; the press path exists and is contract-tested but " +
        "refuses until the audit clears it",
    },
  };
}

/** Seams the production adapter needs; mirrors `FileDialogSeams`. */
export type ContextMenuSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: ContextMenuMutationGate;
  /**
   * Compiled darwin input-helper directory (tests / prebuilt helpers).
   * Absent → auto-detect via `ensureDarwinInputHelpers()`.
   */
  readonly helpersDir?: string | undefined;
  /** Test seam: replace the right-click vehicle entirely. */
  readonly rightClick?: ContextMenuOps["rightClick"];
  /** Test seam: replace the item-press vehicle entirely. */
  readonly pressItem?: ContextMenuOps["pressItem"];
};

function guiOptions(
  target: GuiObservationTarget,
  seams: ContextMenuSeams,
  allowConsoleSession: boolean,
): GuiRecoveryOptions {
  return {
    session: target.session,
    pid: target.pid,
    allowConsoleSession,
    ...(seams.stateRoot === undefined ? {} : { stateRoot: seams.stateRoot }),
    ...(seams.ownerId === undefined ? {} : { ownerId: seams.ownerId }),
    ...(seams.lease === undefined ? {} : { lease: seams.lease }),
    ...(seams.runSession === undefined ? {} : { runSession: seams.runSession }),
    ...(seams.census === undefined ? {} : { census: seams.census }),
    ...(seams.censusRun === undefined ? {} : { censusRun: seams.censusRun }),
    ...(seams.readTargetSession === undefined
      ? {}
      : { readTargetSession: seams.readTargetSession }),
    ...(seams.consoleUid === undefined ? {} : { consoleUid: seams.consoleUid }),
  };
}

/**
 * A handle to the owned After Effects instance's context menus.
 * `open` re-observes on every call; `invokeItem` re-resolves the menu
 * window immediately before pressing — a `ContextMenuResolution` is a
 * locator set, not a handle to a remembered window.
 */
export class ContextMenu {
  readonly #controller: ContextMenuController;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(controller: ContextMenuController, telemetry?: OpTelemetry) {
    this.#controller = controller;
    this.#telemetry = telemetry;
  }

  /**
   * Right-click the declared surface and bounded-wait for the menu.
   * Mutate-gui: gated, single post, never resent. The post point is the
   * frame center or `locator.at` — always inside the re-verified frame.
   */
  open(
    locator: ContextMenuTargetLocator,
    options: OpenContextMenuOptions,
  ): Promise<ContextMenuResolution> {
    return observeOp(this.#telemetry, "contextMenu.open", { locator }, () =>
      Promise.resolve().then(() => this.#controller.open(locator, options)),
    );
  }

  /**
   * The resolved menu's observed item candidates — observe-class.
   * Re-resolves the window; a dismissed or drifted menu is
   * `stale-locator`.
   */
  items(
    resolution: ContextMenuResolution,
    titles: ContextMenuTitles,
  ): Promise<{ readonly items: readonly ContextMenuItem[]; readonly observedAt: string }> {
    return observeOp(this.#telemetry, "contextMenu.items", undefined, () =>
      Promise.resolve().then(() => this.#controller.items(resolution, titles)),
    );
  }

  /**
   * Press one item inside the resolved menu. Mutate-gui: gated and
   * re-resolved immediately before the press; the title must still be
   * exposed — no nearest-match fallback.
   */
  invokeItem(
    resolution: ContextMenuResolution,
    titles: ContextMenuTitles,
    itemTitle: string,
  ): Promise<ContextMenuActResult> {
    return observeOp(this.#telemetry, "contextMenu.invokeItem", { itemTitle }, () =>
      Promise.resolve().then(() =>
        this.#controller.invokeItem(resolution, titles, itemTitle),
      ),
    );
  }
}

/**
 * The `ae.contextMenu()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller. `target === null`
 * means no owned pid/session is provable — same fail-closed shape as
 * `fileDialogForTarget`.
 */
export function contextMenuForTarget(
  target: GuiObservationTarget | null,
  seams: ContextMenuSeams = {},
  telemetry?: OpTelemetry,
): ContextMenu {
  if (target === null) {
    throw new ContextMenuError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven window list to right-click against",
    );
  }
  if (process.platform !== "darwin") {
    throw new ContextMenuError(
      "unsupported",
      `the context-menu surface is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  // Two views share the target, like fileDialogForTarget: the observer
  // may run in the console session (read-only listing); the mutators
  // keep the default console refusal — a right-click is a real GUI
  // mutation on the screen the user may be watching.
  let mutator: MacGuiRecovery | null = null;
  const mutatorView = (): MacGuiRecovery => {
    if (mutator === null) {
      mutator = new MacGuiRecovery(guiOptions(target, seams, false));
    }
    return mutator;
  };

  // The right-click vehicle: the compiled `input-mouse` helper inside
  // the target session (CGEvent right-button post). Absent helpers or a
  // test override leave the channel unset — `open` then refuses
  // `unsupported` before anything posts.
  let rightClick = seams.rightClick;
  if (rightClick === undefined) {
    const helpersDir = seams.helpersDir ?? ensureDarwinInputHelpers();
    if (helpersDir !== null) {
      const exec: DarwinInputExec = sessionInputExec({
        session: target.session,
        helpersDir,
      });
      const click = darwinMouseClick(exec, { tap: "session" });
      rightClick = ({ point }) => {
        click({ x: point.x, y: point.y, button: "right" });
        return "clicked";
      };
    }
  }

  const ops: ContextMenuOps = {
    observe: () =>
      new MacGuiRecovery(guiOptions(target, seams, true)).listWindows(),
    ...(rightClick === undefined ? {} : { rightClick }),
    pressItem:
      seams.pressItem ??
      (({ windowIndex, title, expected }) => {
        // Best available vehicle: the same in-window title press the
        // file-dialog acts use. Whether AE's context-menu items are
        // exposed as pressable titled elements is unverified on a real
        // host — a miss reports `not-found`, never a blind click.
        const pressed = mutatorView().pressButtonIn(
          windowIndex,
          title,
          expected,
          "",
        );
        return pressed ? ("clicked" as const) : ("not-found" as const);
      }),
  };
  const controller = new ContextMenuController({
    pid: target.pid,
    ops,
    // The A-SAFETY gate is wired explicitly, not left to the
    // controller's fail-closed default: docs/gui-supervision-safety-gates.md
    // is the policy source and src/contextmenu/gate.ts its flip point.
    authorizeMutation: seams.authorizeMutation ?? contextMenuMutationGate(),
  });
  return new ContextMenu(controller, telemetry);
}
