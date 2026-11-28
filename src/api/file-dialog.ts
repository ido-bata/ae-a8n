/**
 * Public file-dialog API (#365, `specs/workspace-editing/spec.md` §3 W3).
 *
 * `ae.fileDialog()` returns a handle whose operations run the native
 * file-picker contract: bounded wait for the declared dialog class,
 * re-resolved confirm/cancel presses, and filename entry through the
 * B-IME text path.
 *
 * Honesty rules carried from `ae.menuBar()`/`ae.dockedPane()`:
 *
 *   - No owned, attested target → every operation reports `unavailable`.
 *   - macOS only in this slice. Windows reports `unsupported` — the
 *     Win32 dialog census + UIA edit path is a separate ticket.
 *   - `awaitDialog` is observe-class. `confirm`/`cancel`/`enterFilename`
 *     are `mutate-gui` and stay gated: the production gate refuses them
 *     until the A-SAFETY review clears a dialog-act class — see
 *     `fileDialogCapabilities()` for the current answer.
 *   - Filename entry additionally needs the B-IME OS text-input posters
 *     (#372/#373), which have not landed on any platform: production
 *     reports `unsupported` rather than pretending a channel exists.
 *   - AE's native-picker AX fidelity (button titles, sheet vs window
 *     shape, filename field exposure) is unverified on a real host;
 *     every capability reports its level.
 */

import { MacGuiRecovery, type GuiRecoveryOptions } from "../driver/gui-recovery.js";
import {
  FileDialogController,
  type FileDialogOps,
} from "../filedialog/controller.js";
import { fileDialogMutationGate } from "../filedialog/gate.js";
import {
  FileDialogError,
  type FileDialogActResult,
  type FileDialogMutationGate,
  type FileDialogResolution,
  type FileDialogTitles,
} from "../filedialog/index.js";
import type { GuiObservationTarget, GuiObservationSeams } from "./gui-state.js";
import { observeOp, type OpTelemetry } from "../observability/telemetry.js";

export type {
  FileDialogActResult,
  FileDialogErrorCode,
  FileDialogResolution,
  FileDialogTitles,
} from "../filedialog/types.js";
export { FileDialogError, matchFileDialog, type FileDialogMatch } from "../filedialog/index.js";
export type {
  AwaitFileDialogOptions,
  FileDialogMutationGate,
  FileDialogOps,
  FilenameEntryVerdict,
} from "../filedialog/index.js";

/** The verification level every file-dialog claim carries until real-host proof. */
const VERIFICATION = "automated test" as const;

/** Per-capability honesty record, same shape as `MenuCapability`. */
export type FileDialogCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with native file dialogs on this platform. */
export type FileDialogCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly awaitDialog: FileDialogCapability;
  readonly confirm: FileDialogCapability;
  readonly cancel: FileDialogCapability;
  readonly enterFilename: FileDialogCapability;
};

/**
 * What this build supports for the file-dialog surface on `platform`.
 * Windows is deliberately all-unsupported: the Win32 dialog census +
 * UIA edit-control path is a separate ticket and nothing here may imply
 * otherwise.
 */
export function fileDialogCapabilities(platform: NodeJS.Platform): FileDialogCapabilities {
  if (platform !== "darwin") {
    const unsupported: FileDialogCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "the file-dialog surface is implemented for macOS only in this slice; " +
        "the Windows dialog census + UIA edit path is a separate ticket",
    };
    return {
      platform: "win32",
      awaitDialog: unsupported,
      confirm: unsupported,
      cancel: unsupported,
      enterFilename: unsupported,
    };
  }
  return {
    platform: "darwin",
    awaitDialog: {
      support: "implemented",
      verification: VERIFICATION,
      reason:
        "bounded wait + title-matched dialog classification are contracted; " +
        "AE's native-picker AX fidelity (button titles, sheet shape) is " +
        "unverified on a real host — callers must declare localized titles",
    },
    confirm: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "mutate-gui class gated off by fileDialogMutationGate() per the " +
        "A-SAFETY audit (docs/gui-supervision-safety-gates.md) and the " +
        "workspace spec §13; the press path exists and is contract-tested " +
        "but refuses until the audit clears it",
    },
    cancel: {
      support: "unavailable",
      verification: VERIFICATION,
      reason:
        "same mutate-gui gate as confirm; cancel presses nothing dangerous " +
        "but the gate does not distinguish — it clears as a class",
    },
    enterFilename: {
      support: "unsupported",
      verification: VERIFICATION,
      reason:
        "filename entry is mutate-gui shared-state and needs the B-IME OS " +
        "text-input posters (#372 macOS / #373 Windows), which have not " +
        "landed on any platform; the contract and gates exist, the vehicle " +
        "does not",
    },
  };
}

/** Seams the production adapter needs; mirrors `MenuSeams`. */
export type FileDialogSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to the A-SAFETY gate, which refuses. */
  readonly authorizeMutation?: FileDialogMutationGate;
  /** Test/future seam for the filename-entry channel; production leaves it unset. */
  readonly enterFilename?: FileDialogOps["enterFilename"];
};

function guiOptions(
  target: GuiObservationTarget,
  seams: FileDialogSeams,
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
 * A handle to the owned After Effects instance's native file dialogs.
 * `awaitDialog` re-observes on every call; the acts re-resolve the
 * dialog window immediately before pressing — a `FileDialog` is a
 * locator set, not a handle to a remembered window.
 */
export class FileDialog {
  readonly #controller: FileDialogController;
  readonly #telemetry: OpTelemetry | undefined;

  constructor(controller: FileDialogController, telemetry?: OpTelemetry) {
    this.#controller = controller;
    this.#telemetry = telemetry;
  }

  /**
   * Bounded wait for the declared file dialog. Observe-class: polls the
   * window listing until a dialog's buttons match `titles` or the
   * deadline expires (`indeterminate` — never resent). A different
   * blocking dialog on screen refuses rather than being pressed.
   */
  awaitDialog(
    titles: FileDialogTitles,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<FileDialogResolution> {
    return observeOp(this.#telemetry, "fileDialog.awaitDialog", { titles }, () =>
      Promise.resolve().then(() =>
        this.#controller.awaitFileDialog({ titles, ...(options ?? {}) }),
      ),
    );
  }

  /**
   * Press the resolved dialog's confirm button. Mutate-gui: gated —
   * currently refused in production until the A-SAFETY review clears a
   * dialog-act class. Re-resolves the window immediately before the
   * press.
   */
  confirm(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): Promise<FileDialogActResult> {
    return observeOp(this.#telemetry, "fileDialog.confirm", undefined, () =>
      Promise.resolve().then(() => this.#controller.confirm(resolution, titles)),
    );
  }

  /** Press the resolved dialog's cancel button. Same mutate-gui gate. */
  cancel(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): Promise<FileDialogActResult> {
    return observeOp(this.#telemetry, "fileDialog.cancel", undefined, () =>
      Promise.resolve().then(() => this.#controller.cancel(resolution, titles)),
    );
  }

  /**
   * Enter a filename into the resolved dialog — shared-state mutate-gui.
   * Currently `unsupported` in production: the B-IME OS text-input
   * posters (#372/#373) have not landed on any platform.
   */
  enterFilename(
    resolution: FileDialogResolution,
    text: string,
  ): Promise<FileDialogActResult> {
    return observeOp(this.#telemetry, "fileDialog.enterFilename", { length: text.length }, () =>
      this.#controller.enterFilename(resolution, text),
    );
  }
}

/**
 * The `ae.fileDialog()` body: attest the owned target, refuse
 * unsupported platforms, and bind the controller. `target === null`
 * means no owned pid/session is provable — same fail-closed shape as
 * `menuBarForTarget`.
 */
export function fileDialogForTarget(
  target: GuiObservationTarget | null,
  seams: FileDialogSeams = {},
  telemetry?: OpTelemetry,
): FileDialog {
  if (target === null) {
    throw new FileDialogError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven window list to observe dialogs against",
    );
  }
  if (process.platform !== "darwin") {
    throw new FileDialogError(
      "unsupported",
      `the file-dialog surface is implemented for macOS only in this slice; ` +
        `platform is ${process.platform}`,
    );
  }
  // Two views share the target, like menuBarForTarget: the observer may
  // run in the console session (read-only listing, same rule as
  // guiState); the mutator keeps the default console refusal — a dialog
  // press is a real GUI mutation on the screen the user may be watching.
  let mutator: MacGuiRecovery | null = null;
  const ops: FileDialogOps = {
    observe: () =>
      new MacGuiRecovery(guiOptions(target, seams, true)).listWindows(),
    pressButton: (windowIndex, title, expected, expectedText) => {
      if (mutator === null) {
        // Construction can refuse (console session, unreadable console
        // owner) — that refusal is a provable non-mutation.
        mutator = new MacGuiRecovery(guiOptions(target, seams, false));
      }
      return mutator.pressButtonIn(windowIndex, title, expected, expectedText ?? "");
    },
    ...(seams.enterFilename === undefined
      ? {}
      : { enterFilename: seams.enterFilename }),
  };
  const controller = new FileDialogController({
    pid: target.pid,
    ops,
    // The A-SAFETY gate is wired explicitly, not left to the controller's
    // fail-closed default: docs/gui-supervision-safety-gates.md is the
    // policy source and src/filedialog/gate.ts its single code flip point.
    authorizeMutation: seams.authorizeMutation ?? fileDialogMutationGate(),
  });
  return new FileDialog(controller, telemetry);
}
