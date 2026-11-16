/**
 * GUI fallback: what to do when After Effects has stopped answering.
 *
 * A modal dialog that the ExtendScript API cannot reach — a plugin's own
 * window, an Adobe sign-in prompt, a crash-recovery notice — makes every
 * script call time out. The only way out is to look at the screen and click.
 *
 * Two rules make that safe, and both are enforced here rather than left to
 * the caller:
 *
 *   1. **Only the isolated session is ever touched.** Every action is
 *      executed inside the session that owns the After Effects instance
 *      being recovered (see `mac-session.ts`). When the target session
 *      cannot be entered, the recovery refuses. It never falls back to the
 *      console session, because "the desktop the agent happens to sit on" is
 *      never the right answer.
 *
 *   2. **The Accessibility API is preferred over coordinates.** A button is
 *      pressed by its accessibility identity — role, title, position — and
 *      only when the element cannot be pressed that way is a coordinate
 *      click used, with the coordinates taken from that same element's frame
 *      in the target session.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  censusForPid,
  windowServerCensus,
  type CensusRunner,
  type WindowCensus,
} from "../platform/darwin/window-census.js";
import {
  acquireGuiLease,
  auditGuiEvent,
  defaultGuiLeaseRoot,
  guiSessionKey,
  type GuiLease,
} from "../platform/darwin/gui-lease.js";
import {
  consoleSessionUid,
  MacSessionError,
  runInSession,
  type MacSession,
  type SessionCommandResult,
} from "./mac-session.js";

export type GuiButtonInfo = {
  readonly title: string;
  readonly description: string;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly size: { readonly width: number; readonly height: number } | null;
};

export type GuiWindowInfo = {
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  readonly buttons: readonly GuiButtonInfo[];
  /**
   * The static text the window shows.
   *
   * The title of an Adobe account window is often just "警告" or a product
   * name; what tells it apart from an ordinary dialog is what it says. The
   * wording is in the UI language of the session, so it is kept verbatim
   * rather than translated.
   */
  readonly texts: readonly string[];
};

export type GuiAppState = {
  readonly pid: number;
  /** Whether the process is the frontmost application of its session. */
  readonly frontmost: boolean;
  readonly windows: readonly GuiWindowInfo[];
  /**
   * What the WindowServer itself says about this pid's windows, across all
   * Spaces. The Accessibility listing above is NOT authoritative: a process
   * can own real windows while answering AX with an empty tree (observed on
   * a real host: a crash-repair dialog was on screen while AX reported
   * zero windows). When the census is unavailable this says so — it is
   * degraded observation, never "no windows".
   */
  readonly windowServer: {
    readonly available: boolean;
    readonly reason: string | null;
    /** Windows the WindowServer attributes to this pid (all Spaces). */
    readonly windowCount: number;
    readonly onScreenCount: number;
  };
  /**
   * True when AX reported zero windows but the WindowServer lists windows
   * for this pid. `windows` is then NOT evidence of a clean screen — the
   * AX tree is unserviceable and every AX-derived conclusion is suspect.
   */
  readonly axSuspect: boolean;
};

/**
 * Combine the AX listing with the WindowServer census into an honest
 * observation. Pure — the census gathering lives in `window-census.ts`.
 */
export function assessGuiObservation(
  pid: number,
  frontmost: boolean,
  windows: readonly GuiWindowInfo[],
  census: WindowCensus,
): GuiAppState {
  const mine = censusForPid(census, pid);
  return {
    pid,
    frontmost,
    windows,
    windowServer: {
      available: census.available,
      reason: census.available ? null : census.reason,
      windowCount: mine.windowCount,
      onScreenCount: mine.onScreenCount,
    },
    axSuspect: windows.length === 0 && mine.windowCount > 0,
  };
}

/** A window that keeps the application from taking scripts. */
export function isBlockingWindow(window: GuiWindowInfo): boolean {
  const role = window.role.toLowerCase();
  const subrole = window.subrole?.toLowerCase() ?? "";
  return (
    role.includes("dialog") ||
    subrole.includes("dialog") ||
    subrole.includes("sheet") ||
    subrole.includes("alert")
  );
}

/**
 * The listing the accessibility query returns.
 *
 * ```
 * FRONTMOST|1
 * W|After Effects|AXWindow|AXStandardWindow
 * T|Adobe Creative Cloud にサインインしてください
 * B|OK||640,480|80,32
 * ```
 */
export function parseUiListing(text: string): { frontmost: boolean; windows: GuiWindowInfo[] } {
  const windows: {
    title: string;
    role: string;
    subrole: string | null;
    buttons: GuiButtonInfo[];
    texts: string[];
  }[] = [];
  let frontmost = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split("|");
    if (parts[0] === "FRONTMOST") {
      frontmost = parts[1] === "1";
      continue;
    }
    if (parts[0] === "W") {
      windows.push({
        title: parts[1] ?? "",
        role: parts[2] ?? "",
        subrole: parts[3] ?? null,
        buttons: [],
        texts: [],
      });
      continue;
    }
    if (parts[0] === "T") {
      const current = windows[windows.length - 1];
      if (current === undefined) {
        continue;
      }
      current.texts.push(parts.slice(1).join("|"));
      continue;
    }
    if (parts[0] === "B") {
      const current = windows[windows.length - 1];
      if (current === undefined) {
        continue;
      }
      const position = parsePoint(parts[3]);
      const size = parseSize(parts[4]);
      current.buttons.push({
        title: parts[1] ?? "",
        description: parts[2] ?? "",
        position: position === null ? null : { x: position.x, y: position.y },
        size: size === null ? null : { width: size.width, height: size.height },
      });
    }
  }
  return { frontmost, windows };
}

/** A point the accessibility API reported, as "x,y". */
function parsePoint(text: string | undefined): { x: number; y: number } | null {
  const parts = splitNumbers(text);
  return parts === null ? null : { x: parts[0], y: parts[1] };
}

/** A size the accessibility API reported, as "width,height". */
function parseSize(text: string | undefined): { width: number; height: number } | null {
  const parts = splitNumbers(text);
  return parts === null ? null : { width: parts[0], height: parts[1] };
}

function splitNumbers(text: string | undefined): [number, number] | null {
  if (text === undefined || text.trim().length === 0) {
    return null;
  }
  const parts = text.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return [parts[0] as number, parts[1] as number];
}

/**
 * Lists the windows of a process through the Accessibility API.
 *
 * The script is written as an `on run argv` handler so the pid and the
 * button title are arguments, never source: nothing that comes from the
 * outside is spliced into AppleScript.
 *
 * Exported so a test can hand it to `osacompile`: a script that does not
 * compile fails only on a real host, at the moment a dialog needs closing.
 */
export const LIST_WINDOWS_SCRIPT = [
  "on run argv",
  "  set targetPid to (item 1 of argv) as integer",
  "  set report to \"\"",
  "  tell application \"System Events\"",
  "    set procs to (every application process whose unix id is targetPid)",
  "    if (count of procs) is 0 then",
  "      return \"MISSING\"",
  "    end if",
  "    set p to item 1 of procs",
  "    try",
  "      if (frontmost of p) is true then set report to report & \"FRONTMOST|1\" & linefeed",
  "    end try",
  "    repeat with w in windows of p",
  "      set wtitle to \"\"",
  "      try",
  "        set wtitle to (name of w) as string",
  "      end try",
  "      set wrole to \"\"",
  "      try",
  "        set wrole to (role of w) as string",
  "      end try",
  "      set wsub to \"\"",
  "      try",
  "        set wsub to (subrole of w) as string",
  "      end try",
  "      set report to report & \"W|\" & my a8nClean(wtitle) & \"|\" & wrole & \"|\" & wsub & linefeed",
  "      set wtexts to {}",
  "      try",
  "        set wtexts to static texts of w",
  "      on error",
  "        set wtexts to {}",
  "      end try",
  "      repeat with t in wtexts",
  "        set ttext to \"\"",
  "        try",
  "          set ttext to (value of t) as string",
  "        end try",
  "        if ttext is \"\" then",
  "          try",
  "            set ttext to (name of t) as string",
  "          end try",
  "        end if",
  // `my` is required: inside a `tell application …` block an unqualified
  // handler name is sent to that application as a command, and System Events
  // answers "Can't continue a8nClean (-1708)". Measured on a real host,
  // 2026-11-03, the first time the Automation grant let this script run at
  // all.
  "        if ttext is not \"\" then set report to report & \"T|\" & my a8nClean(ttext) & linefeed",
  "      end repeat",
  "      repeat with b in buttons of w",
  "        set btitle to \"\"",
  "        try",
  "          set btitle to (name of b) as string",
  "        end try",
  "        set bdesc to \"\"",
  "        try",
  "          set bdesc to (description of b) as string",
  "        end try",
  "        set bpos to \"\"",
  "        try",
  "          set bpos to ((item 1 of (get position of b)) as string) & \",\" & ((item 2 of (get position of b)) as string)",
  "        end try",
  "        set bsize to \"\"",
  "        try",
  "          set bsize to ((item 1 of (get size of b)) as string) & \",\" & ((item 2 of (get size of b)) as string)",
  "        end try",
  "        set report to report & \"B|\" & my a8nClean(btitle) & \"|\" & my a8nClean(bdesc) & \"|\" & bpos & \"|\" & bsize & linefeed",
  "      end repeat",
  "    end repeat",
  "  end tell",
  "  return report",
  "end run",
  // One line per field: the listing is line-based, so a line break inside a
  // label would split it into two records. Every label goes through this —
  // a window title or a button description as well as a static text — and the
  // `|`s are folded too, so the field layout cannot shift either.
  "on a8nClean(s)",
  "  set AppleScript's text item delimiters to {return, linefeed, \"|\"}",
  "  set parts to text items of s",
  "  set AppleScript's text item delimiters to \" \"",
  "  return parts as string",
  "end a8nClean",
];

/** Presses the button with the given title, in the process with the given pid. */
export const PRESS_BUTTON_SCRIPT = [
  "on run argv",
  "  set targetPid to (item 1 of argv) as integer",
  "  set windowIndex to (item 2 of argv) as integer",
  "  set wanted to item 3 of argv",
  "  set expectedTitle to item 4 of argv",
  "  set expectedSubrole to item 5 of argv",
  "  set expectedText to item 6 of argv",
  "  tell application \"System Events\"",
  "    set procs to (every application process whose unix id is targetPid)",
  "    if (count of procs) is 0 then return \"MISSING\"",
  "    set p to item 1 of procs",
  "    set wlist to windows of p",
  "    if windowIndex < 1 then return \"NOT_FOUND\"",
  "    if windowIndex > (count of wlist) then return \"NOT_FOUND\"",
  "    set w to item windowIndex of wlist",
  // The listing was made by a separate call, so the windows may have shifted
  // in between. Pressing by index alone would then click a different window —
  // possibly a sign-in sheet raised by the very operation that timed out.
  // The identity the caller saw is checked against the window that is there
  // now; a mismatch is a refusal, not a guess.
  "    if expectedTitle is not \"\" then",
  "      set wtitle to \"\"",
  "      try",
  "        set wtitle to (name of w) as string",
  "      end try",
  "      if wtitle is not expectedTitle then return \"CHANGED\"",
  "    end if",
  "    if expectedSubrole is not \"\" then",
  "      set wsub to \"\"",
  "      try",
  "        set wsub to (subrole of w) as string",
  "      end try",
  "      if wsub is not expectedSubrole then return \"CHANGED\"",
  "    end if",
  // The measured class has an empty title, so title and subrole alone cannot
  // tell it from another empty-title dialog in the same process. The text it
  // says is the identity the caller actually recognised, and it is checked
  // the same way: a window whose static text no longer contains it is a
  // different window, and gets no press.
  "    if expectedText is not \"\" then",
  "      set found to false",
  "      try",
  "        repeat with t in static texts of w",
  "          try",
  "            if (value of t as string) contains expectedText then set found to true",
  "          end try",
  "        end repeat",
  "      end try",
  "      if not found then return \"CHANGED\"",
  "    end if",
  "    try",
  "      repeat with b in buttons of w",
  "        set btitle to \"\"",
  "        try",
  "          set btitle to (name of b) as string",
  "        end try",
  "        if btitle is wanted then",
  "          click b",
  "          return \"CLICKED\"",
  "        end if",
  "      end repeat",
  "    end try",
  "  end tell",
  "  return \"NOT_FOUND\"",
  "end run",
];

/** Clicks at a point of the target session's screen. */
export const CLICK_AT_SCRIPT = [
  "on run argv",
  "  set x to (item 1 of argv) as integer",
  "  set y to (item 2 of argv) as integer",
  "  tell application \"System Events\" to click at {x, y}",
  "  return \"CLICKED\"",
  "end run",
];

/**
 * The lease + audit surface `MacGuiRecovery` uses. The default is the
 * file-based lease under the ae-a8n state root; tests inject a fake so no
 * real lease file or audit line is needed.
 */
export type GuiLeaseController = {
  /**
   * Take the mutation lease or throw `GuiRecoveryError` naming the holder.
   * The returned lease must be released exactly once by the caller.
   */
  acquire(op: string): GuiLease;
  /** Append an audit record. Throws when the record cannot be written. */
  audit(event: {
    readonly kind: "observe" | "mutate" | "lease-release";
    readonly op?: string;
    readonly detail?: string;
    readonly outcome?: string;
  }): void;
};

export type GuiRecoveryOptions = {
  /** The session the After Effects instance lives in. Nothing else is ever touched. */
  readonly session: MacSession;
  /** The pid of the After Effects instance to recover. */
  readonly pid: number;
  /** Where screenshots are written. Mainly a test seam. */
  readonly screenshotDir?: string;
  /**
   * Allow the recovery to act in the console session.
   *
   * Off by default: the console session is the screen the human is looking
   * at, and a recovery that clicks there takes their cursor and their focus.
   * A caller that owns that screen can say so explicitly.
   */
  readonly allowConsoleSession?: boolean;
  /**
   * WindowServer census seam. Production runs the CLT-python probe inside
   * the target session; tests inject a stub. A census that cannot run is
   * reported as unavailable — never treated as "no windows".
   */
  readonly census?: () => WindowCensus;
  /** Census exec seam (program, args) → stdout; mainly a test seam. */
  readonly censusRun?: CensusRunner;
  /**
   * Where the GUI lease files and the audit log live. Defaults to
   * `~/.ae-a8n`, the same state root the runner uses, so every cooperating
   * ae-a8n consumer shares one lease per GUI session.
   */
  readonly stateRoot?: string;
  /** Identity written into lease records and audit lines. */
  readonly ownerId?: string;
  /** Lease/audit seam — mainly a test seam. */
  readonly lease?: GuiLeaseController;
  /**
   * Session-command seam — mainly a test seam. Production runs
   * `runInSession`; tests inject a stub so mutation error paths can be
   * exercised without a real GUI session.
   */
  readonly runSession?: typeof runInSession;
};

export class GuiRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuiRecoveryError";
  }
}

/**
 * A GUI mutation was attempted and its outcome is unknown.
 *
 * Distinct from `GuiRecoveryError`, which is thrown *before* anything reaches
 * the screen (lease refusal, session entry failure, bad arguments). This
 * error means the press or click may already have happened — the caller must
 * not report "nothing was done" and must not retry blindly; the screen state
 * has to be re-observed first.
 */
export class GuiMutationError extends Error {
  /** Always true: thrown only after the mutation step was entered. */
  readonly mutationAttempted = true;
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "GuiMutationError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * The GUI fallback for one After Effects instance.
 *
 * Every method runs inside the instance's own session. When the session
 * cannot be entered the method refuses; there is no path from here to the
 * console desktop.
 */
export class MacGuiRecovery {
  readonly #session: MacSession;
  readonly #pid: number;
  readonly #screenshotDir: string | undefined;
  readonly #census: (() => WindowCensus) | undefined;
  readonly #lease: GuiLeaseController;
  readonly #runSession: typeof runInSession;

  constructor(options: GuiRecoveryOptions) {
    if (options.session.kind !== "Aqua") {
      throw new GuiRecoveryError(
        `the recovery target has no Aqua session (uid ${options.session.uid}, session kind ${options.session.kind}); ` +
          "there is no screen to recover. No GUI action was taken.",
      );
    }
    if (options.allowConsoleSession !== true) {
      const consoleUid = consoleSessionUid();
      // A console owner that cannot be read must not be read as "not the
      // console": -1 never equals a real uid, so the check below would pass
      // and the recovery would act on the screen the human is looking at.
      if (consoleUid < 0) {
        throw new GuiRecoveryError(
          "the console session could not be identified (the owner of /dev/console could not be read), so it " +
            "cannot be shown that this recovery would not reach the screen the user is looking at. " +
            "No GUI action was taken.",
        );
      }
      if (consoleUid === options.session.uid) {
        throw new GuiRecoveryError(
          `the target session (uid ${options.session.uid}) is the console session, the screen the user is looking ` +
            "at. Recovering there would move their cursor and take their focus, so no GUI action was taken. " +
            "Recover in an isolated session instead.",
        );
      }
    }
    this.#session = options.session;
    this.#pid = options.pid;
    this.#screenshotDir = options.screenshotDir;
    this.#census = options.census ?? this.#defaultCensus(options.censusRun);
    this.#lease =
      options.lease ??
      defaultLeaseController({
        stateRoot: options.stateRoot ?? defaultGuiLeaseRoot(),
        session: options.session,
        ownerId: options.ownerId ?? "ae-a8n",
      });
    this.#runSession = options.runSession ?? runInSession;
  }

  /**
   * The WindowServer census, run inside the target session — the same
   * scoping rule as every other GUI action here. A missing interpreter or
   * a failed probe degrades to `available: false`, not to "no windows".
   */
  #defaultCensus(censusRun: CensusRunner | undefined): () => WindowCensus {
    return () =>
      windowServerCensus(
        censusRun ??
          censusRunnerInSession(this.#session, (s, program, args, opts) =>
            this.#runSession(s, program, args, opts),
          ),
      );
  }

  get session(): MacSession {
    return this.#session;
  }

  get pid(): number {
    return this.#pid;
  }

  /**
   * Read-only observation is audited but never leased: listing windows and
   * taking a screenshot cannot disturb the screen, and requiring the lease
   * for them would let a stuck lease blind the observer too.
   */
  #observe(op: string): void {
    this.#lease.audit({ kind: "observe", op });
  }

  /**
   * A GUI mutation runs under the session's single-owner lease and is
   * audited around the action.
   *
   * Error boundary, deliberately narrow:
   *
   *   - `this.#lease.acquire(op)` throws before `fn` runs — nothing reached
   *     the screen, and the error is the plain refusal.
   *   - A `MacSessionError` from `fn` means the target session was never
   *     entered, so nothing was pressed or clicked either.
   *   - Any other `fn` error becomes `GuiMutationError`: the action may have
   *     partially reached the screen, so "nothing was done" would be a lie
   *     and a retry could double-apply it.
   */
  #mutate<T>(op: string, fn: () => T): T {
    const lease = this.#lease.acquire(op);
    try {
      let result: T;
      try {
        result = fn();
      } catch (error) {
        if (error instanceof MacSessionError) {
          // The session was never entered: provably nothing was mutated.
          try {
            this.#lease.audit({
              kind: "mutate",
              op,
              outcome: "not-performed",
              detail: error.message,
            });
          } catch {
            // The original failure is the evidence that matters.
          }
          throw error;
        }
        try {
          this.#lease.audit({
            kind: "mutate",
            op,
            outcome: "unknown",
            detail: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The original failure is the evidence that matters.
        }
        throw new GuiMutationError(
          `the ${op} mutation was attempted but its result is unknown: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "The screen must be re-observed before any retry.",
          { cause: error },
        );
      }
      try {
        this.#lease.audit({
          kind: "mutate",
          op,
          outcome: result === false ? "not-performed" : "performed",
        });
      } catch {
        // The action already happened; an audit failure cannot undo it and
        // must not masquerade as a mutation failure.
      }
      return result;
    } finally {
      let released = true;
      try {
        lease.release();
      } catch (error) {
        released = false;
        try {
          this.#lease.audit({
            kind: "lease-release",
            op,
            outcome: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Nothing left to report to.
        }
      }
      if (released) {
        try {
          this.#lease.audit({ kind: "lease-release", op });
        } catch {
          // A failed release audit must not replace the operation's outcome.
        }
      }
    }
  }

  /** The windows of the After Effects instance, as the Accessibility API sees them. */
  listWindows(): GuiAppState {
    this.#observe("listWindows");
    const result = this.#osascript(LIST_WINDOWS_SCRIPT, [String(this.#pid)]);
    if (result.stdout.trim() === "MISSING") {
      throw new GuiRecoveryError(
        `the After Effects process ${this.#pid} is not visible to the Accessibility API of ` +
          `${this.#session.username}'s session; it may have exited.`,
      );
    }
    const parsed = parseUiListing(result.stdout);
    let census: WindowCensus;
    try {
      census = this.#census !== undefined ? this.#census() : { available: false, reason: "no census configured" };
    } catch (error) {
      census = {
        available: false,
        reason: `window census failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return assessGuiObservation(this.#pid, parsed.frontmost, parsed.windows, census);
  }

  /** The windows that keep the application from taking a script. */
  blockingWindows(): GuiWindowInfo[] {
    return this.listWindows().windows.filter(isBlockingWindow);
  }

  /**
   * A screenshot of the target session, as evidence of what the screen held.
   *
   * The capture happens inside the target session, so the file holds that
   * session's screen, not the console user's.
   */
  capture(path: string): string {
    this.#observe("capture");
    if (this.#screenshotDir !== undefined) {
      mkdirSync(this.#screenshotDir, { recursive: true });
    }
    mkdirSync(dirname(path), { recursive: true });
    const result = runInSession(this.#session, "/usr/sbin/screencapture", ["-x", "-o", path], {
      timeoutMs: 30_000,
    });
    if (result.status !== 0) {
      throw new GuiRecoveryError(
        `could not capture the screen of ${this.#session.username}'s session: ${result.stderr.trim()}`,
      );
    }
    return path;
  }

  /**
   * Presses a button **in one window**, identified by its 1-based position in
   * the listing the Accessibility API returned.
   *
   * The window matters. Scanning every window of the process would press the
   * first matching button wherever it is — including a sign-in or licence
   * sheet the caller was explicitly told not to touch. The caller decides
   * which window is safe; this method only acts inside it.
   *
   * When `expected` is given, the window found at that position must still be
   * the one the caller saw: the listing and the press are two calls, and a
   * window that appeared in between would otherwise receive the press.
   */
  pressButton(
    windowIndex: number,
    title: string,
    expected?: GuiWindowInfo,
    /**
     * A static text the chosen window must still contain before anything is
     * pressed. The measured dialog class has an empty title, so this is the
     * only identity that distinguishes it from another empty-title window
     * raised in between the listing and the press.
     */
    expectedText = "",
  ): boolean {
    return this.#mutate("pressButton", () =>
      this.#pressButton(windowIndex, title, expected, expectedText),
    );
  }

  #pressButton(
    windowIndex: number,
    title: string,
    expected?: GuiWindowInfo,
    expectedText = "",
  ): boolean {
    const result = this.#osascript(PRESS_BUTTON_SCRIPT, [
      String(this.#pid),
      String(windowIndex),
      title,
      expected?.title ?? "",
      expected?.subrole ?? "",
      expectedText,
    ]);
    return result.stdout.trim() === "CLICKED";
  }

  /**
   * Clicks at a point of the target session's screen.
   *
   * The coordinates must come from the target session — an accessibility
   * frame read in that session, or a screenshot of it. Coordinates taken
   * from the physical display of another session are meaningless here.
   */
  clickAt(x: number, y: number): boolean {
    return this.#mutate("clickAt", () => this.#clickAt(x, y));
  }

  #clickAt(x: number, y: number): boolean {
    const result = this.#osascript(CLICK_AT_SCRIPT, [String(Math.round(x)), String(Math.round(y))]);
    return result.stdout.trim() === "CLICKED";
  }

  /**
   * Clicks a button in one window, by accessibility identity first and by
   * coordinates only when the element cannot be pressed directly.
   *
   * `windowIndex` is the same 1-based position `listWindows()` returned. The
   * coordinate fallback is taken from that window's own listing, never from a
   * different window and never from the physical display.
   */
  pressButtonIn(
    windowIndex: number,
    buttonTitle: string,
    expected?: GuiWindowInfo,
    expectedText = "",
  ): boolean {
    // The press and its coordinate fallback are one mutation: the lease is
    // held across the whole sequence so no other mutator can act between
    // the accessibility press failing and the click landing.
    return this.#mutate("pressButtonIn", () => {
      if (this.#pressButton(windowIndex, buttonTitle, expected, expectedText)) {
        return true;
      }
      const state = this.listWindows();
      const window = state.windows[windowIndex - 1];
      if (window === undefined) {
        return false;
      }
      if (expected !== undefined && (window.title !== expected.title || window.subrole !== expected.subrole)) {
        // The window at that position is no longer the one the caller chose.
        return false;
      }
      if (expectedText !== "" && !window.texts.some((text) => text.includes(expectedText))) {
        // Nor is the window saying what it said when it was chosen.
        return false;
      }
      for (const button of window.buttons) {
        if (button.title !== buttonTitle || button.position === null || button.size === null) {
          continue;
        }
        return this.#clickAt(
          button.position.x + button.size.width / 2,
          button.position.y + button.size.height / 2,
        );
      }
      return false;
    });
  }

  /**
   * Runs an AppleScript in the target session.
   *
   * The arguments are passed to the script as `argv`, never spliced into its
   * source: nothing that comes from the outside becomes AppleScript.
   */
  #osascript(script: readonly string[], args: readonly string[]): SessionCommandResult {
    const result = this.#runSession(
      this.#session,
      "/usr/bin/osascript",
      [...script.flatMap((line) => ["-e", line]), ...args],
      { timeoutMs: 60_000 },
    );
    if (result.status !== 0) {
      throw new GuiRecoveryError(
        `the accessibility query in ${this.#session.username}'s session failed: ${result.stderr.trim()}`,
      );
    }
    return result;
  }
}

/**
 * The production lease controller: the file lease under `stateRoot`, with
 * every acquisition, refusal and release written to the shared audit log.
 */
export function defaultLeaseController(options: {
  readonly stateRoot: string;
  readonly session: MacSession;
  readonly ownerId: string;
}): GuiLeaseController {
  const sessionKey = guiSessionKey(options.session);
  const pid = process.pid;
  return {
    acquire(op) {
      const outcome = acquireGuiLease({
        stateRoot: options.stateRoot,
        session: options.session,
        owner: { id: options.ownerId, pid },
        purpose: `gui:${op}`,
      });
      if (!outcome.ok) {
        try {
          auditGuiEvent(options.stateRoot, {
            kind: "lease-refuse",
            sessionKey,
            ownerId: options.ownerId,
            pid,
            op,
            detail: outcome.detail,
            outcome: outcome.reason,
          });
        } catch {
          // The refusal itself is the evidence; a failed audit line must not
          // turn a refusal into an acquisition.
        }
        throw new GuiRecoveryError(`GUI mutation refused: ${outcome.detail}`);
      }
      // The lease file exists at this point; if recording the acquisition
      // fails, an unaudited mutation must not proceed — release the lease
      // and refuse, leaving nothing held and nothing pressed.
      try {
        auditGuiEvent(options.stateRoot, {
          kind: "lease-acquire",
          sessionKey,
          ownerId: options.ownerId,
          pid,
          op,
        });
      } catch (auditError) {
        outcome.lease.release();
        throw new GuiRecoveryError(
          `GUI mutation refused: the lease was acquired but its audit record could not be ` +
            `written (${auditError instanceof Error ? auditError.message : String(auditError)}); ` +
            "the lease was released and nothing was pressed or clicked",
        );
      }
      return outcome.lease;
    },
    audit(event) {
      auditGuiEvent(options.stateRoot, {
        kind: event.kind,
        sessionKey,
        ownerId: options.ownerId,
        pid,
        ...(event.op === undefined ? {} : { op: event.op }),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      });
    },
  };
}

/**
 * A `CensusRunner` bound to one GUI session: the census probe executes
 * inside that session via `runInSession`, so the window list it returns is
 * the session's own WindowServer view — never the caller's desktop by
 * accident. Exported for exit/crash verification paths that need the same
 * session scoping `MacGuiRecovery` applies internally.
 */
export function censusRunnerInSession(
  session: MacSession,
  runSession: typeof runInSession = runInSession,
): CensusRunner {
  return (program, args) => {
    const result = runSession(session, program, [...args], { timeoutMs: 30_000 });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `exit status ${result.status}`);
    }
    return result.stdout;
  };
}

/** Whether a screenshot file was written and is not empty. Mainly a test seam. */
export function screenshotLooksReal(path: string): boolean {
  try {
    const stat = execFileSync("stat", ["-f", "%z", path], { encoding: "utf-8" });
    return Number(stat.trim()) > 0;
  } catch {
    return false;
  }
}

export { MacSessionError };
