/**
 * The Windows input helpers (#373, `specs/ime-input/spec.md` §5–§7,
 * parent #344 / program #337).
 *
 * This module is the platform adapter half of the input contract
 * (#371): it turns the `InputPoster` / `InputFocusOps` /
 * `InputClipboardOps` / `InputImeOps` ports into PowerShell child
 * processes running the `input-*-script.ts` helpers, and it is the
 * object a caller hands to `runInputPlan` as `deps.poster`/`deps.focus`/
 * `deps.clipboard`/`deps.ime`.
 *
 * Safety posture — unchanged from the contract:
 *
 *   - NOTHING here authorizes anything. `runInputPlan` still runs the
 *     `inputAuthorizationVerdict` check and the fail-closed
 *     `inputMutationGate()` before a single poster method may be
 *     reached through the runner. These helpers are delivery channels
 *     only; a caller that invokes them directly bypasses every gate,
 *     which is exactly why they are internal (`src/platform/windows`)
 *     and not exported from the package surface.
 *   - Every helper runs as a `powershell.exe` child of this process,
 *     so it lands on this session's desktop by construction — the same
 *     session-scoping argument `gui-act-script.ts` documents. There is
 *     no Windows equivalent of `launchctl asuser`; the scripts emit
 *     their own session id and the focus readback cross-checks the
 *     focused pid's session against ours.
 *   - Delivery is UNVERIFIED. No Windows host lane exists; UIPI /
 *     integrity-level interaction with `SendInput`, `SetForegroundWindow`
 *     foreground-lock rules, and whether TSF activation reaches an
 *     installed IME are all unproven. The verification level of
 *     everything here is `implemented` + `automated test` (script
 *     validation and fake-channel behavior), never `verified on real
 *     host`.
 *
 * The `KEYEVENTF_UNICODE` (`postText`) channel bypasses the IME by
 * design — it is the `type-direct` vehicle and is NEVER Tier-1b IME
 * evidence (spec §4.2). VK/scan events (`keyDown`/`typeSequential`)
 * traverse the normal input pipeline and are the Tier-1b candidate.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { InputFocusOps } from "../../input/focus.js";
import type {
  ClipboardSnapshot,
  ExpectedFocus,
  FocusHolder,
  ImeModeSnapshot,
  InputMouseEvent,
  InputPoster,
} from "../../input/types.js";
import type { InputClipboardOps, InputImeOps } from "../../input/runner.js";
import {
  encodeWindowsInputSendEvents,
  windowsInputSendScript,
  type WindowsInputSendEvent,
  type WindowsInputSendKeyEvent,
} from "./input-send-script.js";
import { windowsClipboardScript } from "./input-clipboard-script.js";
import { windowsImeScript } from "./input-ime-script.js";
import { windowsFocusScript } from "./input-focus-script.js";

/** The result of one helper invocation. */
export type WindowsInputChannelResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/**
 * The synchronous command channel the helpers run through. Injected so
 * tests drive fakes; the default spawns `powershell.exe` like the
 * existing Windows helpers (`script-invocation.ts` precedent for
 * `execFileSync`).
 */
export type WindowsInputChannel = (script: string) => WindowsInputChannelResult;

const INPUT_SCRIPT_TIMEOUT_MS = 30_000;
const INPUT_SCRIPT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The default channel: one `powershell.exe -NoProfile -NonInteractive
 * -Command` child per helper call. Non-zero exits and spawn failures
 * are returned, not thrown, so callers can classify the stderr.
 */
export function powershellInputChannel(timeoutMs = INPUT_SCRIPT_TIMEOUT_MS): WindowsInputChannel {
  return (script: string): WindowsInputChannelResult => {
    try {
      const stdout = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: INPUT_SCRIPT_MAX_BUFFER,
        },
      );
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        status?: number;
        message?: string;
      };
      return {
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr:
          typeof err.stderr === "string" && err.stderr !== ""
            ? err.stderr
            : (err.message ?? String(error)),
        exitCode: typeof err.status === "number" ? err.status : 1,
      };
    }
  };
}

// ---------------------------------------------------------------- NDJSON

type NdjsonRecord = Record<string, unknown>;

function parseNdjson(stdout: string): NdjsonRecord[] {
  const records: NdjsonRecord[] = [];
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        records.push(value as NdjsonRecord);
      }
    } catch {
      // Malformed lines are skipped; the result/typed record the caller
      // needs either arrives or the call fails closed.
    }
  }
  return records;
}

function lastRecordOfType(records: readonly NdjsonRecord[], type: string): NdjsonRecord | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record !== undefined && record.type === type) return record;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Run one script and return its records; throws on infra failure. */
function runScript(
  channel: WindowsInputChannel,
  script: string,
  what: string,
): NdjsonRecord[] {
  const result = channel(script);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 500);
    throw new Error(
      `${what} helper exited ${result.exitCode}` +
        (detail === "" ? "" : `: ${detail}`),
    );
  }
  return parseNdjson(result.stdout);
}

function resultStatus(records: readonly NdjsonRecord[], what: string): {
  readonly status: string;
  readonly detail: string | null;
} {
  const result = lastRecordOfType(records, "result");
  const status = result === null ? null : asString(result.status);
  if (status === null) {
    throw new Error(`${what} helper produced no result record`);
  }
  return { status, detail: result === null ? null : asString(result.detail) };
}

function assertPosted(records: readonly NdjsonRecord[], what: string): void {
  const { status, detail } = resultStatus(records, what);
  if (status === "POSTED") return;
  if (status === "PARTIAL") {
    // Some events landed and some did not — indeterminate. The runner
    // records this as a failed step; UNKNOWN non-resend means the
    // caller must re-observe, never blindly retry (spec §5.5).
    throw new Error(
      `${what} helper posted only part of the batch` +
        (detail === null ? "" : `: ${detail}`),
    );
  }
  throw new Error(
    `${what} helper did not post` +
      (status === "FAILED" ? "" : ` (${status})`) +
      (detail === null ? "" : `: ${detail}`),
  );
}

// ---------------------------------------------------------------- key map

/**
 * Named-key → VK table for the VK/scan path (the IME-traversing
 * channel). `extended` marks keys that need KEYEVENTF_EXTENDEDKEY
 * (arrows, navigation cluster, right modifiers, Win keys). Printable
 * ASCII characters map through `charVk` below; anything without a VK
 * mapping must go through `postText` (KEYEVENTF_UNICODE, direct-entry,
 * never IME evidence).
 */
type VkEntry = { readonly vk: number; readonly extended?: boolean };

const VK_NAMED: Readonly<Record<string, VkEntry>> = {
  // Modifiers (canonical names the contract's cleanup uses).
  ctrl: { vk: 0x11 },
  control: { vk: 0x11 },
  lctrl: { vk: 0xa2 },
  rctrl: { vk: 0xa3, extended: true },
  shift: { vk: 0x10 },
  lshift: { vk: 0xa0 },
  rshift: { vk: 0xa1 },
  alt: { vk: 0x12 },
  lalt: { vk: 0xa4 },
  ralt: { vk: 0xa5, extended: true },
  win: { vk: 0x5b },
  lwin: { vk: 0x5b, extended: true },
  rwin: { vk: 0x5c, extended: true },
  meta: { vk: 0x5b },
  // Editing / navigation.
  enter: { vk: 0x0d },
  return: { vk: 0x0d },
  escape: { vk: 0x1b },
  esc: { vk: 0x1b },
  tab: { vk: 0x09 },
  space: { vk: 0x20 },
  backspace: { vk: 0x08 },
  delete: { vk: 0x2e, extended: true },
  del: { vk: 0x2e, extended: true },
  insert: { vk: 0x2d, extended: true },
  ins: { vk: 0x2d, extended: true },
  home: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true },
  pgup: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  pgdn: { vk: 0x22, extended: true },
  up: { vk: 0x26, extended: true },
  down: { vk: 0x28, extended: true },
  left: { vk: 0x25, extended: true },
  right: { vk: 0x27, extended: true },
  // Lock / system keys.
  capslock: { vk: 0x14 },
  numlock: { vk: 0x90 },
  scrolllock: { vk: 0x91 },
  pause: { vk: 0x13, extended: true },
  printscreen: { vk: 0x2c, extended: true },
  printscr: { vk: 0x2c, extended: true },
  apps: { vk: 0x5d, extended: true },
  // Function keys.
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, { vk: 0x6f + i }]),
  ),
  // Numpad digits/operators (distinct from the top-row digits).
  numpad0: { vk: 0x60 },
  numpad1: { vk: 0x61 },
  numpad2: { vk: 0x62 },
  numpad3: { vk: 0x63 },
  numpad4: { vk: 0x64 },
  numpad5: { vk: 0x65 },
  numpad6: { vk: 0x66 },
  numpad7: { vk: 0x67 },
  numpad8: { vk: 0x68 },
  numpad9: { vk: 0x69 },
  numpadadd: { vk: 0x6b },
  numpadsubtract: { vk: 0x6d },
  numpadmultiply: { vk: 0x6a },
  numpaddivide: { vk: 0x6f },
  numpaddecimal: { vk: 0x6e },
};

/** Printable ASCII → VK (US layout). Letters map to uppercase VKs. */
function asciiCharVk(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (code >= 0x41 && code <= 0x5a) return code; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x20; // a-z → A-Z VK
  if (code >= 0x30 && code <= 0x39) return code; // 0-9
  switch (char) {
    case " ": return 0x20;
    case ";": return 0xba;
    case "=": return 0xbb;
    case ",": return 0xbc;
    case "-": return 0xbd;
    case ".": return 0xbe;
    case "/": return 0xbf;
    case "`": return 0xc0;
    case "[": return 0xdb;
    case "\\": return 0xdc;
    case "]": return 0xdd;
    case "'": return 0xde;
    default: return null;
  }
}

function resolveKey(key: string): VkEntry {
  const named = VK_NAMED[key.toLowerCase()];
  if (named !== undefined) return named;
  if (key.length === 1) {
    const vk = asciiCharVk(key);
    if (vk !== null) return { vk };
  }
  throw new TypeError(
    `unknown key ${JSON.stringify(key)}: use a named key, a printable ` +
      "ASCII character, or the unicode (direct-entry) channel for text",
  );
}

function normalizeModifiers(modifiers: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const mod of modifiers ?? []) {
    // Validate now: an unknown modifier name must fail before any event
    // is built, not mid-batch.
    resolveKey(mod);
    out.push(mod);
  }
  return out;
}

// ---------------------------------------------------------------- options

export type WindowsInputHelpersOptions = {
  /**
   * Test seam: replaces `process.platform`. Must be `"win32"` for any
   * real use; the constructor refuses otherwise, same posture as
   * `WindowsGuiRecovery`.
   */
  readonly platform?: NodeJS.Platform;
  /** The synchronous command channel; defaults to `powershell.exe`. */
  readonly channel?: WindowsInputChannel;
  /** Per-invocation timeout forwarded to the default channel. */
  readonly timeoutMs?: number;
};

/**
 * The Windows delivery adapter for the input contract ports. One
 * instance serves `runInputPlan` deps: `poster`, `focus`,
 * `clipboard`, `ime`.
 *
 * Every method is synchronous because the `InputPoster` port is
 * synchronous; each call is one bounded `powershell.exe` child. That
 * is deliberate at this verification level (`implemented` +
 * `automated test`): batching/persistent-session optimization is a
 * later concern once a real host can measure it.
 */
export class WindowsInputHelpers
  implements InputPoster, InputFocusOps, InputClipboardOps, InputImeOps
{
  readonly #channel: WindowsInputChannel;
  /** Clipboard payloads held for restore, keyed by snapshot digest. */
  readonly #clipboardPayloads = new Map<
    string,
    { readonly text: string; readonly flavors: readonly string[] }
  >();

  constructor(options: WindowsInputHelpersOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") {
      throw new Error(
        `the Windows input helpers require win32, not ${platform}; ` +
          "there is no session-stream to post into. Nothing was sent.",
      );
    }
    this.#channel =
      options.channel ?? powershellInputChannel(options.timeoutMs);
  }

  // ------------------------------------------------------------ posting

  #post(events: readonly WindowsInputSendEvent[]): void {
    const payload = encodeWindowsInputSendEvents({ events });
    const records = runScript(
      this.#channel,
      windowsInputSendScript(payload),
      "SendInput",
    );
    assertPosted(records, "SendInput");
  }

  #keyEvent(key: string, action: "down" | "up"): WindowsInputSendKeyEvent {
    const entry = resolveKey(key);
    return {
      type: "key",
      action,
      vk: entry.vk,
      ...(entry.extended === true ? { extended: true } : {}),
    };
  }

  keyDown(key: string, modifiers?: readonly string[]): void {
    const mods = normalizeModifiers(modifiers);
    const events: WindowsInputSendEvent[] = [
      ...mods.map((mod) => this.#keyEvent(mod, "down")),
      this.#keyEvent(key, "down"),
    ];
    this.#post(events);
  }

  keyUp(key: string, modifiers?: readonly string[]): void {
    const mods = normalizeModifiers(modifiers);
    // Release order: the key first, then the modifiers in reverse —
    // the unwind order that cannot leave a modifier held under a key.
    const events: WindowsInputSendEvent[] = [
      this.#keyEvent(key, "up"),
      ...[...mods].reverse().map((mod) => this.#keyEvent(mod, "up")),
    ];
    this.#post(events);
  }

  /**
   * Sequential per-character entry through the VK path — the Tier-1b
   * IME candidate channel. Every character must resolve to a VK; a
   * character without one (CJK directly, emoji, …) throws, because
   * silently falling back to unicode would mislabel the evidence.
   *
   * Pacing is not implemented: the batch posts in one SendInput call.
   * "Default human-ish" pacing from spec §6 is a later refinement once
   * a real host can measure what the IME tolerates.
   */
  typeSequential(text: string): void {
    if (typeof text !== "string" || text.length === 0) {
      throw new TypeError("typeSequential requires a non-empty string");
    }
    const events: WindowsInputSendEvent[] = [];
    for (const char of text) {
      // `for..of` iterates code points; a surrogate pair is two UTF-16
      // units and has no single VK — reject honestly.
      if (char.length !== 1) {
        throw new TypeError(
          `type-sequential cannot represent ${JSON.stringify(char)} ` +
            "(multi-code-unit character); use type-direct and label it " +
            "direct-entry — it is never IME evidence",
        );
      }
      let vk: number;
      try {
        vk = asciiCharVk(char) ?? resolveKey(char).vk;
      } catch {
        throw new TypeError(
          `type-sequential cannot represent U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} ` +
            "through the VK path; use type-direct and label it " +
            "direct-entry — it is never IME evidence",
        );
      }
      events.push({ type: "key", action: "down", vk });
      events.push({ type: "key", action: "up", vk });
    }
    this.#post(events);
  }

  /**
   * Direct/bulk entry via KEYEVENTF_UNICODE — bypasses the IME by
   * design. This is the `type-direct` vehicle: label it `direct-entry`
   * and never count it as Tier-1b OS-IME evidence (spec §4.2).
   */
  postText(text: string): void {
    if (typeof text !== "string" || text.length === 0) {
      throw new TypeError("postText requires a non-empty string");
    }
    if (text.length > 8192) {
      throw new TypeError("postText payload exceeds the 8192 UTF-16 unit cap");
    }
    const events: WindowsInputSendEvent[] = [];
    // Iterate UTF-16 code units: KEYEVENTF_UNICODE consumes one unit
    // per event, so surrogate pairs post as their two halves — the
    // documented Win32 behavior for supplementary characters.
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      events.push({ type: "key", action: "down", unicode: String.fromCharCode(unit) });
      events.push({ type: "key", action: "up", unicode: String.fromCharCode(unit) });
    }
    this.#post(events);
  }

  clipboardWrite(text: string): void {
    const records = runScript(
      this.#channel,
      windowsClipboardScript({ mode: "write", text }),
      "clipboard write",
    );
    const { status, detail } = resultStatus(records, "clipboard write");
    if (status !== "WRITTEN") {
      throw new Error(
        `clipboard write was not confirmed` +
          (status === "FAILED" ? "" : ` (${status})`) +
          (detail === null ? "" : `: ${detail}`),
      );
    }
  }

  /**
   * Select an OS IME/input-source mode. `mode` is
   * `"<langid>:<clsid>:<guidProfile>"` — e.g. the shape `currentMode()`
   * returns — where langid is hex (`0x0411`) or decimal. Anything else
   * throws before a script is built.
   */
  imeSelect(mode: string): void {
    const parsed = parseImeMode(mode);
    const records = runScript(
      this.#channel,
      windowsImeScript({
        mode: "activate",
        langid: parsed.langid,
        clsid: parsed.clsid,
        guidProfile: parsed.guidProfile,
      }),
      "IME activate",
    );
    const { status, detail } = resultStatus(records, "IME activate");
    if (status !== "ACTIVATED") {
      throw new Error(
        `IME mode ${JSON.stringify(mode)} was not activated` +
          (status === "ACTIVATE_FAILED" || status === "FAILED" ? "" : ` (${status})`) +
          (detail === null ? "" : `: ${detail}`),
      );
    }
  }

  mouse(event: InputMouseEvent): void {
    const events = mouseToSendEvents(event);
    this.#post(events);
  }

  // ------------------------------------------------------------- focus

  readFocusHolder(): FocusHolder | null {
    const records = runScript(this.#channel, windowsFocusScript({ mode: "read" }), "focus read");
    const focus = lastRecordOfType(records, "focus");
    if (focus === null || focus.ok !== true) return null;
    const pid = asInt(focus.pid);
    if (pid === null || pid <= 0) return null;
    // A holder in another session cannot be typed into from here —
    // treat it as unproven, never as a match (spec §5.3).
    if (focus.sessionMatch === false) return null;
    const element =
      asString(focus.uiaAutomationId) ??
      asString(focus.uiaRuntimeId) ??
      null;
    return {
      pid,
      element: element === "" ? null : element,
      app: asString(focus.app),
      observedAt: new Date().toISOString(),
    };
  }

  requestFocus(expected: ExpectedFocus): void {
    const automationId =
      expected.element !== null && !expected.element.includes(";")
        ? expected.element
        : undefined;
    const records = runScript(
      this.#channel,
      windowsFocusScript({
        mode: "set",
        pid: expected.pid,
        ...(automationId !== undefined ? { automationId } : {}),
      }),
      "focus request",
    );
    const { status, detail } = resultStatus(records, "focus request");
    if (status !== "FOCUSED" && status !== "FOREGROUND_ONLY") {
      throw new Error(
        `focus request was not confirmed` +
          (status === "FAILED" ? "" : ` (${status})`) +
          (detail === null ? "" : `: ${detail}`),
      );
    }
    // The post-set `focus` record is evidence for the audit trail; the
    // runner performs its own readback for the proof, so nothing is
    // asserted here beyond "the request ran".
  }

  restoreFocus(holder: FocusHolder): void {
    const records = runScript(
      this.#channel,
      windowsFocusScript({ mode: "set", pid: holder.pid }),
      "focus restore",
    );
    const { status, detail } = resultStatus(records, "focus restore");
    if (status !== "FOCUSED" && status !== "FOREGROUND_ONLY") {
      throw new Error(
        `focus restore was not confirmed` +
          (status === "FAILED" ? "" : ` (${status})`) +
          (detail === null ? "" : `: ${detail}`),
      );
    }
  }

  // ---------------------------------------------------------- clipboard

  /**
   * Snapshot the clipboard as flavors + digest + size — never the
   * payload in the returned record (spec §5.5/§5.6). The text payload
   * is held in-process keyed by digest so `restore` can put it back;
   * a snapshot this process did not create cannot be restored and
   * fails honestly.
   *
   * Known limitation, recorded not hidden: only the text flavor is
   * restorable through this helper. `flavors` names every format the
   * OS reported, including non-text ones a restore will not bring
   * back — the audit trail must not read that as a full restore.
   */
  clipboardSnapshot(): ClipboardSnapshot {
    const records = runScript(
      this.#channel,
      windowsClipboardScript({ mode: "read" }),
      "clipboard read",
    );
    const clip = lastRecordOfType(records, "clipboard");
    if (clip === null || clip.ok !== true) {
      const error = clip === null ? null : asString(clip.error);
      throw new Error(
        `clipboard read failed` + (error === null ? "" : `: ${error}`),
      );
    }
    const flavors: string[] = [];
    if (Array.isArray(clip.formats)) {
      for (const item of clip.formats) {
        const rec = item as Record<string, unknown> | null;
        const name = rec === null ? null : asString(rec.name);
        if (name !== null) flavors.push(name);
      }
    }
    const text = asString(clip.text) ?? "";
    const bytes = asInt(clip.textBytes) ?? Buffer.byteLength(text, "utf8");
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    this.#clipboardPayloads.set(sha256, { text, flavors });
    return { flavors, sha256, bytes };
  }

  /** `InputClipboardOps.snapshot` — the runner-facing name. */
  snapshot(): ClipboardSnapshot {
    return this.clipboardSnapshot();
  }

  /**
   * Restore a snapshot's text through `CF_UNICODETEXT`. Throws when the
   * payload is not held by this process (e.g. a snapshot that crossed a
   * restart) — restore failure is reported by the cleanup contract,
   * never hidden.
   */
  restoreClipboard(snapshot: ClipboardSnapshot): void {
    const held = this.#clipboardPayloads.get(snapshot.sha256);
    if (held === undefined) {
      throw new Error(
        "clipboard snapshot payload is not held by this process; " +
          "only in-process snapshots can be restored",
      );
    }
    this.clipboardWrite(held.text);
  }

  /**
   * The runner-facing restore for both shared-state ports. The two
   * port signatures collide on the name `restore`, so one dispatch
   * covers both: a `ClipboardSnapshot` restores clipboard text, a
   * `string | null` restores an IME mode (`null` = "no profile was
   * active" → deactivate). Anything else throws.
   */
  restore(value: ClipboardSnapshot | string | null): void {
    if (value === null || typeof value === "string") {
      this.imeRestore(value);
      return;
    }
    this.restoreClipboard(value);
  }

  // ------------------------------------------------------------------ IME

  /**
   * The current TSF input-processor profile as
   * `"<langid>:<clsid>:<guidProfile>"` (langid hex), or `mode: null`
   * when TSF reports no active keyboard profile — an honest "none",
   * not a failure.
   */
  imeCurrentMode(): ImeModeSnapshot {
    const records = runScript(
      this.#channel,
      windowsImeScript({ mode: "query" }),
      "IME query",
    );
    const active = lastRecordOfType(records, "ime-active");
    if (active === null) {
      throw new Error("IME query helper produced no ime-active record");
    }
    if (active.found !== true) {
      return { mode: null };
    }
    const langid = asString(active.langid);
    const clsid = asString(active.clsid);
    const guidProfile = asString(active.guidProfile);
    if (langid === null || clsid === null || guidProfile === null) {
      throw new Error("IME query returned a malformed active profile");
    }
    return { mode: `${langid}:${clsid}:${guidProfile}` };
  }

  /** `InputImeOps.currentMode` — the runner-facing name. */
  currentMode(): ImeModeSnapshot {
    return this.imeCurrentMode();
  }

  /**
   * Restore a prior IME mode. `mode: null` means "no profile was
   * active" — restored by deactivating whatever is active now. Throws
   * on failure; the cleanup contract reports it.
   */
  imeRestore(mode: string | null): void {
    if (mode === null) {
      const records = runScript(
        this.#channel,
        windowsImeScript({ mode: "deactivate" }),
        "IME deactivate",
      );
      const { status, detail } = resultStatus(records, "IME deactivate");
      if (status !== "DEACTIVATED") {
        throw new Error(
          `IME deactivate was not confirmed` +
            (status === "DEACTIVATE_FAILED" || status === "FAILED" ? "" : ` (${status})`) +
            (detail === null ? "" : `: ${detail}`),
        );
      }
      return;
    }
    this.imeSelect(mode);
  }

  /**
   * Enumerate TSF profiles for a LANGID (e.g. `0x0411` Japanese) —
   * the diagnostic/probe surface for "is a Japanese IME installed",
   * which the capability report marks `needs-human` until a real host
   * answers it.
   */
  imeListProfiles(langid: number): readonly {
    readonly langid: string;
    readonly clsid: string;
    readonly guidProfile: string;
    readonly dwProfileType: number;
  }[] {
    if (!Number.isInteger(langid) || langid < 0 || langid > 0xffff) {
      throw new TypeError(`invalid LANGID ${String(langid)}`);
    }
    const records = runScript(
      this.#channel,
      windowsImeScript({ mode: "list", langid }),
      "IME list",
    );
    const profiles: {
      langid: string;
      clsid: string;
      guidProfile: string;
      dwProfileType: number;
    }[] = [];
    for (const record of records) {
      if (record.type !== "ime-profile") continue;
      const lang = asString(record.langid);
      const clsid = asString(record.clsid);
      const guidProfile = asString(record.guidProfile);
      if (lang === null || clsid === null || guidProfile === null) continue;
      profiles.push({
        langid: lang,
        clsid,
        guidProfile,
        dwProfileType: asInt(record.dwProfileType) ?? 0,
      });
    }
    return profiles;
  }
}

// ------------------------------------------------------------------ misc

/** `"0x0411:{clsid}:{guidProfile}"` or decimal langid variants. */
function parseImeMode(mode: string): {
  readonly langid: number;
  readonly clsid: string;
  readonly guidProfile: string;
} {
  const parts = mode.split(":");
  if (parts.length !== 3) {
    throw new TypeError(
      `IME mode must be "<langid>:<clsid>:<guidProfile>", got ${JSON.stringify(mode)}`,
    );
  }
  const [langidText, clsid, guidProfile] = parts as [string, string, string];
  const langid = langidText.startsWith("0x") || langidText.startsWith("0X")
    ? Number.parseInt(langidText.slice(2), 16)
    : Number.parseInt(langidText, 10);
  if (!Number.isInteger(langid) || langid < 0 || langid > 0xffff) {
    throw new TypeError(`IME mode has invalid langid ${JSON.stringify(langidText)}`);
  }
  const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!GUID_RE.test(clsid) || !GUID_RE.test(guidProfile)) {
    throw new TypeError(`IME mode has invalid clsid/guidProfile in ${JSON.stringify(mode)}`);
  }
  return { langid, clsid, guidProfile };
}

/** Translate one contract mouse event into send-script events. */
function mouseToSendEvents(event: InputMouseEvent): WindowsInputSendEvent[] {
  switch (event.type) {
    case "click": {
      const button = event.button ?? "left";
      return [
        { type: "mouse", action: "move", x: event.x, y: event.y },
        { type: "mouse", action: "down", x: event.x, y: event.y, button },
        { type: "mouse", action: "up", x: event.x, y: event.y, button },
      ];
    }
    case "drag":
      return [
        { type: "mouse", action: "move", x: event.from.x, y: event.from.y },
        { type: "mouse", action: "down", x: event.from.x, y: event.from.y, button: "left" },
        { type: "mouse", action: "move", x: event.to.x, y: event.to.y },
        { type: "mouse", action: "up", x: event.to.x, y: event.to.y, button: "left" },
      ];
    case "scroll":
      if (event.dx !== 0) {
        // Horizontal wheel (MOUSEEVENTF_HWHEEL) is not implemented;
        // dropping dx silently would post the wrong gesture.
        throw new TypeError("horizontal scroll (dx) is not supported by the Windows input helper");
      }
      // Wheel input lands on whatever is under the cursor: move first
      // when coordinates are meaningful, then wheel at that point.
      return [
        ...(Number.isInteger(event.x) && Number.isInteger(event.y)
          ? [{ type: "mouse", action: "move", x: event.x, y: event.y } as const]
          : []),
        { type: "mouse", action: "wheel", wheelDelta: event.dy },
      ];
    case "hover":
      return [{ type: "mouse", action: "move", x: event.x, y: event.y }];
    default:
      throw new TypeError(`unknown mouse event ${JSON.stringify(event)}`);
  }
}
