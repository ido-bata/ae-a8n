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
import { dirname, join } from "node:path";

import {
  censusForPid,
  windowServerCensus,
  type CensusRunner,
  type WindowCensus,
  type WindowServerWindow,
} from "../platform/darwin/window-census.js";
import { errorMessage } from "../errors.js";
import {
  acquireGuiLease,
  auditGuiEvent,
  defaultGuiLeaseRoot,
  guiSessionKey,
  type GuiLease,
  type GuiLeaseSession,
} from "../platform/darwin/gui-lease.js";
import {
  consoleSessionUid,
  MacSessionError,
  readGuiSession,
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
  /**
   * The measured "this window blocks the host" verdict, when the producer
   * already has one — the Windows census evidence
   * (`WindowsGuiWindow.blocking`). Absent on macOS, where
   * `isBlockingWindow` derives the answer from the AX role words. An
   * explicit verdict always wins: it is the caller's measured answer, the
   * same contract `DialogWindow.blocking` carries in the platform-neutral
   * recovery policy.
   */
  readonly blocking?: boolean;
  /**
   * The window's frame in global screen coordinates (points, top-left
   * origin), when the Accessibility API reported one. The WindowServer
   * census reports the same space, so frames are how an AX window is
   * matched to the census window it accounts for (#321). Absent when the
   * attribute could not be read — such a window can never "account for"
   * a census window.
   */
  readonly frame?: GuiFrame | null;
  /**
   * The pid attribution the WindowServer census gave this AX window
   * (#330). Present only when the census ran:
   *
   *   - `"owned"` — the window's frame matches a census window the
   *     WindowServer attributes to the target pid. The only attribution
   *     that makes the window usable as blocking or mutation evidence.
   *   - `"foreign"` — the frame matches census windows, but only of OTHER
   *     pids. This is the bundle-confused listing of issue #330: two AE
   *     versions share `com.adobe.AfterEffects.application`, and System
   *     Events can answer `windows of process` with the other instance's
   *     windows. Foreign windows are never evidence about this pid.
   *   - `"unmatched"` — no census window of any pid has this frame (a
   *     frameless window, an AX phantom, or timing skew between the two
   *     session commands), or census windows of MORE THAN ONE pid share
   *     it — an ambiguity no frame comparison can resolve (#332).
   *     Unproven, so not evidence either.
   *
   * Absent when the census was unavailable: attribution is then
   * unproven, which the press path refuses on — see `pressButtonIn`.
   */
  readonly censusAttribution?: AxWindowAttribution;
};

/**
 * The WindowServer census's verdict on who an AX-listed window belongs
 * to (#330). See `GuiWindowInfo.censusAttribution`.
 */
export type AxWindowAttribution = "owned" | "foreign" | "unmatched";

/**
 * Whether an AX window may be used as blocking or mutation evidence.
 *
 * `undefined` attribution — the census could not run — keeps the legacy
 * trust level: there is no positive evidence of foreignness, and the
 * unavailable census is already reported as degraded observation. A
 * defined attribution must be `"owned"`: `"foreign"` and `"unmatched"`
 * are excluded, never silently trusted.
 */
export function isPidAttributedWindow(window: GuiWindowInfo): boolean {
  return (
    window.censusAttribution !== "foreign" &&
    window.censusAttribution !== "unmatched"
  );
}

/** A rectangle in global screen coordinates (points, top-left origin). */
export type GuiFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
   * True when AX reported zero windows attributable to this pid but the
   * WindowServer lists windows for it — either an empty listing, or one
   * whose every window the census attributes to other pids or to nothing
   * (#330). `windows` is then NOT evidence of a clean screen — the AX
   * tree is unserviceable or untrusted and every AX-derived conclusion
   * is suspect.
   */
  readonly axSuspect: boolean;
  /**
   * Why `axSuspect` fired, in one sentence — which of the two shapes
   * was measured (empty AX listing vs. a wholly foreign/unmatched
   * listing) and what the WindowServer census counted. `null` whenever
   * `axSuspect` is false. After Effects 2026/2027 is the canonical
   * empty-listing case (#406): the app vends no AX windows at all, so
   * `windows` is empty while the census lists real windows — the
   * reason names that possibility so callers do not read it as a
   * transient glitch.
   */
  readonly axSuspectReason: string | null;
  /**
   * On-screen WindowServer windows for this pid that no Accessibility
   * window accounts for (#321). AX can list the ordinary project windows
   * while a modal dialog stays completely invisible — AE 2027 `ui.alert`
   * measured 2026-11-23: census showed a 410x342 layer-8 window while the
   * AX tree held only the main window. These are the census entries whose
   * frame no AX window's `frame` matches; each is a surface the screen
   * shows that AX-derived conclusions cannot see. Empty when the census
   * is unavailable (already degraded) or every on-screen window is
   * accounted for.
   *
   * This is the blocking-evidence subset: `onScreen` is required because
   * only what the visible screen shows can block the host right now.
   * The superset — the same unaccounted rows regardless of `onScreen` —
   * is `axUnaccountedCensusWindows` below.
   */
  readonly axUnaccountedWindows: readonly WindowServerWindow[];
  /**
   * WindowServer census windows attributed to this pid that no
   * Accessibility window accounts for, on ANY Space and whether on-screen
   * or not (#451). `axUnaccountedWindows` is the on-screen subset used
   * for blocking evidence; this field is degraded observation only —
   * each row is a surface AX cannot see, honestly labelled "possibly
   * parked/offscreen — not proven blocking". It exists because an
   * AX-invisible modal can be parked (`onScreen: false`, layer 0) and
   * still be the thing that stopped the host answering: measured on the
   * AE 2027 BirthPrefs modal (pid 18577, issue #451), where the census
   * showed the modal off-screen while AX reported zero windows. Rows
   * carry `windowNumber` so a read-only `captureWindowById` can still
   * image them. Empty when the census is unavailable or every census
   * window is accounted for. This field NEVER feeds a blocking verdict.
   */
  readonly axUnaccountedCensusWindows: readonly WindowServerWindow[];
  /**
   * AX-listed windows the census attributes to OTHER pids (#330): the
   * bundle-confused listing of issue #330, where `windows of process`
   * answers with another same-bundle-id instance's windows. Excluded from
   * blocking and mutation evidence by `isPidAttributedWindow`.
   */
  readonly axForeignWindowCount: number;
  /**
   * AX-listed windows no census window of any pid accounts for (#330):
   * frameless windows, AX phantoms, or timing skew between the listing
   * and the census commands. Also excluded from blocking and mutation
   * evidence — unproven is not owned.
   */
  readonly axUnmatchedWindowCount: number;
};

/**
 * How far an AX frame may sit from its WindowServer census bounds and still
 * be the same window. Measured on AE 2027 (2026-11-23, #321): AX reports
 * {0,39,1710,1073} where the census reports {0,38,1710,1074} — a 1px
 * rounding difference. The AX listing and the census are two separate
 * session commands, so a window mid-drag or mid-resize can skew further;
 * four points is generous for rounding and still far tighter than the
 * distance between two distinct windows.
 */
export const AX_FRAME_MATCH_TOLERANCE = 4;

/** Whether an AX-reported frame and census bounds name the same window. */
export function framesMatch(ax: GuiFrame, ws: GuiFrame): boolean {
  return (
    Math.abs(ax.x - ws.x) <= AX_FRAME_MATCH_TOLERANCE &&
    Math.abs(ax.y - ws.y) <= AX_FRAME_MATCH_TOLERANCE &&
    Math.abs(ax.width - ws.width) <= AX_FRAME_MATCH_TOLERANCE &&
    Math.abs(ax.height - ws.height) <= AX_FRAME_MATCH_TOLERANCE
  );
}

/**
 * Whether one census window is a surface no AX window accounts for,
 * regardless of `onScreen`. Only rows with real bounds count: a census
 * row without geometry cannot be matched or captured, so it is skipped
 * rather than guessed at. Parked, off-Space and minimized windows ARE
 * admitted here on purpose — they are degraded evidence (#451), never
 * proof of a blocker: a healthy AE owns several while AX shows only the
 * visible window (measured 2026-11-23, #321).
 */
function isAxUnaccountedCensusWindow(
  ws: WindowServerWindow,
  pid: number,
  windows: readonly GuiWindowInfo[],
): boolean {
  if (ws.pid !== pid) {
    return false;
  }
  const bounds = ws.bounds;
  if (bounds === null || bounds.width <= 0 || bounds.height <= 0) {
    return false;
  }
  return !windows.some(
    (ax) => ax.frame != null && framesMatch(ax.frame, bounds),
  );
}

/**
 * Whether one census window is an on-screen surface no AX window accounts
 * for. On-screen is the blocking-evidence bar (#321); the off-screen rows
 * the same predicate admits are `axUnaccountedCensusWindows`' degraded
 * evidence instead (#451).
 */
function isAxUnaccountedWindow(
  ws: WindowServerWindow,
  pid: number,
  windows: readonly GuiWindowInfo[],
): boolean {
  return ws.onScreen && isAxUnaccountedCensusWindow(ws, pid, windows);
}

/**
 * Attribute one AX-listed window to a pid via the WindowServer census
 * (#330).
 *
 * The AX listing is not pid-accurate on multi-install hosts: two AE
 * versions share `CFBundleIdentifier`, and System Events can answer
 * `windows of process` with the OTHER instance's windows (issue #330,
 * verified on a real host). The census is pid-accurate, so an AX
 * window's frame is the evidence: a frame that matches census windows
 * of the target pid — and of no other pid — is `"owned"`; one that
 * matches only census windows of other pids is `"foreign"`; anything
 * else is `"unmatched"`.
 *
 * A frame matched by census windows of MORE THAN ONE pid is ambiguous:
 * two instances can hold same-geometry dialogs, and no frame comparison
 * can separate them. It is `"unmatched"`, never `"owned"` — the press
 * path refuses what it cannot prove (#332).
 *
 * Returns `undefined` when the census is unavailable: nothing can be
 * proven either way, and callers keep the legacy trust level while the
 * unavailable census is already reported as degraded.
 */
function attributeAxWindow(
  window: GuiWindowInfo,
  pid: number,
  census: WindowCensus,
): AxWindowAttribution | undefined {
  if (!census.available) {
    return undefined;
  }
  const frame = window.frame;
  if (frame == null) {
    return "unmatched";
  }
  const matches = (ws: WindowServerWindow): boolean =>
    ws.bounds !== null && framesMatch(frame, ws.bounds);
  const ownedMatch = census.windows.some((ws) => ws.pid === pid && matches(ws));
  const foreignMatch = census.windows.some((ws) => ws.pid !== pid && matches(ws));
  // `"owned"` requires the frame to single out this pid: a match shared
  // with another pid's census window is ambiguous, and ambiguous is
  // unproven — the same refusal `"unmatched"` already carries (#332).
  if (ownedMatch !== foreignMatch) {
    return ownedMatch ? "owned" : "foreign";
  }
  return "unmatched";
}

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
  const axUnaccountedCensusWindows = census.available
    ? census.windows.filter((ws) => isAxUnaccountedCensusWindow(ws, pid, windows))
    : [];
  const axUnaccountedWindows = census.available
    ? census.windows.filter((ws) => isAxUnaccountedWindow(ws, pid, windows))
    : [];
  // Attribute every AX window before anyone trusts it (#330). The raw
  // listing order is preserved — `windows`-class indices still address
  // PRESS_BUTTON_SCRIPT's `windows of p` — but each entry now carries
  // the census's verdict on whose window it really is.
  const observed = windows.map((window) => {
    const attribution = attributeAxWindow(window, pid, census);
    return attribution === undefined
      ? window
      : { ...window, censusAttribution: attribution };
  });
  const axSuspect =
    mine.windowCount > 0 &&
    observed.every((window) => window.censusAttribution !== "owned");
  return {
    pid,
    frontmost,
    windows: observed,
    windowServer: {
      available: census.available,
      reason: census.available ? null : census.reason,
      windowCount: mine.windowCount,
      onScreenCount: mine.onScreenCount,
    },
    // AX-empty is suspect; so is an AX listing whose every window belongs
    // to somebody else or to nothing — the pid's real windows are then
    // AX-invisible, the same unobservable-surface evidence one listing at
    // a time (#330). With the census unavailable `windowCount` is 0 and
    // this stays false exactly as before.
    axSuspect,
    axSuspectReason: axSuspect
      ? observed.length === 0
        ? `the AX window listing is empty while the WindowServer census ` +
          `lists ${mine.windowCount} window(s) for pid ${pid} — the app ` +
          "may not vend AX windows at all (After Effects, #406) or the " +
          "listing is untrusted; only AXFocusedWindow is reachable"
        : `all ${observed.length} AX-listed window(s) are attributed to ` +
          `other pids or to nothing while the census lists ` +
          `${mine.windowCount} window(s) for pid ${pid} — the pid's real ` +
          "windows are AX-invisible (#330)"
      : null,
    axUnaccountedWindows,
    axUnaccountedCensusWindows,
    axForeignWindowCount: observed.filter(
      (window) => window.censusAttribution === "foreign",
    ).length,
    axUnmatchedWindowCount: observed.filter(
      (window) => window.censusAttribution === "unmatched",
    ).length,
  };
}

/** A window that keeps the application from taking scripts. */
export function isBlockingWindow(window: GuiWindowInfo): boolean {
  // An explicit verdict is the producer's measured answer (the Windows
  // census); only when it is absent does the AX role heuristic decide.
  // Without this, a Windows `#32770` dialog — whose role carries a Win32
  // class name, not an AX role — would never read as blocking.
  if (window.blocking !== undefined) {
    return window.blocking;
  }
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
 * G|0,39|1710,1073
 * T|Adobe Creative Cloud にサインインしてください
 * B|OK||640,480|80,32
 * ```
 *
 * `G` carries the window frame (`x,y|w,h`) for census reconciliation; it
 * is optional — older listings and windows whose geometry cannot be read
 * simply have none.
 */
export function parseUiListing(text: string): { frontmost: boolean; windows: GuiWindowInfo[] } {
  const windows: {
    title: string;
    role: string;
    subrole: string | null;
    buttons: GuiButtonInfo[];
    texts: string[];
    frame?: GuiFrame;
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
    // `G|x,y|w,h` — the window frame, emitted right after its `W` record so
    // it attaches to that window. It is what lets the WindowServer census
    // be reconciled against the AX listing (#321); a malformed or missing
    // geometry line leaves the window without a frame, which only means it
    // cannot account for a census window — never a wrong match.
    if (parts[0] === "G") {
      const current = windows[windows.length - 1];
      if (current === undefined) {
        continue;
      }
      const position = parsePoint(parts[1]);
      const size = parseSize(parts[2]);
      if (position !== null && size !== null) {
        current.frame = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
        };
      }
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
  // The window's frame, so the listing can be reconciled against the
  // WindowServer census: an on-screen WS window no AX window accounts for
  // is evidence of an AX-invisible surface (AE 2027 modal dialogs, issue
  // #321). Emitted as `G|x,y|w,h` right after its `W` record; a window
  // whose geometry cannot be read simply has no `G` line.
  "      set wpos to \"\"",
  "      set wsize to \"\"",
  "      try",
  "        set wpos to ((item 1 of (get position of w)) as string) & \",\" & ((item 2 of (get position of w)) as string)",
  "        set wsize to ((item 1 of (get size of w)) as string) & \",\" & ((item 2 of (get size of w)) as string)",
  "      end try",
  "      if wpos is not \"\" and wsize is not \"\" then set report to report & \"G|\" & wpos & \"|\" & wsize & linefeed",
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
  // After Effects does not vend its windows through the `windows` class or
  // the AXWindows attribute — measured on AE 2026 (2026-11-23, issue #304):
  // a healthy instance reports AXWindows=0 while WindowServer census sees
  // every window, and its real windows appear as `UI elements` of role
  // AXLayoutArea (subrole AXFloatingWindow). Without this second listing a
  // healthy AE always looks AX-unobservable and supervision can never reach
  // `running`. Window-like UI elements are appended AFTER the `windows`
  // records so PRESS_BUTTON_SCRIPT's 1-based `windows`-class index is
  // unchanged for the dialog classes it can press.
  "    repeat with e in UI elements of p",
  "      set erole to \"\"",
  "      try",
  "        set erole to (role of e) as string",
  "      end try",
  // AXWindow is deliberately absent: it is what the `windows` class already
  // returns, and AE vends its modal dialog through both paths — listing it
  // here too would report every dialog twice (measured 2026-11-23, #304).
  "      if erole is \"AXLayoutArea\" or erole is \"AXSheet\" or erole is \"AXDialog\" or erole is \"AXSystemDialog\" then",
  "        set etitle to \"\"",
  "        try",
  "          set etitle to (name of e) as string",
  "        end try",
  "        set esub to \"\"",
  "        try",
  "          set esub to (subrole of e) as string",
  "        end try",
  "        set report to report & \"W|\" & my a8nClean(etitle) & \"|\" & erole & \"|\" & esub & linefeed",
  // Same `G|x,y|w,h` geometry record as the `windows` loop above: AE vends
  // its real windows as AXLayoutArea UI elements, so this is the path that
  // matters for census reconciliation on AE (#321).
  "        set epos to \"\"",
  "        set esize to \"\"",
  "        try",
  "          set epos to ((item 1 of (get position of e)) as string) & \",\" & ((item 2 of (get position of e)) as string)",
  "          set esize to ((item 1 of (get size of e)) as string) & \",\" & ((item 2 of (get size of e)) as string)",
  "        end try",
  "        if epos is not \"\" and esize is not \"\" then set report to report & \"G|\" & epos & \"|\" & esize & linefeed",
  // Only dialog-shaped UI elements get their children walked: an
  // AXLayoutArea's full subtree is the whole application UI and would make
  // the listing enormous. Dialog content still arrives through the
  // `windows` class whenever AX exposes it (observed for AXDialog).
  "        if erole is \"AXSheet\" or erole is \"AXDialog\" or erole is \"AXSystemDialog\" or esub contains \"Dialog\" or esub contains \"Sheet\" or esub contains \"Alert\" then",
  "          set etexts to {}",
  "          try",
  "            set etexts to static texts of e",
  "          on error",
  "            set etexts to {}",
  "          end try",
  "          repeat with t in etexts",
  "            set ttext to \"\"",
  "            try",
  "              set ttext to (value of t) as string",
  "            end try",
  "            if ttext is \"\" then",
  "              try",
  "                set ttext to (name of t) as string",
  "              end try",
  "            end if",
  "            if ttext is not \"\" then set report to report & \"T|\" & my a8nClean(ttext) & linefeed",
  "          end repeat",
  "          repeat with b in buttons of e",
  "            set btitle to \"\"",
  "            try",
  "              set btitle to (name of b) as string",
  "            end try",
  "            set bdesc to \"\"",
  "            try",
  "              set bdesc to (description of b) as string",
  "            end try",
  "            set bpos to \"\"",
  "            try",
  "              set bpos to ((item 1 of (get position of b)) as string) & \",\" & ((item 2 of (get position of b)) as string)",
  "            end try",
  "            set bsize to \"\"",
  "            try",
  "              set bsize to ((item 1 of (get size of b)) as string) & \",\" & ((item 2 of (get size of b)) as string)",
  "            end try",
  "            set report to report & \"B|\" & my a8nClean(btitle) & \"|\" & my a8nClean(bdesc) & \"|\" & bpos & \"|\" & bsize & linefeed",
  "          end repeat",
  "        end if",
  "      end if",
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
  "  set expectedFrame to item 7 of argv",
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
  // The last identity check is geometry (#330). On multi-install hosts the
  // AX listing itself can be bundle-confused — `windows of process` may
  // enumerate ANOTHER same-bundle-id instance's windows, so title, subrole
  // and text can all describe a foreign dialog. The caller passes the frame
  // of the window the census attributed to the target pid; the window found
  // at the index must still occupy that frame before anything is pressed.
  // A mismatch is a refusal ("CHANGED"), never a click.
  "    if expectedFrame is not \"\" then",
  "      set AppleScript's text item delimiters to \",\"",
  "      set ef to text items of expectedFrame",
  "      set AppleScript's text item delimiters to \" \"",
  "      if (count of ef) is not 4 then return \"CHANGED\"",
  "      set want to {(item 1 of ef) as integer, (item 2 of ef) as integer, (item 3 of ef) as integer, (item 4 of ef) as integer}",
  "      set got to {}",
  "      try",
  "        set wpos to get position of w",
  "        set wsize to get size of w",
  "        set got to {(item 1 of wpos) as integer, (item 2 of wpos) as integer, (item 1 of wsize) as integer, (item 2 of wsize) as integer}",
  "      end try",
  "      if (count of got) is not 4 then return \"CHANGED\"",
  "      set frameOk to true",
  "      repeat with i from 1 to 4",
  "        set d to (item i of got) - (item i of want)",
  "        if d < 0 then set d to -d",
  "        if d > 4 then set frameOk to false",
  "      end repeat",
  "      if not frameOk then return \"CHANGED\"",
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
   * Directory containing the compiled `scripts/isolated-session/`
   * helpers — specifically `window-ops`, the direct-AX mutation vehicle
   * `resizePanelWindow` uses since #358 (the System Events `set size`
   * vehicle was disproved on real After Effects, #357: AppleEvent
   * -1712 timeout, and System Events enumeration sees almost nothing on
   * AE). Absent means panel resize refuses before the lease is taken.
   */
  readonly windowOpsHelpersDir?: string;
  /**
   * Session-command seam — mainly a test seam. Production runs
   * `runInSession`; tests inject a stub so mutation error paths can be
   * exercised without a real GUI session.
   */
  readonly runSession?: typeof runInSession;
  /**
   * Re-checks, immediately before each GUI action, that `pid` still names
   * the process this run started. A pid alone is not an identity: the
   * process may have exited and the pid been reused by another After
   * Effects — or by anything else — between the listing and the press.
   * Returning false, or throwing, refuses the action with `A8N-AE-004`;
   * nothing is sent to the Accessibility API or to `screencapture`.
   *
   * The check runs before *every* session command this recovery issues —
   * each window listing, screenshot, press and click — not once per
   * attempt, because the process can change between two actions of the
   * same attempt.
   */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /**
   * Re-reads the target's login session immediately before each GUI
   * action. Mainly a test seam; defaults to `readGuiSession(session.uid)`.
   * The session proven at construction can end or change — a new asid
   * after re-login, or the console session after a fast user switch — and
   * `runInSession` alone cannot see that on the root path, which delivers
   * by uid. A changed or unprovable session refuses the action; issue #59
   * T035.
   */
  readonly readTargetSession?: (() => MacSession | null) | undefined;
  /**
   * Reads the console session's owner uid (-1 when unreadable). Mainly a
   * test seam; defaults to `consoleSessionUid`.
   */
  readonly consoleUid?: (() => number) | undefined;
};

export class GuiRecoveryError extends Error {
  /** A stable code for a refusal a caller may act on. */
  readonly code: "A8N-AE-004" | undefined;

  constructor(message: string, options: { code?: "A8N-AE-004" } = {}) {
    super(message);
    this.name = "GuiRecoveryError";
    this.code = options.code;
  }
}

/**
 * A GUI press was refused because the target window's pid attribution
 * could not be proven (#330).
 *
 * Thrown BEFORE the mutation lease is taken and before any session
 * command runs: provably nothing was pressed or clicked, so callers may
 * treat it like any other pre-mutation refusal — never as an unknown
 * mutation outcome.
 */
export class GuiAttributionError extends GuiRecoveryError {
  constructor(message: string) {
    super(message);
    this.name = "GuiAttributionError";
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
  readonly #windowOpsHelpersDir: string | undefined;
  readonly #verifyProcess: ((pid: number) => boolean) | undefined;
  readonly #readTargetSession: () => MacSession | null;
  readonly #consoleUid: () => number;
  readonly #allowConsoleSession: boolean;

  constructor(options: GuiRecoveryOptions) {
    if (options.session.kind !== "Aqua") {
      throw new GuiRecoveryError(
        `the recovery target has no Aqua session (uid ${options.session.uid}, session kind ${options.session.kind}); ` +
          "there is no screen to recover. No GUI action was taken.",
      );
    }
    if (options.allowConsoleSession !== true) {
      const consoleUid = (options.consoleUid ?? consoleSessionUid)();
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
    this.#windowOpsHelpersDir = options.windowOpsHelpersDir;
    this.#verifyProcess = options.verifyProcess;
    this.#readTargetSession =
      options.readTargetSession ?? (() => readGuiSession(options.session.uid));
    this.#consoleUid = options.consoleUid ?? consoleSessionUid;
    this.#allowConsoleSession = options.allowConsoleSession === true;
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
        if (error instanceof GuiRecoveryError && error.code !== undefined) {
          // A coded refusal — today only the process-identity re-check —
          // is raised *before* its session command runs, so nothing was
          // pressed or clicked. It is a refusal, not an unknown mutation.
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
            detail: errorMessage(error),
          });
        } catch {
          // The original failure is the evidence that matters.
        }
        throw new GuiMutationError(
          `the ${op} mutation was attempted but its result is unknown: ` +
            `${errorMessage(error)}. ` +
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
            detail: errorMessage(error),
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
    // The census is a second session command after the listing: the
    // process is re-verified before it too, for the same reason. The
    // refusal must not be swallowed by the census's degrade-to-unavailable
    // handling below, so it runs outside that try.
    this.#assertSameProcess();
    this.#assertSessionProof();
    let census: WindowCensus;
    try {
      census = this.#census !== undefined ? this.#census() : { available: false, reason: "no census configured" };
    } catch (error) {
      census = {
        available: false,
        reason: `window census failed: ${errorMessage(error)}`,
      };
    }
    return assessGuiObservation(this.#pid, parsed.frontmost, parsed.windows, census);
  }

  /** The windows that keep the application from taking a script. */
  blockingWindows(): GuiWindowInfo[] {
    // Only pid-attributed windows count (#330): a foreign or unproven AX
    // window is not this instance's blocker, and reporting it as one is
    // exactly the false-`blocked` the bundle-confused listing produced.
    return this.listWindows().windows.filter(
      (window) => isBlockingWindow(window) && isPidAttributedWindow(window),
    );
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
    this.#assertSameProcess();
    this.#assertSessionProof();
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
   * The WindowServer census rows attributed to this pid, across all
   * Spaces — the pid-accurate half of panel identification (#343). Read
   * -only and audited as observation; an unavailable census returns
   * `available: false` with the reason, never an empty list that could be
   * mistaken for "no windows".
   */
  windowServerWindows(): {
    readonly available: boolean;
    readonly reason: string | null;
    readonly windows: readonly WindowServerWindow[];
  } {
    this.#observe("windowServerWindows");
    try {
      const census =
        this.#census !== undefined
          ? this.#census()
          : { available: false as const, reason: "no census configured" };
      if (!census.available) {
        return { available: false, reason: census.reason, windows: [] };
      }
      return {
        available: true,
        reason: null,
        windows: census.windows.filter((w) => w.pid === this.#pid),
      };
    } catch (error) {
      return {
        available: false,
        reason: `window census failed: ${errorMessage(error)}`,
        windows: [],
      };
    }
  }

  /**
   * Runs a caller-supplied read-only Accessibility AppleScript inside the
   * target session and returns its stdout (#361 docked-pane walk; the
   * menu-bar surface is the sibling consumer).
   *
   * The script arrives as `argv`-driven source — nothing from the outside
   * is spliced into it — is audited as `observe` under `op`, and gets the
   * same process-identity and session-proof re-checks every session
   * command gets. It is for observation only: a script that mutates must
   * go through `#mutate` instead, which this method deliberately is not.
   */
  accessibilityQuery(
    script: readonly string[],
    args: readonly string[],
    op: string,
  ): string {
    this.#observe(op);
    return this.#osascript(script, args).stdout;
  }

  /**
   * A screenshot of one rectangular region of the target session's
   * screen (#343 panel capture). `frame` is in the same points,
   * top-left-origin space the census and AX frames use. Read-only
   * observation — audited, never leased — but the file it writes is
   * evidence, so callers own where it lands.
   *
   * `-R` takes the rect in points; whether screencapture honours that on
   * every macOS version is a T002 real-host question — the capture
   * artifact records the pixel size so a scale mismatch is visible rather
   * than silent.
   */
  captureRegion(path: string, frame: GuiFrame): string {
    this.#observe("captureRegion");
    if (this.#screenshotDir !== undefined) {
      mkdirSync(this.#screenshotDir, { recursive: true });
    }
    mkdirSync(dirname(path), { recursive: true });
    this.#assertSameProcess();
    this.#assertSessionProof();
    const rect = [frame.x, frame.y, frame.width, frame.height]
      .map((value) => String(Math.round(value)))
      .join(",");
    const result = this.#runSession(
      this.#session,
      "/usr/sbin/screencapture",
      ["-x", "-o", "-R", rect, path],
      { timeoutMs: 30_000 },
    );
    if (result.status !== 0) {
      throw new GuiRecoveryError(
        `could not capture the region of ${this.#session.username}'s session: ${result.stderr.trim()}`,
      );
    }
    return path;
  }

  /**
   * A screenshot of one window of the target session, addressed by its
   * WindowServer window number — the capture that does not leak the rest
   * of the screen (#343). Read-only observation, same audit rule as
   * `captureRegion`.
   */
  captureWindowById(path: string, windowNumber: number): string {
    this.#observe("captureWindowById");
    if (this.#screenshotDir !== undefined) {
      mkdirSync(this.#screenshotDir, { recursive: true });
    }
    mkdirSync(dirname(path), { recursive: true });
    this.#assertSameProcess();
    this.#assertSessionProof();
    const result = this.#runSession(
      this.#session,
      "/usr/sbin/screencapture",
      ["-x", "-o", "-l", String(windowNumber), path],
      { timeoutMs: 30_000 },
    );
    if (result.status !== 0) {
      throw new GuiRecoveryError(
        `could not capture window ${windowNumber} of ${this.#session.username}'s session: ${result.stderr.trim()}`,
      );
    }
    return path;
  }

  /**
   * Resizes the panel window `expected` resolved to (#343/#358), under
   * the same lease + audit + pid-attribution proof a press requires.
   *
   * `expected` must carry `"owned"` census attribution and a frame —
   * the same fail-closed gate `pressButton` applies (#330). The vehicle
   * is the compiled `scripts/isolated-session/window-ops` helper's
   * `act --op resize`: it re-lists the pid's AX windows inside the
   * session (`AXUIElementCreateApplication(pid)` — it can never see
   * another process's windows), re-verifies the expected
   * frame+title+subrole identity within 4pt immediately before
   * `AXUIElementSetAttributeValue(kAXSizeAttribute)`, and reads the same
   * element back afterwards. This replaced the System Events `set size`
   * vehicle (`RESIZE_PANEL_SCRIPT`), which real After Effects disproved
   * (#357: AppleEvent -1712 timeout; System Events enumeration returns
   * almost nothing for AE, so the element was unreachable). The helper
   * requires `windowOpsHelpersDir`; without it the call refuses before
   * the lease is taken.
   *
   * Verdict mapping (helper JSON → this contract):
   *
   *   - `performed` → true.
   *   - `not-found` / `ambiguous` → false: the in-session identity
   *     re-check refused, provably nothing was resized.
   *   - `missing` → `MacSessionError`: the target process/session was
   *     never entered — a pre-mutation refusal (`unavailable`), not an
   *     unknown outcome.
   *   - `failed`, a non-zero exit, or an unusable receipt → error
   *     inside `#mutate`, audited `unknown` and surfaced as
   *     `GuiMutationError`: the outcome is unknown — re-observe before
   *     any retry, never resend.
   */
  resizePanelWindow(
    expected: GuiWindowInfo & { frame: GuiFrame },
    size: { readonly width: number; readonly height: number },
  ): boolean {
    this.#assertPressAttribution(expected);
    const helpersDir = this.#windowOpsHelpersDir;
    if (helpersDir === undefined) {
      throw new GuiRecoveryError(
        "panel resize needs the compiled window-ops helpers " +
          "(scripts/isolated-session/window-ops); none are configured " +
          "for this recovery — nothing was resized",
      );
    }
    return this.#mutate("resizePanelWindow", () => {
      // Same identity/session re-checks every session command gets —
      // the pid in the argv is only meaningful while it still names the
      // process this run started.
      this.#assertSameProcess();
      this.#assertSessionProof();
      const frameArg = [
        expected.frame.x,
        expected.frame.y,
        expected.frame.width,
        expected.frame.height,
      ]
        .map((value) => String(value))
        .join(",");
      const result = this.#runSession(
        this.#session,
        join(helpersDir, "window-ops"),
        [
          "act",
          "--pid",
          String(this.#pid),
          "--op",
          "resize",
          "--title",
          expected.title,
          "--subrole",
          expected.subrole ?? "-",
          "--frame",
          frameArg,
          "--width",
          String(size.width),
          "--height",
          String(size.height),
        ],
        { timeoutMs: 30_000 },
      );
      if (result.status !== 0) {
        // The helper may have applied the AX set before dying — the
        // outcome is unknown, which `#mutate` audits as `unknown`.
        throw new GuiRecoveryError(
          `the window-ops resize vehicle failed (exit ${result.status}): ` +
            `${result.stderr.trim() || result.stdout.trim() || "no diagnostic"}`,
        );
      }
      let verdict: string | null = null;
      let detail: string | null = null;
      try {
        const parsed = JSON.parse(result.stdout) as {
          verdict?: unknown;
          detail?: unknown;
        };
        verdict = typeof parsed.verdict === "string" ? parsed.verdict : null;
        detail = typeof parsed.detail === "string" ? parsed.detail : null;
      } catch {
        verdict = null;
      }
      switch (verdict) {
        case "performed":
          return true;
        case "not-found":
        case "ambiguous":
          // The helper re-verified identity inside the session and
          // refused: provably nothing was resized.
          return false;
        case "missing":
          // The target process/session was never entered — provable
          // non-mutation, surfaced as unavailable rather than a clean
          // refusal so the caller re-observes instead of retrying blind.
          throw new MacSessionError(
            `the window-ops resize vehicle could not reach pid ${this.#pid}'s ` +
              "process or session" +
              (detail === null ? "" : ` (${detail})`) +
              "; nothing was resized",
          );
        case "failed":
          // The AX set was attempted and errored: the mutation may have
          // partially applied. Unknown outcome — never "not-performed".
          throw new Error(
            "the panel resize was attempted but the window-ops vehicle " +
              `reported failure${detail === null ? "" : ` (${detail})`}; ` +
              "the window state must be re-observed before any retry",
          );
        default:
          throw new Error(
            "the window-ops vehicle returned an unusable receipt" +
              (result.stdout.trim() === ""
                ? " (empty stdout)"
                : `: ${result.stdout.trim().slice(0, 200)}`) +
              "; the resize outcome is unknown — re-observe before any retry",
          );
      }
    });
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
    this.#assertPressAttribution(expected);
    return this.#mutate("pressButton", () =>
      this.#pressButton(windowIndex, title, expected, expectedText),
    );
  }

  /**
   * Fail-closed pid attribution for a press (#330).
   *
   * When the caller names the window it chose (`expected`), that window
   * must carry `"owned"` census attribution AND a frame: the frame is
   * what PRESS_BUTTON_SCRIPT re-verifies inside the target session
   * before clicking. `"foreign"`, `"unmatched"`, a missing attribution
   * (census unavailable) and a missing frame all mean the press cannot
   * be proven to land on this pid's window — on a multi-install host
   * the AX listing can be entirely another instance's, and pressing by
   * index alone would click THAT instance's dialog.
   *
   * `expected === undefined` keeps the legacy index-and-title press: the
   * caller takes responsibility for the window it addresses, exactly as
   * before this check existed.
   */
  #assertPressAttribution(expected: GuiWindowInfo | undefined): void {
    if (expected === undefined) {
      return;
    }
    if (expected.censusAttribution !== "owned" || expected.frame == null) {
      throw new GuiAttributionError(
        `the window chosen for the press cannot be proven to belong to After Effects ` +
          `${this.#pid}: the WindowServer census did not attribute it to this pid ` +
          `(attribution ${expected.censusAttribution ?? "unproven"}). On a host running ` +
          "multiple same-bundle-id After Effects versions the Accessibility listing can " +
          "enumerate another instance's windows, so an unattributed press could click that " +
          "instance's dialog. No button was pressed.",
      );
    }
  }

  /** The `x,y,w,h` frame argument PRESS_BUTTON_SCRIPT verifies, or "". */
  #expectedFrameArg(expected: GuiWindowInfo | undefined): string {
    const frame = expected?.frame;
    if (frame == null) {
      return "";
    }
    return [frame.x, frame.y, frame.width, frame.height]
      .map((value) => String(Math.round(value)))
      .join(",");
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
      this.#expectedFrameArg(expected),
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
    this.#assertPressAttribution(expected);
    // The press and its coordinate fallback are one mutation: the lease is
    // held across the whole sequence so no other mutator can act between
    // the accessibility press failing and the click landing.
    return this.#mutate("pressButtonIn", () => {
      if (expected !== undefined) {
        // The attribution `expected` carries was taken at the caller's
        // listing — it can predate a window change, and the press script's
        // title/subrole/text/frame checks all read the same possibly
        // bundle-confused listing. Re-attribute the window at this index
        // now, inside the lease; anything but "owned" refuses the press
        // (#332). The window between this re-check and the AX press is
        // narrower but not removed — the in-session identity checks remain
        // the last line.
        const current = this.listWindows().windows[windowIndex - 1];
        if (current?.censusAttribution !== "owned") {
          return false;
        }
      }
      if (this.#pressButton(windowIndex, buttonTitle, expected, expectedText)) {
        return true;
      }
      const state = this.listWindows();
      const window = state.windows[windowIndex - 1];
      if (window === undefined) {
        return false;
      }
      // The coordinate fallback clicks raw screen positions: the window
      // they come from must be just as pid-attributed as the one the
      // accessibility press targeted (#330). A foreign or unproven window
      // at this index means the listing is untrusted — click nothing.
      if (window.censusAttribution !== "owned") {
        return false;
      }
      if (expected !== undefined && (window.title !== expected.title || window.subrole !== expected.subrole)) {
        // The window at that position is no longer the one the caller chose.
        return false;
      }
      if (
        expected?.frame != null &&
        window.frame != null &&
        !framesMatch(expected.frame, window.frame)
      ) {
        // Nor is it sitting where the caller saw it.
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
    // Every AppleScript this recovery sends — a window listing, a button
    // press, a coordinate click — is preceded by the identity re-check.
    // The pid in `args` is only meaningful while it still names the
    // process this run started.
    this.#assertSameProcess();
    this.#assertSessionProof();
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

  /**
   * Refuses unless `pid` still names the process this run started.
   *
   * A pid can be reused between the moment ownership was decided and the
   * moment a dialog is pressed; without this check the Accessibility query
   * would find and act on whatever process now holds that pid. The check
   * runs immediately before every session command — listing, screenshot,
   * press, click — because the process can change between two actions of
   * the same attempt.
   *
   * A verifier that throws counts as "cannot prove it is the same
   * process": fail closed, never act on a maybe.
   */
  #assertSameProcess(): void {
    const verify = this.#verifyProcess;
    if (verify === undefined) {
      return;
    }
    let same = false;
    try {
      same = verify(this.#pid);
    } catch {
      same = false;
    }
    if (!same) {
      throw new GuiRecoveryError(
        `the After Effects process ${this.#pid} is no longer the one this run started (A8N-AE-004); ` +
          "no GUI action was taken.",
        { code: "A8N-AE-004" },
      );
    }
  }

  /**
   * Re-proves the target session immediately before each GUI action.
   *
   * `options.session` was proven once, at construction. Since then the
   * user may have logged out and back in (a new asid), the session may
   * have ended, or a fast user switch may have made it the console
   * session. `runInSession` re-checks only *this* process's session and,
   * on the root path, delivers by uid alone — so without this check a
   * stale proof would keep acting on whatever session the uid now owns,
   * possibly the screen the human is looking at. Any difference from the
   * proven identity — including an unreadable console owner — refuses
   * before anything is sent. A `MacSessionError` is the refusal
   * `#mutate` already classifies as "the session was never entered":
   * provably nothing was pressed or clicked.
   */
  #assertSessionProof(): void {
    const proven = this.#session;
    const current = this.#readTargetSession();
    const consoleUid = this.#consoleUid();
    // The console check guards the cross-user path only, and only when the
    // constructor did not explicitly allow the console session: a recovery
    // inside the caller's own session — where the target legitimately is
    // the console session — must keep working.
    const selfUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const needsConsoleProof = proven.uid !== selfUid && !this.#allowConsoleSession;
    const unchanged =
      current !== null &&
      current.uid === proven.uid &&
      current.asid !== null &&
      current.asid === proven.asid &&
      current.kind === proven.kind &&
      (!needsConsoleProof || (consoleUid >= 0 && consoleUid !== proven.uid));
    if (unchanged) {
      return;
    }
    const now =
      current === null
        ? "no login session"
        : `asid ${current.asid ?? "unknown"}, kind ${current.kind}` +
          (needsConsoleProof && consoleUid === proven.uid ? ", and it is the console session" : "");
    throw new MacSessionError(
      `the login session this recovery proved (uid ${proven.uid}, asid ${proven.asid ?? "unknown"}, ` +
        `kind ${proven.kind}) no longer holds — it now reads as ${now}` +
        `${needsConsoleProof && consoleUid < 0 ? "; the console owner could not be read" : ""}. ` +
        "No GUI action was taken.",
    );
  }
}

/**
 * The production lease controller: the file lease under `stateRoot`, with
 * every acquisition, refusal and release written to the shared audit log.
 */
export function defaultLeaseController(options: {
  readonly stateRoot: string;
  /**
   * The lease scope: a macOS `{uid, asid}` session or, since #283, a
   * Windows `{platform: "win32", sessionId}` one. The on-disk format and
   * fail-closed semantics are identical for both.
   */
  readonly session: GuiLeaseSession;
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
            `written (${errorMessage(auditError)}); ` +
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
