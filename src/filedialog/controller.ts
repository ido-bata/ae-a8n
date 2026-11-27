/**
 * File-dialog orchestration (#365,
 * `specs/workspace-editing/spec.md` §3 Slice W3, §5, §10).
 *
 * Platform-neutral, mirroring `MenuController`/`DockedPaneObserver`:
 * every OS touch arrives through injected `FileDialogOps`, so the
 * contract — bounded wait, dialog-class verification, re-resolution
 * before act, gate-before-mutate — is identical on macOS, Windows and
 * in tests.
 *
 *   - `awaitFileDialog` is observe-class: it polls `observe()` until a
 *     window classifies as the declared file dialog or the deadline
 *     expires. Expiry is `indeterminate` — the invoking action may
 *     still be in flight; nothing is resent.
 *   - A blocking window that is human-only, unrecognized, or a second
 *     file-dialog candidate stops the flow with a coded refusal —
 *     blind auto-confirm is prohibited by contract, not by convention.
 *   - `confirm`/`cancel`/`enterFilename` are `mutate-gui`: they require
 *     the injected gate (fail-closed when absent), re-resolve the dialog
 *     window immediately before acting, and map vehicle verdicts onto
 *     coded errors — `stale-locator` for provable non-mutations,
 *     `indeterminate` for unknown outcomes.
 */

import {
  GuiMutationError,
  GuiRecoveryError,
  isPidAttributedWindow,
  MacSessionError,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import { fileDialogButtonTitle, matchFileDialog } from "./classify.js";
import {
  FileDialogError,
  type FileDialogActResult,
  type FileDialogResolution,
  type FileDialogTitles,
} from "./types.js";

/** What the filename-entry channel reports. */
export type FilenameEntryVerdict =
  /** The text was delivered to the dialog's filename field. */
  | "entered"
  /** The dialog moved or its field identity drifted — re-resolve. */
  | "changed"
  /** The dialog or field was not found at act time. */
  | "not-found"
  /** Delivery was attempted and its outcome is unknown. */
  | "failed";

/**
 * Every OS touch the controller needs, injected. The production adapter
 * (`src/api/file-dialog.ts`) binds these to `MacGuiRecovery`; tests bind
 * fakes.
 */
export type FileDialogOps = {
  /** One Accessibility+WindowServer observation of the target pid. */
  observe(): GuiAppState;
  /**
   * Press `title` inside the window at `windowIndex`, after the vehicle
   * re-verifies `expected`'s identity in-session. Mutate-class: runs
   * under whatever lease the platform requires. Returns whether the
   * press landed; throws `GuiMutationError` when the outcome is unknown.
   */
  pressButton(
    windowIndex: number,
    title: string,
    expected: GuiWindowInfo,
    expectedText?: string,
  ): boolean;
  /**
   * Filename entry into the resolved dialog — the B-IME text path
   * (spec §5 shared-state: prior state save/restore is the channel's
   * own contract). Optional: absent means this build has no text-input
   * vehicle and `enterFilename` refuses `unsupported`.
   */
  enterFilename?(request: {
    readonly windowIndex: number;
    readonly window: GuiWindowInfo;
    readonly text: string;
  }): Promise<FilenameEntryVerdict> | FilenameEntryVerdict;
};

export type FileDialogMutationOp = "confirm" | "cancel" | "enter-filename";

export type FileDialogMutationGate = (
  op: FileDialogMutationOp,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type FileDialogControllerOptions = {
  readonly pid: number;
  readonly ops: FileDialogOps;
  /**
   * The mutate-gui gate. Fail-closed: absent means every act refuses.
   * Production wires the A-SAFETY gate state; tests inject allow/deny.
   */
  readonly authorizeMutation?: FileDialogMutationGate;
  readonly now?: () => Date;
  /** Millisecond clock seam for deadline math; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Millisecond sleep seam; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type AwaitFileDialogOptions = {
  /** The localized titles the picker is expected to show. */
  readonly titles: FileDialogTitles;
  /** Bounded wait; default 15s — a picker that takes longer is reported, not waited on forever. */
  readonly timeoutMs?: number;
  /** Poll interval inside the wait; default 250ms. */
  readonly pollIntervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function framesEqual(a: GuiFrame | null | undefined, b: GuiFrame | null | undefined): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * Map a platform/transport failure onto the public codes: observation
 * failures are `unavailable`; a mutation whose outcome is unknown is
 * `indeterminate`; coded `GuiRecoveryError`s are provable non-mutations.
 */
function asFileDialogError(error: unknown, duringAct: boolean): FileDialogError {
  if (error instanceof FileDialogError) {
    return error;
  }
  if (error instanceof GuiMutationError) {
    return new FileDialogError("indeterminate", errorText(error), { cause: error });
  }
  if (error instanceof MacSessionError || error instanceof GuiRecoveryError) {
    return new FileDialogError("unavailable", errorText(error), { cause: error });
  }
  return new FileDialogError(duringAct ? "indeterminate" : "unavailable", errorText(error), {
    cause: error,
  });
}

export class FileDialogController {
  readonly #ops: FileDialogOps;
  readonly #authorizeMutation: FileDialogMutationGate | undefined;
  readonly #now: () => Date;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: FileDialogControllerOptions) {
    this.#ops = options.ops;
    this.#authorizeMutation = options.authorizeMutation;
    this.#now = options.now ?? (() => new Date());
    this.#clock = options.clock ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  #observe(): GuiAppState {
    try {
      return this.#ops.observe();
    } catch (error) {
      throw asFileDialogError(error, false);
    }
  }

  /**
   * Scan one observation for the declared file dialog. Returns the
   * resolution, or a coded refusal when a *different* blocking dialog
   * is what's on screen — the flow never interacts with a window it
   * could not classify.
   */
  #scan(
    state: GuiAppState,
    titles: FileDialogTitles,
  ): { readonly resolution: FileDialogResolution | null; readonly refusal: FileDialogError | null } {
    const matches: { index: number; window: GuiWindowInfo; confirm: readonly string[]; cancel: readonly string[] }[] = [];
    for (let i = 0; i < state.windows.length; i += 1) {
      const window = state.windows[i];
      if (window === undefined) continue;
      const match = matchFileDialog(window, titles);
      switch (match.kind) {
        case "not-a-dialog":
          continue;
        case "human-only":
          return {
            resolution: null,
            refusal: new FileDialogError(
              "refused",
              `window ${i + 1} "${window.title}" is a human-only surface ` +
                "(sign-in/licence class); the file-dialog flow refuses to interact with it",
            ),
          };
        case "unrecognized-dialog":
          return {
            resolution: null,
            refusal: new FileDialogError(
              "refused",
              `window ${i + 1} "${window.title}" is a blocking dialog whose buttons do ` +
                "not match the declared file-dialog titles; refusing rather than pressing " +
                "an unclassified modal — if this IS the picker, pass its real localized titles",
            ),
          };
        case "file-dialog":
          matches.push({
            index: i + 1,
            window,
            confirm: match.matchedConfirmTitles,
            cancel: match.matchedCancelTitles,
          });
      }
    }
    if (matches.length === 0) {
      return { resolution: null, refusal: null };
    }
    if (matches.length > 1) {
      return {
        resolution: null,
        refusal: new FileDialogError(
          "ambiguous",
          `${matches.length} windows match the file-dialog titles; refusing to guess which ` +
            "is the picker",
          {
            candidates: matches.map(
              (m) => `#${m.index} "${m.window.title}" role=${m.window.role}`,
            ),
          },
        ),
      };
    }
    const only = matches[0];
    if (only === undefined) {
      return { resolution: null, refusal: null };
    }
    return {
      resolution: {
        index: only.index,
        window: only.window,
        matchedConfirmTitles: only.confirm,
        matchedCancelTitles: only.cancel,
        observedAt: this.#now().toISOString(),
      },
      refusal: null,
    };
  }

  /**
   * Bounded wait for the declared file dialog. Observe-class: no lease,
   * no mutation, no resend. Deadline → `indeterminate`.
   */
  async awaitFileDialog(options: AwaitFileDialogOptions): Promise<FileDialogResolution> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const deadline = this.#clock() + timeoutMs;
    for (;;) {
      const state = this.#observe();
      const { resolution, refusal } = this.#scan(state, options.titles);
      if (refusal !== null) {
        throw refusal;
      }
      if (resolution !== null) {
        return resolution;
      }
      if (this.#clock() >= deadline) {
        throw new FileDialogError(
          "indeterminate",
          `no file dialog matching the declared titles appeared within ${timeoutMs}ms; ` +
            "the action that should have opened it may still be in flight — " +
            "re-observe before retrying and never resend automatically",
        );
      }
      await this.#sleep(Math.min(pollIntervalMs, Math.max(1, deadline - this.#clock())));
    }
  }

  /**
   * Re-resolve a previously returned dialog immediately before an act:
   * same listing index, same title/subrole, same frame. Anything else is
   * `stale-locator` — the dialog the caller saw is gone or moved, and
   * pressing by index alone could hit a different window.
   */
  #reresolve(resolution: FileDialogResolution): FileDialogResolution {
    const state = this.#observe();
    const window = state.windows[resolution.index - 1];
    if (window === undefined) {
      throw new FileDialogError(
        "stale-locator",
        `the dialog at listing index ${resolution.index} is gone; re-run awaitFileDialog`,
      );
    }
    const same =
      window.title === resolution.window.title &&
      window.subrole === resolution.window.subrole &&
      framesEqual(window.frame ?? null, resolution.window.frame ?? null);
    if (!same) {
      throw new FileDialogError(
        "stale-locator",
        `the window at listing index ${resolution.index} changed since resolution ` +
          `("${resolution.window.title}" → "${window.title}"); re-run awaitFileDialog`,
      );
    }
    // Attribution must still hold at act time — a census flip between
    // observe and act is exactly the #330 wrong-target case.
    const match = matchFileDialog(window, {
      confirm: resolution.matchedConfirmTitles,
      cancel: resolution.matchedCancelTitles,
    });
    if (match.kind !== "file-dialog" || !isPidAttributedWindow(window)) {
      throw new FileDialogError(
        "unproven",
        "the resolved dialog no longer proves pid attribution or file-dialog " +
          "shape at act time; refusing the press",
      );
    }
    return { ...resolution, window, observedAt: this.#now().toISOString() };
  }

  #requireMutationAllowed(op: FileDialogMutationOp): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for file-dialog operations; dialog acts are " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new FileDialogError(
        "refused",
        `file-dialog ${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Press the dialog's confirm button. Mutate-gui: gated, re-resolved
   * immediately before the press. A `false` vehicle answer means the
   * press provably did not land — reported `stale-locator`, never
   * retried here.
   */
  confirm(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): FileDialogActResult {
    this.#requireMutationAllowed("confirm");
    const current = this.#reresolve(resolution);
    const title = fileDialogButtonTitle(current, titles, "confirm");
    if (title === null) {
      throw new FileDialogError(
        "refused",
        "the resolved dialog exposes no declared confirm title at act time",
      );
    }
    let pressed: boolean;
    try {
      pressed = this.#ops.pressButton(current.index, title, current.window);
    } catch (error) {
      throw asFileDialogError(error, true);
    }
    if (!pressed) {
      throw new FileDialogError(
        "stale-locator",
        `the confirm press on "${title}" reported no click — the dialog likely ` +
          "changed between resolution and act; re-observe before retrying",
      );
    }
    return {
      action: "confirm",
      detail: `pressed "${title}"`,
      actedAt: this.#now().toISOString(),
    };
  }

  /** Press the dialog's cancel button. Same mutate-gui shape as confirm. */
  cancel(
    resolution: FileDialogResolution,
    titles: FileDialogTitles,
  ): FileDialogActResult {
    this.#requireMutationAllowed("cancel");
    const current = this.#reresolve(resolution);
    const title = fileDialogButtonTitle(current, titles, "cancel");
    if (title === null) {
      throw new FileDialogError(
        "refused",
        "the resolved dialog exposes no declared cancel title at act time",
      );
    }
    let pressed: boolean;
    try {
      pressed = this.#ops.pressButton(current.index, title, current.window);
    } catch (error) {
      throw asFileDialogError(error, true);
    }
    if (!pressed) {
      throw new FileDialogError(
        "stale-locator",
        `the cancel press on "${title}" reported no click — the dialog likely ` +
          "changed between resolution and act; re-observe before retrying",
      );
    }
    return {
      action: "cancel",
      detail: `pressed "${title}"`,
      actedAt: this.#now().toISOString(),
    };
  }

  /**
   * Enter a filename into the resolved dialog — the shared-state leg of
   * the W3 slice. Gated like every other act, and additionally requires
   * the injected text-entry channel: without one this refuses
   * `unsupported`, honestly reporting that the B-IME OS input posters
   * (#372/#373) have not landed on any platform.
   */
  async enterFilename(
    resolution: FileDialogResolution,
    text: string,
  ): Promise<FileDialogActResult> {
    this.#requireMutationAllowed("enter-filename");
    const current = this.#reresolve(resolution);
    if (this.#ops.enterFilename === undefined) {
      throw new FileDialogError(
        "unsupported",
        "filename entry needs the B-IME text-input path; no OS poster is " +
          "implemented on any platform yet (#372 macOS / #373 Windows) — " +
          "the shared-state save/restore contract exists but has no vehicle",
      );
    }
    let verdict: FilenameEntryVerdict;
    try {
      verdict = await this.#ops.enterFilename({
        windowIndex: current.index,
        window: current.window,
        text,
      });
    } catch (error) {
      throw asFileDialogError(error, true);
    }
    switch (verdict) {
      case "entered":
        return {
          action: "enter-filename",
          detail: `entered ${text.length} char(s) via the text-input channel`,
          actedAt: this.#now().toISOString(),
        };
      case "changed":
        throw new FileDialogError(
          "stale-locator",
          "the filename field's identity drifted during entry; re-resolve the dialog",
        );
      case "not-found":
        throw new FileDialogError(
          "not-found",
          "the filename field was not found in the dialog at act time",
        );
      case "failed":
        throw new FileDialogError(
          "indeterminate",
          "filename entry was attempted but the channel reported failure; " +
            "the field's contents are unknown — re-observe before retrying",
        );
      default: {
        const exhaustive: never = verdict;
        throw new FileDialogError("unavailable", `unknown entry verdict ${String(exhaustive)}`);
      }
    }
  }
}

