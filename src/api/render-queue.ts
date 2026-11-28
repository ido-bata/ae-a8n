/**
 * Public Render Queue API (#365, `specs/workspace-editing/spec.md` §3 W3).
 *
 * `ae.renderQueue(locator)` returns a handle whose operations run the
 * W3 contract: AX-observed queue-item rows through the `docked-region`
 * deep walk (#361), and menu-driven add through the gated menu invoke
 * (#360) with a bounded, never-resent postcondition wait.
 *
 * Honesty rules carried from `ae.dockedPane()`/`ae.menuBar()`:
 *
 *   - No owned, attested target → every operation reports `unavailable`.
 *   - macOS only in this slice; Windows reports `unsupported`.
 *   - There is NO DOM readback for the render queue: every snapshot is
 *     stamped `oracle: "limited"` — AX rows plus walk evidence only.
 *     Whether AE exposes one row per queue item is unverified on a real
 *     host.
 *   - `items` is observe-class. `addViaMenu` invokes the real menu —
 *     `mutate-gui`, gated — and never falls back to
 *     `menu.execute`/`app.executeCommand`, which are `scripting-direct`
 *     and never GUI-pass evidence (spec §2).
 */

import type { GuiObservationTarget } from "./gui-state.js";
import type { DockedPaneLocator, DockedPaneSeams } from "./docked-pane.js";
import {
  type MenuBar,
  type MenuSeams,
  menuBarForTarget,
} from "./menus.js";
import type { MenuItemLocator } from "../menus/types.js";
import {
  addCompositionToRenderQueue,
  RenderQueueObserver,
  type AddToRenderQueueOptions,
  type RenderQueueAddResult,
  type RenderQueueSnapshot,
} from "../renderqueue/index.js";
import { RenderQueueError } from "../renderqueue/types.js";
import {
  AX_PANE_WALK_SCRIPT,
  type DockedPaneOps,
} from "../panels/docked/index.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";

export type {
  RenderQueueAddResult,
  RenderQueueErrorCode,
  RenderQueueItem,
  RenderQueueOracle,
  RenderQueueSnapshot,
  RenderQueueWalkInfo,
} from "../renderqueue/types.js";
export { RenderQueueError, RENDER_QUEUE_ORACLE } from "../renderqueue/types.js";
export type { AddToRenderQueueOptions } from "../renderqueue/orchestrate.js";

/** The verification level every render-queue claim carries until real-host proof. */
const VERIFICATION = "automated test" as const;

/** Per-capability honesty record, same shape as `MenuCapability`. */
export type RenderQueueCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with the Render Queue surface on this platform. */
export type RenderQueueCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly observe: RenderQueueCapability;
  readonly addViaMenu: RenderQueueCapability;
};

/**
 * What this build supports for the render-queue surface on `platform`.
 * Windows is deliberately all-unsupported in this slice.
 */
export function renderQueueCapabilities(platform: NodeJS.Platform): RenderQueueCapabilities {
  if (platform !== "darwin") {
    const unsupported: RenderQueueCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "the render-queue surface is implemented for macOS only in this slice; " +
        "the Windows RQ pane walk is a separate ticket",
    };
    return { platform: "win32", observe: unsupported, addViaMenu: unsupported };
  }
  return {
    platform: "darwin",
    observe: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "the bounded docked-pane AX walk is contracted (#361) but no DOM " +
        "readback exists for the render queue — the oracle is \"limited\" " +
        "and AE's RQ pane AX fidelity is unverified on a real host",
    },
    addViaMenu: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "menu invoke is mutate-gui and gated off by menuInvokeGate() per " +
        "the A-SAFETY audit; the orchestration exists and is contract-tested " +
        "but refuses until the audit clears it",
    },
  };
}

/** Seams the production adapter needs; mirrors `DockedPaneSeams` + menu mutation. */
export type RenderQueueSeams = DockedPaneSeams & {
  /** Mutation gate override forwarded to the menu invoke — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: MenuSeams["authorizeMutation"];
};

/**
 * Bind the platform-neutral observer to the macOS GUI recovery — the
 * same vehicle `ae.dockedPane()` uses (observe-class, console session
 * allowed for the read-only walk).
 */
function macDockedPaneOps(
  target: GuiObservationTarget,
  seams: RenderQueueSeams,
): DockedPaneOps {
  const base: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    allowConsoleSession: true,
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
  const observer = new MacGuiRecovery(base);
  const frameArg = (frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): string =>
    [frame.x, frame.y, frame.width, frame.height]
      .map((value) => String(Math.round(value)))
      .join(",");
  return {
    observe: () => observer.listWindows(),
    censusWindows: () => {
      const view = observer.windowServerWindows();
      return {
        available: view.available,
        reason: view.reason,
        windows: view.windows,
      };
    },
    walkPane: (request) =>
      observer.accessibilityQuery(
        AX_PANE_WALK_SCRIPT,
        [
          String(target.pid),
          frameArg(request.parentFrame),
          String(request.maxDepth),
          String(request.maxNodes),
          String(request.maxSeconds),
        ],
        "render-queue-pane-walk",
      ),
  };
}

/**
 * A handle to the owned After Effects instance's Render Queue pane.
 * `items` re-walks the pane on every call; `addViaMenu` composes the
 * gated menu invoke with a bounded postcondition wait — a locator set,
 * not a cached handle.
 */
export class RenderQueue {
  readonly #observer: RenderQueueObserver;
  readonly #pane: DockedPaneLocator;
  readonly #menuBar: () => MenuBar;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(
    observer: RenderQueueObserver,
    pane: DockedPaneLocator,
    menuBar: () => MenuBar,
    telemetry?: OpTelemetry,
  ) {
    this.#observer = observer;
    this.#pane = pane;
    this.#menuBar = menuBar;
    this.#telemetry = telemetry;
  }

  /**
   * The pane's visible rows as queue-item candidates — observe-class,
   * `oracle: "limited"`. There is no DOM readback for the render queue;
   * these rows are the only honest channel.
   */
  items(): Promise<RenderQueueSnapshot> {
    return observeOp(this.#telemetry, "renderQueue.items", { pane: this.#pane }, () =>
      Promise.resolve().then(() => this.#observer.snapshot(this.#pane)),
    );
  }

  /**
   * Add a composition to the render queue through the real menu path
   * (e.g. `{ menuPath: ["Composition"], itemTitle: "Add to Render Queue" }`)
   * and verify the pane gained rows within the bounded wait.
   *
   * The menu invoke is `mutate-gui` and gated — currently refused in
   * production until the A-SAFETY review clears it. On wait expiry the
   * result is `indeterminate`: the click may still be in flight and is
   * never resent.
   */
  addViaMenu(options: AddToRenderQueueOptions): Promise<RenderQueueAddResult> {
    const menuBar = this.#menuBar();
    return observeOp(this.#telemetry, "renderQueue.addViaMenu", { options }, () =>
      addCompositionToRenderQueue(
        {
          observer: this.#observer,
          pane: this.#pane,
          invokeMenu: (locator: MenuItemLocator) => menuBar.invoke(locator),
        },
        options,
      ),
    );
  }
}

/**
 * The `ae.renderQueue()` body: attest the owned target, refuse
 * unsupported platforms, and bind the observer + menu surface.
 * `target === null` means no owned pid/session is provable — same
 * fail-closed shape as `dockedPaneForTarget`.
 */
export function renderQueueForTarget(
  target: GuiObservationTarget | null,
  locator: DockedPaneLocator,
  seams: RenderQueueSeams = {},
  telemetry?: OpTelemetry,
): RenderQueue {
  if (target === null) {
    throw new RenderQueueError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window list to resolve a render-queue pane against",
    );
  }
  if (process.platform !== "darwin") {
    throw new RenderQueueError(
      "unsupported",
      `the render-queue surface is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const ops = macDockedPaneOps(target, seams);
  const observer = new RenderQueueObserver({
    pid: target.pid,
    ops,
    ...(seams.bounds === undefined ? {} : { bounds: seams.bounds }),
  });
  // The menu surface is built lazily per addViaMenu call so a session
  // that never invokes never constructs the mutator view — and so the
  // mutation gate inside menuBarForTarget is consulted at act time.
  const menuBar = (): MenuBar =>
    menuBarForTarget(target, {
      ...(seams.stateRoot === undefined ? {} : { stateRoot: seams.stateRoot }),
      ...(seams.ownerId === undefined ? {} : { ownerId: seams.ownerId }),
      ...(seams.lease === undefined ? {} : { lease: seams.lease }),
      ...(seams.runSession === undefined ? {} : { runSession: seams.runSession }),
      ...(seams.readTargetSession === undefined
        ? {}
        : { readTargetSession: seams.readTargetSession }),
      ...(seams.consoleUid === undefined ? {} : { consoleUid: seams.consoleUid }),
      ...(seams.authorizeMutation === undefined
        ? {}
        : { authorizeMutation: seams.authorizeMutation }),
    });
  return new RenderQueue(observer, locator, menuBar, telemetry);
}

