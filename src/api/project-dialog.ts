/**
 * Public Open/Save dialog round-trip API (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5, §10).
 *
 * `ae.projectDialog()` returns a handle whose operations run the W4+
 * round-trip contract: File > Open / Save through the *real* menu and
 * native picker — never `project.open`/`project.save` scripting, which
 * is setup-only and never asserted (spec §2).
 *
 * Honesty rules carried from `ae.fileDialog()`/`ae.menuBar()`:
 *
 *   - No owned, attested target → construction throws
 *     `ProjectDialogError` `unavailable`.
 *   - macOS only in this slice. Windows reports `unsupported`.
 *   - Every leg is `mutate-gui` and stays gated at THREE layers: this
 *     controller's gate, the menu invoke's gate, and the file-dialog
 *     acts' gate — plus the shared-state filename-entry channel, which
 *     has no vehicle on any platform yet (#372/#373). Production
 *     refuses; see `projectDialogCapabilities()`.
 *   - Oracles are recorded per leg: `project.info().file` for open,
 *     read-only file stat for save. A non-converging postcondition is
 *     `indeterminate`, never a resend.
 */

import { statSync } from "node:fs";

import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import type { Session } from "./session.js";
import {
  ProjectDialogController,
  type ProjectDialogOps,
} from "../projectdialog/controller.js";
import { projectDialogMutationGate } from "../projectdialog/gate.js";
import {
  ProjectDialogError,
  type CancelProjectDialogRequest,
  type OpenProjectDialogRequest,
  type ProjectDialogFileStat,
  type ProjectDialogLegResult,
  type ProjectDialogMutationGate,
  type ProjectDialogProjectInfo,
  type ProjectDialogRoundTripResult,
  type SaveProjectDialogRequest,
} from "../projectdialog/index.js";
import { fileDialogForTarget, type FileDialogSeams } from "./file-dialog.js";
import { menuBarForTarget, type MenuSeams } from "./menus.js";
import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import type { ProjectInfo } from "./types.js";

export type {
  CancelProjectDialogRequest,
  OpenProjectDialogRequest,
  ProjectDialogErrorCode,
  ProjectDialogEvidence,
  ProjectDialogFileStat,
  ProjectDialogLegResult,
  ProjectDialogProjectInfo,
  ProjectDialogRoundTripResult,
  SaveProjectDialogRequest,
} from "../projectdialog/index.js";
export { ProjectDialogError, projectDialogMutationGate } from "../projectdialog/index.js";
export type {
  ProjectDialogChannel,
  ProjectDialogControllerOptions,
  ProjectDialogMutationGate,
  ProjectDialogMutationOp,
  ProjectDialogOps,
} from "../projectdialog/index.js";

/** The verification level every round-trip claim carries until real-host proof. */
const VERIFICATION = "automated test" as const;

/** Per-capability honesty record, same shape as `FileDialogCapability`. */
export type ProjectDialogCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with project Open/Save dialogs on this platform. */
export type ProjectDialogCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly openProject: ProjectDialogCapability;
  readonly saveProjectAs: ProjectDialogCapability;
  readonly cancelDialog: ProjectDialogCapability;
  readonly roundTrip: ProjectDialogCapability;
};

/**
 * What this build supports for the project-dialog round-trip on
 * `platform`. Windows is deliberately all-unsupported in this slice.
 */
export function projectDialogCapabilities(platform: NodeJS.Platform): ProjectDialogCapabilities {
  if (platform !== "darwin") {
    const unsupported: ProjectDialogCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "the project-dialog round-trip is implemented for macOS only in " +
        "this slice; the Windows dialog census + UIA edit path is a " +
        "separate ticket",
    };
    return {
      platform: "win32",
      openProject: unsupported,
      saveProjectAs: unsupported,
      cancelDialog: unsupported,
      roundTrip: unsupported,
    };
  }
  const gated = (leg: string): ProjectDialogCapability => ({
    support: "unavailable",
    verification: VERIFICATION,
    reason:
      `mutate-gui class gated off by projectDialogMutationGate() per the ` +
      `A-SAFETY audit; the ${leg} path is contract-tested but refuses ` +
      "until the audit clears it — and filename entry additionally needs " +
      "the B-IME OS text-input posters (#372/#373), not yet landed",
  });
  return {
    platform: "darwin",
    openProject: gated("open"),
    saveProjectAs: gated("save-as"),
    cancelDialog: gated("cancel"),
    roundTrip: gated("round-trip"),
  };
}

/** Seams the production adapter needs; mirrors `FileDialogSeams`. */
export type ProjectDialogSeams = GuiObservationSeams & {
  /** Round-trip gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: ProjectDialogMutationGate;
  /** Menu-invoke gate override forwarded to `menuBarForTarget`. */
  readonly menuAuthorizeMutation?: MenuSeams["authorizeMutation"];
  /** Dialog-act gate override forwarded to `fileDialogForTarget`. */
  readonly dialogAuthorizeMutation?: FileDialogSeams["authorizeMutation"];
  /** Test/future seam for the filename-entry channel; forwarded to the dialog. */
  readonly enterFilename?: FileDialogSeams["enterFilename"];
  /** Test seams for the read-only oracles. */
  readonly projectInfo?: () => Promise<ProjectDialogProjectInfo> | ProjectDialogProjectInfo;
  readonly statFile?: (path: string) => Promise<ProjectDialogFileStat> | ProjectDialogFileStat;
};

function guiOptions(
  target: GuiObservationTarget,
  seams: ProjectDialogSeams,
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

/** Read-only file evidence: existence + mtime, gathered outside AE. */
function statPath(path: string): ProjectDialogFileStat {
  try {
    const stats = statSync(path);
    return { exists: true, mtimeMs: stats.mtimeMs, sizeBytes: stats.size };
  } catch {
    return { exists: false, mtimeMs: null, sizeBytes: null };
  }
}

/**
 * A handle to the owned After Effects instance's project Open/Save
 * dialogs. Every leg re-raises the picker through the real menu and
 * re-resolves the dialog — a `ProjectDialog` is a locator set, not a
 * handle to a remembered window or project.
 */
export class ProjectDialog {
  readonly #controller: ProjectDialogController;

  constructor(controller: ProjectDialogController) {
    this.#controller = controller;
  }

  /**
   * File > Open round-trip: menu invoke → bounded picker wait →
   * filename entry → confirm → `project.info().file` postcondition.
   * Mutate-gui, gated at every layer.
   */
  openProject(request: OpenProjectDialogRequest): Promise<ProjectDialogLegResult> {
    return Promise.resolve().then(() => this.#controller.openProject(request));
  }

  /**
   * File > Save As round-trip: same GUI path, postcondition is the
   * read-only stat of the declared `path`.
   */
  saveProjectAs(request: SaveProjectDialogRequest): Promise<ProjectDialogLegResult> {
    return Promise.resolve().then(() => this.#controller.saveProjectAs(request));
  }

  /**
   * Raise the picker and cancel it — the dismiss path, with the
   * window-listing oracle proving no file-dialog window remains.
   */
  cancelDialog(request: CancelProjectDialogRequest): Promise<ProjectDialogLegResult> {
    return Promise.resolve().then(() => this.#controller.cancelDialog(request));
  }

  /**
   * Open the fixture project, then save-as the declared path — the
   * composed round-trip. `performed` only when both legs' postconditions
   * converged.
   */
  roundTrip(request: {
    readonly open: OpenProjectDialogRequest;
    readonly save: SaveProjectDialogRequest;
  }): Promise<ProjectDialogRoundTripResult> {
    return Promise.resolve().then(() => this.#controller.roundTrip(request));
  }
}

/**
 * The `ae.projectDialog()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller over the session's
 * DOM readback and the composed menu/dialog surfaces.
 * `target === null` means no owned pid/session is provable.
 */
export function projectDialogForTarget(
  target: GuiObservationTarget | null,
  session: Session,
  seams: ProjectDialogSeams = {},
): ProjectDialog {
  if (target === null) {
    throw new ProjectDialogError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        '(ownership must be "owned" and the transport must name its target); ' +
        "there is no proven surface to raise project dialogs against",
    );
  }
  if (process.platform !== "darwin") {
    throw new ProjectDialogError(
      "unsupported",
      `the project-dialog round-trip is implemented for macOS only in this ` +
        `slice; platform is ${process.platform}`,
    );
  }

  const sharedSeams = {
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

  // The composed surfaces are built lazily per leg so a session that
  // only observes never constructs the mutator views — and so each
  // surface's own mutation gate is consulted at act time.
  const dialog = fileDialogForTarget(target, {
    ...sharedSeams,
    ...(seams.dialogAuthorizeMutation === undefined
      ? {}
      : { authorizeMutation: seams.dialogAuthorizeMutation }),
    ...(seams.enterFilename === undefined
      ? {}
      : { enterFilename: seams.enterFilename }),
  });
  const menuBar = () =>
    menuBarForTarget(target, {
      ...sharedSeams,
      ...(seams.menuAuthorizeMutation === undefined
        ? {}
        : { authorizeMutation: seams.menuAuthorizeMutation }),
    });

  const ops: ProjectDialogOps = {
    invokeMenu: (locator) => menuBar().invoke(locator),
    dialog: {
      awaitDialog: (titles, options) => dialog.awaitDialog(titles, options),
      enterFilename: (resolution, text) => dialog.enterFilename(resolution, text),
      confirm: (resolution, titles) => dialog.confirm(resolution, titles),
      cancel: (resolution, titles) => dialog.cancel(resolution, titles),
    },
    observe: () =>
      new MacGuiRecovery(guiOptions(target, seams, true)).listWindows(),
    projectInfo:
      seams.projectInfo ??
      (() =>
        session.call<ProjectInfo>("project.info", "project.info").then((info) => ({
          file: info.file,
          name: info.name,
        }))),
    statFile: seams.statFile ?? ((path) => statPath(path)),
  };
  const controller = new ProjectDialogController({
    pid: target.pid,
    ops,
    authorizeMutation: seams.authorizeMutation ?? projectDialogMutationGate(),
  });
  return new ProjectDialog(controller);
}
