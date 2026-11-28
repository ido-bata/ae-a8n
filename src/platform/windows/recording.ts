/**
 * Windows screen-recording backend — the `ScreenRecorder` seam
 * implementation for #384 (`specs/gui-evidence/spec.md` §6.2, E3 of
 * program #337 / tracking #346).
 *
 * Two vehicles, in spec order:
 *
 *   1. **WGC (preferred, contract target)** — the embedded PowerShell +
 *      C# helper in `record-script.ts`: `Windows.Graphics.Capture`
 *      `Direct3D11CaptureFramePool` → MediaFoundation `IMFSinkWriter`
 *      (H.264 via OS MFTs) → `.mp4`. HWND-scoped through
 *      `GraphicsCaptureItemInterop` for `window` scopes, monitor-scoped
 *      for `display`/`session`. Win10 1903+; audio is never enabled.
 *   2. **ffmpeg (declared-external fallback)** — `ffmpeg -f gdigrab`
 *      whole-desktop capture, used ONLY when the caller declares the
 *      fallback (`ffmpegFallback: true` / `AE_A8N_FFMPEG_FALLBACK=1`)
 *      AND WGC cannot start for environment reasons
 *      (`unsupported`/`compile-failed`/`capture-failed` verdicts —
 *      never for scope refusals like `window-not-capturable`, where a
 *      wider substitute would be a silent scope lie). ffmpeg is
 *      version-checked once (`ffmpeg -version`) and the artifact
 *      records `tool: "ffmpeg"` + the probed version through the
 *      `RecorderStartResult.tool`/`toolVersion` override (#384).
 *
 * Scope mapping (honest, no silent substitution):
 *
 *   - `window` → WGC HWND mode. The HWND comes from
 *     `scope.window.surface.windowNumber`, which on Windows is the OS
 *     window number — the census's HWND rendered decimal. `null` or a
 *     non-window surface refuses; there is no display-scope fallback.
 *   - `display` → WGC monitor mode (`displayId` parsed as the
 *     0-based `EnumDisplayMonitors` index; absent/`"-1"` = primary).
 *   - `session` → WGC primary monitor with `actualScope: display`
 *     (WGC records one capture item per pool; claiming whole-session
 *     coverage would be a lie — the delivered scope is explicit).
 *     If WGC is environmentally unavailable AND ffmpeg is declared,
 *     gdigrab's whole-desktop capture honestly IS the session scope.
 *   - `region` → no vehicle: WGC cannot clip an arbitrary rect and
 *     ffmpeg's desktop grab is wider still. The resolver returns `null`
 *     so `record.start` refuses `unsupported`.
 *
 * Exclusions (§7.2): neither vehicle can honor declarative exclusions,
 * so every requested exclusion is reported through
 * `unhonoredExclusions` — recorded on the segment, never silently
 * dropped.
 *
 * Level: `automated test` — spawn/verdict/file logic is covered by
 * injected fakes; the PowerShell+C# helper itself has NEVER compiled
 * or run (no Windows host exists in this repo's evidence). Every
 * helper failure surfaces as `unavailable`, never as a silent success.
 */

import { execFile, spawn } from "node:child_process";
import { open, rm, stat, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  RecorderFileProbe,
  RecorderHandle,
  RecorderResolver,
  RecorderStartRequest,
  RecorderStartResult,
  RecorderStopResult,
  ScreenRecorder,
} from "../../evidence/recording.js";
import type {
  CaptureScope,
  EvidenceExclusion,
} from "../../evidence/types.js";
import { windowsWgcHelperScript } from "./record-script.js";

/* ------------------------------------------------------------------ */
/* Injectable seams                                                   */
/* ------------------------------------------------------------------ */

/**
 * The minimal child-process surface the backend needs. The default is
 * `node:child_process.spawn`; tests inject fakes.
 */
export type WindowsRecorderChild = {
  readonly pid: number | null;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
};

export type WindowsRecorderSpawn = (
  program: string,
  args: readonly string[],
) => WindowsRecorderChild;

/** `ffmpeg -version` probe; injectable for tests. */
export type FfmpegVersionProbe = (ffmpegPath: string) => Promise<string>;

export type WindowsScreenRecorderOptions = {
  /** powershell.exe path; default `"powershell.exe"` (PATH-resolved). */
  readonly powershellPath?: string;
  /**
   * The declared-external ffmpeg fallback (spec §6.2: allowed only when
   * declared). `true` enables it; `false`/absent keeps WGC-only.
   */
  readonly ffmpegFallback?: boolean;
  /** ffmpeg binary; default `"ffmpeg"` (PATH-resolved). */
  readonly ffmpegPath?: string;
  /** Process spawn seam; defaults to `child_process.spawn`. */
  readonly spawnProcess?: WindowsRecorderSpawn;
  /** `ffmpeg -version` seam; defaults to a real probe. */
  readonly probeFfmpegVersion?: FfmpegVersionProbe;
  /** Directory the WGC helper `.ps1` is written to; default `os.tmpdir()`. */
  readonly helperDir?: string;
  /** How long `start` waits for the helper's first verdict. */
  readonly startTimeoutMs?: number;
  /** How long `stop` waits for the helper to exit after requesting stop. */
  readonly stopGraceMs?: number;
};

type ResolvedWindowsRecorderOptions = {
  readonly powershellPath: string;
  readonly ffmpegPath: string;
  readonly helperDir: string;
  readonly startTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly ffmpegFallback: boolean;
  readonly spawnProcess?: WindowsRecorderSpawn;
  readonly probeFfmpegVersion?: FfmpegVersionProbe;
};

const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_STOP_GRACE_MS = 30_000;
const FFMPEG_START_TIMEOUT_MS = 30_000;

/** WGC helper verdicts that mean "this host cannot run WGC at all". */
const WGC_ENVIRONMENT_FAILURES = new Set([
  "unsupported",
  "compile-failed",
  "capture-failed",
]);

class WindowsRecorderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WindowsRecorderError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Default child-process plumbing                                      */
/* ------------------------------------------------------------------ */

function defaultSpawnProcess(
  program: string,
  args: readonly string[],
): WindowsRecorderChild {
  const child = spawn(program, [...args], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    pid: child.pid ?? null,
    stdout: child.stdout as NodeJS.ReadableStream,
    stderr: child.stderr,
    stdin: child.stdin,
    onExit: (listener) => {
      child.once("exit", (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function defaultProbeFfmpegVersion(ffmpegPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-hide_banner", "-version"],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`ffmpeg -version failed: ${error.message}`));
          return;
        }
        // First line: `ffmpeg version 6.1.1-... Copyright ...`
        const first = stdout.split(/\r?\n/u, 1)[0] ?? "";
        const match = /^ffmpeg version (\S+)/u.exec(first.trim());
        resolve(match?.[1] ?? first.trim());
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* NDJSON verdict parsing                                              */
/* ------------------------------------------------------------------ */

type NdjsonRecord = Record<string, unknown>;

function parseNdjsonLines(chunk: string, carry: { partial: string }): NdjsonRecord[] {
  const text = carry.partial + chunk;
  const lines = text.split(/\r?\n/u);
  carry.partial = lines.pop() ?? "";
  const records: NdjsonRecord[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        records.push(value as NdjsonRecord);
      }
    } catch {
      // Non-JSON helper noise is ignored; verdicts are what matter.
    }
  }
  return records;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* mp4 container probe                                                 */
/* ------------------------------------------------------------------ */

/**
 * Walk the top-level ISO-BMFF boxes looking for `moov`. A killed
 * encoder leaves `mdat` without `moov` — unplayable, recorded honestly.
 * `faststart` files carry `moov` up front; the walk handles both.
 */
async function probeMp4(path: string): Promise<RecorderFileProbe> {
  const base = { exists: true, bytes: null as number | null };
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { exists: false, bytes: null, playable: false, detail: `${path} is not a regular file` };
    }
    base.bytes = info.size;
    if (info.size < 16) {
      return { ...base, playable: false, detail: "file is too small to be an mp4 container" };
    }
    handle = await open(path, "r");
    const header = Buffer.alloc(16);
    let position = 0;
    for (let boxes = 0; boxes < 256; boxes += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const boxType = header.toString("latin1", 4, 8);
      if (boxType === "moov") {
        return { ...base, playable: true };
      }
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(large);
      } else if (boxSize === 0) {
        break; // box runs to EOF (typical trailing mdat)
      }
      if (boxSize < 8) break;
      position += boxSize;
      if (position >= info.size) break;
    }
    return {
      ...base,
      playable: false,
      detail: "no moov atom found — the encoder did not finalize the container",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        exists: false,
        bytes: null,
        playable: false,
        detail: "no media file exists at the expected path",
      };
    }
    return {
      exists: false,
      bytes: null,
      playable: null,
      detail: `container probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Live recording bookkeeping                                          */
/* ------------------------------------------------------------------ */

type LiveRecording = {
  readonly child: WindowsRecorderChild;
  readonly filePath: string;
  readonly tool: "wgc" | "ffmpeg";
  /** WGC graceful-stop trigger file; `null` for ffmpeg (stdin 'q'). */
  readonly stopFile: string | null;
  readonly helperScript: string | null;
  readonly records: NdjsonRecord[];
  readonly stderrTail: string[];
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Set once the "stopped" verdict arrives (WGC) for stats reporting. */
  stoppedFrames: number | null;
  stoppedElapsedMs: number | null;
};

/** Stats captured at `stop` time — `probe` runs after `stop` deletes
 *  the live record, so completed stats live in their own map. */
type CompletedStats = {
  readonly achievedFps?: number;
};

function exclusionReason(exclusion: EvidenceExclusion): string {
  const predicate =
    exclusion.predicate === undefined ? "" : ` (${exclusion.predicate})`;
  return `${exclusion.kind} exclusion${predicate} cannot be honored by this recorder`;
}

function unhonored(exclude: readonly EvidenceExclusion[] | undefined): string[] | undefined {
  if (exclude === undefined || exclude.length === 0) return undefined;
  return exclude.map(exclusionReason);
}

/* ------------------------------------------------------------------ */
/* The backend                                                         */
/* ------------------------------------------------------------------ */

/**
 * One Windows recording backend. `start` picks WGC first and falls back
 * to declared ffmpeg only for environment-level WGC failures on
 * session scope; `stop`/`probe`/`listPids`/`terminate` serve both
 * vehicles through the same bookkeeping.
 */
export class WindowsScreenRecorder implements ScreenRecorder {
  readonly tool = "windows-graphics-capture";
  readonly toolVersion: string;
  readonly fileExtension = ".mp4";

  readonly #options: ResolvedWindowsRecorderOptions;
  readonly #spawn: WindowsRecorderSpawn;
  readonly #probeVersion: FfmpegVersionProbe;
  readonly #live = new Map<string, LiveRecording>();
  readonly #completedStats = new Map<string, CompletedStats>();
  #ffmpegVersionCache: string | null | undefined;

  constructor(options: WindowsScreenRecorderOptions = {}) {
    this.#options = {
      powershellPath: options.powershellPath ?? "powershell.exe",
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      helperDir: options.helperDir ?? tmpdir(),
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      ffmpegFallback: options.ffmpegFallback ?? false,
      ...(options.spawnProcess === undefined
        ? {}
        : { spawnProcess: options.spawnProcess }),
      ...(options.probeFfmpegVersion === undefined
        ? {}
        : { probeFfmpegVersion: options.probeFfmpegVersion }),
    };
    this.#spawn = options.spawnProcess ?? defaultSpawnProcess;
    this.#probeVersion = options.probeFfmpegVersion ?? defaultProbeFfmpegVersion;
    // toolVersion reports the OS build the helper would run on; the
    // backend only ever runs on win32, so `release()` is the Windows
    // version there.
    this.toolVersion = `win32-${release()}`;
  }

  /* ---------------- scope → vehicle args ---------------- */

  #wgcArgs(request: RecorderStartRequest): {
    mode: "window" | "monitor";
    hwnd: string;
    monitorIndex: string;
    actualScope?: CaptureScope;
  } {
    const { scope } = request;
    if (scope.kind === "window") {
      const surface = scope.window.surface;
      const hwnd = surface.windowNumber;
      if (surface.kind !== "window" || hwnd === null || !Number.isInteger(hwnd) || hwnd <= 0) {
        throw new WindowsRecorderError(
          "invalid",
          "window scope requires an OS window number (HWND) on the resolved " +
            "panel surface; this surface does not carry one — there is no " +
            "display-scope substitution",
        );
      }
      return { mode: "window", hwnd: String(hwnd), monitorIndex: "-1" };
    }
    if (scope.kind === "display") {
      const id = scope.displayId;
      if (id === undefined || id === "-1") {
        return { mode: "monitor", hwnd: "", monitorIndex: "-1", actualScope: scope };
      }
      if (!/^-?\d+$/u.test(id)) {
        throw new WindowsRecorderError(
          "invalid",
          `displayId "${id}" is not a monitor index; pass a 0-based ` +
            "EnumDisplayMonitors index or omit it for the primary monitor",
        );
      }
      return { mode: "monitor", hwnd: "", monitorIndex: id, actualScope: scope };
    }
    if (scope.kind === "session") {
      // WGC records one capture item per session/pool — the primary
      // monitor — so the delivered scope is `display`, stated plainly.
      return {
        mode: "monitor",
        hwnd: "",
        monitorIndex: "-1",
        actualScope: { kind: "display" },
      };
    }
    throw new WindowsRecorderError(
      "invalid",
      `scope kind "${(scope as { kind: string }).kind}" has no Windows ` +
        "recording vehicle (region capture is not implemented)",
    );
  }

  /* ---------------- WGC start ---------------- */

  async #writeHelperScript(): Promise<string> {
    const path = join(
      this.#options.helperDir,
      `ae-a8n-wgc-${process.pid}-${randomUUID()}.ps1`,
    );
    await writeFile(path, windowsWgcHelperScript(), "utf8");
    return path;
  }

  async #startWgc(request: RecorderStartRequest): Promise<RecorderStartResult> {
    const args = this.#wgcArgs(request);
    const scriptPath = await this.#writeHelperScript();
    const stopFile = `${request.filePath}.stop`;
    const child = this.#spawn(this.#options.powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Mode",
      args.mode,
      "-Hwnd",
      args.hwnd,
      "-MonitorIndex",
      args.monitorIndex,
      "-Output",
      request.filePath,
      "-MaxDurationMs",
      String(request.maxDurationMs),
      "-Fps",
      String(request.fps ?? 30),
      "-StopFile",
      stopFile,
    ]);

    const live = this.#track(child, request.filePath, "wgc", stopFile, scriptPath);
    const verdict = await this.#awaitWgcVerdict(live);
    if (verdict.type === "error") {
      this.#live.delete(request.filePath);
      child.kill();
      await rm(scriptPath, { force: true }).catch(() => undefined);
      await rm(stopFile, { force: true }).catch(() => undefined);
      throw new WindowsRecorderError(
        asString(verdict.code) ?? "capture-failed",
        asString(verdict.message) ?? "the WGC helper reported an error",
      );
    }
    const exclusions = unhonored(request.exclude);
    return {
      handle: { pid: child.pid, filePath: request.filePath },
      ...(args.actualScope === undefined ? {} : { actualScope: args.actualScope }),
      ...(exclusions === undefined ? {} : { unhonoredExclusions: exclusions }),
    };
  }

  #track(
    child: WindowsRecorderChild,
    filePath: string,
    tool: "wgc" | "ffmpeg",
    stopFile: string | null,
    helperScript: string | null,
  ): LiveRecording {
    const live: LiveRecording = {
      child,
      filePath,
      tool,
      stopFile,
      helperScript,
      records: [],
      stderrTail: [],
      exited: new Promise((resolve) => {
        child.onExit((code, signal) => resolve({ code, signal }));
        child.onError(() => resolve({ code: null, signal: null }));
      }),
      stoppedFrames: null,
      stoppedElapsedMs: null,
    };
    const carry = { partial: "" };
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const record of parseNdjsonLines(text, carry)) {
        live.records.push(record);
        if (record.type === "stopped") {
          live.stoppedFrames = asNumber(record.frames);
          live.stoppedElapsedMs = asNumber(record.elapsedMs);
        }
      }
    });
    child.stdout.on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      live.stderrTail.push(text);
      if (live.stderrTail.length > 40) live.stderrTail.shift();
    });
    child.stderr?.on("error", () => undefined);
    this.#live.set(filePath, live);
    return live;
  }

  async #awaitWgcVerdict(live: LiveRecording): Promise<NdjsonRecord> {
    const deadline = Date.now() + this.#options.startTimeoutMs;
    while (Date.now() < deadline) {
      const verdict = [...live.records]
        .reverse()
        .find((r) => r.type === "recording" || r.type === "error");
      if (verdict !== undefined) return verdict;
      const exited = await Promise.race([
        live.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (exited) {
        // The process ended — re-scan once: a verdict emitted in the
        // same breath as exit must still win over "no verdict".
        const late = [...live.records]
          .reverse()
          .find((r) => r.type === "recording" || r.type === "error");
        if (late !== undefined) return late;
        // Process ended without a verdict — surface stderr tail.
        const tail = live.stderrTail.join("").trim().slice(-400);
        throw new WindowsRecorderError(
          "capture-failed",
          `the WGC helper exited before reporting${tail === "" ? "" : `: ${tail}`}`,
        );
      }
    }
    throw new WindowsRecorderError(
      "capture-failed",
      `the WGC helper produced no verdict within ${this.#options.startTimeoutMs}ms`,
    );
  }

  /* ---------------- ffmpeg fallback ---------------- */

  async #ffmpegVersion(): Promise<string> {
    if (this.#ffmpegVersionCache === undefined) {
      try {
        this.#ffmpegVersionCache = await this.#probeVersion(this.#options.ffmpegPath);
      } catch {
        this.#ffmpegVersionCache = null;
      }
    }
    return this.#ffmpegVersionCache ?? "";
  }

  async #startFfmpeg(
    request: RecorderStartRequest,
  ): Promise<RecorderStartResult | null> {
    if (this.#options.ffmpegFallback !== true) return null;
    if (request.scope.kind !== "session") {
      // gdigrab captures the whole virtual desktop — honest only for
      // session scope. Window/display asks stay unavailable rather than
      // silently widening (spec §6.2).
      return null;
    }
    const version = await this.#ffmpegVersion();
    if (version === "") {
      throw new WindowsRecorderError(
        "unavailable",
        "the declared ffmpeg fallback is not installed or not runnable " +
          `(probed "${this.#options.ffmpegPath}")`,
      );
    }
    const fps = Math.max(1, Math.floor(request.fps ?? 30));
    const child = this.#spawn(this.#options.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-an",
      "-f",
      "gdigrab",
      "-framerate",
      String(fps),
      "-i",
      "desktop",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      request.filePath,
    ]);
    const live = this.#track(child, request.filePath, "ffmpeg", null, null);
    const started = await this.#awaitFfmpegStart(live);
    if (!started) {
      this.#live.delete(request.filePath);
      child.kill();
      return null;
    }
    const exclusions = unhonored(request.exclude);
    return {
      handle: { pid: child.pid, filePath: request.filePath },
      tool: "ffmpeg",
      toolVersion: version,
      ...(exclusions === undefined ? {} : { unhonoredExclusions: exclusions }),
    };
  }

  /** ffmpeg prints nothing at `-loglevel error` until it fails; "started"
   *  means the output file exists and is growing. */
  async #awaitFfmpegStart(live: LiveRecording): Promise<boolean> {
    const deadline = Date.now() + FFMPEG_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const info = await stat(live.filePath);
        if (info.isFile() && info.size > 0) return true;
      } catch {
        // not yet
      }
      const done = await Promise.race([
        live.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (done) return false;
    }
    return false;
  }

  /* ---------------- ScreenRecorder ---------------- */

  async start(request: RecorderStartRequest): Promise<RecorderStartResult> {
    try {
      return await this.#startWgc(request);
    } catch (error) {
      const code = error instanceof WindowsRecorderError ? error.code : "capture-failed";
      // Fallback ONLY for environment-level WGC failure on session
      // scope — a scope refusal (window-not-capturable, invalid) must
      // surface as-is; substituting a wider capture would be silent
      // scope drift (spec §6.2).
      if (
        WGC_ENVIRONMENT_FAILURES.has(code) &&
        request.scope.kind === "session"
      ) {
        const fallback = await this.#startFfmpeg(request);
        if (fallback !== null) return fallback;
      }
      throw error;
    }
  }

  async stop(handle: RecorderHandle): Promise<RecorderStopResult> {
    const live = this.#live.get(handle.filePath);
    if (live === undefined) {
      return { exited: true, exitCode: null };
    }
    // Graceful stop: WGC watches the stop file; ffmpeg reads 'q' on
    // stdin. Both let the encoder finalize the moov atom.
    if (live.stopFile !== null) {
      await writeFile(live.stopFile, "stop", "utf8").catch(() => undefined);
    } else {
      try {
        live.child.stdin?.write("q", () => undefined);
      } catch {
        // stdin already closed — the grace wait + kill covers it.
      }
    }
    const grace = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), this.#options.stopGraceMs),
    );
    const outcome = await Promise.race([live.exited, grace]);
    if (outcome === null) {
      live.child.kill();
      const forced = await Promise.race([
        live.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      return {
        exited: false,
        exitCode: null,
        error:
          "the recorder did not exit within the stop grace period" +
          (forced === null ? " and had to be terminated" : ""),
      };
    }
    // Preserve achieved-fps stats for the probe that runs after stop.
    if (
      live.stoppedFrames !== null &&
      live.stoppedElapsedMs !== null &&
      live.stoppedElapsedMs > 0
    ) {
      this.#completedStats.set(handle.filePath, {
        achievedFps: (live.stoppedFrames / live.stoppedElapsedMs) * 1000,
      });
    }
    this.#live.delete(handle.filePath);
    await this.#cleanupLive(live);
    return { exited: true, exitCode: outcome.code };
  }

  async #cleanupLive(live: LiveRecording): Promise<void> {
    if (live.helperScript !== null) {
      await rm(live.helperScript, { force: true }).catch(() => undefined);
    }
    if (live.stopFile !== null) {
      await rm(live.stopFile, { force: true }).catch(() => undefined);
    }
  }

  async probe(filePath: string): Promise<RecorderFileProbe> {
    const probe = await probeMp4(filePath);
    const stats = this.#completedStats.get(filePath);
    if (probe.playable === true && stats?.achievedFps !== undefined) {
      return { ...probe, stats: { achievedFps: stats.achievedFps } };
    }
    return probe;
  }

  listPids(): Promise<readonly number[] | null> {
    const pids: number[] = [];
    for (const live of this.#live.values()) {
      if (live.child.pid !== null) pids.push(live.child.pid);
    }
    return Promise.resolve(pids);
  }

  terminate(pid: number): Promise<boolean> {
    for (const live of this.#live.values()) {
      if (live.child.pid === pid) {
        live.child.kill();
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }
}

/**
 * The production resolver for `createRecordingController`'s `recorder`
 * seam on win32. `region` scope resolves to `null` — no vehicle honors
 * an arbitrary rectangle, so starts refuse `unsupported` honestly.
 */
export function windowsScreenRecorderResolver(
  options: WindowsScreenRecorderOptions = {},
): RecorderResolver {
  const recorder = new WindowsScreenRecorder(options);
  return (scope: CaptureScope) =>
    scope.kind === "region" ? null : recorder;
}
