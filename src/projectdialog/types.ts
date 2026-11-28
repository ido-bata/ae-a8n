/**
 * Open/Save dialog round-trip contract (#368,
 * `specs/workspace-editing/spec.md` §3 W4+, §5, §10).
 *
 * File > Open / Save run through After Effects' *native* pickers — the
 * same dialog machinery #365 fixed (`awaitFileDialog` bounded wait,
 * title-matched classification, gated confirm/cancel, B-IME filename
 * entry). This module adds the round-trip layer on top:
 *
 *   - The **act path is the GUI path only** (spec §2): the menu invoke
 *     is the real menu surface (`ae.menuBar()` vocabulary), the dialog
 *     acts go through the file-dialog contract, and filename entry goes
 *     through the shared-state B-IME channel. `project.open` /
 *     `project.save` scripting is setup-only and is never asserted.
 *   - The **oracle is hybrid** (spec §2 rule 2): open verifies
 *     `project.info().file` (DOM readback, observe-class); save verifies
 *     the file's existence/mtime through a read-only OS stat outside
 *     the AE process. Both channels are recorded on the result — never
 *     blended silently.
 *   - Every leg is `mutate-gui` and gated: the menu invoke keeps its
 *     own gate, the dialog acts keep theirs, and this controller's gate
 *     refuses the whole flow until the A-SAFETY audit clears it.
 *   - Waits are bounded and resend is prohibited (spec §10): a post-
 *     condition that does not converge is `indeterminate`, never a
 *     second confirm.
 *
 * Verification level of everything here: `automated test` against
 * fakes. Real-picker filename entry and `project.info` convergence
 * after a GUI open are unverified until the real-host lane runs.
 */

import type { FileDialogResolution, FileDialogTitles } from "../filedialog/types.js";
import type { MenuItemLocator } from "../menus/types.js";

/** Stable refusal codes a caller may act on. */
export type ProjectDialogErrorCode =
  /** This platform/kind has no implementation (Windows in this slice). */
  | "unsupported"
  /** The expected menu path or dialog titles are absent — never a fallback. */
  | "unsupported-locale"
  /** The locator itself is malformed. */
  | "invalid-locator"
  /** No candidate matched (dialog, menu item, project file). */
  | "not-found"
  /** More than one candidate matched; never a guess. */
  | "ambiguous"
  /** The surface exists but pid attribution is not "owned". */
  | "unproven"
  /** A resolved identity drifted before the act. */
  | "stale-locator"
  /** The target session or observation could not be produced. */
  | "unavailable"
  /** A safety gate or policy refuses the operation now. */
  | "refused"
  /** A bounded wait expired or an act's outcome is unknown. */
  | "indeterminate";

export class ProjectDialogError extends Error {
  readonly code: ProjectDialogErrorCode;
  readonly candidates: readonly string[];

  constructor(
    code: ProjectDialogErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProjectDialogError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The project facts the DOM exposes for the open postcondition. */
export type ProjectDialogProjectInfo = {
  /** `project.file.fsName` — absolute path, null for untitled projects. */
  readonly file: string | null;
  /** `project.file.name` — file name only. */
  readonly name: string | null;
};

/** Read-only file evidence gathered outside the AE process. */
export type ProjectDialogFileStat = {
  readonly exists: boolean;
  /** Epoch milliseconds; null when the file does not exist. */
  readonly mtimeMs: number | null;
  readonly sizeBytes: number | null;
};

/** What `openProject` asks for. */
export type OpenProjectDialogRequest = {
  /**
   * The real menu path that raises the picker (e.g.
   * `{ menuPath: ["File"], itemTitle: "Open…" }`) — resolved by the
   * gated menu surface at act time, localized titles included.
   */
  readonly menu: MenuItemLocator;
  /** The localized confirm/cancel titles the picker is expected to show. */
  readonly titles: FileDialogTitles;
  /** The text entered into the picker's filename field. */
  readonly fileName: string;
  /**
   * The absolute path `project.info().file` must equal after the open —
   * the DOM readback oracle. When omitted the postcondition accepts any
   * non-null `file` ending with `fileName` (weaker; recorded as such).
   */
  readonly expectedFile?: string;
  /** Bounded wait for the picker itself; default 15s. */
  readonly timeoutMs?: number;
  /** Bounded wait for the project-info postcondition; default 10s. */
  readonly postconditionTimeoutMs?: number;
};

/** What `saveProjectAs` asks for. */
export type SaveProjectDialogRequest = {
  /** The real menu path that raises the picker (e.g. File > Save As…). */
  readonly menu: MenuItemLocator;
  /** The localized confirm/cancel titles the picker is expected to show. */
  readonly titles: FileDialogTitles;
  /** The text entered into the picker's filename field. */
  readonly fileName: string;
  /**
   * The absolute path the file must exist at afterwards — the
   * read-only stat oracle. This is the evidence path, not the field
   * text: callers resolve `fileName` against their fixture directory.
   */
  readonly path: string;
  /** Bounded wait for the picker itself; default 15s. */
  readonly timeoutMs?: number;
  /** Bounded wait for the file-stat postcondition; default 10s. */
  readonly postconditionTimeoutMs?: number;
};

/** What `cancelDialog` asks for. */
export type CancelProjectDialogRequest = {
  readonly menu: MenuItemLocator;
  readonly titles: FileDialogTitles;
  readonly timeoutMs?: number;
};

/** The evidence one dialog round-trip leg produced. */
export type ProjectDialogEvidence = {
  /** The dialog resolution the acts addressed. */
  readonly dialog: FileDialogResolution;
  /** The menu locator that raised the picker. */
  readonly menu: MenuItemLocator;
  /** The filename text that was entered. */
  readonly fileName: string;
  /** Which channels produced the postcondition verdict. */
  readonly channels: {
    /** `project.info` DOM readback — open leg. */
    readonly projectInfo: ProjectDialogProjectInfo | null;
    /** Read-only OS stat — save leg. */
    readonly fileStat: ProjectDialogFileStat | null;
    /** `listWindows` observation used by the cancel-dismiss wait. */
    readonly windows: number;
  };
  /** True when the declared postcondition was observed in time. */
  readonly postconditionMet: boolean;
};

/** The verdict one leg reports. */
export type ProjectDialogLegResult = {
  readonly action: "open" | "save-as" | "cancel";
  readonly verdict: "performed" | "indeterminate";
  readonly evidence: ProjectDialogEvidence;
  readonly detail: string;
  readonly actedAt: string;
};

/** The composed open → save-as round-trip result. */
export type ProjectDialogRoundTripResult = {
  readonly verdict: "performed" | "indeterminate";
  readonly open: ProjectDialogLegResult;
  readonly save: ProjectDialogLegResult;
  readonly observedAt: string;
};
