/**
 * Public input API (#374, `specs/ime-input/spec.md` §5–§6, parent #344 /
 * program #337).
 *
 * `ae.input(locator)` resolves a `PanelTarget` — the same pid-attributed
 * surface resolution `ae.panel()` uses — and returns an `Input` handle
 * whose operations are `InputPlan`s run through `runInputPlan`. Nothing
 * here bypasses the contract: every mutation goes
 * authorize → (global-input authorization) → mutation gate → focus
 * proof → post → cleanup → audit, exactly once, with the GUI lease held
 * around non-observe operations on an owned target.
 *
 * Honesty rules carried from `ae.panel()`/`ae.guiState()`:
 *
 *   - No owned, attested target → operations throw `InputError`
 *     `unavailable`; there is no honest surface list to type into.
 *   - PanelTarget resolution is the macOS AX+census path only in this
 *     slice; other platforms report `unsupported` unless a test seam
 *     supplies surface ops.
 *   - Every mutation is gate-pending: `inputMutationGate()` refuses all
 *     classes today, and session-stream/shared-state scopes additionally
 *     refuse `unavailable` without an explicit `GlobalInputAuthorization`.
 *     Both refusals come back as the audit record's `verdict`, not throws.
 *   - Ops return the `InputAuditRecord` (spec §5.6) — `performed` /
 *     `refused` / `indeterminate` / `failed` with the full evidence —
 *     never a bare success flag. Observe-class queries (`identify`,
 *     `imeModeQuery`, `clipboardRead`) return their data instead, like
 *     `Panel.identify()`.
 *
 * Verification level: `automated test` (fake posters/focus/ops). No real
 * key event has been delivered to After Effects; that stays `unverified`
 * for the real-host ticket.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultLeaseController,
  GuiRecoveryError,
  MacGuiRecovery,
  type GuiAppState,
  type GuiLeaseController,
} from "../driver/gui-recovery.js";
import { defaultGuiLeaseRoot, type GuiLease } from "../platform/darwin/gui-lease.js";
import {
  consoleSessionUid,
  type MacSession,
} from "../driver/mac-session.js";
import type { PanelCensusView } from "../panels/controller.js";
import { resolvePanelTarget } from "../panels/resolve.js";
import { PanelError } from "../panels/types.js";
import type {
  PanelFrame,
  PanelLocator,
  PanelTarget,
} from "../panels/types.js";
import {
  inputCapabilities as inputCapabilityReport,
  type InputCapabilities,
} from "../input/capabilities.js";
import {
  darwinInputOps,
  sessionInputExec,
  type DarwinInputExec,
} from "../input/darwin.js";
import { inputMutationGate, type InputMutationGate } from "../input/gate.js";
import { runInputPlan, type InputRunnerDeps } from "../input/runner.js";
import {
  INPUT_OPERATION_GATES,
  InputError,
  type ClipboardSnapshot,
  type GlobalInputAuthorization,
  type ImeModeSnapshot,
  type InputAuditRecord,
  type InputPlan,
  type InputErrorCode,
} from "../input/types.js";
import type { GuiObservationSeams, GuiObservationTarget } from "./gui-state.js";
import {
  WindowsInputHelpers,
  type WindowsInputChannel,
} from "../platform/windows/input.js";

// ---------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------

/** The session kind input authorization and capabilities are evaluated for. */
export type InputSessionKind = "shared" | "dedicated" | "unknown";

/**
 * Derive the §5.4 session kind from the attested GUI session: the console
 * owner's own session is `"shared"` (a human is looking at it), another
 * user's proven Aqua session is `"dedicated"`, and anything unprovable
 * stays `"unknown"` — never upgraded.
 */
export function inputSessionKind(
  session: MacSession,
  consoleUid: () => number = consoleSessionUid,
): InputSessionKind {
  const uid = consoleUid();
  if (uid >= 0 && session.uid === uid) {
    return "shared";
  }
  if (session.kind === "Aqua" && session.asid !== null) {
    return "dedicated";
  }
  return "unknown";
}

/**
 * What this build can do with OS-level input on `platform` in
 * `sessionKind` — the per-OS/per-session-kind capability report
 * (`specs/ime-input/spec.md` §7). Unsupported combinations are explicit
 * values; the global-input authorization row reports `unavailable`
 * until a grant path exists.
 */
export function inputCapabilities(
  platform: NodeJS.Platform,
  sessionKind: InputSessionKind = "unknown",
): InputCapabilities {
  // The contract covers darwin and win32 only; every other platform
  // reports the darwin row set shape with platform recorded honestly by
  // the caller — same convention as `panelCapabilities`.
  return inputCapabilityReport(
    platform === "win32" ? "win32" : "darwin",
    sessionKind,
  );
}

// ---------------------------------------------------------------------
// Ops dispatch (per-OS delivery channels)
// ---------------------------------------------------------------------

/** Everything `runInputPlan` needs from the platform helpers. */
export type InputOps = Pick<
  InputRunnerDeps,
  "poster" | "focus" | "clipboard" | "ime"
>;

/** What the ops factory needs to build the platform delivery channels. */
export type InputOpsContext = {
  readonly pid: number;
  readonly session: MacSession;
  readonly platform: NodeJS.Platform;
  /**
   * Compiled darwin helper directory when the caller already resolved
   * one (tests, a future packaged-helpers layout). Absent → auto-detect.
   */
  readonly helpersDir?: string | undefined;
  /** win32 command-channel override (tests). */
  readonly channel?: WindowsInputChannel | undefined;
};

export type InputOpsFactory = (ctx: InputOpsContext) => InputOps | null;

// MARK: - darwin helper resolution

const DARWIN_HELPER_NAMES = [
  "input-post",
  "input-clipboard",
  "input-source",
  "input-focus",
  "input-mouse",
] as const;

/**
 * Walk up from this module looking for the repo's
 * `scripts/isolated-session/input-*.swift` sources. Works from both
 * `src/api/` (vitest) and `dist/api/` (compiled) because both sit two
 * levels under the package root. Returns null when the sources are not
 * shipped — the installed npm package does not carry `scripts/`, so a
 * packaged consumer gets `unavailable`, never a guessed path.
 */
function findDarwinHelperSources(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "scripts", "isolated-session");
    if (
      existsSync(join(candidate, "input-post.swift")) &&
      existsSync(join(candidate, "input-focus.swift"))
    ) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Compile the darwin input helpers into a content-keyed cache under the
 * OS temp dir and return the binary directory — or null when the sources
 * are absent or `swiftc` fails. Compilation is a one-time, local,
 * side-effect-bounded step (`swiftc -O`, the same invocation the helper
 * headers document); the binaries are Mach-O executables run inside the
 * target session via `runInSession`. This is the *only* place helpers are
 * built; `src/input/darwin.ts` itself never compiles.
 */
export function ensureDarwinInputHelpers(): string | null {
  const srcDir = findDarwinHelperSources();
  if (srcDir === null) {
    return null;
  }
  try {
    const hash = createHash("sha256");
    for (const name of DARWIN_HELPER_NAMES) {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(join(srcDir, `${name}.swift`)));
    }
    const outDir = join(
      tmpdir(),
      `ae-a8n-input-helpers-${hash.digest("hex").slice(0, 16)}`,
    );
    const complete = DARWIN_HELPER_NAMES.every((name) =>
      existsSync(join(outDir, name)),
    );
    if (complete) {
      return outDir;
    }
    mkdirSync(outDir, { recursive: true });
    for (const name of DARWIN_HELPER_NAMES) {
      execFileSync("swiftc", ["-O", join(srcDir, `${name}.swift`), "-o", join(outDir, name)], {
        stdio: "pipe",
      });
    }
    return outDir;
  } catch {
    // No swiftc, no sources readable, compile failure — all mean the
    // helpers are unavailable, which the ops report honestly.
    return null;
  }
}

/**
 * The production ops factory: per-OS dispatch to the delivery helpers.
 * Returns null when the platform's helpers cannot be constructed — the
 * caller substitutes fail-closed unavailable ops, never a partial set.
 */
export function platformInputOps(ctx: InputOpsContext): InputOps | null {
  if (ctx.platform === "darwin") {
    const helpersDir = ctx.helpersDir ?? ensureDarwinInputHelpers();
    if (helpersDir === null) {
      return null;
    }
    const exec: DarwinInputExec = sessionInputExec({
      session: ctx.session,
      helpersDir,
    });
    return darwinInputOps(exec);
  }
  if (ctx.platform === "win32") {
    // One helper object serves all four ports: SendInput posting, Win32
    // clipboard, TSF profiles and focus readback/request. It runs as a
    // powershell child of this process — the same session by
    // construction (spec §5.4 session scoping). The `platform` option
    // lets tests construct it off-win32 with a fake channel.
    const helpers = new WindowsInputHelpers({
      platform: "win32",
      ...(ctx.channel !== undefined ? { channel: ctx.channel } : {}),
    });
    return {
      poster: helpers,
      focus: helpers,
      clipboard: helpers,
      ime: helpers,
    };
  }
  return null;
}

/**
 * Fail-closed ops for a platform whose helpers cannot be built: every
 * port exists but throws `unavailable`, so plans still flow through
 * `runInputPlan` and produce honest audit records instead of bypassing
 * the gate or crashing on a missing channel.
 */
function unavailableInputOps(reason: string): InputOps {
  const fail = (): never => {
    throw new InputError("unavailable", reason);
  };
  return {
    poster: {
      keyDown: () => fail(),
      keyUp: () => fail(),
    },
    focus: {
      readFocusHolder: () => null,
      requestFocus: () => fail(),
    },
  };
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/** Map a `PanelError` resolution refusal onto the input vocabulary. */
function asInputError(error: unknown): InputError {
  if (error instanceof InputError) {
    return error;
  }
  if (error instanceof PanelError) {
    const code: InputErrorCode =
      error.code === "ambiguous"
        ? "ambiguous-target"
        : error.code === "stale-locator"
          ? "refused"
          : error.code;
    return new InputError(code, error.message, {
      candidates: error.candidates,
      cause: error,
    });
  }
  return new InputError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

// ---------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------

/** The surface-observation half of resolution (AX listing + census). */
export type InputSurfaceOps = {
  observe(): GuiAppState;
  censusWindows(): PanelCensusView;
};

export type InputSeams = GuiObservationSeams & {
  /** Mutation gate override — production falls back to `inputMutationGate()`. */
  readonly authorizeMutation?: InputMutationGate;
  /** Explicit global-input grant; absent on gated scopes refuses `unavailable`. */
  readonly authorization?: GlobalInputAuthorization | null;
  /** Ops factory override — production dispatches per-OS via `platformInputOps`. */
  readonly inputOps?: InputOpsFactory;
  /** darwin helpers dir override (tests / prebuilt helpers). */
  readonly helpersDir?: string | undefined;
  /** win32 command-channel override (tests). */
  readonly channel?: WindowsInputChannel | undefined;
  /** Surface ops override — production binds `MacGuiRecovery` observation. */
  readonly surfaceOps?: InputSurfaceOps;
  /** Focus re-proof interval in steps; default 1 (every step). */
  readonly recheckEvery?: number;
  readonly newOperationId?: () => string;
  readonly now?: () => Date;
};

// ---------------------------------------------------------------------
// macOS surface ops binding (same observation path as `ae.panel()`)
// ---------------------------------------------------------------------

function macInputSurfaceOps(
  target: GuiObservationTarget,
  seams: InputSeams,
): InputSurfaceOps {
  const {
    authorizeMutation: _gate,
    authorization: _auth,
    inputOps: _ops,
    helpersDir: _helpers,
    channel: _channel,
    surfaceOps: _surface,
    recheckEvery: _recheck,
    newOperationId: _opId,
    now: _now,
    ...guiSeams
  } = seams;
  const observer = new MacGuiRecovery({
    session: target.session,
    pid: target.pid,
    // Read-only observation inside the caller's own session — the same
    // allowConsoleSession posture `ae.panel()` takes; mutations are
    // gated separately by the input contract, not by this observer.
    allowConsoleSession: true,
    ...guiSeams,
  });
  return {
    observe: () => observer.listWindows(),
    censusWindows: () => {
      const view = observer.windowServerWindows();
      return {
        available: view.available,
        reason: view.reason,
        windows: view.windows,
      };
    },
  };
}

// ---------------------------------------------------------------------
// The Input handle
// ---------------------------------------------------------------------

const MAX_REPEAT = 1000;

function requireKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("key must be a non-empty string");
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: number | undefined, fallback: number): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT) {
    throw new TypeError(`count must be an integer between 1 and ${MAX_REPEAT}`);
  }
  return count;
}

function requirePoint(
  value: { x?: number; y?: number } | undefined,
): { x: number; y: number } | null {
  if (value === undefined) return null;
  const { x, y } = value;
  if (x === undefined && y === undefined) return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw new TypeError("point must be { x: number, y: number }");
  }
  return { x, y };
}

/**
 * A resolved input surface of the session's owned After Effects. Every
 * method re-resolves the `PanelTarget` first — a handle is a locator,
 * not a cached identity — so a moved, docked or recreated surface is
 * re-proven or refused, never silently retargeted.
 */
export class Input {
  readonly #pid: number;
  readonly #session: MacSession;
  readonly #locator: PanelLocator;
  readonly #surface: InputSurfaceOps;
  readonly #seams: InputSeams;
  readonly #sessionKind: InputSessionKind;
  readonly #sessionId: string | undefined;
  readonly #authorizeMutation: InputMutationGate;
  readonly #authorization: GlobalInputAuthorization | null;
  readonly #now: () => Date;
  #ops: InputOps | null = null;

  constructor(options: {
    readonly target: GuiObservationTarget;
    readonly locator: PanelLocator;
    readonly surface: InputSurfaceOps;
    readonly seams: InputSeams;
  }) {
    this.#pid = options.target.pid;
    this.#session = options.target.session;
    this.#locator = options.locator;
    this.#surface = options.surface;
    this.#seams = options.seams;
    this.#sessionKind = inputSessionKind(this.#session);
    this.#sessionId =
      this.#session.asid !== null ? String(this.#session.asid) : undefined;
    this.#authorizeMutation =
      options.seams.authorizeMutation ?? inputMutationGate();
    this.#authorization = options.seams.authorization ?? null;
    this.#now = options.seams.now ?? (() => new Date());
  }

  /** One fresh PanelTarget resolution; throws InputError on refusal. */
  #resolve(): PanelTarget {
    let state: GuiAppState;
    try {
      state = this.#surface.observe();
    } catch (error) {
      throw asInputError(error);
    }
    let census: PanelCensusView;
    try {
      census = this.#surface.censusWindows();
    } catch (error) {
      census = {
        available: false,
        reason: `window census failed: ${error instanceof Error ? error.message : String(error)}`,
        windows: [],
      };
    }
    try {
      return resolvePanelTarget({
        pid: this.#pid,
        state,
        census: census.available ? census.windows : [],
        locator: this.#locator,
        now: this.#now,
      }).target;
    } catch (error) {
      throw asInputError(error);
    }
  }

  /** The platform delivery channels, built once per handle. */
  #inputOps(): InputOps {
    if (this.#ops !== null) {
      return this.#ops;
    }
    const factory = this.#seams.inputOps ?? platformInputOps;
    const built = factory({
      pid: this.#pid,
      session: this.#session,
      platform: process.platform,
      helpersDir: this.#seams.helpersDir,
      channel: this.#seams.channel,
    });
    this.#ops =
      built ??
      unavailableInputOps(
        `no input delivery helpers are available on ${process.platform} ` +
          "for this session — the darwin helpers need their compiled " +
          "scripts/isolated-session/input-* binaries (auto-built from " +
          "source in a repo checkout) and the win32 helpers need a " +
          "win32 host",
      );
    return this.#ops;
  }

  #leaseController(): GuiLeaseController {
    return (
      this.#seams.lease ??
      defaultLeaseController({
        stateRoot: this.#seams.stateRoot ?? defaultGuiLeaseRoot(),
        session: { uid: this.#session.uid, asid: this.#session.asid },
        ownerId: this.#seams.ownerId ?? "ae-a8n",
      })
    );
  }

  #auditObserve(op: string, outcome: string, detail?: string): void {
    try {
      this.#leaseController().audit({
        kind: "observe",
        op,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch {
      // An audit failure must not mask the observation's own result.
    }
  }

  /**
   * Run one plan: resolve → owned check → lease (non-observe) →
   * `runInputPlan` → audit → release. Resolution refusals throw
   * `InputError`; plan outcomes come back as the audit record.
   */
  async #run(
    plan: InputPlan | ((deps: InputOps, target: PanelTarget) => InputPlan),
  ): Promise<InputAuditRecord> {
    const target = this.#resolve();
    const ops = this.#inputOps();
    const resolved = typeof plan === "function" ? plan(ops, target) : plan;
    const gateRow = INPUT_OPERATION_GATES[resolved.operation];
    const deps: InputRunnerDeps = {
      target,
      poster: ops.poster,
      focus: ops.focus,
      ...(ops.clipboard !== undefined ? { clipboard: ops.clipboard } : {}),
      ...(ops.ime !== undefined ? { ime: ops.ime } : {}),
      authorizeMutation: this.#authorizeMutation,
      authorization: this.#authorization,
      sessionKind: this.#sessionKind,
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      expectedFocus: { pid: target.pid, element: null },
      recheckEvery: this.#seams.recheckEvery ?? 1,
      ...(this.#seams.newOperationId !== undefined
        ? { newOperationId: this.#seams.newOperationId }
        : {}),
      ...(this.#seams.now !== undefined ? { now: this.#seams.now } : {}),
    };

    // Observe-class ops never take the lease; mutations on a proven
    // owned target run inside it (spec §5.1: lease → audit → act).
    // Non-owned targets skip the lease — the runner refuses `unproven`
    // before anything could post.
    if (gateRow.class === "observe" || target.surface.attribution !== "owned") {
      return runInputPlan(resolved, deps);
    }

    const leaseCtl = this.#leaseController();
    const op = `input:${resolved.operation}`;
    let lease: GuiLease;
    try {
      lease = leaseCtl.acquire(op);
    } catch (error) {
      if (error instanceof GuiRecoveryError) {
        throw new InputError("refused", error.message, { cause: error });
      }
      throw error;
    }
    try {
      const record = await runInputPlan(resolved, deps);
      try {
        leaseCtl.audit({
          kind: "mutate",
          op,
          outcome: record.verdict,
          detail: record.refusal?.reason ?? record.verdict,
        });
      } catch {
        // The audit record itself is the primary evidence; a failed
        // lease-log line must not replace the operation's outcome.
      }
      return record;
    } finally {
      let released = true;
      try {
        lease.release();
      } catch {
        released = false;
      }
      try {
        leaseCtl.audit({
          kind: "lease-release",
          op,
          ...(released ? {} : { outcome: "error" }),
        });
      } catch {
        // Nothing left to report to.
      }
    }
  }

  /**
   * Owned-target precondition for observe-class queries that do not go
   * through `runInputPlan`. Throws `InputError`, never guesses.
   */
  #requireOwnedTarget(): PanelTarget {
    const target = this.#resolve();
    if (target.surface.attribution !== "owned") {
      throw new InputError(
        "unproven",
        `the resolved surface's pid attribution is "${target.surface.attribution}", ` +
          'not "owned"; input operations never act on an unproven surface',
      );
    }
    return target;
  }

  // ------------------------------------------------------------- observe

  /** Resolve the locator against the live screen. Observe-class. */
  identify(): Promise<PanelTarget> {
    return Promise.resolve().then(() => {
      const target = this.#resolve();
      this.#auditObserve("input:identify", "performed");
      return target;
    });
  }

  /**
   * Read the current OS IME/input-source mode (observe-class). Returns
   * the platform mode record — `mode: null` is an honest "none", not a
   * failure. Throws `InputError` `unavailable` when no IME port exists.
   */
  imeModeQuery(): Promise<ImeModeSnapshot> {
    return Promise.resolve().then(() => {
      this.#requireOwnedTarget();
      const ops = this.#inputOps();
      if (ops.ime === undefined) {
        throw new InputError(
          "unavailable",
          "no IME mode query channel is available on this platform",
        );
      }
      try {
        const mode = ops.ime.currentMode();
        this.#auditObserve("input:ime-mode-query", "performed");
        return mode instanceof Promise ? mode : Promise.resolve(mode);
      } catch (error) {
        this.#auditObserve(
          "input:ime-mode-query",
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw asInputError(error);
      }
    });
  }

  /**
   * Snapshot the clipboard as flavors + digest + size — never the
   * payload (spec §5.6 sensitive-evidence rule). Observe-class; the
   * snapshot record is what a later `clipboardWrite` restores from.
   */
  clipboardRead(): Promise<ClipboardSnapshot> {
    return Promise.resolve().then(() => {
      this.#requireOwnedTarget();
      const ops = this.#inputOps();
      if (ops.clipboard === undefined) {
        throw new InputError(
          "unavailable",
          "no clipboard read channel is available on this platform",
        );
      }
      try {
        const snap = ops.clipboard.snapshot();
        this.#auditObserve("input:clipboard-read", "performed");
        return snap instanceof Promise ? snap : Promise.resolve(snap);
      } catch (error) {
        this.#auditObserve(
          "input:clipboard-read",
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw asInputError(error);
      }
    });
  }

  // ------------------------------------------------------------ mutations
  // Every method below returns the InputAuditRecord for the op.

  /**
   * Request and verify focus on the resolved surface (spec §6 `focus`).
   * Target-scoped mutate-gui: gated; on darwin the focus-*request*
   * channel is not implemented, so the honest verdict today is a
   * `focus-unproven`/`refused` record, never a blind post.
   */
  focus(): Promise<InputAuditRecord> {
    return this.#run((deps, target) => {
      const expected = { pid: target.pid, element: null };
      return {
        operation: "focus",
        steps: [
          {
            kind: "custom",
            summary: `request focus on pid ${target.pid}`,
            run: () => {
              const result = deps.focus.requestFocus(expected);
              if (
                result !== undefined &&
                typeof result.then === "function"
              ) {
                throw new Error(
                  "the focus request channel is asynchronous; this slice " +
                    "supports synchronous delivery only",
                );
              }
            },
          },
        ],
        readback: () => {
          try {
            const holder = deps.focus.readFocusHolder();
            return holder === null ? null : JSON.stringify(holder);
          } catch {
            return null;
          }
        },
      };
    });
  }

  /**
   * Press a key — `key-press` (down+up) per `times`. Named keys and
   * modifiers follow the platform helper vocabulary (`cmd`/`ctrl`/…).
   * Session-stream: needs global-input authorization + focus proof.
   */
  press(
    key: string,
    options: { modifiers?: readonly string[]; times?: number } = {},
  ): Promise<InputAuditRecord> {
    const name = requireKey(key);
    const times = requireCount(options.times, 1);
    const modifiers = options.modifiers;
    return this.#run({
      operation: "key",
      steps: Array.from({ length: times }, () => ({
        kind: "key-press" as const,
        key: name,
        ...(modifiers !== undefined ? { modifiers } : {}),
      })),
    });
  }

  /** Hold a key down. Pair with `keyUp`; residue is released by cleanup. */
  keyDown(
    key: string,
    options: { modifiers?: readonly string[] } = {},
  ): Promise<InputAuditRecord> {
    const name = requireKey(key);
    return this.#run({
      operation: "key",
      steps: [
        {
          kind: "key-down",
          key: name,
          ...(options.modifiers !== undefined
            ? { modifiers: options.modifiers }
            : {}),
        },
      ],
    });
  }

  /** Release a held key. Unknown keys are ignored by the pressed-set. */
  keyUp(
    key: string,
    options: { modifiers?: readonly string[] } = {},
  ): Promise<InputAuditRecord> {
    const name = requireKey(key);
    return this.#run({
      operation: "key",
      steps: [
        {
          kind: "key-up",
          key: name,
          ...(options.modifiers !== undefined
            ? { modifiers: options.modifiers }
            : {}),
        },
      ],
    });
  }

  /**
   * Sequential per-character entry through the IME path (spec §6
   * `type` sequential) — the Tier-1b candidate channel. Never claim
   * OS-IME evidence from the audit record alone; Tier-1b verdicts are
   * recorded separately.
   */
  typeSequential(text: string): Promise<InputAuditRecord> {
    return this.#run({
      operation: "type-sequential",
      steps: [{ kind: "type-sequential", text: requireText(text, "text") }],
    });
  }

  /**
   * Direct/bulk entry via the poster's unicode channel — labelled
   * `direct-entry`, NEVER IME evidence (spec §4.2).
   */
  typeDirect(text: string): Promise<InputAuditRecord> {
    return this.#run({
      operation: "type-direct",
      steps: [{ kind: "type-direct", text: requireText(text, "text") }],
    });
  }

  /** Select-all (`cmd+a` / `ctrl+a` per platform). Session-stream. */
  selectAll(): Promise<InputAuditRecord> {
    const modifier = process.platform === "win32" ? "ctrl" : "cmd";
    return this.#run({
      operation: "select",
      steps: [{ kind: "key-press", key: "a", modifiers: [modifier] }],
    });
  }

  /**
   * Replace the current contents: select-all then type over the
   * selection. `entry` picks the text channel — `"sequential"` (IME
   * path, default) or `"direct"` (unicode post, never IME evidence).
   */
  replace(
    text: string,
    options: { entry?: "sequential" | "direct" } = {},
  ): Promise<InputAuditRecord> {
    const body = requireText(text, "text");
    const entry = options.entry ?? "sequential";
    const modifier = process.platform === "win32" ? "ctrl" : "cmd";
    return this.#run({
      operation: "replace",
      steps: [
        { kind: "key-press", key: "a", modifiers: [modifier] },
        entry === "direct"
          ? { kind: "type-direct", text: body }
          : { kind: "type-sequential", text: body },
      ],
    });
  }

  /** Backspace `count` times. Session-stream. */
  deleteBackward(count = 1): Promise<InputAuditRecord> {
    const times = requireCount(count, 1);
    return this.#run({
      operation: "delete",
      steps: Array.from({ length: times }, () => ({
        kind: "key-press" as const,
        key: "backspace",
      })),
    });
  }

  /** Forward-delete `count` times (platform key name mapped). Session-stream. */
  deleteForward(count = 1): Promise<InputAuditRecord> {
    const times = requireCount(count, 1);
    const key = process.platform === "win32" ? "delete" : "forwarddelete";
    return this.#run({
      operation: "delete",
      steps: Array.from({ length: times }, () => ({
        kind: "key-press" as const,
        key,
      })),
    });
  }

  /**
   * Write the clipboard (shared-state: save+restore is mandatory and
   * the op needs global-input authorization). The write leg of
   * `type-direct`-via-paste is composed by the caller as
   * `clipboardWrite` + `press("v", {modifiers:[paste]})` — labelled
   * direct-entry, never IME evidence.
   */
  clipboardWrite(text: string): Promise<InputAuditRecord> {
    return this.#run({
      operation: "clipboard-write",
      steps: [
        { kind: "clipboard-write", text: requireText(text, "text") },
      ],
    });
  }

  /**
   * Select an OS IME/input-source mode by platform id/name
   * (shared-state: user-global, save+restore mandatory). `mode` is the
   * value `imeModeQuery()` reported.
   */
  imeModeSelect(mode: string): Promise<InputAuditRecord> {
    return this.#run({
      operation: "ime-mode-select",
      steps: [
        {
          kind: "ime-mode-select",
          mode: requireText(mode, "mode"),
        },
      ],
    });
  }

  // ------------------------------------------------------------ mouse

  /** Center of the freshly resolved target frame, in points. */
  #frameCenter(target: PanelTarget): { x: number; y: number } {
    const f: PanelFrame = target.surface.frame;
    return {
      x: Math.round(f.x + f.width / 2),
      y: Math.round(f.y + f.height / 2),
    };
  }

  #pointOrCenter(
    point: { x?: number; y?: number } | undefined,
    target: PanelTarget,
  ): { x: number; y: number } {
    const explicit = requirePoint(point);
    return explicit ?? this.#frameCenter(target);
  }

  /**
   * Click on the target — coordinates default to the re-verified frame
   * center, never a remembered position (spec §6 mouse row).
   * Target-scoped mutate-gui.
   */
  click(
    options: { x?: number; y?: number; button?: "left" | "right" } = {},
  ): Promise<InputAuditRecord> {
    const button = options.button ?? "left";
    if (button !== "left" && button !== "right") {
      throw new TypeError('button must be "left" or "right"');
    }
    return this.#run((_deps, target) => {
      const at = this.#pointOrCenter(options, target);
      return {
        operation: "mouse-click",
        steps: [
          {
            kind: "custom",
            channel: "mouse",
            summary: `mouse click at ${at.x},${at.y} (${button})`,
            run: (poster) => {
              if (poster.mouse === undefined) {
                throw new Error("the poster has no mouse channel");
              }
              poster.mouse({ type: "click", x: at.x, y: at.y, button });
            },
          },
        ],
      };
    });
  }

  /** Drag between two points in the target's coordinate space. */
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<InputAuditRecord> {
    const a = requirePoint(from);
    const b = requirePoint(to);
    if (a === null || b === null) {
      throw new TypeError("drag requires explicit from/to points");
    }
    return this.#run({
      operation: "mouse-drag",
      steps: [
        {
          kind: "custom",
          channel: "mouse",
          summary: `mouse drag ${a.x},${a.y} → ${b.x},${b.y}`,
          run: (poster) => {
            if (poster.mouse === undefined) {
              throw new Error("the poster has no mouse channel");
            }
            poster.mouse({ type: "drag", from: a, to: b });
          },
        },
      ],
    });
  }

  /** Scroll over the target; `x`/`y` default to the frame center. */
  scroll(options: {
    x?: number;
    y?: number;
    dx: number;
    dy: number;
  }): Promise<InputAuditRecord> {
    if (
      typeof options.dx !== "number" ||
      typeof options.dy !== "number" ||
      !Number.isFinite(options.dx) ||
      !Number.isFinite(options.dy)
    ) {
      throw new TypeError("scroll requires numeric dx and dy");
    }
    return this.#run((_deps, target) => {
      const at = this.#pointOrCenter(options, target);
      return {
        operation: "mouse-scroll",
        steps: [
          {
            kind: "custom",
            channel: "mouse",
            summary: `mouse scroll dx=${options.dx} dy=${options.dy} at ${at.x},${at.y}`,
            run: (poster) => {
              if (poster.mouse === undefined) {
                throw new Error("the poster has no mouse channel");
              }
              poster.mouse({
                type: "scroll",
                x: at.x,
                y: at.y,
                dx: options.dx,
                dy: options.dy,
              });
            },
          },
        ],
      };
    });
  }

  /** Hover over the target; defaults to the frame center. */
  hover(options: { x?: number; y?: number } = {}): Promise<InputAuditRecord> {
    return this.#run((_deps, target) => {
      const at = this.#pointOrCenter(options, target);
      return {
        operation: "mouse-hover",
        steps: [
          {
            kind: "custom",
            channel: "mouse",
            summary: `mouse hover at ${at.x},${at.y}`,
            run: (poster) => {
              if (poster.mouse === undefined) {
                throw new Error("the poster has no mouse channel");
              }
              poster.mouse({ type: "hover", x: at.x, y: at.y });
            },
          },
        ],
      };
    });
  }
}

/**
 * The `ae.input()` body: attest the owned target, refuse unsupported
 * platforms without a surface-ops seam, and bind the handle. Called with
 * the session's `recoveryTarget()` — `null` means no owned pid/session
 * is provable.
 */
export function inputForTarget(
  target: GuiObservationTarget | null,
  locator: PanelLocator,
  seams: InputSeams = {},
): Input {
  if (target === null) {
    throw new InputError(
      "unavailable",
      "no owned After Effects process and GUI session is attested for this session " +
        "(ownership must be \"owned\" and the transport must name its target); " +
        "there is no proven surface list to resolve input against",
    );
  }
  if (process.platform !== "darwin" && seams.surfaceOps === undefined) {
    throw new InputError(
      "unsupported",
      `input operations resolve PanelTargets through the macOS AX+census ` +
        `path only in this slice; platform is ${process.platform}`,
    );
  }
  const surface =
    seams.surfaceOps ?? macInputSurfaceOps(target, seams);
  return new Input({ target, locator, surface, seams });
}
