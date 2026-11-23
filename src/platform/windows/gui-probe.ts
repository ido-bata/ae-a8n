/**
 * Windows GUI probe for supervision (#282,
 * specs/gui-supervision/spec.md §Observation).
 *
 * Observes the target pid's GUI through OS-native sources only — Win32
 * window census plus UI Automation — driven by the PowerShell script in
 * `gui-observe-script.ts`. It never mutates: no lease, no click, no
 * `SendInput`, no `Invoke` pattern. Observation is read-only, exactly like
 * the recovery path's `tasklist /V` read but structured.
 *
 * Honesty rules carried over from the macOS probe and the spec:
 *
 *   - A window the UIA tree cannot inspect is still reported — from its
 *     Win32 census row (title, class, visibility, owner, geometry,
 *     responsiveness). UIA failure is degraded evidence, never "no
 *     dialog".
 *   - A census that cannot run is degraded evidence, not a clean screen:
 *     the host state becomes `unknown`, never `none`.
 *   - A dead pid is `process-gone`; a locked GUI session is
 *     `gui-session-lost`; an unanswering process or window is
 *     `not-responding`. All are host-level states, not windows.
 *   - Permission failure, observer failure and UIA unavailability all
 *     surface as degraded observation health through `degraded` notes or
 *     an `ok: false` snapshot — fail-closed, never healthy-by-default.
 *
 * No image recognition and no OCR anywhere in this path: detection is
 * Win32 + UIA structured data only (spec prohibition).
 */

import type { CommandResult, CommandRunner, ProbeCommand } from "./probe.js";
import { SpawnCommandRunner } from "./spawn-runner.js";
import { windowsGuiObserveScript } from "./gui-observe-script.js";
import type { DialogWindow } from "../recovery-policy.js";
import type { GuiProbe, ProbeSnapshot } from "../../supervision/probe.js";
import type { HostLevelState } from "../../supervision/types.js";

/** The standard Win32 dialog class (`#32770`): the dialog-shaped census row. */
const WIN32_DIALOG_CLASS = "#32770";

/** Per-window and total caps mirror the observer script's own bounds. */
const MAX_WINDOWS = 128;
const MAX_TEXTS = 100;
const MAX_BUTTONS = 50;
const MAX_TITLE = 1024;
const MAX_NAME = 2048;

/** One Win32 census row for a top-level window owned by the target pid. */
export type WindowsWindowCensus = {
  readonly hwnd: string;
  readonly title: string;
  readonly className: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly iconic: boolean;
  /** [left, top, right, bottom] in screen coordinates; null when unreadable. */
  readonly rect: readonly [number, number, number, number] | null;
  readonly ownerPid: number | null;
  /** Owner window handle as a decimal string; "0"/null when unowned. */
  readonly ownerHwnd: string | null;
  /**
   * Whether the owner window is enabled. A modal dialog disables its
   * owner, so `ownerEnabled === false` on an owned window is the census
   * evidence of modality. Null when there is no owner or it was unreadable.
   */
  readonly ownerEnabled: boolean | null;
  readonly threadId: number | null;
  /** Per-window `WM_NULL` liveness; null when the probe could not ask. */
  readonly responding: boolean | null;
  readonly sessionId: number | null;
};

/** What UIA could prove about one window's element tree. */
export type WindowsUiaResult =
  | {
      readonly ok: true;
      readonly controlType: string | null;
      readonly name: string | null;
      readonly automationId: string | null;
      readonly enabled: boolean | null;
      readonly texts: readonly string[];
      readonly buttons: readonly string[];
      readonly elementCount: number;
    }
  | {
      readonly ok: false;
      /** Why UIA yielded nothing; becomes degraded evidence. */
      readonly error: string;
    };

/** The parsed observer output — platform evidence before policy mapping. */
export type WindowsGuiObservation = {
  readonly pid: number;
  readonly process: {
    readonly exists: boolean;
    readonly responding: boolean | null;
    readonly sessionId: number | null;
    readonly startTime: string | null;
    readonly imageName: string | null;
  };
  /** Foreground window's pid; null when unreadable. */
  readonly foregroundPid: number | null;
  /** GUI session lock evidence; null when unreadable. Never guessed. */
  readonly locked: boolean | null;
  readonly windows: readonly WindowsWindowCensus[];
  /** UIA results keyed by hwnd string; absent hwnd = no UIA record. */
  readonly uia: ReadonlyMap<string, WindowsUiaResult>;
  /** Why the Win32 census failed, when it did. */
  readonly censusError: string | null;
  /** Why UIA was unavailable process-wide, when it was. */
  readonly uiaUnavailable: string | null;
  /** The census hit its window cap; rows beyond it were not observed. */
  readonly truncated: boolean;
  /** NDJSON lines that failed to parse; counted, never silently dropped. */
  readonly malformedLines: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asStringList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      continue;
    }
    out.push(item.length > maxLen ? item.slice(0, maxLen) : item);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function parseRect(value: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const item of value) {
    const parsed = asInteger(item);
    if (parsed === null) {
      return null;
    }
    nums.push(parsed);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function parseWindow(record: Record<string, unknown>): WindowsWindowCensus | null {
  const hwnd = asString(record.hwnd, 32);
  if (hwnd === null) {
    return null;
  }
  const rect = parseRect(record.rect);
  const sessionId = asInteger(record.sessionId);
  return {
    hwnd,
    title: asString(record.title, MAX_TITLE) ?? "",
    className: asString(record.className, 256) ?? "",
    visible: asBoolean(record.visible) ?? false,
    enabled: asBoolean(record.enabled) ?? false,
    iconic: asBoolean(record.iconic) ?? false,
    rect,
    ownerPid: asInteger(record.ownerPid),
    ownerHwnd: asString(record.ownerHwnd, 32),
    ownerEnabled: asBoolean(record.ownerEnabled),
    threadId: asInteger(record.threadId),
    responding: asBoolean(record.responding),
    sessionId,
  };
}

function parseUia(record: Record<string, unknown>): WindowsUiaResult | null {
  const hwnd = asString(record.hwnd, 32);
  if (hwnd === null) {
    return null;
  }
  if (record.ok !== true) {
    return { ok: false, error: asString(record.error, MAX_NAME) ?? "UIA inspection failed" };
  }
  return {
    ok: true,
    controlType: asString(record.controlType, 128),
    name: asString(record.name, MAX_NAME),
    automationId: asString(record.automationId, 512),
    enabled: asBoolean(record.enabled),
    texts: asStringList(record.texts, MAX_TEXTS, MAX_NAME),
    buttons: asStringList(record.buttons, MAX_BUTTONS, MAX_NAME),
    elementCount: asInteger(record.elementCount) ?? 0,
  };
}

/**
 * Parse the observer's NDJSON stdout into a `WindowsGuiObservation`.
 * Returns null when no `meta` record arrived — the observer's own identity
 * statement is the minimum evidence a parse can stand on. Malformed lines
 * are counted, never trusted.
 */
export function parseWindowsGuiObservation(stdout: string): WindowsGuiObservation | null {
  let pid: number | null = null;
  let exists: boolean | null = null;
  let responding: boolean | null = null;
  let sessionId: number | null = null;
  let startTime: string | null = null;
  let imageName: string | null = null;
  let foregroundPid: number | null = null;
  let locked: boolean | null = null;
  let sawSession = false;
  let censusError: string | null = null;
  let uiaUnavailable: string | null = null;
  let truncated = false;
  let malformedLines = 0;
  const windows: WindowsWindowCensus[] = [];
  const uia = new Map<string, WindowsUiaResult>();

  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const record = asRecord(value);
    if (record === null) {
      malformedLines += 1;
      continue;
    }
    switch (record.type) {
      case "meta": {
        pid = asInteger(record.pid) ?? pid;
        exists = asBoolean(record.exists) ?? exists;
        responding = asBoolean(record.responding);
        sessionId = asInteger(record.sessionId);
        startTime = asString(record.startTime, 64);
        imageName = asString(record.imageName, 256);
        break;
      }
      case "session": {
        sawSession = true;
        foregroundPid = asInteger(record.foregroundPid);
        locked = asBoolean(record.locked);
        break;
      }
      case "window": {
        const window = parseWindow(record);
        if (window === null || windows.length >= MAX_WINDOWS) {
          malformedLines += 1;
        } else {
          windows.push(window);
        }
        break;
      }
      case "uia": {
        const hwnd = asString(record.hwnd, 32);
        const result = parseUia(record);
        if (hwnd === null || result === null) {
          malformedLines += 1;
        } else {
          uia.set(hwnd, result);
        }
        break;
      }
      case "uia-unavailable": {
        uiaUnavailable = asString(record.error, MAX_NAME) ?? "UIA unavailable";
        break;
      }
      case "census-error": {
        censusError = asString(record.error, MAX_NAME) ?? "window census failed";
        break;
      }
      case "done": {
        truncated = asBoolean(record.truncated) ?? truncated;
        break;
      }
      default:
        malformedLines += 1;
    }
  }

  if (pid === null || exists === null) {
    return null;
  }
  return {
    pid,
    process: {
      exists,
      responding,
      sessionId,
      startTime,
      imageName,
    },
    foregroundPid: sawSession ? foregroundPid : null,
    locked: sawSession ? locked : null,
    windows,
    uia,
    censusError,
    uiaUnavailable,
    truncated,
    malformedLines,
  };
}

/**
 * Whether a census row is a blocking window. Evidence-based, documented:
 *
 *   - visible AND Win32 dialog class `#32770`, or
 *   - visible AND owned by another window whose owner is disabled — a modal
 *     dialog disables its owner, which is the census-visible signature of
 *     modality without guessing at class names.
 *
 * Invisible windows, unowned windows and owned popups whose owner stayed
 * enabled are reported but never blocking. A window UIA cannot inspect is
 * still judged on its census row — absence of detail is not absence of a
 * window.
 */
export function isBlockingWindowsWindow(window: WindowsWindowCensus): boolean {
  if (!window.visible) {
    return false;
  }
  if (window.className === WIN32_DIALOG_CLASS) {
    return true;
  }
  return (
    window.ownerHwnd !== null &&
    window.ownerHwnd !== "0" &&
    window.ownerEnabled === false
  );
}

/** Map one census row (+ its UIA result, when any) to `DialogWindow`. */
export function windowsGuiWindowToDialog(
  window: WindowsWindowCensus,
  uia: WindowsUiaResult | undefined,
): DialogWindow {
  const texts: string[] = [];
  const buttons: string[] = [];
  let subrole: string | null = null;
  if (uia !== undefined && uia.ok) {
    subrole = uia.controlType;
    texts.push(...uia.texts);
    buttons.push(...uia.buttons);
  } else if (uia !== undefined) {
    // Preserve the OS evidence that exists: the census fields ride in
    // title/role, and the UIA failure is named so a human reading the
    // blocking detail sees *why* the content is unknown.
    texts.push(`UIA inspection unavailable: ${uia.error}`);
  }
  return {
    title: window.title,
    // The Win32 class name is the Windows analog of the AX role: it is the
    // most stable machine identifier a census row carries (#32770 dialogs,
    // app-specific classes).
    role: window.className === "" ? "Window" : window.className,
    subrole,
    texts,
    buttons,
    blocking: isBlockingWindowsWindow(window),
  };
}

/** Host-level state proven by one parsed observation. */
export function windowsGuiHostState(observation: WindowsGuiObservation): HostLevelState {
  if (!observation.process.exists) {
    return "process-gone";
  }
  if (observation.locked === true) {
    return "gui-session-lost";
  }
  if (observation.process.responding === false) {
    return "not-responding";
  }
  // The census is the only window-level evidence: without it, or without a
  // readable responsiveness answer and no proven host state, "clean" is
  // unproven — report unknown, never none.
  if (observation.censusError !== null || observation.process.responding === null) {
    return "unknown";
  }
  return "none";
}

export type WindowsGuiProbeOptions = {
  /** The command channel; defaults to a real `SpawnCommandRunner`. */
  readonly runner?: CommandRunner;
  /** Test seam: replaces `process.platform`. */
  readonly platform?: NodeJS.Platform;
};

const OBSERVER_TIMEOUT_MS = 30_000;
const OBSERVER_MAX_BUFFER = 4 * 1024 * 1024;

export class WindowsGuiProbe implements GuiProbe {
  readonly #pid: number;
  readonly #runner: CommandRunner;
  readonly #platform: NodeJS.Platform;

  constructor(pid: number, options: WindowsGuiProbeOptions = {}) {
    this.#pid = pid;
    this.#platform = options.platform ?? process.platform;
    this.#runner =
      options.runner ??
      new SpawnCommandRunner({ timeoutMs: OBSERVER_TIMEOUT_MS, maxBuffer: OBSERVER_MAX_BUFFER });
  }

  async observe(): Promise<ProbeSnapshot> {
    if (this.#platform !== "win32") {
      return { ok: false, reason: `Windows GUI observation requires win32, not ${this.#platform}` };
    }
    if (!Number.isInteger(this.#pid) || this.#pid <= 0) {
      return { ok: false, reason: `invalid target pid ${String(this.#pid)}` };
    }

    const command: ProbeCommand = {
      program: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", windowsGuiObserveScript(this.#pid)],
    };
    let result: CommandResult;
    try {
      result = await this.#runner.run(command);
    } catch (error) {
      return {
        ok: false,
        reason: `observer could not run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const observation = parseWindowsGuiObservation(result.stdout);
    if (observation === null) {
      const detail = result.stderr.trim();
      return {
        ok: false,
        reason:
          `observer produced no readable meta record (exit ${result.exitCode})` +
          (detail === "" ? "" : `: ${detail.slice(0, 300)}`),
      };
    }

    const degraded: string[] = [];
    if (result.exitCode !== 0) {
      degraded.push(
        `observer exited ${result.exitCode}` +
          (result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().slice(0, 300)}`),
      );
    }
    if (observation.censusError !== null) {
      degraded.push(`Win32 window census failed: ${observation.censusError}`);
    }
    if (observation.uiaUnavailable !== null) {
      degraded.push(`UI Automation unavailable: ${observation.uiaUnavailable}`);
    }
    const uiaMissing = observation.windows.filter(
      (window) => !observation.uia.has(window.hwnd),
    ).length;
    if (uiaMissing > 0) {
      degraded.push(`UIA detail missing for ${uiaMissing} window(s)`);
    }
    const uiaFailed = [...observation.uia.values()].filter((uia) => !uia.ok);
    if (uiaFailed.length > 0) {
      degraded.push(
        `UIA inspection failed for ${uiaFailed.length} window(s): ` +
          uiaFailed
            .slice(0, 3)
            .map((uia) => (uia.ok ? "" : uia.error))
            .join("; "),
      );
    }
    if (observation.truncated) {
      degraded.push(`window census truncated at ${MAX_WINDOWS} windows`);
    }
    if (observation.malformedLines > 0) {
      degraded.push(`${observation.malformedLines} malformed observer line(s) ignored`);
    }
    if (observation.process.exists && observation.locked === null) {
      degraded.push("GUI session lock state unreadable");
    }
    if (observation.process.exists && observation.process.responding === null) {
      degraded.push("process responsiveness unreadable");
    }

    const windows = observation.windows.map((window) =>
      windowsGuiWindowToDialog(window, observation.uia.get(window.hwnd)),
    );

    const host = windowsGuiHostState(observation);
    const frontmost =
      observation.foregroundPid !== null
        ? observation.foregroundPid === this.#pid
        : undefined;

    return {
      ok: true,
      windows,
      host,
      ...(frontmost === undefined ? {} : { frontmost }),
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }
}
