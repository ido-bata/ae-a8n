/**
 * Workspace operation orchestration (#363, W1 of
 * `specs/workspace-editing/spec.md` §3). Platform-neutral: every OS
 * touch arrives through the injected `WorkspaceSurfaceOps`, so the
 * contract — observe → authorize → act → bounded postcondition wait →
 * re-observe — is identical on macOS, Windows (when it lands) and in
 * tests.
 *
 * Safety shape, mirroring `MenuController`/`PanelController`:
 *
 *   - Every operation re-resolves against fresh observations; a
 *     `WorkspaceObservation` is a locator, not a handle — nothing about
 *     the active workspace is cached across calls (spec §5).
 *   - `observe`/`verifyRestore` are observe-class: no gate, but an
 *     unavailable channel is reported inside the observation, never as
 *     an empty guess.
 *   - `switch`/`arrange` are `mutate-gui`: they require the injected
 *     gate (fail-closed when absent), re-resolve immediately before the
 *     act, and never auto-resend — spec §10: a resent workspace click
 *     or drag has no undo. A bounded postcondition wait that expires is
 *     `indeterminate`, not a retry cue.
 *   - `arrange` additionally requires the drag vehicle (`ops.drag`),
 *     which does not exist in production yet — it refuses `unsupported`
 *     before the gate is even consulted.
 */

import { PanelError, type PanelTarget } from "../panels/types.js";
import type { DockedPaneLocator } from "../panels/docked/index.js";
import type { MenuInvokeVerdict } from "../menus/controller.js";
import type { MenuBarSnapshot, MenuItemNode } from "../menus/types.js";
import type { GuiAppState } from "../driver/gui-recovery.js";
import type { WorkspaceStoreSnapshot } from "../workspace-xml/types.js";
import {
  workspaceIdentity,
  workspaceMenuEntries,
  workspaceSubmenu,
  workspaceXmlLookup,
} from "./resolve.js";
import {
  DEFAULT_WORKSPACE_MENU_PATH,
  DEFAULT_WORKSPACE_POLL,
  WorkspaceError,
  type WorkspaceArrangeExpectation,
  type WorkspaceArrangeRequest,
  type WorkspaceArrangeResult,
  type WorkspaceDragRequest,
  type WorkspaceDragVerdict,
  type WorkspaceIdentity,
  type WorkspaceMenuEntry,
  type WorkspaceMenuPath,
  type WorkspaceMutationGate,
  type WorkspaceMonitorReport,
  type WorkspaceObservation,
  type WorkspaceObservationFailure,
  type WorkspacePanelFrame,
  type WorkspacePollOptions,
  type WorkspaceRestoreReport,
  type WorkspaceSurfaceOps,
  type WorkspaceSwitchResult,
  type WorkspaceXmlComparison,
} from "./types.js";
import { monitorEvidence } from "./monitors/index.js";
import type { MonitorCensus, MonitorEvidence } from "./monitors/types.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return error instanceof Error ? error.name : "error";
}

/** `PanelError`/`MenuError`-shaped codes map onto the workspace vocabulary. */
function asWorkspaceError(error: unknown, duringMutation: boolean): WorkspaceError {
  if (error instanceof WorkspaceError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code =
      error.code === "ambiguous"
        ? "ambiguous-target"
        : error.code === "not-found"
          ? "not-found"
          : error.code === "unproven"
            ? "unproven"
            : error.code === "unsupported"
              ? "unsupported"
              : error.code === "stale-locator"
                ? "stale-locator"
                : error.code === "refused"
                  ? "refused"
                  : error.code === "indeterminate"
                    ? "indeterminate"
                    : "unavailable";
    return new WorkspaceError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new WorkspaceError(
    duringMutation ? "indeterminate" : "unavailable",
    errorText(error),
    { cause: error },
  );
}

/** Per-coordinate frame equality within `tolerance` points. */
export function workspaceFramesMatch(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tolerance: number,
): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/**
 * Multiset frame comparison: every `expected` frame must find an
 * unmatched `actual` frame within `tolerance`, and vice versa. Order is
 * not significant — a workspace restore may legitimately reorder the AX
 * window listing.
 */
export function compareWorkspaceFrames(
  expected: readonly WorkspacePanelFrame[],
  actual: readonly WorkspacePanelFrame[],
  tolerance: number,
): {
  readonly compared: number;
  readonly matched: number;
  readonly mismatches: readonly {
    expected: WorkspacePanelFrame | null;
    actual: WorkspacePanelFrame | null;
  }[];
} {
  const pool = [...actual];
  const matched: WorkspacePanelFrame[] = [];
  const mismatches: { expected: WorkspacePanelFrame | null; actual: WorkspacePanelFrame | null }[] = [];

  for (const want of expected) {
    const index = pool.findIndex((candidate) =>
      workspaceFramesMatch(want.frame, candidate.frame, tolerance),
    );
    if (index === -1) {
      mismatches.push({ expected: want, actual: null });
    } else {
      const found = pool.splice(index, 1)[0];
      if (found !== undefined) {
        matched.push(found);
      }
    }
  }
  // Actual frames nobody claimed are extra surfaces — also a mismatch.
  for (const extra of pool) {
    mismatches.push({ expected: null, actual: extra });
  }

  return {
    compared: expected.length,
    matched: matched.length,
    mismatches,
  };
}

/** sha256 per path, for the XML-changed evidence of a switch. */
function xmlHashes(
  snapshot: WorkspaceStoreSnapshot | null,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (snapshot === null) {
    return map;
  }
  for (const file of snapshot.files) {
    map.set(file.path, file.sha256);
  }
  return map;
}

export function xmlChangedPaths(
  before: WorkspaceStoreSnapshot | null,
  after: WorkspaceStoreSnapshot | null,
): string[] {
  const a = xmlHashes(before);
  const b = xmlHashes(after);
  const changed: string[] = [];
  for (const [path, sha] of a) {
    if (b.get(path) !== sha) {
      changed.push(path);
    }
  }
  for (const path of b.keys()) {
    if (!a.has(path)) {
      changed.push(path);
    }
  }
  return changed.sort();
}

export type WorkspaceControllerOptions = {
  readonly pid: number;
  readonly ops: WorkspaceSurfaceOps;
  /** The mutate-gui gate. Fail-closed: absent means every mutation refuses. */
  readonly authorizeMutation?: WorkspaceMutationGate;
  /** Where the Workspace submenu lives; defaults to English "Window > Workspace". */
  readonly menuPath?: WorkspaceMenuPath;
  readonly poll?: WorkspacePollOptions;
  readonly dockedPanes?: readonly DockedPaneLocator[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export class WorkspaceController {
  readonly #pid: number;
  readonly #ops: WorkspaceSurfaceOps;
  readonly #authorizeMutation: WorkspaceMutationGate | undefined;
  readonly #menuPath: WorkspaceMenuPath;
  readonly #poll: Required<WorkspacePollOptions>;
  readonly #dockedPanes: readonly DockedPaneLocator[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: WorkspaceControllerOptions) {
    this.#pid = options.pid;
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#menuPath = options.menuPath ?? DEFAULT_WORKSPACE_MENU_PATH;
    this.#poll = { ...DEFAULT_WORKSPACE_POLL, ...options.poll };
    this.#dockedPanes = options.dockedPanes ?? [];
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------
  // Observe-class
  // ------------------------------------------------------------------

  /**
   * One full observe pass. Every channel degrades honestly inside the
   * observation: an unavailable menu bar yields `identity: unknown`, a
   * failed XML read yields `xml.status: "unavailable"`, a failed pane
   * walk lands in `failures` — none of them fails the whole pass.
   */
  observe(options?: { readonly dockedPanes?: readonly DockedPaneLocator[] }): WorkspaceObservation {
    const observedAt = this.#now().toISOString();

    let menu: WorkspaceObservation["menu"] = {
      available: false,
      reason: "the menu bar was not observed",
      truncated: false,
    };
    let snapshot: MenuBarSnapshot | undefined;
    try {
      snapshot = this.#ops.observeMenuBar();
      menu = {
        available: snapshot.available,
        reason: snapshot.reason,
        truncated: snapshot.truncated,
      };
    } catch (error) {
      menu = {
        available: false,
        reason: `menu bar observation failed: ${errorText(error)}`,
        truncated: false,
      };
    }

    let xmlSnapshot: WorkspaceStoreSnapshot | null = null;
    let xml: WorkspaceObservation["xml"];
    try {
      xmlSnapshot = this.#ops.snapshotXml();
      xml = { status: "observed", reason: null, snapshot: xmlSnapshot };
    } catch (error) {
      xml = {
        status: "unavailable",
        reason: `workspace XML read failed: ${errorText(error)}`,
        snapshot: null,
      };
    }

    let identity: WorkspaceIdentity = {
      status: "unknown",
      reason: "the menu bar observation failed before the workspace submenu could be read",
    };
    if (snapshot !== undefined) {
      try {
        identity = workspaceIdentity(
          snapshot,
          this.#menuPath,
          xmlSnapshot,
          this.#pid,
          this.#now,
        );
      } catch (error) {
        identity = {
          status: "unknown",
          reason: `${errorCode(error)}: ${errorText(error)}`,
        };
      }
    }

    const panels: WorkspacePanelFrame[] = [];
    const failures: WorkspaceObservationFailure[] = [];
    let state: GuiAppState | undefined;
    try {
      state = this.#ops.observeWindows();
      for (const window of state.windows) {
        if (window.frame == null) {
          continue;
        }
        panels.push({
          kind: "window",
          title: window.title,
          role: window.role,
          subrole: window.subrole,
          frame: {
            x: window.frame.x,
            y: window.frame.y,
            width: window.frame.width,
            height: window.frame.height,
          },
          attribution:
            window.censusAttribution === "owned" ||
            window.censusAttribution === "foreign" ||
            window.censusAttribution === "unmatched"
              ? window.censusAttribution
              : "unproven",
        });
      }
    } catch (error) {
      failures.push({
        channel: "windows",
        code: errorCode(error),
        message: `window observation failed: ${errorText(error)}`,
      });
    }

    const paneLocators = options?.dockedPanes ?? this.#dockedPanes;
    if (paneLocators.length > 0) {
      if (this.#ops.resolveDockedPane === undefined) {
        for (const locator of paneLocators) {
          failures.push({
            channel: "docked-pane",
            locator,
            code: "unsupported",
            message: "no docked-pane resolver is wired for this workspace surface",
          });
        }
      } else {
        for (const locator of paneLocators) {
          try {
            const resolution = this.#ops.resolveDockedPane(locator);
            const surface = resolution.target.surface;
            panels.push({
              kind: "docked-region",
              title: surface.locator.title ?? null,
              role: surface.locator.role ?? null,
              subrole: surface.locator.subrole ?? null,
              frame: surface.frame,
              attribution: surface.attribution,
              paneLocator: locator,
            });
          } catch (error) {
            failures.push({
              channel: "docked-pane",
              locator,
              code: errorCode(error),
              message: errorText(error),
            });
          }
        }
      }
    }

    return {
      pid: this.#pid,
      identity,
      menu,
      panels,
      failures,
      xml,
      observedAt,
    };
  }

  /**
   * The leaf entries of the Workspace submenu with check state and XML
   * persistence — the discovery read W1 callers use to pick a
   * `switchTo` target. Observe-class.
   */
  listWorkspaces(): WorkspaceMenuEntry[] {
    let snapshot;
    try {
      snapshot = this.#ops.observeMenuBar();
    } catch (error) {
      throw asWorkspaceError(error, false);
    }
    let xmlSnapshot: WorkspaceStoreSnapshot | null = null;
    try {
      xmlSnapshot = this.#ops.snapshotXml();
    } catch {
      xmlSnapshot = null;
    }
    try {
      const { submenu } = workspaceSubmenu(snapshot, this.#menuPath);
      return workspaceMenuEntries(submenu, workspaceXmlLookup(xmlSnapshot));
    } catch (error) {
      throw asWorkspaceError(error, false);
    }
  }

  // ------------------------------------------------------------------
  // Mutate-gui
  // ------------------------------------------------------------------

  #requireMutationAllowed(op: "switch" | "arrange"): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for workspace operations; workspace " +
        "mutation is a mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new WorkspaceError(
        "refused",
        `workspace ${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Bounded postcondition wait (spec §10): poll `predicate` until it
   * holds or the deadline expires. Expiry is `indeterminate` — the act
   * already happened and its outcome is unproven; nothing is resent.
   */
  async #pollUntil(
    predicate: () => boolean,
    describe: string,
  ): Promise<void> {
    const deadline = Date.now() + this.#poll.timeoutMs;
    for (;;) {
      let holds = false;
      try {
        holds = predicate();
      } catch {
        holds = false;
      }
      if (holds) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new WorkspaceError(
          "indeterminate",
          `the postcondition was not observed within ${this.#poll.timeoutMs}ms ` +
            `(${describe}); the mutation was attempted and its outcome is ` +
            "unknown — re-observe before any retry, never resend",
        );
      }
      await this.#sleep(this.#poll.intervalMs);
    }
  }

  /**
   * The checkmark postcondition of a switch: the named item reports
   * `checked` in a fresh menu listing. Read failures count as
   * "not yet" — the deadline decides, never a guessed answer.
   */
  #workspaceItemChecked(name: string): boolean {
    const snapshot = this.#ops.observeMenuBar();
    if (!snapshot.available) {
      return false;
    }
    const { submenu } = workspaceSubmenu(snapshot, this.#menuPath);
    const entry = workspaceMenuEntries(submenu, workspaceXmlLookup(null)).find(
      (item) => item.title === name,
    );
    return entry?.check === "checked";
  }

  /**
   * Switch the active workspace by clicking its Window > Workspace menu
   * item — the GUI path only (spec §2: `app.executeCommand` /
   * `menu.execute` is `scripting-direct`, never evidence here).
   *
   * Mutate-gui: gated, re-resolved immediately before the act, one
   * invoke, then a bounded checkmark poll. A click whose postcondition
   * never appears is `indeterminate`; the op never resends.
   */
  async switchTo(name: string): Promise<WorkspaceSwitchResult> {
    this.#requireMutationAllowed("switch");
    if (name === "") {
      throw new WorkspaceError("not-found", "a workspace switch needs a non-empty name");
    }

    const before = this.observe();

    // Re-resolution immediately before the act (spec §6): a fresh
    // listing, the leaf proven present/enabled, then the platform
    // vehicle re-verifies every title inside the session.
    let snapshot;
    try {
      snapshot = this.#ops.observeMenuBar();
    } catch (error) {
      throw asWorkspaceError(error, false);
    }
    let submenuNode: MenuItemNode;
    let titles: readonly string[];
    try {
      const resolved = workspaceSubmenu(snapshot, this.#menuPath);
      const candidates = resolved.submenu.children.filter(
        (node) => node.kind === "item" && node.title === name,
      );
      if (candidates.length === 0) {
        const present = resolved.submenu.children
          .filter((node) => node.kind === "item")
          .map((node) => `"${node.title}"`)
          .join(", ");
        throw new WorkspaceError(
          "not-found",
          `no workspace menu item titled "${name}" was observed on pid ` +
            `${this.#pid} (observed items: ${present || "none"})`,
        );
      }
      if (candidates.length > 1) {
        throw new WorkspaceError(
          "ambiguous-target",
          `${candidates.length} workspace menu items are titled "${name}"`,
          { candidates: candidates.map((node) => `path ${node.path.join(",")}`) },
        );
      }
      const node = candidates[0] as MenuItemNode;
      if (node.enabled === false) {
        throw new WorkspaceError(
          "refused",
          `the workspace menu item "${name}" is disabled; invoking it ` +
            "would act on a command AE does not currently offer",
        );
      }
      submenuNode = node;
      titles = [...resolved.titles, node.title];
    } catch (error) {
      throw asWorkspaceError(error, false);
    }

    let verdict: MenuInvokeVerdict;
    try {
      verdict = await this.#ops.invokeMenuItem({
        path: submenuNode.path,
        titles,
      });
    } catch (error) {
      throw asWorkspaceError(error, true);
    }
    const invokedAt = this.#now().toISOString();
    switch (verdict) {
      case "clicked":
        break;
      case "missing":
      case "nomenubar":
        throw new WorkspaceError(
          "unavailable",
          `the workspace switch reported "${verdict}": the target process ` +
            "or its menu bar is gone — re-observe before retrying",
        );
      case "changed":
      case "not-found":
        throw new WorkspaceError(
          "stale-locator",
          `the workspace menu item moved between resolution and invoke ` +
            `(verdict "${verdict}"); nothing was clicked — re-resolve and retry`,
        );
      case "failed":
        throw new WorkspaceError(
          "indeterminate",
          "the workspace menu press was attempted but the platform reported " +
            "failure; the outcome is unknown — re-observe before any retry",
        );
      default: {
        const exhaustive: never = verdict;
        throw new WorkspaceError(
          "indeterminate",
          `unknown invoke verdict ${String(exhaustive)}`,
        );
      }
    }

    // Postcondition wait: the checkmark must land on the requested
    // item. Bounded; expiry is indeterminate — never a resend.
    await this.#pollUntil(
      () => this.#workspaceItemChecked(name),
      `workspace "${name}" checkmark`,
    );

    const after = this.observe();
    const framesChanged =
      compareWorkspaceFrames(before.panels, after.panels, this.#poll.frameTolerance)
        .mismatches.length > 0;
    const xmlBefore = before.xml.snapshot;
    const xmlAfter = after.xml.snapshot;
    return {
      requested: name,
      before,
      after,
      activeAfter: after.identity,
      checkConfirmed: true,
      framesChanged,
      xmlChanged: xmlChangedPaths(xmlBefore, xmlAfter),
      invokedAt,
      verifiedAt: this.#now().toISOString(),
    };
  }

  /**
   * Re-resolve the arrange source panel fresh — the pre-act proof. A
   * `docked-region` source cannot be dragged by frame and refuses
   * `unsupported`; anything not census-attributed `"owned"` refuses
   * `unproven` before the gate is even consulted for the drag itself.
   */
  #resolveArrangeSource(request: WorkspaceArrangeRequest): PanelTarget {
    if (this.#ops.resolvePanel === undefined) {
      throw new WorkspaceError(
        "unsupported",
        "no panel resolver is wired for this workspace surface; " +
          "arrange cannot prove its source panel",
      );
    }
    let target: PanelTarget;
    try {
      target = this.#ops.resolvePanel(request.panel);
    } catch (error) {
      throw asWorkspaceError(error, false);
    }
    if (target.surface.kind !== "window") {
      throw new WorkspaceError(
        "unsupported",
        `the resolved panel is a "${target.surface.kind}" surface, not a ` +
          "window; docked panes have no title-bar drag vehicle in this slice",
      );
    }
    if (target.surface.attribution !== "owned") {
      throw new WorkspaceError(
        "unproven",
        `the resolved panel's pid attribution is "${target.surface.attribution}", ` +
          'not "owned"; dragging it could act on another After Effects ' +
          "instance — refused before any mutation",
      );
    }
    return target;
  }

  /** The destination frame and postcondition for one arrange request. */
  #resolveArrangeDestination(
    request: WorkspaceArrangeRequest,
  ): { frame: PanelTarget["surface"]["frame"]; expectation: WorkspaceArrangeExpectation } {
    const destination = request.destination;
    switch (destination.kind) {
      case "float":
      case "move":
        return {
          frame: destination.frame,
          expectation: { kind: "frame", frame: destination.frame },
        };
      case "dock":
      case "tab": {
        if (this.#ops.resolveDockedPane === undefined) {
          throw new WorkspaceError(
            "unsupported",
            "no docked-pane resolver is wired; a dock/tab destination " +
              "cannot be bounded against the pane's frame",
          );
        }
        let resolution;
        try {
          resolution = this.#ops.resolveDockedPane(destination.pane);
        } catch (error) {
          throw asWorkspaceError(error, false);
        }
        return {
          frame: resolution.target.surface.frame,
          // Dock/tab have no exact landing frame: the honest
          // postcondition is that the source's resolved surface changed.
          expectation: { kind: "changed" },
        };
      }
      default: {
        const exhaustive: never = destination;
        throw new WorkspaceError(
          "not-found",
          `unknown arrange destination ${String(exhaustive)}`,
        );
      }
    }
  }

  /**
   * Arranging panels by real drag — dock↔float, tab regroup, and plain
   * window move (`destination.kind: "move"`/`"float"` with a frame).
   *
   * Mutate-gui and drag-vehicle dependent: production has no
   * `ops.drag` (the B-IME mouse-drag poster is unimplemented), so this
   * refuses `unsupported` before the gate. When a vehicle exists the
   * sequence is: resolve source + destination frames → one atomic drag
   * → bounded postcondition poll on the re-resolved panel →
   * `indeterminate` on deadline, never a resent drag.
   */
  async arrange(request: WorkspaceArrangeRequest): Promise<WorkspaceArrangeResult> {
    if (this.#ops.drag === undefined) {
      throw new WorkspaceError(
        "unsupported",
        "no drag vehicle is wired for workspace arrange; the B-IME " +
          "mouse-drag poster (specs/ime-input/spec.md §6) is not implemented " +
          "in this slice — the contract and its tests run against injected fakes",
      );
    }
    this.#requireMutationAllowed("arrange");

    const before = this.#resolveArrangeSource(request);
    const { frame: toFrame, expectation } = this.#resolveArrangeDestination(request);
    const fromFrame = before.surface.frame;

    const drag: WorkspaceDragRequest = {
      kind: "panel-arrange",
      from: fromFrame,
      to: toFrame,
    };
    let verdict: WorkspaceDragVerdict;
    try {
      verdict = await this.#ops.drag(drag);
    } catch (error) {
      throw asWorkspaceError(error, true);
    }
    if (verdict === "not-performed") {
      throw new WorkspaceError(
        "stale-locator",
        "the drag vehicle proved nothing was dragged (identity or focus " +
          "was lost mid-sequence); nothing was arranged — re-resolve and retry",
      );
    }
    if (verdict === "failed") {
      throw new WorkspaceError(
        "indeterminate",
        "the drag was attempted but the vehicle reported failure; the " +
          "outcome is unknown — re-observe before any retry, never resend",
      );
    }

    // Postcondition poll: re-resolve the source panel until the
    // expectation holds or the deadline expires.
    const tolerance = this.#poll.frameTolerance;
    let after: PanelTarget | null = null;
    let verified = false;
    const deadline = Date.now() + this.#poll.timeoutMs;
    for (;;) {
      try {
        const resolved = this.#ops.resolvePanel?.(request.panel);
        if (resolved !== undefined) {
          after = resolved;
          if (expectation.kind === "frame") {
            verified = workspaceFramesMatch(
              resolved.surface.frame,
              expectation.frame,
              tolerance,
            );
          } else {
            // "changed": the surface moved, re-kinded, or re-attributed.
            verified =
              resolved.surface.kind !== before.surface.kind ||
              resolved.surface.attribution !== before.surface.attribution ||
              !workspaceFramesMatch(
                resolved.surface.frame,
                before.surface.frame,
                tolerance,
              );
          }
        }
      } catch {
        // A resolution failure during the poll is not proof of the
        // postcondition — but for "changed" a vanished window surface
        // IS the expected dock outcome; it is counted below via `after`
        // staying null only when nothing ever resolved.
        after = null;
        if (expectation.kind === "changed") {
          // The panel no longer resolves as a window — consistent with
          // having docked into a pane. Count it once, then keep polling
          // in case it was a transient observation failure.
          verified = true;
        }
      }
      if (verified || Date.now() >= deadline) {
        break;
      }
      await this.#sleep(this.#poll.intervalMs);
    }
    if (!verified) {
      throw new WorkspaceError(
        "indeterminate",
        `the arrange postcondition was not observed within ` +
          `${this.#poll.timeoutMs}ms; the drag was attempted and its ` +
          "outcome is unknown — re-observe before any retry, never resend",
      );
    }

    const finalTarget = after ?? this.#resolveArrangeSourceQuiet(request);
    const a = before.surface.frame;
    const b = finalTarget?.surface.frame ?? null;
    return {
      request,
      expectation,
      before,
      // `after` may be null when the panel docked into a pane and no
      // longer resolves as a window — the honest shape of a dock.
      after: finalTarget,
      verified,
      frameDelta:
        b === null
          ? null
          : {
              dx: b.x - a.x,
              dy: b.y - a.y,
              dWidth: b.width - a.width,
              dHeight: b.height - a.height,
            },
      observedAt: this.#now().toISOString(),
    };
  }

  /**
   * Best-effort re-resolution for the result record after a verified
   * "changed" arrange — returns null rather than throwing when the
   * panel genuinely became a docked pane.
   */
  #resolveArrangeSourceQuiet(request: WorkspaceArrangeRequest): PanelTarget | null {
    try {
      return this.#ops.resolvePanel?.(request.panel) ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Monitor/DPI evidence (#370 — observe-class)
  // ------------------------------------------------------------------

  /**
   * One display census, degraded honestly: a missing seam or a throwing
   * probe is `available: false` with the reason — never an empty display
   * list that could pass for "single monitor".
   */
  #displayCensus(): MonitorCensus {
    if (this.#ops.enumerateDisplays === undefined) {
      return {
        available: false,
        reason: "this workspace surface has no display census",
      };
    }
    try {
      return this.#ops.enumerateDisplays();
    } catch (error) {
      return {
        available: false,
        reason: `display census failed: ${errorText(error)}`,
      };
    }
  }

  /** Monitor/DPI assessment of one observation's panel frames. */
  #monitorsFor(observation: WorkspaceObservation): MonitorEvidence {
    return monitorEvidence(
      this.#displayCensus(),
      observation.panels.map((p) => ({ frame: p.frame, title: p.title })),
    );
  }

  /**
   * A fresh observe pass plus its monitor/DPI assessment (#370): display
   * topology (single/multi/unknown), which displays each panel frame
   * intersects, and mixed-DPI flags for frames straddling displays with
   * different backing scales. Observe-class — the pre-flight read for
   * deciding whether a restore's point-space frame comparison needs a
   * wider, reviewer-declared tolerance on a mixed-resolution desktop.
   */
  monitorReport(options?: {
    readonly dockedPanes?: readonly DockedPaneLocator[];
  }): WorkspaceMonitorReport {
    const observation = this.observe(options);
    return {
      observation,
      monitors: this.#monitorsFor(observation),
      observedAt: this.#now().toISOString(),
    };
  }

  // ------------------------------------------------------------------
  // Verify (observe-class)
  // ------------------------------------------------------------------

  /**
   * Compare a prior `observe()` against the live screen: active
   * workspace name, every tracked panel frame within tolerance, and the
   * XML persistence records. Observe-class — the "restore verified"
   * half of the save/restore AC runs entirely on readback channels.
   */
  verifyRestore(
    expected: WorkspaceObservation,
    options?: { readonly tolerance?: number },
  ): WorkspaceRestoreReport {
    const tolerance = options?.tolerance ?? this.#poll.frameTolerance;
    const current = this.observe();

    const expectedName =
      expected.identity.status === "resolved" ? expected.identity.target.workspace.name : null;
    const currentName =
      current.identity.status === "resolved" ? current.identity.target.workspace.name : null;
    const activeNameMatches =
      expectedName === null || currentName === null ? null : expectedName === currentName;

    const frames = compareWorkspaceFrames(expected.panels, current.panels, tolerance);
    const framesRestored = frames.mismatches.length === 0;

    let xml: WorkspaceXmlComparison = null;
    if (expected.xml.status === "observed" && expected.xml.snapshot !== null) {
      const before = xmlHashes(expected.xml.snapshot);
      const after =
        current.xml.status === "observed" && current.xml.snapshot !== null
          ? xmlHashes(current.xml.snapshot)
          : new Map<string, string>();
      const changed: string[] = [];
      const missing: string[] = [];
      let unchanged = 0;
      for (const [path, sha] of before) {
        if (!after.has(path)) {
          missing.push(path);
        } else if (after.get(path) === sha) {
          unchanged += 1;
        } else {
          changed.push(path);
        }
      }
      xml = { checked: before.size, unchanged, changed, missing };
    }

    const xmlClean =
      xml === null || (xml.changed.length === 0 && xml.missing.length === 0);
    const verdict =
      activeNameMatches === true && framesRestored && xmlClean
        ? "restored"
        : activeNameMatches === false || !framesRestored || !xmlClean
          ? "mismatch"
          : "unknown";

    return {
      expected,
      current,
      activeNameMatches,
      frames,
      framesRestored,
      xml,
      // #370: record the monitor/DPI context the frame comparison ran
      // under — display topology plus per-frame display membership and
      // mixed-DPI flags — so a `restored` verdict on a mixed-resolution
      // desktop carries its caveat as evidence, not prose.
      monitors: this.#ops.enumerateDisplays === undefined
        ? null
        : this.#monitorsFor(current),
      verdict,
      observedAt: this.#now().toISOString(),
    };
  }
}
