/**
 * Workspace editing contract — W1 slice (#363,
 * `specs/workspace-editing/spec.md` §3 W1, §5, §10; parent #345 / program
 * #337).
 *
 * This module fixes the vocabulary the workspace vertical slice uses:
 *
 *   - `WorkspaceTarget` — the spec §5 descriptor. The active workspace is
 *     *not* durable state: its identity is re-read from the Window >
 *     Workspace menu checkmark on every observation, never cached.
 *   - `WorkspaceObservation` — one observe pass: menu identity, panel
 *     frames (window census + bounded docked-pane walk), and the
 *     read-only workspace-XML store snapshot.
 *   - The operation results for `switch` / `arrange` / `verifyRestore`,
 *     each carrying before/after evidence rather than a bare verdict.
 *
 * Mutation honesty (spec §10, §13): every mutating op is `mutate-gui`,
 * runs behind the injected gate (fail-closed), never auto-resends, and
 * reports `indeterminate` when a bounded postcondition wait expires.
 */

import type { GuiAppState } from "../driver/gui-recovery.js";
import type { MenuInvokeVerdict } from "../menus/controller.js";
import type { MenuBarSnapshot, MenuCheckState } from "../menus/types.js";
import type { DockedPaneLocator, DockedPaneResolution } from "../panels/docked/index.js";
import type { PanelFrame, PanelLocator, PanelTarget } from "../panels/types.js";
import type {
  WorkspaceStoreSnapshot,
  WorkspaceXmlRef,
} from "../workspace-xml/types.js";
import type { MonitorCensus, MonitorEvidence } from "./monitors/types.js";

/**
 * The spec §5 `WorkspaceTarget` descriptor, extended with the pid the
 * observation belongs to (same role `PanelTarget.pid` plays).
 *
 * `workspace.name === null` means "the checked item could not be named"
 * is NOT what this means — a resolved target always carries the checked
 * item's observed title. `null` is reserved for a workspace AE itself
 * leaves unnamed; today no observation produces it, and the field stays
 * nullable because the spec fixes the shape ahead of the evidence.
 */
export type WorkspaceTarget = {
  readonly pid: number;
  readonly workspace: {
    /** The checked menu item's observed title; null = unnamed layout. */
    readonly name: string | null;
    /** True when the name appears in a discovered workspace XML store. */
    readonly persisted: boolean;
    /** Read-only evidence handle — never identity (spec §5). */
    readonly xmlRef?: WorkspaceXmlRef;
  };
  readonly resolvedAt: string;
};

/** One leaf item inside the Workspace submenu, with its observed state. */
export type WorkspaceMenuEntry = {
  readonly title: string;
  /** 1-based index path the invoke vehicle addresses. */
  readonly path: readonly number[];
  readonly enabled: boolean | null;
  readonly check: MenuCheckState;
  /** True when the title appears in a discovered workspace XML store. */
  readonly persisted: boolean;
  readonly xmlRef?: WorkspaceXmlRef;
};

/**
 * The answer to "which workspace is active". `resolved` carries the
 * checkmark-proven target; `unknown` is the honest answer when the
 * checkmark cannot be read — spec §5: re-read from the menu checkmark
 * "or, failing that, indeterminate". Observation reports `unknown`
 * rather than throwing so callers can still use the rest of the
 * observation.
 */
export type WorkspaceIdentity =
  | {
      readonly status: "resolved";
      readonly target: WorkspaceTarget;
      /** The checked submenu entry the identity rests on. */
      readonly item: WorkspaceMenuEntry;
    }
  | {
      readonly status: "unknown";
      readonly reason: string;
    };

/** One panel's frame as observed during a workspace pass. */
export type WorkspacePanelFrame = {
  /** `"window"` is a census/AX window; `"docked-region"` a walked pane. */
  readonly kind: "window" | "docked-region";
  readonly title: string | null;
  readonly role: string | null;
  readonly subrole: string | null;
  readonly frame: PanelFrame;
  /**
   * Census/parent attribution. Only `"owned"` frames are usable as
   * mutation evidence — the same rule `PanelTarget` carries.
   */
  readonly attribution: "owned" | "foreign" | "unmatched" | "unproven";
  /** The pane locator echoed for `docked-region` entries; absent for windows. */
  readonly paneLocator?: DockedPaneLocator;
};

/** A surface observation that failed during an observe pass. */
export type WorkspaceObservationFailure = {
  readonly channel: "windows" | "docked-pane";
  /** Present for `docked-pane` failures — the locator that failed. */
  readonly locator?: DockedPaneLocator;
  readonly code: string;
  readonly message: string;
};

/** The workspace-XML side of one observation. */
export type WorkspaceXmlEvidence = {
  readonly status: "observed" | "unavailable";
  readonly reason: string | null;
  readonly snapshot: WorkspaceStoreSnapshot | null;
};

/** One full observe pass — the evidence every W1 op reads back. */
export type WorkspaceObservation = {
  readonly pid: number;
  readonly identity: WorkspaceIdentity;
  /** The menu-bar listing summary the identity came from. */
  readonly menu: {
    readonly available: boolean;
    readonly reason: string | null;
    readonly truncated: boolean;
  };
  readonly panels: readonly WorkspacePanelFrame[];
  readonly failures: readonly WorkspaceObservationFailure[];
  readonly xml: WorkspaceXmlEvidence;
  readonly observedAt: string;
};

/**
 * The drag vehicle contract (spec §10 drag-sequence integrity). The
 * production adapter has no drag poster yet — B-IME `mouse-drag`
 * delivery (#372) is unimplemented — so `ops.drag` is absent in
 * production and `arrange`/`move` refuse `unsupported` before any gate
 * question. Tests bind fakes; a real vehicle must implement the
 * press → move → release sequence atomically inside one lease and
 * abort (never finish the drag) on focus change.
 */
export type WorkspaceDragRequest = {
  readonly kind: "panel-arrange" | "window-move";
  /** The source surface's frame in global points. */
  readonly from: PanelFrame;
  /** The destination region's frame in global points. */
  readonly to: PanelFrame;
  /**
   * Optional explicit grab/drop points in global coordinates. Absent
   * means the vehicle chooses inside the re-verified frames — it must
   * never use remembered positions (spec §6 coordinate fallback rule).
   */
  readonly grab?: { readonly x: number; readonly y: number };
  readonly drop?: { readonly x: number; readonly y: number };
};

export type WorkspaceDragVerdict =
  /** The drag sequence completed and released. */
  | "performed"
  /** The vehicle proved nothing was dragged (identity lost mid-sequence). */
  | "not-performed"
  /** The drag was attempted and its outcome is unknown. */
  | "failed";

/** Where an arrange drag is meant to land. */
export type WorkspaceArrangeDestination =
  /** Free geometry — also serves a plain window/panel move. */
  | { readonly kind: "float" | "move"; readonly frame: PanelFrame }
  /** Dock into a docked pane's region. */
  | { readonly kind: "dock"; readonly pane: DockedPaneLocator }
  /** Tab-regroup onto a docked pane's tab strip. */
  | { readonly kind: "tab"; readonly pane: DockedPaneLocator };

/** One arrange request: move `panel` to `destination` by real drag. */
export type WorkspaceArrangeRequest = {
  /** The panel being moved — a `"window"`-kind `PanelLocator`. */
  readonly panel: PanelLocator;
  readonly destination: WorkspaceArrangeDestination;
};

/** The postcondition an arrange verifies by frame readback. */
export type WorkspaceArrangeExpectation =
  /** The panel's frame must land within `tolerance` of `frame`. */
  | { readonly kind: "frame"; readonly frame: PanelFrame }
  /** The panel's resolved surface must change (dock/tab have no exact frame). */
  | { readonly kind: "changed" };

/** What `arrange` proved, with before/after frames recorded. */
export type WorkspaceArrangeResult = {
  readonly request: WorkspaceArrangeRequest;
  readonly expectation: WorkspaceArrangeExpectation;
  readonly before: PanelTarget;
  /**
   * The post-drag resolution. `null` when a verified dock/tab arrange
   * left the panel unresolvable as a window — the honest shape of a
   * panel that became a docked pane.
   */
  readonly after: PanelTarget | null;
  /** True when the postcondition held within the recorded tolerance. */
  readonly verified: boolean;
  /** Frame delta in points, when both sides exposed geometry. */
  readonly frameDelta: {
    readonly dx: number;
    readonly dy: number;
    readonly dWidth: number;
    readonly dHeight: number;
  } | null;
  readonly observedAt: string;
};

/** What `switchTo` proved, with the full before/after observations. */
export type WorkspaceSwitchResult = {
  /** The workspace item title the caller asked for. */
  readonly requested: string;
  readonly before: WorkspaceObservation;
  readonly after: WorkspaceObservation;
  /** The post-switch identity — expected to be `resolved` to `requested`. */
  readonly activeAfter: WorkspaceIdentity;
  /** True when the menu checkmark postcondition was observed. */
  readonly checkConfirmed: boolean;
  /** True when any tracked panel frame moved between the observations. */
  readonly framesChanged: boolean;
  /** Workspace XML paths whose sha256 changed across the switch. */
  readonly xmlChanged: readonly string[];
  readonly invokedAt: string;
  readonly verifiedAt: string;
};

/** The frame-comparison section of a restore report. */
export type WorkspaceFrameComparison = {
  readonly compared: number;
  readonly matched: number;
  readonly mismatches: readonly {
    readonly expected: WorkspacePanelFrame | null;
    readonly actual: WorkspacePanelFrame | null;
  }[];
};

/** The XML-persistence section of a restore report. */
export type WorkspaceXmlComparison = {
  /** xmlRef paths re-inspected against the current store. */
  readonly checked: number;
  readonly unchanged: number;
  readonly changed: readonly string[];
  readonly missing: readonly string[];
} | null;

/** What `verifyRestore` proved against a prior observation. */
export type WorkspaceRestoreReport = {
  readonly expected: WorkspaceObservation;
  readonly current: WorkspaceObservation;
  /**
   * Whether the active workspace name matches the expected one.
   * `null` when either side's identity is `unknown` — an unreadable
   * checkmark is never counted as a match or a mismatch.
   */
  readonly activeNameMatches: boolean | null;
  readonly frames: WorkspaceFrameComparison;
  /** True when every expected panel frame re-observed within tolerance. */
  readonly framesRestored: boolean;
  readonly xml: WorkspaceXmlComparison;
  /**
   * Monitor/DPI evidence for the `current` observation (#370): display
   * topology, per-frame display membership and mixed-DPI flags. `null`
   * when the surface has no display census (`ops.enumerateDisplays`
   * absent or the census unavailable is still recorded — only a missing
   * seam yields `null`). Never silently absent on platforms that can
   * enumerate.
   */
  readonly monitors?: MonitorEvidence | null;
  readonly verdict: "restored" | "mismatch" | "unknown";
  readonly observedAt: string;
};

/**
 * The result of `WorkspaceController.monitorReport` / `Workspace.
 * monitorReport` (#370): a fresh workspace observation plus the
 * monitor/DPI assessment of its panel frames. Observe-class.
 */
export type WorkspaceMonitorReport = {
  readonly observation: WorkspaceObservation;
  readonly monitors: MonitorEvidence;
  readonly observedAt: string;
};

/** Stable refusal codes a caller may act on. */
export type WorkspaceErrorCode =
  /** The expected menu path/item or pane is absent. */
  | "not-found"
  /** More than one candidate matched. */
  | "ambiguous-target"
  /** The resolved surface's attribution is not "owned". */
  | "unproven"
  /** This platform or vehicle has no implementation in this slice. */
  | "unsupported"
  /** The expected menu path is absent — the localized-title refusal. */
  | "unsupported-locale"
  /** A recorded locator drifted; re-resolve, never remap. */
  | "stale-locator"
  /** A safety gate refuses the operation now. */
  | "refused"
  /** The target session/process could not be entered or observed. */
  | "unavailable"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly candidates: readonly string[];

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Every OS touch the workspace controller needs, injected. The
 * production adapter (`src/api/workspace.ts`) binds these to
 * `MacMenuSurface`, `MacGuiRecovery`, `DockedPaneObserver` and the
 * workspace-XML reader; tests bind fakes. `resolvePanel` and
 * `resolveDockedPane` are only required by `arrange`.
 */
export type WorkspaceSurfaceOps = {
  /** One menu-bar observation of the target pid (observe-class). */
  observeMenuBar(): MenuBarSnapshot;
  /**
   * Press the menu item at `path`, after re-verifying `titles` inside
   * the target session. Same contract as `MenuSurfaceOps.invokeMenuItem`.
   */
  invokeMenuItem(target: {
    readonly path: readonly number[];
    readonly titles: readonly string[];
  }): Promise<MenuInvokeVerdict> | MenuInvokeVerdict;
  /** One Accessibility+WindowServer observation of the target pid. */
  observeWindows(): GuiAppState;
  /**
   * Resolve a `PanelLocator` to its `PanelTarget` — fresh observation,
   * census attribution included. Required by `arrange`; throws
   * `PanelError` on resolution failure.
   */
  resolvePanel?(locator: PanelLocator): PanelTarget;
  /**
   * Resolve a `DockedPaneLocator` — fresh bounded walk. Required when an
   * arrange destination or an observe pass names docked panes.
   */
  resolveDockedPane?(locator: DockedPaneLocator): DockedPaneResolution;
  /**
   * The drag vehicle. Absent in production until the B-IME mouse-drag
   * poster lands — `arrange` then refuses `unsupported` before the gate.
   */
  drag?(request: WorkspaceDragRequest): Promise<WorkspaceDragVerdict> | WorkspaceDragVerdict;
  /** Read-only workspace-XML store snapshot (#362 reader). */
  snapshotXml(): WorkspaceStoreSnapshot;
  /**
   * Enumerate the session's displays with bounds (points), pixel size
   * and backing scale (#370, spec §9 multi-monitor/DPI row). Optional:
   * absent means the platform has no display census in this slice —
   * monitor evidence then reports `unknown`, never a guessed topology.
   * Observe-class and synchronous, like `snapshotXml`.
   */
  enumerateDisplays?(): MonitorCensus;
};

/** The mutate-gui gate row; fail-closed like every sibling gate. */
export type WorkspaceMutationGate = (
  op: "switch" | "arrange",
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Where the Workspace submenu lives; titles are localized (spec §6). */
export type WorkspaceMenuPath = {
  /** Menu bar item title, e.g. "Window". */
  readonly barTitle: string;
  /** Submenu item title holding the workspace entries, e.g. "Workspace". */
  readonly submenuTitle: string;
};

export const DEFAULT_WORKSPACE_MENU_PATH: WorkspaceMenuPath = {
  barTitle: "Window",
  submenuTitle: "Workspace",
};

/** Bounded postcondition polling for mutations (spec §10 wait-vs-resend). */
export type WorkspacePollOptions = {
  /** Total wait budget after the act, ms. Default 10_000. */
  readonly timeoutMs?: number;
  /** Delay between postcondition reads, ms. Default 250. */
  readonly intervalMs?: number;
  /** Frame comparison tolerance in points for float/move verification. Default 4. */
  readonly frameTolerance?: number;
};

export const DEFAULT_WORKSPACE_POLL: Required<WorkspacePollOptions> = {
  timeoutMs: 10_000,
  intervalMs: 250,
  frameTolerance: 4,
};
