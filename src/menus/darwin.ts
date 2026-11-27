/**
 * macOS transport for the menu-bar surface (#360).
 *
 * A deliberately thin sibling of `MacGuiRecovery`: the same session
 * scoping (every command runs inside the target's own session via
 * `runInSession`), the same pid-identity and session-proof re-checks
 * before every command, and the same lease + audit + error-boundary
 * shape for mutations. It is a separate class — not a `MacGuiRecovery`
 * method — so the docked-pane deep walk (#361) and this menu surface
 * can evolve without touching `gui-recovery.ts`.
 *
 * What it does NOT do: census attribution. Menu bar items are addressed
 * by pid through `application process whose unix id` — a pid-exact
 * lookup, not the bundle-confused `windows of process` listing #330
 * fixed — so there is no window to attribute. The residual wrong-target
 * risk is pid reuse, which `verifyProcess` + the session proof cover
 * exactly as they do for presses.
 */

import {
  defaultLeaseController,
  GuiMutationError,
  GuiRecoveryError,
  type GuiLeaseController,
} from "../driver/gui-recovery.js";
import {
  consoleSessionUid,
  MacSessionError,
  readGuiSession,
  runInSession,
  type MacSession,
  type SessionCommandResult,
} from "../driver/mac-session.js";
import { defaultGuiLeaseRoot } from "../platform/darwin/gui-lease.js";
import { errorMessage } from "../errors.js";
import { parseMenuBarListing } from "./parse.js";
import { INVOKE_MENU_ITEM_SCRIPT, LIST_MENU_BAR_SCRIPT } from "./script.js";
import type { MenuBarSnapshot } from "./types.js";
import type { MenuInvokeVerdict } from "./controller.js";

export type MacMenuSurfaceOptions = {
  /** The session the After Effects instance lives in. Nothing else is touched. */
  readonly session: MacSession;
  /** The pid of the After Effects instance. */
  readonly pid: number;
  /**
   * Allow the surface to act in the console session. Off by default for
   * the same reason recovery refuses it: the console session is the
   * screen the human is looking at. Production wires the observer with
   * this on (read-only, like `ae.guiState()`) and leaves the mutator on
   * the default refusal.
   */
  readonly allowConsoleSession?: boolean;
  readonly stateRoot?: string;
  readonly ownerId?: string;
  /** Lease/audit seam — mainly a test seam. */
  readonly lease?: GuiLeaseController;
  /** Session-command seam — mainly a test seam. */
  readonly runSession?: typeof runInSession;
  /**
   * Re-checks, immediately before each session command, that `pid` still
   * names the process this surface was built for. Same contract as
   * `GuiRecoveryOptions.verifyProcess`.
   */
  readonly verifyProcess?: ((pid: number) => boolean) | undefined;
  /** Re-reads the target's login session before each command. */
  readonly readTargetSession?: (() => MacSession | null) | undefined;
  /** Reads the console session's owner uid (-1 when unreadable). */
  readonly consoleUid?: (() => number) | undefined;
};

/**
 * The menu-bar observation/mutation vehicle for one After Effects
 * instance on macOS. Mirrors `MacGuiRecovery`'s safety shape without
 * sharing its window-listing state.
 */
export class MacMenuSurface {
  readonly #session: MacSession;
  readonly #pid: number;
  readonly #lease: GuiLeaseController;
  readonly #runSession: typeof runInSession;
  readonly #verifyProcess: ((pid: number) => boolean) | undefined;
  readonly #readTargetSession: () => MacSession | null;
  readonly #consoleUid: () => number;
  readonly #allowConsoleSession: boolean;

  constructor(options: MacMenuSurfaceOptions) {
    if (options.session.kind !== "Aqua") {
      throw new GuiRecoveryError(
        `the menu surface target has no Aqua session (uid ${options.session.uid}, ` +
          `session kind ${options.session.kind}); there is no menu bar to read. ` +
          "No GUI action was taken.",
      );
    }
    if (options.allowConsoleSession !== true) {
      const consoleUid = (options.consoleUid ?? consoleSessionUid)();
      if (consoleUid < 0) {
        throw new GuiRecoveryError(
          "the console session could not be identified (the owner of /dev/console " +
            "could not be read), so it cannot be shown that this surface would not " +
            "reach the screen the user is looking at. No GUI action was taken.",
        );
      }
      if (consoleUid === options.session.uid) {
        throw new GuiRecoveryError(
          `the target session (uid ${options.session.uid}) is the console session, the ` +
            "screen the user is looking at. Acting there would move their cursor and " +
            "take their focus, so no GUI action was taken. Use an isolated session " +
            "instead, or allowConsoleSession for a read-only observer.",
        );
      }
    }
    this.#session = options.session;
    this.#pid = options.pid;
    this.#lease =
      options.lease ??
      defaultLeaseController({
        stateRoot: options.stateRoot ?? defaultGuiLeaseRoot(),
        session: { uid: options.session.uid, asid: options.session.asid },
        ownerId: options.ownerId ?? "ae-a8n",
      });
    this.#runSession = options.runSession ?? runInSession;
    this.#verifyProcess = options.verifyProcess;
    this.#readTargetSession =
      options.readTargetSession ?? (() => readGuiSession(options.session.uid));
    this.#consoleUid = options.consoleUid ?? consoleSessionUid;
    this.#allowConsoleSession = options.allowConsoleSession === true;
  }

  get session(): MacSession {
    return this.#session;
  }

  get pid(): number {
    return this.#pid;
  }

  /**
   * Read-only observation is audited but never leased — same rule as
   * `MacGuiRecovery.listWindows`.
   */
  #observe(op: string): void {
    this.#lease.audit({ kind: "observe", op });
  }

  /**
   * The mutation wrapper, copied from `MacGuiRecovery.#mutate`'s error
   * boundary: lease refusal and session-entry failure are provable
   * non-mutations; anything else inside `fn` is `GuiMutationError`
   * (outcome unknown — re-observe, never resend).
   */
  #mutate<T>(
    op: string,
    fn: () => T,
    performed: (result: T) => boolean = (result) => result !== false,
  ): T {
    const lease = this.#lease.acquire(op);
    try {
      let result: T;
      try {
        result = fn();
      } catch (error) {
        if (error instanceof MacSessionError) {
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
            `${errorMessage(error)}. The screen must be re-observed before any retry.`,
          { cause: error },
        );
      }
      try {
        this.#lease.audit({
          kind: "mutate",
          op,
          outcome: performed(result) ? "performed" : "not-performed",
        });
      } catch {
        // The action already happened; an audit failure cannot undo it.
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
   * Enumerate the process's menu bar tree. Observe-class: audited, no
   * lease. `MISSING`/`NOMENUBAR` are honest answers, not errors — the
   * first means the pid is not visible to this session's AX, the second
   * that the process answered but has no menu bar.
   */
  listMenuBar(): MenuBarSnapshot {
    this.#observe("listMenuBar");
    const result = this.#osascript(LIST_MENU_BAR_SCRIPT, [String(this.#pid)]);
    const trimmed = result.stdout.trim();
    if (trimmed === "MISSING" || trimmed === "NOMENUBAR") {
      return {
        pid: this.#pid,
        channel: "system-events",
        observedAt: new Date().toISOString(),
        available: false,
        reason:
          trimmed === "MISSING"
            ? `the After Effects process ${this.#pid} is not visible to the Accessibility API of ` +
              `${this.#session.username}'s session; it may have exited`
            : `process ${this.#pid} answered but exposes no menu bar`,
        menuBarItems: [],
        truncated: false,
      };
    }
    return parseMenuBarListing(trimmed, this.#pid, new Date().toISOString());
  }

  /**
   * Press one menu item by index path, re-verifying every title inside
   * the session immediately before the click. Mutate-gui: lease + audit
   * + the same pid/session re-checks every command gets.
   *
   * The verdicts are the script's own: `clicked` is the only success;
   * `changed`/`not-found`/`nomenubar`/`missing` are provable
   * non-mutations; `failed` means the press errored after the identity
   * checks passed — surfaced as `GuiMutationError` (indeterminate).
   */
  invokeMenuItem(target: {
    readonly path: readonly number[];
    readonly titles: readonly string[];
  }): MenuInvokeVerdict {
    return this.#mutate("invokeMenuItem", () => {
      const result = this.#osascript(INVOKE_MENU_ITEM_SCRIPT, [
        String(this.#pid),
        target.path.join(","),
        target.titles.join("|"),
      ]);
      const verdict = result.stdout.trim();
      switch (verdict) {
        case "CLICKED":
          return "clicked";
        case "NOT_FOUND":
          return "not-found";
        case "CHANGED":
          return "changed";
        case "FAILED":
          // The press was attempted and errored — outcome unknown.
          throw new GuiMutationError(
            "the menu item press was attempted but System Events reported failure; " +
              "the outcome is unknown — re-observe before any retry",
          );
        case "MISSING":
          return "missing";
        case "NOMENUBAR":
          return "nomenubar";
        default:
          // An unrecognized verdict cannot prove the press did not
          // happen — treat it as unknown, never as a clean refusal.
          throw new GuiMutationError(
            `the menu invoke returned an unrecognized verdict "${verdict}"; ` +
              "the outcome is unknown — re-observe before any retry",
          );
      }
    },
    // Only "clicked" performed a mutation; every other verdict is a
    // provable non-mutation the audit must not record as a press.
    (verdict) => verdict === "clicked");
  }

  /**
   * Runs an AppleScript in the target session — the same contract as
   * `MacGuiRecovery.#osascript`: arguments are `argv`, never source, and
   * the pid/session re-checks run before every command.
   */
  #osascript(script: readonly string[], args: readonly string[]): SessionCommandResult {
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
        `the menu-bar accessibility query in ${this.#session.username}'s session failed: ` +
          result.stderr.trim(),
      );
    }
    return result;
  }

  /**
   * Refuses unless `pid` still names the process this surface was built
   * for — same rule as `MacGuiRecovery.#assertSameProcess`: a reused pid
   * must never receive a menu press meant for the original instance.
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
        `the After Effects process ${this.#pid} is no longer the one this surface ` +
          "was built for (A8N-AE-004); no GUI action was taken.",
        { code: "A8N-AE-004" },
      );
    }
  }

  /**
   * Re-proves the target session immediately before each command —
   * copied from `MacGuiRecovery.#assertSessionProof` (issue #59 T035):
   * the session proven at construction can end or change, and acting on
   * a stale proof could reach the screen the human is looking at.
   */
  #assertSessionProof(): void {
    const proven = this.#session;
    const current = this.#readTargetSession();
    const consoleUid = this.#consoleUid();
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
      `the login session this menu surface proved (uid ${proven.uid}, asid ` +
        `${proven.asid ?? "unknown"}, kind ${proven.kind}) no longer holds — it now ` +
        `reads as ${now}` +
        `${needsConsoleProof && consoleUid < 0 ? "; the console owner could not be read" : ""}. ` +
        "No GUI action was taken.",
    );
  }
}
