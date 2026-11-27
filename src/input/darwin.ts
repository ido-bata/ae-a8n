/**
 * macOS delivery for the input contract (#372,
 * `specs/ime-input/spec.md` §5–§7, parent #344 / program #337).
 *
 * This module is the darwin half of `src/input/`: it turns the
 * `InputPoster` / `InputClipboardOps` / `InputImeOps` / `InputFocusOps`
 * ports that `runInputPlan` injects into calls to the compiled helpers
 * in `scripts/isolated-session/` (`input-post`, `input-clipboard`,
 * `input-source`, `input-focus`), executed inside the target session via
 * `runInSession` — the same boundary `gui-recovery` uses.
 *
 * SAFETY — read before wiring this anywhere:
 *
 *   - These helpers post REAL CGEvents and mutate the real pasteboard /
 *     input source. They are delivery vehicles only. Every call must
 *     arrive through `runInputPlan`, which enforces attribution →
 *     `inputAuthorizationVerdict` → `inputMutationGate()` (fail-closed
 *     today) → the three-step focus proof BEFORE the first post. Nothing
 *     in this file checks the gate itself; do not call the ops
 *     directly from a mutation path.
 *   - `requestFocus` is intentionally unimplemented: #372 ships focus
 *     *readback* only. Any session-stream op will therefore refuse
 *     `focus-unproven` until a focus-request channel lands — that is
 *     the honest fail-closed state, not a bug.
 *   - `CGEventPostToPid` (`to-pid`) exists in the helper for the T001
 *     experiment but is deliberately NOT exposed on the poster: its IME
 *     pass-through behavior is unverified, and the contract has no
 *     operation kind for it yet.
 *
 * Verification level reached here: `implemented` + `automated test`
 * (argument validation, argv construction, JSON parsing against fakes,
 * helper compilation on darwin). Real delivery — whether a posted
 * event reaches a focused After Effects control, and whether it
 * traverses the input-method stack — is `unverified` and stays so until
 * a real-host ticket runs it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runInSession,
  type MacSession,
} from "../driver/mac-session.js";
import type { InputFocusOps } from "./focus.js";
import type { InputClipboardOps, InputImeOps } from "./runner.js";
import type {
  ClipboardSnapshot,
  FocusHolder,
  InputPoster,
} from "./types.js";
import type {
  DragDropFilePayload,
  DragDropVerdict,
} from "../dragdrop/types.js";

/** The compiled helper binaries this adapter can invoke. */
export type DarwinInputHelper =
  | "input-post"
  | "input-clipboard"
  | "input-source"
  | "input-focus"
  | "input-mouse"
  | "input-drag";

export const DARWIN_INPUT_HELPERS: readonly DarwinInputHelper[] = [
  "input-post",
  "input-clipboard",
  "input-source",
  "input-focus",
  "input-mouse",
  "input-drag",
];

/** The exec seam: run one helper with args inside the target session. */
export type DarwinInputExec = (
  helper: DarwinInputHelper,
  args: readonly string[],
) => { readonly status: number; readonly stdout: string; readonly stderr: string };

/**
 * The production exec: `runInSession` against a directory of compiled
 * helpers. The helpers must be built first (`swiftc -O` per
 * `scripts/isolated-session/input-*.swift`); this adapter never compiles
 * or downloads anything itself.
 */
export function sessionInputExec(options: {
  readonly session: MacSession;
  /** Directory containing the compiled helper binaries. */
  readonly helpersDir: string;
  readonly timeoutMs?: number;
}): DarwinInputExec {
  return (helper, args) =>
    runInSession(options.session, join(options.helpersDir, helper), args, {
      timeoutMs: options.timeoutMs ?? 30_000,
    });
}

/** Thrown when a helper exits non-zero; carries its stderr as the reason. */
export class DarwinInputError extends Error {
  readonly helper: DarwinInputHelper;
  readonly exitStatus: number;

  constructor(helper: DarwinInputHelper, exitStatus: number, detail: string) {
    super(`${helper} failed (exit ${exitStatus}): ${detail}`);
    this.name = "DarwinInputError";
    this.helper = helper;
    this.exitStatus = exitStatus;
  }
}

const MAX_TEXT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 256;

function assertTextArg(
  helper: DarwinInputHelper,
  value: string,
  label: string,
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new DarwinInputError(helper, 2, `${label} must be a string of 1..${MAX_TEXT_LENGTH} chars`);
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new DarwinInputError(helper, 2, `${label} contains control characters`);
  }
}

function assertNameArg(
  helper: DarwinInputHelper,
  value: string,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NAME_LENGTH ||
    // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DarwinInputError(helper, 2, `${label} must be a non-empty name without whitespace`);
  }
}

function assertMods(modifiers: readonly string[] | undefined): string[] {
  const mods = [...new Set(modifiers ?? [])];
  for (const mod of mods) assertNameArg("input-post", mod, "modifier");
  return mods;
}

function run(
  exec: DarwinInputExec,
  helper: DarwinInputHelper,
  args: readonly string[],
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = exec(helper, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic";
    throw new DarwinInputError(helper, result.status, detail);
  }
  return result;
}

function parseJson<T>(helper: DarwinInputHelper, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new DarwinInputError(helper, 1, `unparseable JSON receipt: ${stdout.slice(0, 200)}`);
  }
}

// MARK: - InputPoster

/**
 * The keyboard/text/mode poster. `tap` selects the CGEvent tap location:
 * `"session"` (default, kCGSessionEventTap) or `"hid"` (kCGHIDEventTap).
 * The `to-pid` channel is intentionally not exposed — see the module
 * header.
 */
export function darwinInputPoster(
  exec: DarwinInputExec,
  options: { readonly tap?: "hid" | "session" | undefined } = {},
): InputPoster {
  const tap = options.tap ?? "session";

  const keyArgs = (
    verb: "down" | "up",
    key: string,
    modifiers: readonly string[] | undefined,
  ): string[] => {
    assertNameArg("input-post", key, "key");
    const mods = assertMods(modifiers);
    const args = ["key", verb, "--key", key, "--tap", tap];
    if (mods.length > 0) args.push("--mods", mods.join(","));
    return args;
  };

  return {
    keyDown(key, modifiers) {
      run(exec, "input-post", keyArgs("down", key, modifiers));
    },
    keyUp(key, modifiers) {
      run(exec, "input-post", keyArgs("up", key, modifiers));
    },
    typeSequential(text) {
      assertTextArg("input-post", text, "text");
      run(exec, "input-post", ["type", "--text", text, "--tap", tap]);
    },
    postText(text) {
      assertTextArg("input-post", text, "text");
      run(exec, "input-post", ["post-text", "--text", text, "--tap", tap]);
    },
    clipboardWrite(text) {
      assertTextArg("input-clipboard", text, "text");
      run(exec, "input-clipboard", ["write", "--text", text]);
    },
    imeSelect(mode) {
      assertNameArg("input-source", mode, "ime mode");
      run(exec, "input-source", ["select", "--mode", mode]);
    },
    // mouse is deliberately absent: drag/scroll/hover have no helper in
    // this slice, and a missing channel makes the runner refuse
    // `unsupported` at preflight rather than post blind.
  };
}

// MARK: - InputClipboardOps

/**
 * NSPasteboard snapshot/write/restore. `snapshot` stashes the prior
 * contents in a private file (mode 600, under `stashDir`) and returns
 * only the flavors+digest+bytes record the audit contract carries;
 * `restore` looks the stash up by digest and writes it back. A snapshot
 * this instance did not create cannot be restored — that is reported,
 * never silently skipped.
 */
export function darwinClipboardOps(
  exec: DarwinInputExec,
  options: { readonly stashDir?: string | undefined } = {},
): InputClipboardOps {
  const stashDir =
    options.stashDir ??
    (() => {
      const dir = join(tmpdir(), `ae-a8n-input-${process.pid}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    })();
  mkdirSync(stashDir, { recursive: true, mode: 0o700 });
  const stashByDigest = new Map<string, string>();

  return {
    snapshot() {
      const path = join(stashDir, `clip-${randomUUID()}.bin`);
      const result = run(exec, "input-clipboard", ["snapshot", "--stash", path]);
      const parsed = parseJson<ClipboardSnapshot & { items?: number; unreadable?: number }>(
        "input-clipboard",
        result.stdout,
      );
      stashByDigest.set(parsed.sha256, path);
      return {
        flavors: parsed.flavors,
        sha256: parsed.sha256,
        bytes: parsed.bytes,
      };
    },
    restore(snapshot: ClipboardSnapshot) {
      const path = stashByDigest.get(snapshot.sha256);
      if (path === undefined) {
        throw new DarwinInputError(
          "input-clipboard",
          1,
          "no stashed clipboard contents for this snapshot digest — " +
            "refusing to restore blind",
        );
      }
      try {
        run(exec, "input-clipboard", ["restore", "--stash", path]);
      } finally {
        stashByDigest.delete(snapshot.sha256);
        rmSync(path, { force: true });
      }
    },
  };
}

// MARK: - InputImeOps

/**
 * TIS input-source query/restore. `currentMode` reports the source ID
 * (stable across renames) falling back to the localized name; `restore`
 * re-selects it. `restore(null)` is a no-op — there was no prior mode
 * to put back, and the cleanup record shows the action as performed.
 */
export function darwinImeOps(exec: DarwinInputExec): InputImeOps {
  return {
    currentMode() {
      const result = run(exec, "input-source", ["current"]);
      const parsed = parseJson<{ mode: string | null }>("input-source", result.stdout);
      return { mode: parsed.mode };
    },
    restore(mode: string | null) {
      if (mode === null) return;
      run(exec, "input-source", ["select", "--mode", mode]);
    },
  };
}

/**
 * Probe whether a Japanese input method is installed — the honest
 * `unavailable`/`needs-human` answer spec §7 requires. Read-only: it
 * lists input sources and matches on id/name, never selects anything.
 */
export function darwinImeAvailability(
  exec: DarwinInputExec,
): { readonly state: "available" | "unavailable" | "unknown"; readonly detail: string } {
  const result = run(exec, "input-source", ["list"]);
  const parsed = parseJson<{
    sources?: { id?: string; name?: string; type?: string }[];
  }>("input-source", result.stdout);
  const sources = parsed.sources ?? [];
  const japanese = /japanese|kotoeri|imkit|ことえり/i;
  const hit = sources.find(
    (s) =>
      japanese.test(s.id ?? "") ||
      japanese.test(s.name ?? "") ||
      (s.type ?? "").includes("Keyboard Input Method"),
  );
  // A keyboard-input-method source alone does not prove Japanese; require
  // the id/name match for "available", else report what was found.
  const ja = sources.find(
    (s) => japanese.test(s.id ?? "") || japanese.test(s.name ?? ""),
  );
  if (ja !== undefined) {
    return {
      state: "available",
      detail: `Japanese input source present: ${ja.id ?? ja.name ?? "unknown"}`,
    };
  }
  if (hit !== undefined) {
    return {
      state: "unavailable",
      detail:
        "input methods are installed but none match Japanese " +
        "(Kotoeri/IMKit); enable one in System Settings to change this",
    };
  }
  return {
    state: "unavailable",
    detail: "no keyboard input methods installed — nothing to select",
  };
}

// MARK: - InputFocusOps

/**
 * Focus readback via `input-focus read`. `requestFocus` throws: #372
 * ships readback only, so session-stream ops refuse `focus-unproven`
 * rather than posting into an unproven holder.
 */
export function darwinFocusOps(exec: DarwinInputExec): InputFocusOps {
  return {
    readFocusHolder() {
      const result = run(exec, "input-focus", ["read"]);
      const parsed = parseJson<{
        pid: number | null;
        app: string | null;
        element: string | null;
        observedAt?: string;
      }>("input-focus", result.stdout);
      if (parsed.pid === null || parsed.pid <= 0) return null;
      const holder: FocusHolder = {
        pid: parsed.pid,
        element: parsed.element ?? null,
        app: parsed.app ?? null,
        observedAt: parsed.observedAt ?? new Date().toISOString(),
      };
      return holder;
    },
    requestFocus() {
      throw new DarwinInputError(
        "input-focus",
        2,
        "focus request is not implemented on darwin in this slice " +
          "(#372 ships readback only); session-stream ops will refuse " +
          "focus-unproven — fail-closed by design",
      );
    },
  };
}

// MARK: - Mouse click (#368)

/**
 * One CGEvent mouse click through `input-mouse` — the context-menu
 * right-click vehicle (#368, `specs/workspace-editing/spec.md` §9).
 * Deliberately NOT part of `InputPoster`: the input contract's mouse
 * taxonomy (drag/scroll/hover) is B-IME's and stays absent here; this
 * is the single click channel the workspace context-menu slice needs.
 *
 * Coordinates are global display points in the target session — the
 * caller must derive them from a re-verified frame. Returns nothing on
 * success; a non-zero helper exit throws `DarwinInputError`, which the
 * caller maps to `indeterminate` (the click may have partially landed).
 */
export function darwinMouseClick(
  exec: DarwinInputExec,
  options: { readonly tap?: "hid" | "session" | undefined } = {},
): (request: {
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "right" | "middle" | undefined;
}) => void {
  const tap = options.tap ?? "session";
  return ({ x, y, button = "left" }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DarwinInputError("input-mouse", 2, "click coordinates must be finite numbers");
    }
    run(exec, "input-mouse", [
      "click",
      "--x", String(Math.round(x)),
      "--y", String(Math.round(y)),
      "--button", button,
      "--tap", tap,
    ]);
  };
}

// MARK: - Mouse drag / file drop (#422)

/**
 * The `input-drag` vehicle channels for the drag-drop contract (#422,
 * `specs/workspace-editing/spec.md` §9). Deliberately NOT part of
 * `InputPoster`: these post real drags — `press`/`move`/`release` are
 * one CGEvent segment each so the controller can re-check the census
 * between them, and `filedrag` runs the whole NSDraggingSession
 * atomically inside the helper.
 *
 * Every channel returns the helper's verdict; a non-zero exit throws
 * `DarwinInputError`, which the caller maps to `indeterminate` (the
 * drag may have partially landed). These functions check nothing
 * themselves — the gate chain lives in `src/dragdrop/` and must already
 * be satisfied before they are called.
 */
export type DarwinDragChannels = {
  readonly press: (point: { readonly x: number; readonly y: number }) => DragDropVerdict;
  readonly move: (point: { readonly x: number; readonly y: number }) => DragDropVerdict;
  readonly release: (point: { readonly x: number; readonly y: number }) => DragDropVerdict;
  readonly fileDrag: (request: {
    readonly file: DragDropFilePayload;
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
    readonly steps: number;
    readonly stepDelayMs: number;
    readonly dwellMs: number;
  }) => { readonly verdict: DragDropVerdict; readonly operation: string | null };
};

const DRAG_VERDICTS: readonly DragDropVerdict[] = [
  "performed",
  "not-performed",
  "failed",
];

function dragVerdict(
  helper: DarwinInputHelper,
  stdout: string,
  fallbackAction: string,
): DragDropVerdict {
  try {
    const parsed = JSON.parse(stdout) as { verdict?: unknown; action?: unknown; ok?: unknown };
    if (
      typeof parsed.verdict === "string" &&
      (DRAG_VERDICTS as readonly string[]).includes(parsed.verdict)
    ) {
      return parsed.verdict as DragDropVerdict;
    }
    // A receipt without a verdict field still proves the events were
    // posted when ok:true and the action matches — performed.
    if (parsed.ok === true && parsed.action === fallbackAction) {
      return "performed";
    }
  } catch {
    // Fall through to the honest default below.
  }
  throw new DarwinInputError(
    helper,
    1,
    `unparseable drag receipt: ${stdout.slice(0, 200)}`,
  );
}

export function darwinDragChannels(
  exec: DarwinInputExec,
  options: { readonly tap?: "hid" | "session" | undefined } = {},
): DarwinDragChannels {
  const tap = options.tap ?? "session";
  const pointArgs = (action: string, point: { readonly x: number; readonly y: number }) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new DarwinInputError("input-drag", 2, `${action} coordinates must be finite numbers`);
    }
    return [
      action,
      "--x", String(Math.round(point.x)),
      "--y", String(Math.round(point.y)),
      "--tap", tap,
    ];
  };
  const segment = (action: "press" | "move" | "release") =>
    (point: { readonly x: number; readonly y: number }): DragDropVerdict => {
      const result = run(exec, "input-drag", pointArgs(action, point));
      return dragVerdict("input-drag", result.stdout, action);
    };
  return {
    press: segment("press"),
    move: segment("move"),
    release: segment("release"),
    fileDrag(request) {
      const args = [
        "filedrag",
        "--file", request.file.path,
        "--from", `${Math.round(request.from.x)},${Math.round(request.from.y)}`,
        "--to", `${Math.round(request.to.x)},${Math.round(request.to.y)}`,
        "--steps", String(Math.max(1, Math.floor(request.steps))),
        "--step-delay-ms", String(Math.max(0, Math.floor(request.stepDelayMs))),
        "--dwell-ms", String(Math.max(0, Math.floor(request.dwellMs))),
        "--vend", request.file.vend ?? "fileurl",
      ];
      const result = run(exec, "input-drag", args);
      const verdict = dragVerdict("input-drag", result.stdout, "filedrag");
      let operation: string | null = null;
      try {
        const parsed = JSON.parse(result.stdout) as { operation?: unknown };
        if (typeof parsed.operation === "string") {
          operation = parsed.operation;
        }
      } catch {
        // The verdict already parsed; a missing operation stays null.
      }
      return { verdict, operation };
    },
  };
}

// MARK: - Bundle

/** Everything `runInputPlan` needs from the darwin helpers, in one call. */
export type DarwinInputOps = {
  readonly poster: InputPoster;
  readonly clipboard: InputClipboardOps;
  readonly ime: InputImeOps;
  readonly focus: InputFocusOps;
};

export function darwinInputOps(
  exec: DarwinInputExec,
  options: {
    readonly tap?: "hid" | "session" | undefined;
    readonly stashDir?: string | undefined;
  } = {},
): DarwinInputOps {
  return {
    poster: darwinInputPoster(exec, { tap: options.tap ?? "session" }),
    clipboard: darwinClipboardOps(exec, { stashDir: options.stashDir }),
    ime: darwinImeOps(exec),
    focus: darwinFocusOps(exec),
  };
}
