/**
 * macOS recording backend — the darwin `ScreenRecorder` for
 * `record.start`/`record.stop` (#382, spec `specs/gui-evidence/spec.md`
 * §5.2, §5.4, §6.1, §7, §11; E2b of program #337 / tracking #346).
 *
 * Two tiers, per spec §6.1:
 *
 *   - **SCStream tier** — `scripts/isolated-session/screen-record.swift`
 *     compiled to a binary and spawned inside the target session via
 *     `startInSession` (`launchctl asuser` / direct when already inside).
 *     `SCContentFilter` honors `window` (desktop-independent window),
 *     `region` (display filter + `sourceRect` crop) and `display` scopes;
 *     audio is off; the helper enforces `maxDurationMs` itself and
 *     finalizes the `.mov` on SIGTERM/SIGINT/SIGHUP. Progress and final
 *     capture stats arrive through an atomic JSON receipt file the
 *     driver polls — stdout/stderr are not a control channel.
 *   - **`screencapture -V` fallback tier** — `/usr/sbin/screencapture
 *     -V<seconds>`, the documented OS fallback when no compiled helper
 *     exists (e.g. an npm install, which does not ship `scripts/`). It
 *     records whole-display only: a `window`/`region`/`session` request
 *     is still served but `actualScope` reports `{kind:"display"}` and
 *     every scope/exclusion gap is reported — requested ≠ delivered is
 *     always explicit (spec §5.2).
 *
 * Safety posture:
 *
 *   - The recorder only ever runs inside the session `session()`
 *     resolves — the driver-attested target session (`recoveryTarget`),
 *     never "whatever session happens to be convenient". `startInSession`
 *     itself refuses cross-session launches for non-root callers.
 *   - `listPids`/`terminate` only ever name processes this backend (or a
 *     previous driver instance in the same uid session) provably started:
 *     pids are matched by the exact helper binary path or by a
 *     `screencapture` cmdline containing this session's artifacts dir,
 *     filtered to the target uid via `pgrep -U`. The driver's own pid
 *     and its ancestors are never candidates. Termination prefers `kill`
 *     executed *inside* the target session (the recorder's owner can
 *     always signal it).
 *   - The helper binary is compiled on demand from the shipped
 *     `screen-record.swift` into a per-uid directory under `/tmp`
 *     (world-readable so `launchctl asuser` can exec it; the sticky bit
 *     on /tmp keeps other users from replacing it). An explicitly
 *     supplied `helperPath` skips compilation entirely.
 *
 * Verification level: `implemented` + `automated test` (argv
 * construction, receipt parsing, tier/scope mapping, container probe,
 * pid enumeration against fakes; the helper itself is swiftc-compiled
 * and usage-tested on darwin). Whether SCStream delivers frames under
 * `runInSession`, TCC prompt behavior in isolated sessions, achievable
 * fps and `.mov` finalize-on-signal are ALL `unverified` — real-host
 * verification is a later lane (spec §10).
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  runInSession,
  startInSession,
  type MacSession,
} from "../driver/mac-session.js";
import { errorMessage } from "../errors.js";
import type { CaptureScope, EvidenceExclusion } from "./types.js";
import type {
  RecorderFileProbe,
  RecorderHandle,
  RecorderStartRequest,
  RecorderStartResult,
  RecorderStopResult,
  ScreenRecorder,
} from "./recording.js";

const execFileAsync = promisify(execFile);
let compileSeq = 0;

/* ------------------------------------------------------------------ */
/* Seams                                                               */
/* ------------------------------------------------------------------ */

/** A spawned in-session recorder process, reduced to what the seam needs. */
export type DarwinSpawnedProcess = {
  /** The spawned child's pid; `null` when the OS could not name one. */
  readonly pid: number | null;
  /** Resolves when the process exits or `timeoutMs` elapses. */
  waitExit(timeoutMs: number): Promise<{
    readonly exited: boolean;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  /** True once the OS has reaped the process — synchronous, no wait. */
  hasExited(): boolean;
  /** Accumulated stderr (bounded), for failure diagnostics. */
  stderrText(): string;
};

/** Spawns `command args` inside the resolved target session. */
export type DarwinSpawn = (
  command: string,
  args: readonly string[],
) => DarwinSpawnedProcess;

/** `pgrep -fl`-shaped lister: pid + command line, one per line. */
export type DarwinProcessLister = () => Promise<readonly {
  readonly pid: number;
  readonly command: string;
}[] | null>;

export type DarwinRecorderTier = "auto" | "sckit" | "screencapture";

export type DarwinScreenRecorderOptions = {
  /**
   * Resolves the session every recorder process must run inside —
   * production passes the driver-attested target session. `null` means
   * no session is provable and every start refuses.
   */
  readonly session: () => MacSession | null;
  /** Tier selection; `"auto"` prefers SCStream, falls back to screencapture. */
  readonly tier?: DarwinRecorderTier;
  /** Prebuilt `screen-record` binary; skips compilation when given. */
  readonly helperPath?: string;
  /**
   * `screen-record.swift` source to compile on demand. Defaults to the
   * repo's `scripts/isolated-session/screen-record.swift` resolved
   * relative to this module (absent in npm installs → fallback tier).
   */
  readonly helperSourcePath?: string;
  /** Cache directory for the compiled helper; defaults under `/tmp`. */
  readonly helperBuildDir?: string;
  readonly swiftcPath?: string;
  readonly screencapturePath?: string;
  /**
   * The session artifacts dir (`<sessionRoot>/artifacts`). Used to
   * recognize `screencapture -V` cmdlines for residue enumeration even
   * before the first segment of this process starts.
   */
  readonly artifactsDir?: string;
  /** Spawn seam; defaults to `startInSession` against `session()`. */
  readonly spawn?: DarwinSpawn;
  /** `runInSession` seam for in-session `kill` (residue termination). */
  readonly runSession?: typeof runInSession;
  /** Process lister for residue enumeration; defaults to `pgrep -fl`. */
  readonly listProcesses?: DarwinProcessLister;
  /** How long `start` waits for the helper's "recording" receipt. */
  readonly startTimeoutMs?: number;
  /** Grace period `stop` waits for the helper to exit after SIGTERM. */
  readonly stopGraceMs?: number;
  /** Delay before declaring a `screencapture -V` spawn failed-fast. */
  readonly fallbackStartDelayMs?: number;
  /** Poll/sleep seam for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/* ------------------------------------------------------------------ */
/* Helper compilation                                                  */
/* ------------------------------------------------------------------ */

const DEFAULT_SWIFTC = "/usr/bin/swiftc";
const DEFAULT_SCREENCAPTURE = "/usr/sbin/screencapture";

function defaultHelperSourcePath(): string | null {
  try {
    // dist/evidence/recording-darwin.js and src/evidence/recording-darwin.ts
    // are both two levels below the package root.
    const candidate = fileURLToPath(
      new URL("../../scripts/isolated-session/screen-record.swift", import.meta.url),
    );
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function defaultHelperBuildDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // /tmp (not os.tmpdir()): the binary must be executable by the target
  // session's uid, which may differ from the driver's. The per-uid
  // directory name keeps other users' builds apart; the sticky bit on
  // /tmp keeps them from being replaced.
  return `/tmp/ae-a8n-screen-record-u${uid}`;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Compiles `screen-record.swift` once per source hash into the build
 * dir. Returns the binary path, or an error string when compilation is
 * impossible — the caller then uses the fallback tier (or refuses when
 * SCStream was explicitly requested).
 */
export async function ensureScreenRecordHelper(options: {
  readonly helperPath?: string | undefined;
  readonly helperSourcePath?: string | undefined;
  readonly helperBuildDir?: string | undefined;
  readonly swiftcPath?: string | undefined;
}): Promise<{ readonly path: string } | { readonly error: string }> {
  if (options.helperPath !== undefined) {
    return isExecutableFile(options.helperPath)
      ? { path: options.helperPath }
      : { error: `helperPath ${options.helperPath} is not an executable file` };
  }
  const source = options.helperSourcePath ?? defaultHelperSourcePath();
  if (source === null || !existsSync(source)) {
    return {
      error: "screen-record.swift source not found (npm installs do not ship scripts/)",
    };
  }
  let hash: string;
  try {
    hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  } catch (error) {
    return { error: `could not read ${source}: ${errorMessage(error)}` };
  }
  const buildDir = options.helperBuildDir ?? defaultHelperBuildDir();
  const binary = join(buildDir, `screen-record-${hash}`);
  if (isExecutableFile(binary)) {
    return { path: binary };
  }
  try {
    mkdirSync(buildDir, { recursive: true, mode: 0o755 });
  } catch (error) {
    return { error: `could not create ${buildDir}: ${errorMessage(error)}` };
  }
  // Unique per call: concurrent ensures in this process must not share
  // a temp path (the publish `mv` would race).
  const tmp = join(
    buildDir,
    `.screen-record-${hash}.${process.pid}.${compileSeq++}.tmp`,
  );
  try {
    await execFileAsync(options.swiftcPath ?? DEFAULT_SWIFTC, [
      "-O",
      source,
      "-o",
      tmp,
    ]);
    execFileSync("/bin/mv", [tmp, binary]);
  } catch (error) {
    try {
      execFileSync("/bin/rm", ["-f", tmp]);
    } catch {
      // best-effort temp cleanup
    }
    return { error: `swiftc failed for ${source}: ${errorMessage(error)}` };
  }
  return isExecutableFile(binary)
    ? { path: binary }
    : { error: `swiftc produced no executable at ${binary}` };
}

/* ------------------------------------------------------------------ */
/* Shared process plumbing                                             */
/* ------------------------------------------------------------------ */

type LiveRecording = {
  readonly proc: DarwinSpawnedProcess;
  readonly filePath: string;
};

function defaultSpawn(session: MacSession): DarwinSpawn {
  return (command, args) => {
    let stderr = "";
    const child = startInSession(session, command, args, {
      onStderr: (chunk) => {
        if (stderr.length < 65_536) stderr += chunk;
      },
    });
    return {
      pid: child.pid ?? null,
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      stderrText: () => stderr,
      waitExit: (timeoutMs) =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (result: {
            exited: boolean;
            code: number | null;
            signal: NodeJS.Signals | null;
          }) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(result);
            }
          };
          const timer = setTimeout(
            () => finish({ exited: false, code: null, signal: null }),
            timeoutMs,
          );
          timer.unref?.();
          child.once("error", () =>
            finish({ exited: true, code: null, signal: null }),
          );
          child.once("close", (code, signal) =>
            finish({ exited: true, code, signal }),
          );
        }),
    };
  };
}

function defaultProcessLister(session: MacSession): DarwinProcessLister {
  return async () => {
    try {
      const { stdout } = await execFileAsync(
        "pgrep",
        ["-U", String(session.uid), "-fl"],
        { timeout: 10_000 },
      );
      const rows: { pid: number; command: string }[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const space = trimmed.indexOf(" ");
        const pid = Number(
          trimmed.slice(0, space === -1 ? trimmed.length : space),
        );
        if (!Number.isInteger(pid) || pid <= 0) continue;
        rows.push({
          pid,
          command: trimmed.slice(space === -1 ? trimmed.length : space + 1),
        });
      }
      return rows;
    } catch {
      return null;
    }
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* .mov container probe (shared by both tiers)                         */
/* ------------------------------------------------------------------ */

const atom = (name: string) => Buffer.from(name, "ascii");
const FTYP = atom("ftyp");
const MOOV = atom("moov");
const MDAT = atom("mdat");

/**
 * Structural probe of a QuickTime/MP4 file: an `ftyp` brand near the
 * head plus `moov` and `mdat` atoms in the body. This proves the
 * container *structure* exists — it does not decode a frame, so a
 * structurally complete but corrupt stream can still read playable.
 * That limit is documented rather than hidden: `playable: true` here
 * means "container atoms are present", nothing stronger.
 */
export async function probeMovFile(path: string): Promise<RecorderFileProbe> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return {
      exists: false,
      bytes: null,
      playable: false,
      detail: "no media file was produced",
    };
  }
  if (!info.isFile()) {
    return {
      exists: false,
      bytes: null,
      playable: false,
      detail: `${path} is not a regular file`,
    };
  }
  const bytes = info.size;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(bytes, 64));
    await handle.read(head, 0, head.length, 0);
    if (!head.includes(FTYP)) {
      return {
        exists: true,
        bytes,
        playable: false,
        detail: "no ftyp atom — not a QuickTime/MP4 file",
      };
    }
    const found = { moov: false, mdat: false };
    const chunkSize = 1024 * 1024;
    const overlap = 16;
    let offset = 0;
    let tail = Buffer.alloc(0);
    while (offset < bytes && !(found.moov && found.mdat)) {
      const want = Math.min(chunkSize, bytes - offset);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const view = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      if (!found.moov && view.includes(MOOV)) found.moov = true;
      if (!found.mdat && view.includes(MDAT)) found.mdat = true;
      tail = view.subarray(Math.max(0, view.length - overlap));
    }
    if (!found.moov || !found.mdat) {
      return {
        exists: true,
        bytes,
        playable: false,
        detail:
          `container atoms missing (moov:${found.moov}, mdat:${found.mdat})` +
          " — likely an unfinalized recording",
      };
    }
    return { exists: true, bytes, playable: true };
  } catch (error) {
    return {
      exists: true,
      bytes,
      playable: null,
      detail: `container probe failed: ${errorMessage(error)}`,
    };
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* Shared stop / residue plumbing                                      */
/* ------------------------------------------------------------------ */

function unhonoredExclusions(
  exclude: readonly EvidenceExclusion[] | undefined,
): string[] {
  return (exclude ?? []).map(
    (e) =>
      `${e.kind} exclusion${e.predicate === undefined ? "" : ` (${e.predicate})`}` +
      " cannot be honored by this recorder tier",
  );
}

async function stopSpawned(
  proc: DarwinSpawnedProcess,
  pid: number | null,
  options: DarwinScreenRecorderOptions,
  session: MacSession,
): Promise<RecorderStopResult> {
  // SIGTERM first: the SCStream helper finalizes its .mov on it;
  // screencapture's finalize-on-signal is UNVERIFIED — the container
  // probe reports whatever actually landed.
  const target = pid ?? proc.pid;
  terminatePid(options, session, target);
  const grace = options.stopGraceMs ?? 15_000;
  const result = await proc.waitExit(grace);
  if (result.exited) {
    return {
      exited: true,
      exitCode: result.code,
      ...(result.code !== 0 && result.code !== null
        ? {
            error: `recorder exited ${result.code}: ${proc.stderrText().trim()}`,
          }
        : {}),
    };
  }
  return {
    exited: false,
    exitCode: null,
    error:
      `recorder pid ${target ?? "?"} did not exit within ${grace}ms of SIGTERM`,
  };
}

function terminatePid(
  options: DarwinScreenRecorderOptions,
  session: MacSession,
  pid: number | null,
): boolean {
  if (pid === null || pid <= 0) return false;
  const runSession = options.runSession ?? runInSession;
  try {
    // kill inside the target session: the recorder's owner can always
    // signal it, whatever uid the driver runs as.
    const result = runSession(session, "/bin/kill", ["-TERM", String(pid)], {
      timeoutMs: 10_000,
    });
    if (result.status === 0) return true;
  } catch {
    // fall through to a direct signal (same-uid driver case)
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function ancestorPids(): Set<number> {
  const set = new Set<number>();
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    set.add(pid);
    try {
      const out = execFileSync(
        "/bin/ps",
        ["-o", "ppid=", "-p", String(pid)],
        { encoding: "utf-8" },
      ).trim();
      const next = Number(out);
      if (!Number.isInteger(next)) break;
      pid = next;
    } catch {
      break;
    }
  }
  return set;
}

/**
 * Surviving recorder pids for this backend. Matches the exact helper
 * binary path (SCStream tier) and `screencapture` cmdlines containing
 * the session artifacts dir (fallback tier), restricted to the target
 * uid by `pgrep -U`. The driver's own pid and ancestors can never
 * match. `null` when the process list cannot be enumerated — residue
 * then reports `"unknown"`, never a silent `"none"`.
 */
async function listRecorderPids(
  options: DarwinScreenRecorderOptions,
  patterns: {
    readonly helperPath: string | null;
    readonly artifactsDir: string | null;
  },
): Promise<readonly number[] | null> {
  const session = options.session();
  if (session === null) return null;
  const lister = options.listProcesses ?? defaultProcessLister(session);
  const rows = await lister();
  if (rows === null) return null;
  const self = process.pid;
  const ancestors = ancestorPids();
  const pids = new Set<number>();
  for (const row of rows) {
    if (row.pid === self || ancestors.has(row.pid)) continue;
    const cmd = row.command;
    const isHelper =
      patterns.helperPath !== null && cmd.includes(patterns.helperPath);
    const isFallback =
      cmd.includes("screencapture") &&
      patterns.artifactsDir !== null &&
      cmd.includes(patterns.artifactsDir);
    if (isHelper || isFallback) pids.add(row.pid);
  }
  return [...pids];
}

/* ------------------------------------------------------------------ */
/* SCStream tier (screen-record.swift helper)                          */
/* ------------------------------------------------------------------ */

type HelperReceipt = {
  readonly status?: string;
  readonly reason?: string;
  readonly pid?: number;
  readonly delivered?: string;
  readonly framesReceived?: number;
  readonly durationSec?: number | null;
  readonly encodeCpuFraction?: number;
};

async function readReceipt(path: string): Promise<HelperReceipt | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as HelperReceipt;
  } catch {
    return null;
  }
}

class SckitRecorder implements ScreenRecorder {
  readonly tool = "screen-record.swift";
  readonly toolVersion = "1";
  readonly fileExtension = ".mov";

  readonly #options: DarwinScreenRecorderOptions;
  readonly #helperPath: string;
  readonly #live = new Map<string, LiveRecording>();
  readonly #stats = new Map<
    string,
    NonNullable<RecorderFileProbe["stats"]>
  >();

  constructor(options: DarwinScreenRecorderOptions, helperPath: string) {
    this.#options = options;
    this.#helperPath = helperPath;
  }

  #session(): MacSession {
    const session = this.#options.session();
    if (session === null) {
      throw new Error(
        "no attested target session — the recorder cannot prove where to run",
      );
    }
    return session;
  }

  #spawn(command: string, args: readonly string[]): DarwinSpawnedProcess {
    const spawn = this.#options.spawn ?? defaultSpawn(this.#session());
    return spawn(command, args);
  }

  async start(request: RecorderStartRequest): Promise<RecorderStartResult> {
    this.#session(); // guard: refuse before any spawn when unproven
    const receiptPath = `${request.filePath}.receipt.json`;
    const args: string[] = [
      "record",
      "--out", request.filePath,
      "--receipt", receiptPath,
      "--max-duration-ms", String(Math.round(request.maxDurationMs)),
    ];
    if (request.fps !== undefined) {
      args.push("--fps", String(request.fps));
    }

    // Scope → helper arguments. A `window` scope without a CGWindowID
    // degrades to its surface frame as a region capture; the delivered
    // scope is reported through the receipt, never assumed.
    const windowFrame =
      request.scope.kind === "window"
        ? request.scope.window.surface.frame
        : undefined;
    const windowNumber =
      request.scope.kind === "window"
        ? request.scope.window.surface.windowNumber
        : null;

    const rectArg = (frame: { x: number; y: number; width: number; height: number }) =>
      [frame.x, frame.y, frame.width, frame.height]
        .map((v) => String(Math.round(v)))
        .join(",");

    switch (request.scope.kind) {
      case "window":
        if (windowNumber !== null && windowNumber > 0) {
          args.push("--scope", "window", "--window-id", String(windowNumber));
        } else if (windowFrame !== undefined) {
          args.push("--scope", "region", "--rect", rectArg(windowFrame));
        } else {
          throw new Error(
            "window scope has neither a window number nor a frame — " +
              "cannot address the SCStream filter",
          );
        }
        break;
      case "region":
        args.push("--scope", "region", "--rect", rectArg(request.scope.frame));
        break;
      case "display": {
        args.push("--scope", "display");
        const id = request.scope.displayId;
        if (id !== undefined) {
          const numeric = Number(id);
          if (Number.isInteger(numeric) && numeric > 0) {
            args.push("--display-id", String(numeric));
          }
        }
        break;
      }
      case "session":
        // Session scope is gated upstream (authorization); if it ever
        // arrives here the honest delivery is one display — the
        // resolver routes session scopes to the fallback tier anyway.
        args.push("--scope", "display");
        break;
    }

    const proc = this.#spawn(this.#helperPath, args);
    this.#live.set(request.filePath, { proc, filePath: request.filePath });

    const sleep = this.#options.sleep ?? defaultSleep;
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? 30_000);
    let receipt: HelperReceipt | null = null;
    while (Date.now() < deadline) {
      receipt = await readReceipt(receiptPath);
      if (receipt?.status === "recording") break;
      if (receipt?.status === "failed") {
        this.#live.delete(request.filePath);
        throw new Error(
          `screen-record helper failed: ${receipt.reason ?? "unknown"}`,
        );
      }
      // Process died before reporting — fail fast instead of polling.
      if (proc.hasExited()) {
        this.#live.delete(request.filePath);
        throw new Error(
          "screen-record helper exited before recording started: " +
            (proc.stderrText().trim() || "no diagnostic"),
        );
      }
      await sleep(100);
    }
    if (receipt?.status !== "recording") {
      this.#live.delete(request.filePath);
      terminatePid(this.#options, this.#session(), proc.pid);
      await proc.waitExit(2_000);
      throw new Error(
        "screen-record helper did not report recording start in time",
      );
    }

    const delivered = receipt.delivered ?? "display";
    const actualScope = this.#actualScope(request.scope, delivered);
    return {
      handle: {
        pid: receipt.pid ?? proc.pid,
        filePath: request.filePath,
      },
      ...(actualScope === undefined ? {} : { actualScope }),
      unhonoredExclusions: unhonoredExclusions(request.exclude),
    };
  }

  #actualScope(
    scope: CaptureScope,
    delivered: string,
  ): CaptureScope | undefined {
    if (delivered === "window" && scope.kind === "window") {
      return scope;
    }
    if (delivered === "region") {
      if (scope.kind === "region") return scope;
      if (scope.kind === "window") {
        return {
          kind: "region",
          frame: scope.window.surface.frame,
          parent: scope.window,
        };
      }
      return undefined; // a region delivered for a display ask: narrower is fine
    }
    // delivered "display" (or unrecognized): only differs from the
    // request when something narrower was asked.
    if (scope.kind === "display") {
      return {
        kind: "display",
        ...(scope.displayId === undefined ? {} : { displayId: scope.displayId }),
      };
    }
    return { kind: "display" };
  }

  async stop(handle: RecorderHandle): Promise<RecorderStopResult> {
    const live = this.#live.get(handle.filePath);
    this.#live.delete(handle.filePath);
    if (live === undefined) {
      return {
        exited: true,
        exitCode: null,
        error: "no live recording tracked for this handle",
      };
    }
    const result = await stopSpawned(
      live.proc,
      handle.pid,
      this.#options,
      this.#session(),
    );
    // Final receipt → captureStats for the index (spec §11).
    const receipt = await readReceipt(`${handle.filePath}.receipt.json`);
    if (receipt !== null) {
      const durationSec =
        typeof receipt.durationSec === "number" && receipt.durationSec > 0
          ? receipt.durationSec
          : null;
      const frames =
        typeof receipt.framesReceived === "number" ? receipt.framesReceived : null;
      this.#stats.set(handle.filePath, {
        achievedFps:
          frames !== null && durationSec !== null ? frames / durationSec : null,
        // This ScreenCaptureKit SDK exposes no didDrop callback; the
        // receipt's frameStatuses are informational only. droppedFrames
        // stays null — never estimated (spec §11 honesty).
        droppedFrames: null,
        encodeCpu:
          typeof receipt.encodeCpuFraction === "number"
            ? receipt.encodeCpuFraction
            : null,
      });
    }
    return result;
  }

  async probe(filePath: string): Promise<RecorderFileProbe> {
    const probe = await probeMovFile(filePath);
    const stats = this.#stats.get(filePath);
    this.#stats.delete(filePath);
    return stats === undefined ? probe : { ...probe, stats };
  }

  async listPids(): Promise<readonly number[] | null> {
    return listRecorderPids(this.#options, {
      helperPath: this.#helperPath,
      artifactsDir: this.#options.artifactsDir ?? null,
    });
  }

  terminate(pid: number): Promise<boolean> {
    return Promise.resolve(terminatePid(this.#options, this.#session(), pid));
  }
}

/* ------------------------------------------------------------------ */
/* screencapture -V fallback tier                                      */
/* ------------------------------------------------------------------ */

class ScreencaptureRecorder implements ScreenRecorder {
  readonly tool = "screencapture";
  readonly toolVersion = "builtin";
  readonly fileExtension = ".mov";

  readonly #options: DarwinScreenRecorderOptions;
  readonly #screencapturePath: string;
  readonly #live = new Map<string, LiveRecording>();

  constructor(options: DarwinScreenRecorderOptions, screencapturePath: string) {
    this.#options = options;
    this.#screencapturePath = screencapturePath;
  }

  #session(): MacSession {
    const session = this.#options.session();
    if (session === null) {
      throw new Error(
        "no attested target session — the recorder cannot prove where to run",
      );
    }
    return session;
  }

  #spawn(command: string, args: readonly string[]): DarwinSpawnedProcess {
    const spawn = this.#options.spawn ?? defaultSpawn(this.#session());
    return spawn(command, args);
  }

  async start(request: RecorderStartRequest): Promise<RecorderStartResult> {
    this.#session(); // guard
    // `-V` records whole-display video for a whole-second duration; the
    // driver-side deadline still SIGTERMs earlier, and the helper-side
    // bound is the ceil so `-V` never under-runs the contract.
    const seconds = Math.max(1, Math.ceil(request.maxDurationMs / 1000));
    const proc = this.#spawn(this.#screencapturePath, [
      "-x",
      `-V${seconds}`,
      request.filePath,
    ]);

    // Fail-fast window: a bad path/permission exits immediately; give
    // the process a moment before declaring it alive.
    const delay = this.#options.fallbackStartDelayMs ?? 750;
    const early =
      (await proc.waitExit(delay)).exited || proc.hasExited();
    if (early) {
      throw new Error(
        "screencapture -V exited immediately: " +
          (proc.stderrText().trim() || "no diagnostic"),
      );
    }

    this.#live.set(request.filePath, { proc, filePath: request.filePath });

    // Whole-display delivery for every request: window/region/session
    // scopes are served with the gap recorded, never silently.
    const unhonored = unhonoredExclusions(request.exclude);
    if (
      request.scope.kind === "display" &&
      request.scope.displayId !== undefined
    ) {
      unhonored.push(
        `display-id:${request.scope.displayId} (screencapture -V cannot select a display)`,
      );
    }
    if (request.scope.kind === "window" || request.scope.kind === "region") {
      unhonored.push(
        `${request.scope.kind} scope cannot be isolated by screencapture -V; whole display recorded`,
      );
    }
    if (request.scope.kind === "session") {
      unhonored.push("session scope delivered as single-display capture");
    }

    return {
      handle: { pid: proc.pid, filePath: request.filePath },
      actualScope: { kind: "display" },
      unhonoredExclusions: unhonored,
    };
  }

  async stop(handle: RecorderHandle): Promise<RecorderStopResult> {
    const live = this.#live.get(handle.filePath);
    this.#live.delete(handle.filePath);
    if (live === undefined) {
      return {
        exited: true,
        exitCode: null,
        error: "no live recording tracked for this handle",
      };
    }
    return stopSpawned(live.proc, handle.pid, this.#options, this.#session());
  }

  async probe(filePath: string): Promise<RecorderFileProbe> {
    return probeMovFile(filePath);
  }

  async listPids(): Promise<readonly number[] | null> {
    return listRecorderPids(this.#options, {
      helperPath: null,
      artifactsDir: this.#options.artifactsDir ?? null,
    });
  }

  terminate(pid: number): Promise<boolean> {
    return Promise.resolve(terminatePid(this.#options, this.#session(), pid));
  }
}

/* ------------------------------------------------------------------ */
/* Facade — one ScreenRecorder per start (the resolver is called per   */
/* `record.start`, so `tool`/provenance always names the tier that     */
/* actually ran for THAT segment).                                     */
/* ------------------------------------------------------------------ */

type SharedState = {
  helperPath: string | null;
  helperError: string | null;
  compilePromise: Promise<void> | null;
};

/**
 * The production darwin recorder factory. `pick` chooses the tier per
 * scope: SCStream when the helper binary is available (prebuilt
 * `helperPath` or compiled from the shipped source), `screencapture
 * -V` otherwise; `session` scopes always take the fallback tier because
 * SCStream records a single display filter and pretending otherwise
 * would lie about `actualScope`.
 */
export function darwinScreenRecorder(
  options: DarwinScreenRecorderOptions,
): ScreenRecorder {
  const state: SharedState = {
    helperPath: null,
    helperError: null,
    compilePromise: null,
  };
  const screencapturePath = options.screencapturePath ?? DEFAULT_SCREENCAPTURE;
  const forced = options.tier ?? "auto";

  const ensureHelper = async (): Promise<boolean> => {
    if (state.helperPath !== null) return true;
    if (state.compilePromise === null) {
      state.compilePromise = (async () => {
        const result = await ensureScreenRecordHelper({
          helperPath: options.helperPath,
          helperSourcePath: options.helperSourcePath,
          helperBuildDir: options.helperBuildDir,
          swiftcPath: options.swiftcPath,
        });
        if ("path" in result) {
          state.helperPath = result.path;
        } else {
          state.helperError = result.error;
        }
      })();
    }
    await state.compilePromise;
    return state.helperPath !== null;
  };

  // One facade per resolved recorder; the resolver below mints a fresh
  // one per `record.start` so `tool` names the tier that ran.
  const makeFacade = (): ScreenRecorder => {
    let chosen: "sckit" | "screencapture" | null = null;
    let sckit: SckitRecorder | null = null;
    let fallback: ScreencaptureRecorder | null = null;
    const live = new Map<string, "sckit" | "screencapture">();

    const pick = async (scope: CaptureScope): Promise<ScreenRecorder> => {
      if (scope.kind === "session" || forced === "screencapture") {
        chosen = "screencapture";
        fallback ??= new ScreencaptureRecorder(options, screencapturePath);
        return fallback;
      }
      if (forced === "sckit") {
        if (!(await ensureHelper())) {
          throw new Error(
            "SCStream recorder requested but the helper is unavailable: " +
              (state.helperError ?? "unknown"),
          );
        }
        chosen = "sckit";
        sckit ??= new SckitRecorder(options, state.helperPath!);
        return sckit;
      }
      if (await ensureHelper()) {
        chosen = "sckit";
        sckit ??= new SckitRecorder(options, state.helperPath!);
        return sckit;
      }
      chosen = "screencapture";
      fallback ??= new ScreencaptureRecorder(options, screencapturePath);
      return fallback;
    };

    const recorderFor = (
      filePath: string,
    ): { readonly recorder: ScreenRecorder | null; readonly tier: "sckit" | "screencapture" | null } => {
      const tier = live.get(filePath) ?? chosen;
      if (tier === "sckit") return { recorder: sckit, tier };
      if (tier === "screencapture") return { recorder: fallback, tier };
      return { recorder: null, tier: null };
    };

    return {
      get tool() {
        return chosen === "sckit" ? "screen-record.swift" : "screencapture";
      },
      toolVersion: "1",
      fileExtension: ".mov",
      async start(request) {
        const recorder = await pick(request.scope);
        const result = await recorder.start(request);
        live.set(request.filePath, chosen ?? "screencapture");
        return result;
      },
      async stop(handle) {
        const { recorder } = recorderFor(handle.filePath);
        live.delete(handle.filePath);
        if (recorder === null) {
          return {
            exited: true,
            exitCode: null,
            error: "no recorder backend recorded this segment",
          };
        }
        return recorder.stop(handle);
      },
      async probe(filePath) {
        const { recorder } = recorderFor(filePath);
        return recorder !== null
          ? recorder.probe(filePath)
          : probeMovFile(filePath);
      },
      async listPids() {
        // Both tiers' patterns: the helper binary (once known) and the
        // artifacts dir for screencapture cmdlines.
        if (forced !== "screencapture" && state.helperPath === null) {
          await ensureHelper();
        }
        return listRecorderPids(options, {
          helperPath: state.helperPath,
          artifactsDir: options.artifactsDir ?? null,
        });
      },
      terminate(pid) {
        const session = options.session();
        if (session === null) return Promise.resolve(false);
        return Promise.resolve(terminatePid(options, session, pid));
      },
    };
  };

  return makeFacade();
}

/**
 * The `RecorderResolver` the production `ae.record` wiring installs on
 * darwin. Each call mints a fresh facade so `tool` provenance names the
 * tier that ran for that segment. Returns `null` for non-darwin
 * platforms — callers keep the honest `unsupported` refusal there.
 */
export function darwinRecorderResolver(
  options: DarwinScreenRecorderOptions,
): ((scope: CaptureScope) => ScreenRecorder | null) | null {
  if (process.platform !== "darwin") return null;
  return () => darwinScreenRecorder(options);
}
