/**
 * Public workspace API (#363, W1 of `specs/workspace-editing/spec.md`
 * §3; parent #345 / program #337).
 *
 * `ae.workspace()` returns a handle whose operations run the W1
 * contract: `observe`/`listWorkspaces`/`verifyRestore` are observe-class
 * (menu checkmark identity, panel frames, read-only workspace XML);
 * `switchTo`/`arrange` are mutate-gui and stay gated — the production
 * gate refuses them until the A-SAFETY review clears a workspace
 * mutation class (`docs/gui-supervision-safety-gates.md`).
 *
 * Honesty rules carried from `ae.menuBar()`/`ae.panel()`:
 *
 *   - No owned, attested target → construction throws `WorkspaceError`
 *     `unavailable`; there is no honest screen to observe.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - `arrange` additionally needs the drag vehicle, which does not
 *     exist yet (the B-IME `mouse-drag` poster is unimplemented) — it
 *     reports `unsupported` even where the gate would allow.
 *   - AE's menu checkmark fidelity, real drag docking and workspace XML
 *     write timing are all unverified on a real host; every capability
 *     reports `automated test` at most.
 */

import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import { MacMenuSurface, type MacMenuSurfaceOptions } from "../menus/darwin.js";
import { DockedPaneObserver } from "../panels/docked/index.js";
import { resolvePanelTarget } from "../panels/resolve.js";
import type { DockedPaneLocator } from "../panels/docked/index.js";
import type { PanelLocator, PanelTarget } from "../panels/types.js";
import { WorkspaceController } from "../workspace/controller.js";
import { workspaceMutationGate } from "../workspace/gate.js";
import {
  WorkspaceError,
  type WorkspaceArrangeRequest,
  type WorkspaceArrangeResult,
  type WorkspaceMenuEntry,
  type WorkspaceMenuPath,
  type WorkspaceMutationGate,
  type WorkspaceObservation,
  type WorkspacePollOptions,
  type WorkspaceRestoreReport,
  type WorkspaceSurfaceOps,
  type WorkspaceSwitchResult,
} from "../workspace/types.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import { macDockedPaneOps } from "./docked-pane.js";
import type { DockedPaneSeams } from "./docked-pane.js";
import {
  snapshotWorkspaceStore,
  type DiscoverOptions,
} from "../workspace-xml/index.js";

export type {
  WorkspaceArrangeDestination,
  WorkspaceArrangeExpectation,
  WorkspaceArrangeRequest,
  WorkspaceArrangeResult,
  WorkspaceDragRequest,
  WorkspaceDragVerdict,
  WorkspaceErrorCode,
  WorkspaceIdentity,
  WorkspaceMenuEntry,
  WorkspaceMenuPath,
  WorkspaceObservation,
  WorkspaceObservationFailure,
  WorkspacePanelFrame,
  WorkspacePollOptions,
  WorkspaceRestoreReport,
  WorkspaceSurfaceOps,
  WorkspaceSwitchResult,
  WorkspaceTarget,
  WorkspaceXmlComparison,
  WorkspaceXmlEvidence,
} from "../workspace/types.js";
export { WorkspaceError } from "../workspace/types.js";
export { workspaceFramesMatch, compareWorkspaceFrames } from "../workspace/controller.js";
export { DEFAULT_WORKSPACE_MENU_PATH } from "../workspace/types.js";
export {
  discoverWorkspaceXml,
  inspectWorkspaceXml,
  resolveWorkspacePreferencesDir,
  snapshotWorkspaceStore,
  workspaceXmlRef,
  extractWorkspaceNames,
  compareVersionDirNames,
  WORKSPACE_STORE_NAMES,
} from "../workspace-xml/index.js";
export type {
  DiscoverOptions,
  InspectedWorkspaceXml,
  MissingWorkspaceStore,
  ResolvePreferencesOptions,
  WorkspaceDiscovery,
  WorkspaceLayout,
  WorkspaceStoreKind,
  WorkspaceStoreSnapshot,
  WorkspaceXmlErrorCode,
  WorkspaceXmlFile,
  WorkspaceXmlInspection,
  WorkspaceXmlRef,
} from "../workspace-xml/index.js";
export { WorkspaceXmlError } from "../workspace-xml/types.js";

/** Per-capability honesty record, same shape as `PanelCapability`. */
export type WorkspaceCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with workspaces on this platform. */
export type WorkspaceCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly observe: WorkspaceCapability;
  readonly switchWorkspace: WorkspaceCapability;
  readonly arrange: WorkspaceCapability;
  readonly verifyRestore: WorkspaceCapability;
};

/** The verification level every workspace claim carries until real-host proof. */
const VERIFICATION: WorkspaceCapability["verification"] = "automated test";

/**
 * What this build supports for workspace editing on `platform`.
 * Windows is deliberately all-unsupported: the menu-bar, pane-walk and
 * drag vehicles are macOS-only in this slice.
 */
export function workspaceCapabilities(platform: NodeJS.Platform): WorkspaceCapabilities {
  if (platform !== "darwin") {
    const unsupported: WorkspaceCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "workspace editing is implemented for macOS only in this slice; " +
        "the Windows menu/pane/drag vehicles are separate tickets",
    };
    return {
      platform: "win32",
      observe: unsupported,
      switchWorkspace: unsupported,
      arrange: unsupported,
      verifyRestore: unsupported,
    };
  }
  return {
    platform: "darwin",
    observe: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "menu checkmark identity + panel frames + read-only workspace XML " +
        "are wired but AE's menu AX fidelity and the XML layout are " +
        "unverified on a real host",
    },
    switchWorkspace: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by workspaceMutationGate() per the " +
        "A-SAFETY audit (docs/gui-supervision-safety-gates.md) and the " +
        "workspace spec §13; the code path exists and is contract-tested " +
        "but refuses until the audit clears it",
    },
    arrange: {
      support: "unsupported",
      verification: VERIFICATION,
      reason:
        "no drag vehicle exists yet — the B-IME mouse-drag poster " +
        "(specs/ime-input/spec.md §6, #372) is unimplemented, so arrange " +
        "refuses unsupported even where the mutation gate would allow",
    },
    verifyRestore: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "frame-equality + XML-record comparison is observe-class and runs " +
        "wherever an owned target is attested; what it proves about a real " +
        "AE restore is unverified on a real host",
    },
  };
}

/** Seams the production adapter needs; mirrors `MenuSeams`/`PanelSeams`. */
export type WorkspaceSeams = GuiObservationSeams &
  DockedPaneSeams & {
    /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
    readonly authorizeMutation?: WorkspaceMutationGate;
    /** Where the Workspace submenu lives; defaults to English "Window > Workspace". */
    readonly menuPath?: WorkspaceMenuPath;
    /** Bounded postcondition polling overrides (defaults in the controller). */
    readonly poll?: WorkspacePollOptions;
    /** Docked panes tracked by every observation (bounded AX walk each). */
    readonly dockedPanes?: readonly DockedPaneLocator[];
    /** Workspace-XML discovery overrides (explicit preferencesDir/aeVersion for tests). */
    readonly xml?: DiscoverOptions;
    readonly ownerId?: string;
    /** Pid-identity re-check, forwarded to the macOS surfaces. */
    readonly verifyProcess?: GuiRecoveryOptions["verifyProcess"];
  };

function menuSurfaceOptions(
  target: GuiObservationTarget,
  seams: WorkspaceSeams,
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
 * Bind the platform-neutral controller to the macOS surfaces. Two
 * `MacMenuSurface` views share the target like `menuBarForTarget`:
 * observation may run in the console session; the mutator keeps the
 * default console refusal — a menu press is a real GUI mutation.
 */
function macWorkspaceOps(
  target: GuiObservationTarget,
  seams: WorkspaceSeams,
): WorkspaceSurfaceOps {
  const {
    authorizeMutation: _gate,
    menuPath: _menuPath,
    poll: _poll,
    dockedPanes: _panes,
    xml: _xml,
    bounds: _bounds,
    ...surfaceSeams
  } = seams;
  const guiBase: GuiRecoveryOptions = {
    session: target.session,
    pid: target.pid,
    allowConsoleSession: true,
    ...surfaceSeams,
  };
  const observer = new MacGuiRecovery(guiBase);
  const paneObserver = new DockedPaneObserver({
    pid: target.pid,
    ops: macDockedPaneOps(target, seams),
  });
  let mutator: MacMenuSurface | null = null;
  return {
    observeMenuBar: () =>
      new MacMenuSurface(menuSurfaceOptions(target, seams, true)).listMenuBar(),
    invokeMenuItem: (invoke) => {
      if (mutator === null) {
        mutator = new MacMenuSurface(menuSurfaceOptions(target, seams, false));
      }
      return mutator.invokeMenuItem(invoke);
    },
    observeWindows: () => observer.listWindows(),
    resolvePanel: (locator: PanelLocator): PanelTarget => {
      const state = observer.listWindows();
      const census = observer.windowServerWindows();
      return resolvePanelTarget({
        pid: target.pid,
        state,
        census: census.available ? census.windows : [],
        locator,
      }).target;
    },
    resolveDockedPane: (locator: DockedPaneLocator) => paneObserver.identify(locator),
    // No `drag`: the B-IME mouse-drag poster does not exist yet, so
    // `arrange` reports `unsupported` — deliberately absent, not stubbed.
    snapshotXml: () => snapshotWorkspaceStore(seams.xml ?? {}),
  };
}

/**
 * A handle to the session's owned After Effects workspace (#363). Every
 * method re-observes — a `Workspace` is a locator, not a handle, so a
 * workspace that changed is re-proven or refused rather than silently
 * retargeted.
 */
export class Workspace {
  readonly #controller: WorkspaceController;

  constructor(controller: WorkspaceController) {
    this.#controller = controller;
  }

  /**
   * One observe pass: active-workspace identity from the menu checkmark,
   * panel frames (windows plus the configured docked panes), and the
   * read-only workspace-XML store. Observe-class.
   */
  observe(options?: {
    readonly dockedPanes?: readonly DockedPaneLocator[];
  }): Promise<WorkspaceObservation> {
    return Promise.resolve().then(() => this.#controller.observe(options));
  }

  /**
   * The Workspace submenu's leaf entries with check state and XML
   * persistence — the discovery read for picking a `switchTo` target.
   * Observe-class.
   */
  listWorkspaces(): Promise<WorkspaceMenuEntry[]> {
    return Promise.resolve().then(() => this.#controller.listWorkspaces());
  }

  /**
   * Switch the active workspace through the Window > Workspace menu —
   * the GUI path only. Mutate-gui: gated (currently refused in
   * production), re-resolved before the act, bounded checkmark poll,
   * never resent.
   */
  switchTo(name: string): Promise<WorkspaceSwitchResult> {
    return this.#controller.switchTo(name);
  }

  /**
   * Arrange a panel by real drag (dock↔float, tab regroup, window move).
   * Mutate-gui and vehicle-dependent: reports `unsupported` until the
   * B-IME drag poster lands, `refused` while the A-SAFETY gate holds.
   */
  arrange(request: WorkspaceArrangeRequest): Promise<WorkspaceArrangeResult> {
    return this.#controller.arrange(request);
  }

  /**
   * Verify a prior `observe()` against the live screen — active
   * workspace name, panel frames within tolerance, XML persistence
   * records. Observe-class; this is the restore-verification half of
   * the save/restore AC.
   */
  verifyRestore(
    expected: WorkspaceObservation,
    options?: { readonly tolerance?: number },
  ): Promise<WorkspaceRestoreReport> {
    return Promise.resolve().then(() =>
      this.#controller.verifyRestore(expected, options),
    );
  }
}

/**
 * The `ae.workspace()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller. `target === null`
 * means no owned pid/session is provable — same fail-closed shape as
 * `menuBarForTarget`/`panelForTarget`.
 */
export function workspaceForTarget(
  target: GuiObservationTarget | null,
  seams: WorkspaceSeams = {},
): Workspace {
  if (target === null) {
    throw new WorkspaceError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven screen to observe a workspace on",
    );
  }
  if (process.platform !== "darwin") {
    throw new WorkspaceError(
      "unsupported",
      `workspace editing is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  const controller = new WorkspaceController({
    pid: target.pid,
    ops: macWorkspaceOps(target, seams),
    // The A-SAFETY gate is wired explicitly, not left to the
    // controller's fail-closed default: docs/gui-supervision-safety-gates.md
    // is the policy source and src/workspace/gate.ts its flip point.
    authorizeMutation: seams.authorizeMutation ?? workspaceMutationGate(),
    ...(seams.menuPath === undefined ? {} : { menuPath: seams.menuPath }),
    ...(seams.poll === undefined ? {} : { poll: seams.poll }),
    ...(seams.dockedPanes === undefined ? {} : { dockedPanes: seams.dockedPanes }),
  });
  return new Workspace(controller);
}
