/**
 * GUI fallback for Windows: the mutation half of what
 * `platform/windows/gui-probe.ts` observes (#283).
 *
 * The safety contract is the same one `MacGuiRecovery` enforces, restated
 * for the Windows session model:
 *
 *   1. **Only the proven interactive session is ever touched.** The
 *      ae-a8n agent on Windows runs inside the session it may mutate;
 *      there is no `launchctl asuser` equivalent, and this module does not
 *      pretend there is. Every PowerShell invocation is a child of this
 *      process, so it lands on this session's desktop by construction.
 *      When the session proof no longer holds — the agent's measured
 *      session id changed, or the target pid lives in another session —
 *      the action refuses. The console session (the desktop the person at
 *      the machine is looking at, `WTSGetActiveConsoleSessionId`) is
 *      refused by default for the same reason macOS refuses its console
 *      session: a recovery that clicks there takes the human's cursor and
 *      focus.
 *
 *   2. **Lease + audit around every mutation.** The file lease and the
 *      audit log are the shared `gui-lease` machinery; the Windows scope
 *      is the session id (`win32:session:<id>`), which cannot collide with
 *      a macOS `uid:`/`asid:` scope.
 *
 *   3. **Identity re-check immediately before the press.** The press
 *      script re-enumerates the pid's windows inside the same run, checks
 *      the window at the caller's index still carries the expected title,
 *      class and marker text, and only then invokes. UIA `InvokePattern`
 *      is tried first; the coordinate fallback uses the identified
 *      element's own `BoundingRectangle`, never a remembered position —
 *      the same ordering rationale as the macOS AX-press-then-click path.
 *
 *   4. **`GuiRecoveryError` vs `GuiMutationError` is preserved.** A refusal
 *      raised before anything could reach the screen is a
 *      `GuiRecoveryError` (coded `A8N-AE-004` for process-identity
 *      failure); an outcome that may have partially mutated is a
 *      `GuiMutationError` and the caller must re-observe, never retry
 *      blindly.
 *
 * What this module deliberately does NOT do:
 *
 *   - It registers no dialog class as pressable. Which windows may be
 *     pressed is the caller's policy (`chooseRecoveryWindow` and the
 *     measured-class taxonomy); on Windows today every class is
 *     unmeasured, so every blocking window is quarantine/report-only.
 *   - It is not wired into `HostRecovery` or the Windows adapter yet —
 *     see the PR for #283. Attached/read-only targets are refused at
 *     construction (`attached: true`), so observation-only consumers can
 *     never gain mutation through this class.
 */

import { errorMessage } from "../errors.js";
import type { CommandResult, CommandRunner, ProbeCommand } from "../platform/windows/probe.js";
import { SpawnCommandRunner } from "../platform/windows/spawn-runner.js";
import { windowsGuiActScript } from "../platform/windows/gui-act-script.js";
import {
  measureConsoleSessionId,
  measureWindowsSessionId,
} from "../platform/windows/session.js";
import { isBlockingWindowsWindow, type WindowsWindowCensus } from "../platform/windows/gui-probe.js";
import {
  defaultGuiLeaseRoot,
  windowsGuiLeaseSession,
} from "../platform/darwin/gui-lease.js";
import {
  defaultLeaseController,
  GuiMutationError,
  GuiRecoveryError,
  type GuiLeaseController,
  type GuiWindowInfo,
} from "./gui-recovery.js";

/** The interactive Windows session a recovery is allowed to act in. */
export type WindowsGuiSession = {
  /** The measured session id (`[Diagnostics.Process]::SessionId`). */
  readonly sessionId: number;
};

/**
 * The target session this recovery proved no longer holds. Thrown only
 * *before* a command is spawned, so `#mutate` classifies it as
 * "not-performed" — the same role `MacSessionError` plays on macOS.
 */
export class WindowsGuiSessionError extends Error {
  /** Same diagnostic code family as `MacSessionError`. */
  readonly code = "A8N-SESSION-005" as const;

  constructor(message: string) {
    super(message);
    this.name = "WindowsGuiSessionError";
  }
}

/** One button a window listing reported, with its own frame for a click fallback. */
export type WindowsGuiButton = {
  readonly title: string;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly size: { readonly width: number; readonly height: number } | null;
};

/**
 * One top-level window of the target pid, in `EnumWindows` order — the
 * `index` is the 1-based address the press script uses, exactly like the
 * 1-based position in the macOS Accessibility listing.
 */
export type WindowsGuiWindow = {
  readonly index: number;
  readonly hwnd: string;
  readonly title: string;
  /** The Win32 class name — the Windows analog of the AX role (`#32770`, …). */
  readonly className: string;
  /** The UIA control type of the window element, when UIA answered. */
  readonly controlType: string | null;
  readonly visible: boolean;
  /** Census-measured modality evidence (`isBlockingWindowsWindow`). */
  readonly blocking: boolean;
  readonly texts: readonly string[];
  readonly buttons: readonly WindowsGuiButton[];
};

export type WindowsGuiAppState = {
  readonly pid: number;
  readonly sessionId: number;
  readonly windows: readonly WindowsGuiWindow[];
  /** Observation problems that did not stop the listing (UIA gaps, truncation). */
  readonly degraded: readonly string[];
};

/**
 * Adapt a Windows window to the `GuiWindowInfo` shape the shared recovery
 * policy (`chooseRecoveryWindow`, `isHumanOnlyWindow`, taxonomy matchers)
 * is written against. `role` carries the Win32 class name and `subrole`
 * the UIA control type — the closest honest analogs of AX role/subrole.
 *
 * Note for the future wiring: `isBlockingWindow` reads AX role words
 * ("dialog", "sheet", "alert") and will NOT recognise `#32770`; the
 * Windows blocking verdict lives on `WindowsGuiWindow.blocking`. A policy
 * adapter must carry that verdict across rather than re-deriving it.
 */
export function windowsGuiWindowToGuiInfo(window: WindowsGuiWindow): GuiWindowInfo {
  return {
    title: window.title,
    role: window.className === "" ? "Window" : window.className,
    subrole: window.controlType,
    texts: window.texts,
    buttons: window.buttons.map((button) => ({
      title: button.title,
      description: "",
      position: button.position,
      size: button.size,
    })),
  };
}

// ---------------------------------------------------------------- parsing

type ActRecord = Record<string, unknown>;

function asRecord(value: unknown): ActRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ActRecord)
    : null;
}

function asString(value: unknown, max = 4096): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      continue;
    }
    out.push(item.length > 2048 ? item.slice(0, 2048) : item);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function asRect(value: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const item of value) {
    const parsed = asInt(item);
    if (parsed === null) {
      return null;
    }
    nums.push(parsed);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/** The terminal `{"type":"result"}` record of a press/click run, or null. */
export function parseWindowsGuiActResult(
  stdout: string,
): { readonly status: string; readonly detail: string | null } | null {
  let result: { status: string; detail: string | null } | null = null;
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    if (record?.type !== "result") {
      continue;
    }
    const status = asString(record.status, 64);
    if (status !== null) {
      result = { status, detail: asString(record.detail, 2048) };
    }
  }
  return result;
}

type ParsedWindow = {
  census: WindowsWindowCensus;
  index: number;
  controlType: string | null;
  texts: string[];
  buttons: WindowsGuiButton[];
};

/**
 * Parse list-mode NDJSON into windows. Returns null when the output cannot
 * be trusted at all (no `done` record — a killed observer leaves partial
 * evidence, which is degraded but still usable only when it ends cleanly).
 */
export function parseWindowsGuiWindowList(
  stdout: string,
): { readonly windows: readonly WindowsGuiWindow[]; readonly degraded: readonly string[] } | null {
  const pending = new Map<string, ParsedWindow>();
  const order: ParsedWindow[] = [];
  const degraded: string[] = [];
  let sawDone = false;
  let truncated = false;
  let censusError: string | null = null;
  let uiaUnavailable: string | null = null;
  let malformed = 0;

  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const record = asRecord(value);
    if (record === null) {
      malformed += 1;
      continue;
    }
    const type = asString(record.type, 32);
    switch (type) {
      case "meta":
        // Process identity evidence; the pid/session guards live in the
        // recovery, not in the listing shape.
        break;
      case "window": {
        const hwnd = asString(record.hwnd, 32);
        const index = asInt(record.index);
        const rect = asRect(record.rect);
        if (hwnd === null || index === null || index < 1) {
          malformed += 1;
          break;
        }
        const census: WindowsWindowCensus = {
          hwnd,
          title: asString(record.title, 1024) ?? "",
          className: asString(record.className, 256) ?? "",
          visible: asBool(record.visible) ?? false,
          enabled: asBool(record.enabled) ?? false,
          iconic: asBool(record.iconic) ?? false,
          rect,
          ownerPid: null,
          ownerHwnd: asString(record.ownerHwnd, 32),
          ownerEnabled: asBool(record.ownerEnabled),
          threadId: asInt(record.threadId),
          responding: null,
          sessionId: asInt(record.sessionId),
        };
        const parsed: ParsedWindow = {
          census,
          index,
          controlType: null,
          texts: [],
          buttons: [],
        };
        pending.set(hwnd, parsed);
        order.push(parsed);
        break;
      }
      case "uia": {
        const hwnd = asString(record.hwnd, 32);
        const target = hwnd === null ? undefined : pending.get(hwnd);
        if (target === undefined) {
          malformed += 1;
          break;
        }
        if (record.ok === true) {
          target.controlType = asString(record.controlType, 128);
          target.texts = asStringList(record.texts, 100);
          if (Array.isArray(record.buttons)) {
            for (const item of record.buttons) {
              const button = asRecord(item);
              const name = button === null ? null : asString(button.name, 2048);
              if (button === null || name === null || name === "" || target.buttons.length >= 50) {
                continue;
              }
              const rect = asRect(button.rect);
              target.buttons.push({
                title: name,
                position: rect === null ? null : { x: rect[0], y: rect[1] },
                size: rect === null ? null : { width: rect[2], height: rect[3] },
              });
            }
          }
        }
        break;
      }
      case "error": {
        censusError = asString(record.error, 2048) ?? "the window census failed";
        break;
      }
      case "uia-unavailable": {
        uiaUnavailable = asString(record.error, 2048) ?? "UI Automation unavailable";
        break;
      }
      case "done": {
        sawDone = true;
        truncated = asBool(record.truncated) ?? truncated;
        break;
      }
      default:
        malformed += 1;
    }
  }

  if (!sawDone) {
    return null;
  }
  if (censusError !== null) {
    degraded.push(`Win32 window census failed: ${censusError}`);
  }
  if (uiaUnavailable !== null) {
    degraded.push(`UI Automation unavailable: ${uiaUnavailable}`);
  }
  if (truncated) {
    degraded.push("the window census was truncated");
  }
  if (malformed > 0) {
    degraded.push(`${malformed} malformed observer line(s) ignored`);
  }
  const windows = order.map((parsed) => ({
    index: parsed.index,
    hwnd: parsed.census.hwnd,
    title: parsed.census.title,
    className: parsed.census.className,
    controlType: parsed.controlType,
    visible: parsed.census.visible,
    blocking: isBlockingWindowsWindow(parsed.census),
    texts: parsed.texts,
    buttons: parsed.buttons,
  }));
  return { windows, degraded };
}

// ---------------------------------------------------------------- options

export type WindowsGuiRecoveryOptions = {
  /**
   * The interactive session this recovery is allowed to act in — the
   * session the ae-a8n agent itself runs in, measured by the OS. There is
   * no way to enter another session from this vehicle; the proof is what
   * keeps a stale session from being acted on.
   */
  readonly session: WindowsGuiSession;
  /** The pid of the After Effects instance to recover. */
  readonly pid: number;
  /**
   * Test seam: replaces `process.platform`. Must be `"win32"` for any real
   * use; tests inject it so the refusal paths can run anywhere.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * The command channel the PowerShell scripts run through. Defaults to a
   * real `SpawnCommandRunner`; tests inject a fake. Every GUI action —
   * listing, press, click — is one powershell.exe child of this process,
   * so it lands on this session's desktop by construction.
   */
  readonly runner?: CommandRunner;
  /**
   * Re-checks, immediately before each GUI action, that `pid` still names
   * the process this run started. Same contract as the macOS recovery: a
   * pid alone is not an identity, and a verifier that throws counts as
   * "cannot prove it", which refuses with `A8N-AE-004`.
   */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /**
   * Re-reads this process's own session immediately before each GUI
   * action. Mainly a test seam; defaults to `measureWindowsSessionId()`.
   * A changed or unprovable session refuses before anything is spawned.
   */
  readonly readTargetSession?: (() => WindowsGuiSession | null) | undefined;
  /**
   * Reads the console session's id (`WTSGetActiveConsoleSessionId`).
   * Mainly a test seam; defaults to `measureConsoleSessionId`.
   */
  readonly consoleSessionId?: (() => number | null) | undefined;
  /**
   * Allow the recovery to act when the target session IS the console
   * session — the screen the human is looking at. Off by default, same as
   * macOS: observation-only consumers pass `true` explicitly.
   */
  readonly allowConsoleSession?: boolean;
  /**
   * The target is an attached/read-only After Effects, not one this run
   * owns. Mutation is never allowed for it: constructing with `true`
   * refuses outright, so an observation path cannot accidentally gain a
   * press by sharing this class.
   */
  readonly attached?: boolean;
  /** Where the GUI lease files and the audit log live. Defaults to `~/.ae-a8n`. */
  readonly stateRoot?: string;
  /** Identity written into lease records and audit lines. */
  readonly ownerId?: string;
  /** Lease/audit seam — mainly a test seam. */
  readonly lease?: GuiLeaseController;
};

const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The GUI mutation path for one Windows After Effects instance.
 *
 * Every method is async: each GUI action is one `powershell.exe` child.
 * There is no synchronous variant — a listing and the press that depends
 * on it must not be split by another action on the same screen, and the
 * lease is what serialises cooperating mutators.
 */
export class WindowsGuiRecovery {
  readonly #session: WindowsGuiSession;
  readonly #pid: number;
  readonly #runner: CommandRunner;
  readonly #lease: GuiLeaseController;
  readonly #verifyProcess: ((pid: number) => boolean) | undefined;
  readonly #readTargetSession: () => WindowsGuiSession | null;
  readonly #consoleSessionId: () => number | null;
  readonly #allowConsoleSession: boolean;

  constructor(options: WindowsGuiRecoveryOptions) {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") {
      throw new GuiRecoveryError(
        `the Windows GUI recovery requires win32, not ${platform}; ` +
          "there is no screen to recover. No GUI action was taken.",
      );
    }
    if (options.attached === true) {
      throw new GuiRecoveryError(
        `the After Effects process ${options.pid} is attached, not owned by this run; ` +
          "an attached target is read-only and no GUI mutation is ever attempted against it. " +
          "No GUI action was taken.",
      );
    }
    if (!Number.isInteger(options.session.sessionId) || options.session.sessionId <= 0) {
      throw new GuiRecoveryError(
        `the recovery target's session id ${String(options.session.sessionId)} is not a ` +
          "measurable interactive session; there is no proven desktop to act on. " +
          "No GUI action was taken.",
      );
    }
    if (!Number.isInteger(options.pid) || options.pid <= 0) {
      throw new GuiRecoveryError(
        `invalid target pid ${String(options.pid)}; no GUI action was taken.`,
      );
    }
    if (options.allowConsoleSession !== true) {
      const consoleId = (options.consoleSessionId ?? measureConsoleSessionId)();
      // A console owner that cannot be read must not be read as "not the
      // console": the check below would pass and the recovery would act on
      // the screen the human is looking at.
      if (consoleId === null) {
        throw new GuiRecoveryError(
          "the console session could not be identified " +
            "(WTSGetActiveConsoleSessionId could not be read), so it cannot be shown that " +
            "this recovery would not reach the screen the user is looking at. " +
            "No GUI action was taken.",
        );
      }
      if (consoleId === options.session.sessionId) {
        throw new GuiRecoveryError(
          `the target session ${options.session.sessionId} is the console session, the screen ` +
            "the user is looking at. Recovering there would move their cursor and take their " +
            "focus, so no GUI action was taken. Recover in an isolated session instead, or " +
            "pass allowConsoleSession explicitly.",
        );
      }
    }
    this.#session = options.session;
    this.#pid = options.pid;
    this.#runner =
      options.runner ??
      new SpawnCommandRunner({ timeoutMs: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_BUFFER });
    this.#lease =
      options.lease ??
      defaultLeaseController({
        stateRoot: options.stateRoot ?? defaultGuiLeaseRoot(),
        session: windowsGuiLeaseSession(options.session.sessionId),
        ownerId: options.ownerId ?? "ae-a8n",
      });
    this.#verifyProcess = options.verifyProcess;
    this.#readTargetSession =
      options.readTargetSession ??
      (() => {
        const sessionId = measureWindowsSessionId();
        return sessionId === null ? null : { sessionId };
      });
    this.#consoleSessionId = options.consoleSessionId ?? measureConsoleSessionId;
    this.#allowConsoleSession = options.allowConsoleSession === true;
  }

  get session(): WindowsGuiSession {
    return this.#session;
  }

  get pid(): number {
    return this.#pid;
  }

  /**
   * Read-only observation is audited but never leased: listing windows
   * cannot disturb the screen, and requiring the lease for it would let a
   * stuck lease blind the observer too.
   */
  #observe(op: string): void {
    this.#lease.audit({ kind: "observe", op });
  }

  /**
   * A GUI mutation runs under the session's single-owner lease and is
   * audited around the action — the same error boundary as the macOS
   * `#mutate`:
   *
   *   - `lease.acquire` throws before `fn` runs: nothing reached the
   *     screen, plain refusal.
   *   - `WindowsGuiSessionError` means the session proof failed before a
   *     command was spawned: provably nothing was mutated.
   *   - A coded `GuiRecoveryError` (`A8N-AE-004`) is the process-identity
   *     re-check, also raised before its command runs.
   *   - A `GuiMutationError` is already classified — passed through.
   *   - Any other error becomes `GuiMutationError`: the action may have
   *     partially reached the screen.
   */
  async #mutate<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const lease = this.#lease.acquire(op);
    try {
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        if (error instanceof WindowsGuiSessionError) {
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
        if (error instanceof GuiMutationError) {
          try {
            this.#lease.audit({
              kind: "mutate",
              op,
              outcome: "unknown",
              detail: error.message,
            });
          } catch {
            // The original failure is the evidence that matters.
          }
          throw error;
        }
        if (error instanceof GuiRecoveryError && error.code !== undefined) {
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

  /**
   * The windows of the After Effects instance, as Win32 + UIA see them.
   *
   * Throws `GuiRecoveryError` when the session cannot be proven or the
   * listing cannot be trusted — never an empty list standing in for
   * "could not look".
   */
  async listWindows(): Promise<WindowsGuiAppState> {
    this.#observe("listWindows");
    const result = await this.#powershell(
      windowsGuiActScript({ mode: "list", pid: this.#pid }),
    );
    const parsed = parseWindowsGuiWindowList(result.stdout);
    if (parsed === null) {
      const detail = result.stderr.trim();
      throw new GuiRecoveryError(
        `the Windows window listing for pid ${this.#pid} produced no complete ` +
          `record set (exit ${result.exitCode})` +
          (detail === "" ? "" : `: ${detail.slice(0, 300)}`),
      );
    }
    return {
      pid: this.#pid,
      sessionId: this.#session.sessionId,
      windows: parsed.windows,
      degraded: parsed.degraded,
    };
  }

  /** The windows that keep the application from taking a script. */
  async blockingWindows(): Promise<WindowsGuiWindow[]> {
    return (await this.listWindows()).windows.filter((window) => window.blocking);
  }

  /**
   * Clicks at a point of the target session's screen.
   *
   * The coordinates must come from the target session — a UIA
   * `BoundingRectangle` read there, or a listing of it. Coordinates taken
   * from another session's desktop are meaningless here.
   */
  clickAt(x: number, y: number): Promise<boolean> {
    return this.#mutate("clickAt", async () => {
      const result = await this.#powershell(
        windowsGuiActScript({ mode: "click", x: Math.round(x), y: Math.round(y) }),
      );
      return this.#clickOutcome(result);
    });
  }

  /**
   * Presses a button **in one window**, identified by its 1-based position
   * in the `EnumWindows` listing `listWindows()` returned.
   *
   * The window matters — same rule as macOS: scanning every window would
   * press the first matching button wherever it is, including a window the
   * caller was told not to touch. The press script re-verifies the window's
   * identity (title, class, marker text) inside the same run before any
   * input is sent.
   *
   * Ordering, same rationale as `MacGuiRecovery.pressButtonIn`: the UIA
   * invoke press runs first; only when the button has no invoke pattern
   * does the coordinate fallback run, at the identified element's own
   * frame. The lease is held across the whole sequence so no other
   * cooperating mutator can act between the press failing and the click
   * landing.
   */
  pressButtonIn(
    windowIndex: number,
    buttonTitle: string,
    expected?: GuiWindowInfo,
    /**
     * A static text the chosen window must still contain before anything
     * is pressed — the identity marker, checked inside the press run.
     */
    expectedText = "",
  ): Promise<boolean> {
    return this.#mutate("pressButtonIn", async () => {
      const pressed = await this.#pressInWindow(
        windowIndex,
        buttonTitle,
        expected,
        expectedText,
      );
      if (pressed) {
        return true;
      }
      // The press reported a clean refusal (window changed, button absent,
      // no invoke pattern and no usable frame): fall back to a fresh
      // listing and a coordinate click at the button's own frame — but
      // only after re-verifying the window is still the one the caller
      // chose. A second refusal returns false; nothing was pressed.
      const state = await this.listWindows();
      const window = state.windows.find((entry) => entry.index === windowIndex);
      if (window === undefined) {
        return false;
      }
      const info = windowsGuiWindowToGuiInfo(window);
      if (
        expected !== undefined &&
        (info.title !== expected.title || info.subrole !== expected.subrole)
      ) {
        return false;
      }
      if (expectedText !== "" && !info.texts.some((text) => text.includes(expectedText))) {
        return false;
      }
      for (const button of window.buttons) {
        if (
          button.title !== buttonTitle ||
          button.position === null ||
          button.size === null
        ) {
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

  async #pressInWindow(
    windowIndex: number,
    buttonTitle: string,
    expected: GuiWindowInfo | undefined,
    expectedText: string,
  ): Promise<boolean> {
    const result = await this.#powershell(
      windowsGuiActScript({
        mode: "press",
        pid: this.#pid,
        windowIndex,
        buttonTitle,
        expectedTitle: expected?.title ?? "",
        expectedClass: expected === undefined ? "" : classNameOf(expected),
        expectedText,
      }),
    );
    const outcome = parseWindowsGuiActResult(result.stdout);
    if (outcome === null) {
      throw new GuiRecoveryError(
        `the Windows press for pid ${this.#pid} produced no result record ` +
          `(exit ${result.exitCode}); the outcome is unknown`,
      );
    }
    switch (outcome.status) {
      case "INVOKED":
      case "CLICKED":
        return true;
      case "SESSION_MISMATCH":
        throw new WindowsGuiSessionError(
          `the After Effects process ${this.#pid} lives in a different session than ` +
            `this recovery (${this.#session.sessionId}): ${outcome.detail ?? "session mismatch"}. ` +
            "No GUI action was taken.",
        );
      case "MISSING":
      case "CHANGED":
      case "UNVERIFIED":
      case "NOT_FOUND":
      case "NO_FRAME":
        // Clean refusals: provably nothing was pressed.
        return false;
      case "INVOKE_FAILED":
        throw new GuiMutationError(
          `the UIA InvokePattern press on pid ${this.#pid} threw ` +
            `(${outcome.detail ?? "no detail"}); the button may already have been pressed. ` +
            "The screen must be re-observed before any retry.",
        );
      case "FAILED":
      default:
        // Infrastructure failure or an unrecognised status: whether input
        // was sent cannot be proven, so this is the ambiguous case.
        throw new GuiRecoveryError(
          `the Windows press for pid ${this.#pid} ended with status ` +
            `"${outcome.status}"${outcome.detail === null ? "" : ` (${outcome.detail})`}; ` +
            "the outcome is unknown",
        );
    }
  }

  async #clickAt(x: number, y: number): Promise<boolean> {
    const result = await this.#powershell(
      windowsGuiActScript({ mode: "click", x: Math.round(x), y: Math.round(y) }),
    );
    return this.#clickOutcome(result);
  }

  #clickOutcome(result: CommandResult): boolean {
    const outcome = parseWindowsGuiActResult(result.stdout);
    if (outcome === null) {
      throw new GuiRecoveryError(
        `the Windows click produced no result record (exit ${result.exitCode}); ` +
          "the outcome is unknown",
      );
    }
    if (outcome.status === "CLICKED") {
      return true;
    }
    if (outcome.status === "FAILED") {
      throw new GuiRecoveryError(
        `the Windows click failed before input was sent: ${outcome.detail ?? "unknown error"}`,
      );
    }
    throw new GuiRecoveryError(
      `the Windows click ended with unexpected status "${outcome.status}"; the outcome is unknown`,
    );
  }

  /**
   * Run one PowerShell act script inside this session.
   *
   * Every invocation — listing, press, click — is preceded by the identity
   * re-checks: the pid must still name the process this run started, and
   * this process's own session must still be the proven one. The pid in
   * the script is only meaningful while it still names that process.
   */
  async #powershell(script: string): Promise<CommandResult> {
    this.#assertSameProcess();
    this.#assertSessionProof();
    const command: ProbeCommand = {
      program: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
    const result = await this.#runner.run(command);
    if (result.exitCode !== 0) {
      throw new GuiRecoveryError(
        `the Windows GUI script failed (exit ${result.exitCode}): ` +
          `${result.stderr.trim().slice(0, 300)}`,
      );
    }
    return result;
  }

  /**
   * Refuses unless `pid` still names the process this run started. Same
   * contract as the macOS recovery: the check runs before *every* session
   * command, and a verifier that throws counts as "cannot prove it".
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
        `the After Effects process ${this.#pid} is no longer the one this run started ` +
          "(A8N-AE-004); no GUI action was taken.",
        { code: "A8N-AE-004" },
      );
    }
  }

  /**
   * Re-proves this process's session immediately before each GUI action.
   *
   * Unlike macOS there is no cross-user delivery to guard: the script is
   * always a child of this process, so "the session" is this process's own
   * measured session id. What can still change is the proof itself — a
   * session logoff/re-logon gives a new id — and the console relationship:
   * the proven session may have become the console session since
   * construction. Any difference refuses before anything is spawned.
   */
  #assertSessionProof(): void {
    const proven = this.#session.sessionId;
    const current = this.#readTargetSession();
    const consoleId = this.#consoleSessionId();
    const unchanged =
      current !== null &&
      current.sessionId === proven &&
      (this.#allowConsoleSession || (consoleId !== null && consoleId !== proven));
    if (unchanged) {
      return;
    }
    const now =
      current === null
        ? "no measurable session"
        : `session ${current.sessionId}` +
          (this.#allowConsoleSession
            ? ""
            : consoleId === proven
              ? ", which is now the console session"
              : consoleId === null
                ? ", and the console owner could not be read"
                : "");
    throw new WindowsGuiSessionError(
      `the interactive session this recovery proved (session ${proven}) no longer ` +
        `holds — it now reads as ${now}. No GUI action was taken.`,
    );
  }
}

/** The Win32 class name behind a `GuiWindowInfo` produced by `windowsGuiWindowToGuiInfo`. */
function classNameOf(window: GuiWindowInfo): string {
  // `role` carries the class name; a bare "Window" means the class was empty.
  return window.role === "Window" ? "" : window.role;
}
