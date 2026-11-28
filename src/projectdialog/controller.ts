/**
 * Open/Save dialog round-trip orchestration (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5, §10).
 *
 * Platform-neutral composition, mirroring the other workspace
 * controllers: the menu invoke, the file-dialog acts, the window
 * listing and both oracles arrive through injected `ProjectDialogOps`,
 * so the contract is identical on macOS, Windows (when it lands) and
 * in tests.
 *
 *   - Every leg is `mutate-gui`: the controller's own gate is
 *     fail-closed, and the composed surfaces keep their gates — a
 *     denied inner gate surfaces as that surface's coded refusal,
 *     never bypassed.
 *   - The asserted path is the GUI path (spec §2): menu invoke →
 *     bounded dialog wait → filename entry → confirm/cancel. DOM
 *     mutations (`project.open`, `project.save`) are setup-only and
 *     never appear here.
 *   - Oracles are recorded per leg: `project.info().file` for open,
 *     read-only `stat` for save, window-listing diff for cancel. A
 *     postcondition that does not converge inside its bounded wait is
 *     `indeterminate` — resend is prohibited (spec §10).
 */

import { FileDialogError } from "../filedialog/types.js";
import type {
  FileDialogActResult,
  FileDialogResolution,
  FileDialogTitles,
} from "../filedialog/types.js";
import { MenuError } from "../menus/types.js";
import type { MenuItemLocator } from "../menus/types.js";
import { matchFileDialog } from "../filedialog/classify.js";
import {
  GuiMutationError,
  GuiRecoveryError,
  MacSessionError,
  type GuiAppState,
} from "../driver/gui-recovery.js";
import {
  ProjectDialogError,
  type CancelProjectDialogRequest,
  type OpenProjectDialogRequest,
  type ProjectDialogEvidence,
  type ProjectDialogFileStat,
  type ProjectDialogLegResult,
  type ProjectDialogProjectInfo,
  type ProjectDialogRoundTripResult,
  type SaveProjectDialogRequest,
} from "./types.js";

/**
 * The file-dialog channel this controller composes — the same four
 * verbs `FileDialog` exposes, injected so tests bind fakes and
 * production binds `fileDialogForTarget`.
 */
export type ProjectDialogChannel = {
  awaitDialog(
    titles: FileDialogTitles,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<FileDialogResolution>;
  enterFilename(
    resolution: FileDialogResolution,
    text: string,
  ): Promise<FileDialogActResult>;
  confirm(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): Promise<FileDialogActResult> | FileDialogActResult;
  cancel(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): Promise<FileDialogActResult> | FileDialogActResult;
};

/** Every OS/DOM touch the controller needs, injected. */
export type ProjectDialogOps = {
  /** Invoke a menu item through the gated menu surface. */
  invokeMenu(locator: MenuItemLocator): unknown;
  /** The native-picker channel (bounded wait + gated acts). */
  dialog: ProjectDialogChannel;
  /** One window-listing observation (cancel-dismiss oracle). */
  observe(): GuiAppState;
  /** DOM readback: which project file is open (`project.info`). */
  projectInfo(): Promise<ProjectDialogProjectInfo> | ProjectDialogProjectInfo;
  /** Read-only file evidence outside the AE process. */
  statFile(path: string): Promise<ProjectDialogFileStat> | ProjectDialogFileStat;
};

export type ProjectDialogMutationOp = "open" | "save" | "cancel" | "round-trip";

export type ProjectDialogMutationGate = (
  op: ProjectDialogMutationOp,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type ProjectDialogControllerOptions = {
  readonly pid: number;
  readonly ops: ProjectDialogOps;
  /**
   * The mutate-gui gate for the round-trip layer. Fail-closed: absent
   * means every leg refuses. The composed surfaces keep their own
   * gates — this gate governs the orchestration itself.
   */
  readonly authorizeMutation?: ProjectDialogMutationGate;
  readonly now?: () => Date;
  /** Millisecond clock seam for deadline math; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Millisecond sleep seam; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_PICKER_TIMEOUT_MS = 15_000;
const DEFAULT_POSTCONDITION_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map composed-surface failures onto this module's codes: coded
 * `FileDialogError`/`MenuError`/`GuiRecoveryError`s keep their meaning;
 * anything else during an act is `indeterminate` (the flow may have
 * partially reached the screen).
 */
function asProjectDialogError(error: unknown, duringAct: boolean): ProjectDialogError {
  if (error instanceof ProjectDialogError) {
    return error;
  }
  if (error instanceof FileDialogError || error instanceof MenuError) {
    const code: ProjectDialogError["code"] =
      error.code === "ambiguous-target" ? "ambiguous" : error.code;
    return new ProjectDialogError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  if (error instanceof GuiMutationError) {
    return new ProjectDialogError("indeterminate", errorText(error), { cause: error });
  }
  if (error instanceof MacSessionError || error instanceof GuiRecoveryError) {
    return new ProjectDialogError("unavailable", errorText(error), { cause: error });
  }
  return new ProjectDialogError(duringAct ? "indeterminate" : "unavailable", errorText(error), {
    cause: error,
  });
}

/** Normalize a path for the project-info equality check (POSIX separators, no trailing slash). */
function normalizeProjectPath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed;
}

export class ProjectDialogController {
  readonly #ops: ProjectDialogOps;
  readonly #authorizeMutation: ProjectDialogMutationGate | undefined;
  readonly #now: () => Date;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ProjectDialogControllerOptions) {
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#now = options.now ?? (() => new Date());
    this.#clock = options.clock ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  #requireMutationAllowed(op: ProjectDialogMutationOp): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for project-dialog operations; every leg is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new ProjectDialogError(
        "refused",
        `${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Bounded postcondition wait (spec §10): poll `read` until `accept`
   * passes or the deadline expires. A read that NEVER answers is
   * `unavailable` — an oracle that cannot be read cannot verify
   * anything. Deadline expiry is `met:false`, never a resend.
   */
  async #waitFor<T>(
    read: () => Promise<T> | T,
    accept: (value: T) => boolean,
    timeoutMs: number,
    pollIntervalMs: number,
    oracle: string,
  ): Promise<{ met: boolean; last: T | null }> {
    const deadline = this.#clock() + timeoutMs;
    let last: T | null = null;
    let answered = false;
    for (;;) {
      try {
        const value = await read();
        answered = true;
        last = value;
        if (accept(value)) {
          return { met: true, last };
        }
      } catch {
        // A transient oracle failure is a poll miss, not a verdict —
        // the deadline decides.
      }
      if (this.#clock() >= deadline) {
        break;
      }
      await this.#sleep(Math.min(pollIntervalMs, Math.max(1, deadline - this.#clock())));
    }
    if (!answered) {
      throw new ProjectDialogError(
        "unavailable",
        `the ${oracle} oracle never answered during the postcondition ` +
          "wait; the act's outcome cannot be verified",
      );
    }
    return { met: false, last };
  }

  /**
   * The shared leg: invoke the declared menu, bounded-wait for the
   * picker, enter the filename, confirm. Each step's coded failure
   * propagates mapped — the flow stops at the first refusal.
   */
  async #raiseAndConfirm(
    request: {
      readonly menu: MenuItemLocator;
      readonly titles: FileDialogTitles;
      readonly fileName: string;
      readonly timeoutMs?: number;
    },
  ): Promise<{ dialog: FileDialogResolution; entered: FileDialogActResult; confirmed: FileDialogActResult }> {
    try {
      await this.#ops.invokeMenu(request.menu);
    } catch (error) {
      throw asProjectDialogError(error, true);
    }
    let dialog: FileDialogResolution;
    try {
      dialog = await this.#ops.dialog.awaitDialog(request.titles, {
        timeoutMs: request.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
      });
    } catch (error) {
      throw asProjectDialogError(error, true);
    }
    let entered: FileDialogActResult;
    try {
      entered = await this.#ops.dialog.enterFilename(dialog, request.fileName);
    } catch (error) {
      throw asProjectDialogError(error, true);
    }
    let confirmed: FileDialogActResult;
    try {
      confirmed = await this.#ops.dialog.confirm(dialog, request.titles);
    } catch (error) {
      throw asProjectDialogError(error, true);
    }
    return { dialog, entered, confirmed };
  }

  /**
   * File > Open round-trip: raise the picker through the real menu,
   * enter `fileName`, confirm, then bounded-wait for
   * `project.info().file` to name the opened project. The postcondition
   * is the DOM readback oracle — observe-class evidence recorded on the
   * result; a non-converging read is `indeterminate`, never resent.
   */
  async openProject(request: OpenProjectDialogRequest): Promise<ProjectDialogLegResult> {
    this.#requireMutationAllowed("open");
    const { dialog } = await this.#raiseAndConfirm(request);

    const expectedFile =
      request.expectedFile === undefined ? null : normalizeProjectPath(request.expectedFile);
    const wait = await this.#waitFor(
      () => this.#ops.projectInfo(),
      (info) => {
        if (info.file === null) return false;
        if (expectedFile !== null) {
          return normalizeProjectPath(info.file) === expectedFile;
        }
        return info.file.endsWith(request.fileName);
      },
      request.postconditionTimeoutMs ?? DEFAULT_POSTCONDITION_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "project.info",
    );
    const observed = wait.last;
    const evidence: ProjectDialogEvidence = {
      dialog,
      menu: request.menu,
      fileName: request.fileName,
      channels: {
        projectInfo: observed,
        fileStat: null,
        windows: 0,
      },
      postconditionMet: wait.met,
    };
    return {
      action: "open",
      verdict: wait.met ? "performed" : "indeterminate",
      evidence,
      detail: wait.met
        ? `opened ${JSON.stringify(observed?.file ?? request.fileName)} via the ` +
          "native picker; project.info confirms the file"
        : "the picker was confirmed but project.info did not report the " +
          "expected file within the bounded wait; the open may still be " +
          "in flight — no resend was attempted",
      actedAt: this.#now().toISOString(),
    };
  }

  /**
   * File > Save As round-trip: raise the picker through the real menu,
   * enter `fileName`, confirm, then bounded-wait for the declared
   * `path` to exist — the read-only OS stat oracle, evidence gathered
   * outside the AE process.
   */
  async saveProjectAs(request: SaveProjectDialogRequest): Promise<ProjectDialogLegResult> {
    this.#requireMutationAllowed("save");
    const { dialog } = await this.#raiseAndConfirm(request);

    const wait = await this.#waitFor(
      () => this.#ops.statFile(request.path),
      (stat) => stat.exists,
      request.postconditionTimeoutMs ?? DEFAULT_POSTCONDITION_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "file-stat",
    );
    const observed = wait.last;
    const evidence: ProjectDialogEvidence = {
      dialog,
      menu: request.menu,
      fileName: request.fileName,
      channels: {
        projectInfo: null,
        fileStat: observed,
        windows: 0,
      },
      postconditionMet: wait.met,
    };
    return {
      action: "save-as",
      verdict: wait.met ? "performed" : "indeterminate",
      evidence,
      detail: wait.met
        ? `saved to ${request.path}; the file exists (mtime ` +
          `${observed?.mtimeMs ?? "unknown"})`
        : `the picker was confirmed but ${request.path} did not appear ` +
          "within the bounded wait; the save may have gone elsewhere or " +
          "still be in flight — no resend was attempted",
      actedAt: this.#now().toISOString(),
    };
  }

  /**
   * Raise the picker and cancel it: invoke the menu, bounded-wait for
   * the dialog, press cancel, then bounded-wait until no window matches
   * the declared titles — the dismiss oracle is the window listing.
   */
  async cancelDialog(request: CancelProjectDialogRequest): Promise<ProjectDialogLegResult> {
    this.#requireMutationAllowed("cancel");
    let dialog: FileDialogResolution;
    try {
      await this.#ops.invokeMenu(request.menu);
      dialog = await this.#ops.dialog.awaitDialog(request.titles, {
        timeoutMs: request.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
      });
      await this.#ops.dialog.cancel(dialog, request.titles);
    } catch (error) {
      throw asProjectDialogError(error, true);
    }

    let windows = 0;
    const wait = await this.#waitFor(
      () => {
        const state = this.#ops.observe();
        windows = state.windows.length;
        return state;
      },
      (state) =>
        !state.windows.some((window) => {
          const match = matchFileDialog(window, request.titles);
          return match.kind === "file-dialog";
        }),
      DEFAULT_POSTCONDITION_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "window-listing",
    );
    const met = wait.met;
    const evidence: ProjectDialogEvidence = {
      dialog,
      menu: request.menu,
      fileName: "",
      channels: {
        projectInfo: null,
        fileStat: null,
        windows,
      },
      postconditionMet: met,
    };
    return {
      action: "cancel",
      verdict: met ? "performed" : "indeterminate",
      evidence,
      detail: met
        ? "the picker was cancelled and no file-dialog window remains"
        : "cancel was pressed but a file-dialog window still matches the " +
          "declared titles after the bounded wait; re-observe before " +
          "retrying — no resend was attempted",
      actedAt: this.#now().toISOString(),
    };
  }

  /**
   * The open → save-as round-trip: open the fixture project through its
   * picker, then save-as the declared path through its picker. Both
   * legs run their own gates and oracles; the composed verdict is
   * `performed` only when both postconditions converged.
   */
  async roundTrip(request: {
    readonly open: OpenProjectDialogRequest;
    readonly save: SaveProjectDialogRequest;
  }): Promise<ProjectDialogRoundTripResult> {
    this.#requireMutationAllowed("round-trip");
    const open = await this.openProject(request.open);
    const save = await this.saveProjectAs(request.save);
    const verdict =
      open.verdict === "performed" && save.verdict === "performed"
        ? "performed"
        : "indeterminate";
    return {
      verdict,
      open,
      save,
      observedAt: this.#now().toISOString(),
    };
  }
}
