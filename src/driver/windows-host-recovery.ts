/**
 * The Windows `HostRecovery`: the driver's GUI fallback for an After
 * Effects running on Windows (#283 wiring).
 *
 * It is the same contract `MacHostRecovery` implements, over the Windows
 * mutation path (`WindowsGuiRecovery`):
 *
 *   - The operation that timed out is never repeated; this only looks at
 *     the target session's screen and closes what is blocking the host.
 *   - What may be pressed is the shared policy, not a free-for-all:
 *     `chooseRecoveryWindow` over the windows `listWindows()` reported,
 *     with the census blocking verdict carried through
 *     `windowsGuiWindowToGuiInfo`. No Windows dialog class is registered
 *     as pressable today, so every blocking window resolves to
 *     quarantine, report-only or human-required — `A8N-SEC-001` unknown
 *     is never pressed.
 *   - Every mutation stays inside `WindowsGuiRecovery`'s lease + audit +
 *     session re-proof; this class adds no second path to the screen.
 *
 * Differences from the macOS implementation, all forced by the platform:
 *
 *   - Everything is async: each GUI action is one `powershell.exe`
 *     child, so `attempt` awaits the listing and the press.
 *   - There is no screenshot: `WindowsGuiRecovery` has no capture
 *     vehicle, so `screenshotPath` is simply absent from the outcome.
 *   - The "session" is a Windows session id, not a `MacSession`; the
 *     evidence names `session <id>` where macOS names the user.
 */

import { errorMessage } from "../errors.js";
import type { CommandRunner } from "../platform/windows/probe.js";
import type { GuiLeaseController } from "./gui-recovery.js";
import { GuiMutationError, GuiRecoveryError } from "./gui-recovery.js";
import {
  chooseRecoveryWindow,
  describeWindow,
  RECOVERY_BUTTONS,
  type HostRecovery,
  type RecoveryContext,
  type RecoveryOutcome,
} from "./recovery.js";
import {
  WindowsGuiRecovery,
  WindowsGuiSessionError,
  windowsGuiWindowToGuiInfo,
  type WindowsGuiAppState,
  type WindowsGuiSession,
} from "./windows-gui-recovery.js";

export type WindowsHostRecoveryOptions = {
  /** The interactive session the After Effects instance lives in. */
  readonly session: WindowsGuiSession;
  /** The pid of the After Effects instance, when it is known. */
  readonly pid: () => number | null;
  /**
   * Whether that pid still names the process this run started, re-read
   * immediately before every GUI action the recovery takes. Same contract
   * as the macOS recovery: a pid alone is not an identity.
   */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /** The buttons that may be pressed. */
  readonly buttons?: readonly string[];
  /** Test seam: replaces `process.platform`; must be `"win32"` for real use. */
  readonly platform?: NodeJS.Platform;
  /** The PowerShell command channel; forwarded to `WindowsGuiRecovery`. */
  readonly runner?: CommandRunner;
  /** Session re-proof seam; forwarded to `WindowsGuiRecovery`. */
  readonly readTargetSession?: (() => WindowsGuiSession | null) | undefined;
  /** Console-session reader seam; forwarded to `WindowsGuiRecovery`. */
  readonly consoleSessionId?: (() => number | null) | undefined;
  /**
   * Allow acting in the console session — the screen the human is looking
   * at. Off by default, same as macOS; forwarded to `WindowsGuiRecovery`.
   */
  readonly allowConsoleSession?: boolean;
  /**
   * The target is an attached/read-only After Effects. Forwarded to
   * `WindowsGuiRecovery`, which refuses it at construction — an attached
   * session can never reach the mutation path through this class.
   */
  readonly attached?: boolean;
  /** Lease/audit state root; forwarded to `WindowsGuiRecovery`. */
  readonly stateRoot?: string;
  /** Lease/audit owner identity; forwarded to `WindowsGuiRecovery`. */
  readonly ownerId?: string;
  /** Lease/audit seam; forwarded to `WindowsGuiRecovery`. */
  readonly lease?: GuiLeaseController;
};

/**
 * The GUI fallback for a Windows After Effects.
 *
 * Every action is a `powershell.exe` child of this process, so it lands on
 * this session's desktop by construction — the same session scoping the
 * `WindowsGuiRecovery` contract proves before each action.
 */
export class WindowsHostRecovery implements HostRecovery {
  readonly #session: WindowsGuiSession;
  readonly #pid: () => number | null;
  readonly #verifyProcess: ((pid: number) => boolean) | undefined;
  readonly #buttons: readonly string[];
  readonly #options: Omit<
    WindowsHostRecoveryOptions,
    "session" | "pid" | "verifyProcess" | "buttons"
  >;

  constructor(options: WindowsHostRecoveryOptions) {
    this.#session = options.session;
    this.#pid = options.pid;
    this.#verifyProcess = options.verifyProcess;
    this.#buttons = options.buttons ?? RECOVERY_BUTTONS;
    const { session: _session, pid: _pid, verifyProcess: _verify, buttons: _buttons, ...rest } =
      options;
    this.#options = rest;
  }

  attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    return this.#attempt(context);
  }

  async #attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    const pid = this.#pid();
    if (pid === null) {
      return {
        recovered: false,
        outcome: "refused",
        code: "A8N-AE-004",
        evidence: `no After Effects process this run started could be tied to it: ${context.method} (${context.requestId}) timed out and no host process was found`,
      };
    }
    let gui: WindowsGuiRecovery;
    try {
      gui = new WindowsGuiRecovery({
        session: this.#session,
        pid,
        ...(this.#verifyProcess === undefined ? {} : { verifyProcess: this.#verifyProcess }),
        ...this.#options,
      });
    } catch (error) {
      return {
        recovered: false,
        outcome: "refused",
        ...(error instanceof GuiRecoveryError && error.code !== undefined
          ? { code: error.code }
          : {}),
        evidence: `no GUI recovery is possible: ${errorMessage(error)}`,
      };
    }
    let state: WindowsGuiAppState;
    try {
      state = await gui.listWindows();
    } catch (error) {
      return {
        recovered: false,
        outcome: "refused",
        ...(error instanceof GuiRecoveryError && error.code !== undefined
          ? { code: error.code }
          : {}),
        evidence: `the target session could not be inspected: ${errorMessage(error)}`,
      };
    }
    // The shared policy sees the windows through the census-verdict
    // adapter: `blocking` on each GuiWindowInfo is the measured answer,
    // so `#32770` and owned-modal rows block exactly as the census said.
    const windows = state.windows.map(windowsGuiWindowToGuiInfo);
    const choice = chooseRecoveryWindow(windows);
    if (choice.kind === "none") {
      // Degraded observation is named, not hidden: a listing that could
      // not see everything cannot support "no modal window" either.
      const degraded =
        state.degraded.length === 0
          ? ""
          : ` The observation was degraded: ${state.degraded.join("; ")}.`;
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} in session ${this.#session.sessionId} has no blocking window; ` +
          `${context.method} (${context.requestId}) timed out for another reason, and nothing ` +
          `was clicked.${degraded}`,
      };
    }
    const window = choice.window;
    const description = describeWindow(window);
    // There is deliberately no screenshot on Windows: the recovery has no
    // capture vehicle, so `screenshotPath` stays absent rather than
    // pointing at a file that was never written.
    if (choice.kind === "human-only") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
          "which is an Adobe account or licence window. No button was pressed: signing in, " +
          "signing out or deactivating a device is a human's decision. The host stays blocked " +
          "until it is answered by hand.",
        window: description,
      };
    }
    if (choice.kind === "unpressable") {
      return {
        recovered: false,
        outcome: "refused",
        evidence:
          `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
          `which is the ${choice.dialogClass.name} dialog. No button was pressed: ` +
          `${choice.dialogClass.reason}. The host stays blocked until it is answered by hand.`,
        window: description,
      };
    }
    if (choice.kind === "quarantine") {
      return {
        recovered: false,
        outcome: "quarantined",
        code: choice.code,
        evidence:
          `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
          "which is not a dialog class this project has measured. No button was pressed and no " +
          `key was sent (${choice.code}). The state is unknown, so the run is quarantined: ` +
          "answer the window by hand and inspect the host before continuing.",
        window: description,
      };
    }
    // `choice.index` is the window's 1-based position in the listing; the
    // press is addressed to the EnumWindows index the listing recorded,
    // which is the same position for a contiguous census.
    const targetIndex = state.windows[choice.index - 1]?.index ?? choice.index;
    // The identity of the window that was chosen, same rule as macOS: the
    // marker text is re-checked inside the press run before input is sent.
    const marker = window.texts.find((text) => /^\s*ae-a8n:/.test(text)) ?? "";
    let leaseRefusal: string | null = null;
    let sessionRefusal = false;
    let refusalCode: "A8N-AE-004" | undefined;
    let unknownMutation: string | null = null;
    for (const title of this.#buttons) {
      // One call for both cases: a button the listing showed and one it did
      // not both get the UIA invoke press first and the coordinate click
      // second, inside `WindowsGuiRecovery`'s lease.
      let pressed: boolean;
      try {
        pressed = await gui.pressButtonIn(targetIndex, title, window, marker);
      } catch (error) {
        if (error instanceof GuiMutationError) {
          // The press may already have reached the dialog: the screen state
          // is unknown, so this is quarantine — never "nothing was done",
          // and never a retry.
          unknownMutation = error.message;
        } else {
          // A refused GUI lease, a failed process-identity re-check or a
          // broken session proof all mean nothing was pressed; they are
          // reported, never retried under the same conditions.
          leaseRefusal = errorMessage(error);
          sessionRefusal = error instanceof WindowsGuiSessionError;
          refusalCode = error instanceof GuiRecoveryError ? error.code : undefined;
        }
        break;
      }
      if (pressed) {
        const others =
          choice.blockingCount > 1
            ? ` (${choice.blockingCount - 1} other modal window(s) were left untouched)`
            : "";
        return {
          recovered: true,
          outcome: "dismissed",
          evidence:
            `closed "${description}" (${choice.dialogClass}) by pressing "${title}" in ` +
            `session ${this.#session.sessionId}${others}`,
          window: description,
        };
      }
    }
    if (unknownMutation !== null) {
      return {
        recovered: false,
        outcome: "quarantined",
        code: "A8N-SEC-001",
        evidence:
          `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
          "and the press attempt ended with an unknown result: " +
          `${unknownMutation}. Whether the button was pressed cannot be determined from here, ` +
          "so the run is quarantined: re-observe the screen before retrying anything, and do " +
          "not assume the dialog is still up or already gone.",
        window: description,
      };
    }
    if (leaseRefusal !== null) {
      return {
        recovered: false,
        outcome: "refused",
        ...(refusalCode === undefined ? {} : { code: refusalCode }),
        evidence: sessionRefusal
          ? `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
            `but no GUI mutation was attempted: ${leaseRefusal}. The interactive session this ` +
            "recovery proved no longer holds, so nothing was pressed and nothing will be until " +
            "it can be re-verified."
          : refusalCode === "A8N-AE-004"
            ? `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
              `but no GUI mutation was attempted: ${leaseRefusal}. The pid no longer provably ` +
              "names the process this run started, so nothing was pressed and nothing will be " +
              "until the target can be re-verified."
            : `After Effects ${pid} in session ${this.#session.sessionId} shows "${description}", ` +
              `but no GUI mutation was attempted: ${leaseRefusal}. The dialog stays up until ` +
              "the lease holder finishes or the lease is reaped.",
        window: description,
      };
    }
    // There is deliberately no escape-key fallback, same as macOS: the key
    // only reaches the window that happens to be key, and a listing made a
    // moment earlier cannot prove that window is the one identified above.
    return {
      recovered: false,
      outcome: "refused",
      evidence:
        `found "${description}" but pressed nothing: none of ${this.#buttons.join(", ")} was ` +
        "available, and no untargeted key was sent",
      window: description,
    };
  }
}
