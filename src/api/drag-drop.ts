/**
 * Public drag-drop API (#422,
 * `specs/workspace-editing/spec.md` §5, §9 "File/element drag-drop",
 * §10, §12 W4+; parent #345 / program #337).
 *
 * `ae.dragDrop()` returns a handle whose operations run the drag-drop
 * contract: a gated, lease-held drag posted through the compiled
 * `input-drag` helper (CGEvent segments for element drags, one
 * NSDraggingSession for file drops), census-gated drop points, and a
 * bounded `project.items` DOM-delta oracle — never a resend.
 *
 * Honesty rules carried from `ae.contextMenu()`/`ae.projectDialog()`:
 *
 *   - No owned, attested target → construction throws
 *     `DragDropError` `unavailable`; there is no proven surface to
 *     drop onto.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Both kinds are `mutate-gui` and stay gated:
 *     `dragDropMutationGate()` permits `drop-file` (the #411-verified
 *     vehicle, fixture files only, census/attribution/oracle chain)
 *     and refuses `element-drag` pending its own A-SAFETY class
 *     decision — see `dragDropCapabilities()`.
 *   - The whole press→move→release sequence runs inside ONE GUI-lease
 *     acquisition (`dragdrop:<kind>`), audited around the act like
 *     `ae.input()`'s `#run`.
 *   - The vehicles and the `project.items` oracle are `verified on
 *     real host` (#411 PoC + this ticket's e2e); the contract itself
 *     is `automated test` against fakes.
 */

import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";

import {
  defaultLeaseController,
  GuiRecoveryError,
  MacGuiRecovery,
  censusRunnerInSession,
  type GuiRecoveryOptions,
} from "../driver/gui-recovery.js";
import { defaultGuiLeaseRoot, type GuiLease } from "../platform/darwin/gui-lease.js";
import { runInSession } from "../driver/mac-session.js";
import {
  windowServerCensus,
  type WindowCensus,
} from "../platform/darwin/window-census.js";
import {
  DragDropController,
  type DragDropControllerOptions,
} from "../dragdrop/controller.js";
import { dragDropMutationGate } from "../dragdrop/gate.js";
import {
  DragDropError,
  type DragDropElementRequest,
  type DragDropFileProbe,
  type DragDropFileRequest,
  type DragDropMutationGate,
  type DragDropOps,
  type DragDropPoint,
  type DragDropPollOptions,
  type DragDropRequest,
  type DragDropResult,
  type DragDropSnapshot,
  type DragDropTopmost,
} from "../dragdrop/index.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import type { Session } from "./session.js";
import {
  darwinDragChannels,
  sessionInputExec,
  type DarwinInputExec,
} from "../input/darwin.js";
import { ensureDarwinInputHelpers } from "./input.js";

// The contract vocabulary is re-exported so `ae.dragDrop()` callers and
// `src/index.ts` get one import surface, like every sibling API module.
export { DragDropError, dragDropMutationGate } from "../dragdrop/index.js";
export type {
  DragDropDelta,
  DragDropElementRequest,
  DragDropErrorCode,
  DragDropFilePayload,
  DragDropFileProbe,
  DragDropFileRequest,
  DragDropMutationGate,
  DragDropMutationOp,
  DragDropOps,
  DragDropPoint,
  DragDropPollOptions,
  DragDropProjectItem,
  DragDropRequest,
  DragDropResult,
  DragDropSegmentCheck,
  DragDropSnapshot,
  DragDropSurfaceLocator,
  DragDropTopmost,
  DragDropVerdict,
  GuiAppStateLike,
} from "../dragdrop/index.js";
export type { DragDropControllerOptions } from "../dragdrop/index.js";

/** The verification level the contract claims until real-host proof lands. */
const VERIFICATION = "automated test" as const;

export type DragDropCapability = {
  readonly support: "implemented" | "unavailable" | "unsupported";
  readonly verification: "implemented" | "automated test" | "verified on real host";
  readonly reason: string;
};

/**
 * What this build supports for drag-drop on `platform`. Windows is
 * deliberately all-unsupported in this slice; on darwin `drop-file`
 * is the permitted class and `element-drag` stays gate-refused.
 */
export type DragDropCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly dropFile: DragDropCapability;
  readonly elementDrag: DragDropCapability;
};

export function dragDropCapabilities(
  platform: NodeJS.Platform,
): DragDropCapabilities {
  if (platform !== "darwin") {
    const unsupported: DragDropCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "the drag-drop surface is implemented for macOS only in this slice; " +
        "no Windows drag vehicle exists yet",
    };
    return { platform: "win32", dropFile: unsupported, elementDrag: unsupported };
  }
  return {
    platform: "darwin",
    dropFile: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "mutate-gui class permitted by dragDropMutationGate() per the " +
        "A-SAFETY decision in docs/gui-supervision-safety-gates.md, citing " +
        "the #411 real-host PoC (vend=fileurl NSDraggingSession + CGEvent " +
        "drop onto AE 2027's Project panel); fixture files only, census-" +
        "gated drop point, project.items delta oracle, never resent",
    },
    elementDrag: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class kept refused by dragDropMutationGate(): the " +
        "press→move→release vehicle is real-host proven (#411) but its " +
        "in-app blast radius has no dedicated A-SAFETY class decision yet",
    },
  };
}

/** Seams the production adapter needs; mirrors `ContextMenuSeams`. */
export type DragDropSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate. */
  readonly authorizeMutation?: DragDropMutationGate;
  /** Compiled darwin input-helper directory (tests / prebuilt helpers). */
  readonly helpersDir?: string | undefined;
  /** Postcondition poll budget override. */
  readonly poll?: DragDropPollOptions;
  /** Test seam: replace the whole ops bundle's census answer. */
  readonly topmostAt?: DragDropOps["topmostAt"];
  /** Test seam: replace the DOM oracle. */
  readonly readback?: DragDropOps["readback"];
  /** Test seam: replace the file probe. */
  readonly probeFile?: DragDropOps["probeFile"];
  /** Test seam: replace the activate step. */
  readonly activate?: DragDropOps["activate"];
  /** Test seams: replace one drag-vehicle channel (production: input-drag). */
  readonly press?: DragDropOps["press"];
  readonly move?: DragDropOps["move"];
  readonly release?: DragDropOps["release"];
  readonly fileDrag?: DragDropOps["fileDrag"];
  /**
   * Test seam: replace the `project.items` session readback entirely
   * (production goes through `session.call`).
   */
  readonly projectItems?: () => Promise<DragDropSnapshot> | DragDropSnapshot;
};

function guiOptions(
  target: GuiObservationTarget,
  seams: DragDropSeams,
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

/** Does `bounds` contain `point` (inclusive edges, points space)? */
function boundsContain(
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  point: DragDropPoint,
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/**
 * The WindowServer z-order answer at a global point: CGWindowListCopy
 * WindowInfo reports front-to-back, so the FIRST on-screen app window
 * (layer >= 0) whose bounds contain the point is the topmost — exactly
 * the #411 `topmostAt` gate. An unavailable census throws: fail-closed,
 * never "no window".
 */
function censusTopmostAt(
  census: () => WindowCensus,
  point: DragDropPoint,
): DragDropTopmost | null {
  const result = census();
  if (!result.available) {
    throw new Error(`window census unavailable: ${result.reason}`);
  }
  for (const w of result.windows) {
    if (!w.onScreen || w.layer < 0 || w.bounds === null) continue;
    if (!boundsContain(w.bounds, point)) continue;
    return {
      pid: w.pid,
      windowNumber: w.windowNumber ?? null,
      layer: w.layer,
      bounds: w.bounds,
    };
  }
  return null;
}

/** Fixture-file probe: exists, regular file, size, content digest. */
function probeDropFile(path: string): DragDropFileProbe | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { exists: true, isFile: false, size: 0, sha256: "" };
    }
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    return { exists: true, isFile: true, size: stat.size, sha256 };
  } catch {
    return null;
  }
}

/**
 * Best-effort frontmost for the target pid — the same System Events
 * `set frontmost` the #411 PoC used. Activation only reduces the chance
 * the drag stream loses to a focus steal; the census gates remain the
 * authority, so a failure here is swallowed.
 */
function darwinActivatePid(
  session: GuiObservationTarget["session"],
  pid: number,
  runSession: typeof runInSession,
): void {
  try {
    runSession(
      session,
      "/usr/bin/osascript",
      [
        "-e",
        `tell application "System Events" to set frontmost of ` +
          `(first application process whose unix id is ${pid}) to true`,
      ],
      { timeoutMs: 15_000 },
    );
  } catch {
    // Best-effort: the census gates decide whether the drop may post.
  }
}

/** Map a lease/audit failure onto the drag-drop vocabulary. */
function asDragDropError(error: unknown): DragDropError {
  if (error instanceof DragDropError) {
    return error;
  }
  if (error instanceof GuiRecoveryError) {
    return new DragDropError("refused", error.message, { cause: error });
  }
  return new DragDropError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/**
 * Lease-audit outcome for a thrown `DragDropError`: the codes below are
 * only ever raised BEFORE anything posts (gate, channel, locator,
 * attribution, payload proof), so they are provable non-mutations.
 * Everything else — including `stale-locator`/`unavailable` raised
 * mid-act — may have partially reached the screen and audits `unknown`.
 */
function auditOutcome(error: unknown): string {
  if (error instanceof DragDropError) {
    switch (error.code) {
      case "refused":
      case "unsupported":
      case "invalid-locator":
      case "not-found":
      case "unproven":
      case "ambiguous-target":
        return "not-performed";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

/**
 * A handle to the owned After Effects instance's drag-drop surface.
 * `run` re-observes on every call; the locator inside each request is
 * re-resolved against a fresh observation — a `DragDropSurfaceLocator`
 * is a locator set, not a handle to a remembered window.
 */
export class DragDrop {
  readonly #controller: DragDropController;
  readonly #leaseController: ReturnType<typeof defaultLeaseController>;

  constructor(
    controller: DragDropController,
    leaseController: ReturnType<typeof defaultLeaseController>,
  ) {
    this.#controller = controller;
    this.#leaseController = leaseController;
  }

  /**
   * Run one drag-drop request inside the session's single-owner GUI
   * lease: acquire → controller.run → audit → release. The lease is
   * what makes press→move→release atomic against other GUI actors —
   * the whole segment sequence, not each CGEvent.
   */
  async run(request: DragDropRequest): Promise<DragDropResult> {
    const op = `dragdrop:${request.kind}`;
    let lease: GuiLease;
    try {
      lease = this.#leaseController.acquire(op);
    } catch (error) {
      throw asDragDropError(error);
    }
    try {
      const result = await this.#controller.run(request);
      try {
        this.#leaseController.audit({
          kind: "mutate",
          op,
          outcome: "performed",
          detail: `${request.kind} verified=${result.verified}`,
        });
      } catch {
        // The operation's own result is the primary evidence.
      }
      return result;
    } catch (error) {
      try {
        this.#leaseController.audit({
          kind: "mutate",
          op,
          outcome: auditOutcome(error),
          detail: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Nothing left to report to.
      }
      throw asDragDropError(error);
    } finally {
      let released = true;
      try {
        lease.release();
      } catch {
        released = false;
      }
      try {
        this.#leaseController.audit({
          kind: "lease-release",
          op,
          ...(released ? {} : { outcome: "error" }),
        });
      } catch {
        // Nothing left to report to.
      }
    }
  }

  /** Vend `file` and drop it on the resolved surface (fixture files only). */
  dropFile(
    request: Omit<DragDropFileRequest, "kind">,
  ): Promise<DragDropResult> {
    return this.run({ ...request, kind: "file-drop" });
  }

  /** Press→move→release inside the owned window (element reorder). */
  dragElement(
    request: Omit<DragDropElementRequest, "kind">,
  ): Promise<DragDropResult> {
    return this.run({ ...request, kind: "element-drag" });
  }
}

/**
 * The `ae.dragDrop()` body: attest the owned target, refuse unsupported
 * platforms, and bind the controller. `target === null` means no owned
 * pid/session is provable — same fail-closed shape as
 * `contextMenuForTarget`.
 */
export function dragDropForTarget(
  target: GuiObservationTarget | null,
  session: Session,
  seams: DragDropSeams = {},
): DragDrop {
  if (target === null) {
    throw new DragDropError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven window list to drop onto",
    );
  }
  if (process.platform !== "darwin") {
    throw new DragDropError(
      "unsupported",
      `the drag-drop surface is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }

  // The full WindowServer census — every pid — because the topmost gate
  // must see FOREIGN windows to refuse them. `seams.census` injects a
  // stub for tests; production runs the probe inside the target session.
  const census =
    seams.census ??
    (() =>
      windowServerCensus(
        seams.censusRun ??
          censusRunnerInSession(target.session, seams.runSession ?? runInSession),
      ));

  // The drag vehicle: the compiled `input-drag` helper inside the
  // target session. Absent helpers or test overrides leave channels
  // unset — the controller then refuses `unsupported` before anything
  // posts. `filedrag` legitimately runs for seconds (steps × delay +
  // dwell + session watchdogs), so the exec timeout is generous.
  let drag: ReturnType<typeof darwinDragChannels> | null = null;
  if (
    seams.press === undefined &&
    seams.move === undefined &&
    seams.release === undefined &&
    seams.fileDrag === undefined
  ) {
    const helpersDir = seams.helpersDir ?? ensureDarwinInputHelpers();
    if (helpersDir !== null) {
      const exec: DarwinInputExec = sessionInputExec({
        session: target.session,
        helpersDir,
        timeoutMs: 120_000,
      });
      drag = darwinDragChannels(exec, { tap: "session" });
    }
  }

  const runSession = seams.runSession ?? runInSession;
  const projectItems =
    seams.projectItems ??
    ((): Promise<DragDropSnapshot> =>
      session
        .call<{
          items: readonly { name: string; type: string | null }[];
          itemCount: number;
        }>("project.items", "project.items")
        .then((result) => ({
          items: result.items.map((item) => ({
            id: null,
            name: item.name,
            type: item.type,
          })),
          itemCount: result.itemCount,
          observedAt: new Date().toISOString(),
        })));

  const ops: DragDropOps = {
    observe: () =>
      new MacGuiRecovery(guiOptions(target, seams, true)).listWindows(),
    topmostAt:
      seams.topmostAt ?? ((point) => censusTopmostAt(census, point)),
    activate:
      seams.activate ??
      (() => darwinActivatePid(target.session, target.pid, runSession)),
    probeFile: seams.probeFile ?? probeDropFile,
    readback: () => projectItems(),
  };
  // Vehicle channels: a test seam wins per channel; otherwise the
  // compiled-helper binding supplies all four. A channel left unset is
  // the controller's `unsupported` refusal, never a blind post.
  const press = seams.press ?? drag?.press;
  if (press !== undefined) ops.press = press;
  const move = seams.move ?? drag?.move;
  if (move !== undefined) ops.move = move;
  const release = seams.release ?? drag?.release;
  if (release !== undefined) ops.release = release;
  const fileDrag = seams.fileDrag ?? drag?.fileDrag;
  if (fileDrag !== undefined) ops.fileDrag = fileDrag;

  const leaseController =
    seams.lease ??
    defaultLeaseController({
      stateRoot: seams.stateRoot ?? defaultGuiLeaseRoot(),
      session: { uid: target.session.uid, asid: target.session.asid },
      ownerId: seams.ownerId ?? "ae-a8n",
    });

  const controllerOptions: DragDropControllerOptions = {
    pid: target.pid,
    ops,
    // The A-SAFETY gate is wired explicitly, not left to the
    // controller's fail-closed default:
    // docs/gui-supervision-safety-gates.md is the policy source and
    // src/dragdrop/gate.ts its flip point.
    authorizeMutation: seams.authorizeMutation ?? dragDropMutationGate(),
    ...(seams.poll !== undefined ? { poll: seams.poll } : {}),
  };
  const controller = new DragDropController(controllerOptions);
  return new DragDrop(controller, leaseController);
}
