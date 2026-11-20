/**
 * The real transport: run a host script by invoking After Effects itself.
 *
 * Windows and macOS reach the same result by different routes, and the
 * difference is not cosmetic — see ADR 0001.
 *
 *   Windows  `AfterFX.exe -r <entry.jsx>`
 *            Single-instance: if AE is already running the new process hands
 *            the script to it and exits without a usable status. The process is
 *            therefore not waited on; the driver's result-file poll is what
 *            reports success or timeout.
 *
 *   macOS    `osascript` → `tell application <bundle path>` → `DoScriptFile`
 *            Synchronous. The bundle is addressed by path, not by name: the
 *            name differs per release (`Adobe After Effects 2026`) and the
 *            bare `Adobe After Effects` does not resolve to AE at all, which
 *            makes osascript fail to compile the script (-2741).
 *
 *            The host itself is started through LaunchServices (`open`),
 *            never by exec'ing the binary: a directly spawned AE is unknown
 *            to LaunchServices for seconds, and an Apple Event addressed by
 *            bundle path that arrives in that gap makes LaunchServices start
 *            a second instance (observed on AE 27.0, issue #105).
 */

import { execFileSync, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";

import { macAppBundle, resolveInstall, type AfterEffectsInstall } from "./install-path.js";
import {
  MacSessionError,
  consoleSessionUid,
  readGuiSession,
  runInSession,
  spawnInSession,
  type MacSession,
} from "./mac-session.js";
import {
  execFileCensusRunner,
  windowServerCensus,
  type WindowCensus,
} from "../platform/darwin/window-census.js";
import { errorMessage } from "../errors.js";
import type {
  HostAttestation,
  HostOwnership,
  HostState,
  HostTransport,
  InvokeOptions,
  OwnedProcess,
  PendingLaunch,
} from "./transport.js";
import {
  AttachTargetError,
  ScriptNotSentError,
  ScriptingPermissionError,
} from "./transport.js";
import {
  aeScriptingPermission,
  currentUsername,
  type AeScriptingPermission,
} from "../platform/darwin/scripting-permission.js";
import {
  MAX_DIAGNOSTIC_CHARS,
  psProcesses,
  sameProcess,
  sameWindowsPath,
  summariseProcessOutput,
  windowsProcesses,
  type HostProcess,
} from "./host-processes.js";

export {
  MAX_DIAGNOSTIC_CHARS,
  parsePsProcesses,
  parseWindowsProcessList,
  sameProcess,
  sameWindowsPath,
  summariseProcessOutput,
  windowsProcesses,
} from "./host-processes.js";
export type { HostProcess } from "./host-processes.js";

export type ScriptInvocationOptions = {
  /** Explicit install directory; skips discovery. */
  readonly installDir?: string;
  /** Adobe root to scan. Mainly a test seam. */
  readonly installRoot?: string;
  /** Pre-resolved install, when the caller already discovered one. */
  readonly install?: AfterEffectsInstall;
  readonly platform?: NodeJS.Platform;
  /** How long `close` waits for AE to exit after `app.quit`. */
  readonly exitTimeoutMs?: number;
  /**
   * The WindowServer census `close` consults when `app.quit` does not take
   * effect, to name the windows still blocking the quit. Mainly a test seam;
   * defaults to running the census inside the target session.
   */
  readonly windowCensus?: () => WindowCensus;
  /** Running processes. Mainly a test seam. */
  readonly processes?: () => readonly HostProcess[];
  /** The clock ownership is judged against. Mainly a test seam. */
  readonly now?: () => number;
  /** Starts the Windows launcher. Mainly a test seam. */
  readonly spawnLauncher?: SpawnLauncher;
  /**
   * Starts the macOS host explicitly and returns its pid. Mainly a test seam;
   * defaults to asking LaunchServices (`open`) and watching for the process
   * it starts.
   */
  readonly launchMacHost?: () => Promise<number | undefined>;
  /**
   * Runs `open <bundle>` for the macOS host. Mainly a test seam; defaults to
   * running it inside the target session.
   */
  readonly openMacApp?: (bundle: string) => Promise<void>;
  /** How long the process `open` started is watched for in `ps`. Mainly a test seam. */
  readonly macLaunchObserveMs?: number;
  /** How often that watch asks the process list. Mainly a test seam. */
  readonly macLaunchPollMs?: number;
  /**
   * The 8.3 short form of a Windows directory, or null if it has none. Mainly a
   * test seam; defaults to asking Windows.
   */
  readonly shortPath?: (directory: string) => string | null;
  /** This process's id, as the parent of the launchers it spawns. Mainly a test seam. */
  readonly selfPid?: number;
  /**
   * Whether the After Effects at `executable` has shown its main window
   * (Windows). Mainly a test seam; defaults to asking Windows.
   */
  readonly mainWindowVisible?: (executable: string) => boolean;
  /** How often that is asked while waiting. Mainly a test seam. */
  readonly readyPollMs?: number;
  /**
   * The OS user whose login session owns the After Effects (macOS only).
   *
   * Defaults to the user this process runs as. When it names another user,
   * the Apple Event is delivered *inside that user's session* and the
   * process list is scoped to it, so a second After Effects on the same
   * machine — the console user's, say — is neither addressed nor quit.
   */
  readonly sessionUid?: number;
  /**
   * Re-reads the target's login session immediately before a command is
   * sent. Mainly a test seam; defaults to `readGuiSession(sessionUid)`.
   * The session proven at construction can end or change (logout/login
   * gives a new asid; a fast user switch can make it the console session),
   * and a stale proof must never deliver an Apple Event — issue #59 T035.
   */
  readonly readTargetSession?: () => MacSession | null;
  /**
   * Reads the console session's owner uid (-1 when unreadable). Mainly a
   * test seam; defaults to `consoleSessionUid`.
   */
  readonly consoleUid?: () => number;
  /**
   * The macOS install's scripting file/network permission, evaluated for
   * the account that will run After Effects. Mainly a test seam; defaults
   * to reading that account's AE prefs (`scripting-permission.ts`). Only a
   * proven "blocked" refuses the launch — "unreadable" or null proceeds,
   * the same rule the doctor probe follows: an unevaluated fact is never
   * treated as either allowed or blocked.
   */
  readonly macScriptingPermission?: () => AeScriptingPermission | null;
  /**
   * Adopt a host a previous session recorded, instead of starting one.
   *
   * The record is checked against the live process list: the pid must still
   * name the same process (pid *and* start time, plus the Windows creation
   * identity), it must run this install's executable, and it must be the
   * only instance of that install in scope. Anything less refuses the
   * adoption and nothing is launched — resume never quietly starts a
   * replacement host. Ownership is still only claimed after the readiness
   * probe answers, exactly as for a launched host.
   */
  readonly adopt?: {
    readonly pid: number;
    /** Process start time in ms; null cannot prove identity and refuses. */
    readonly startedAt: number | null;
    /** Windows full creation time, when the record has one. */
    readonly identity?: string | null;
    readonly executable: string;
    /** When the record was written, for evidence strings only. */
    readonly recordedAt?: string;
  };
  /**
   * Attach-only mode (#269): `launch()` never starts a process. It selects
   * exactly one already-running instance of this install — the process
   * `targetPid` names, or the single candidate when none is pinned — and
   * refuses with `AttachTargetError` when the census cannot prove one
   * unambiguous target.
   *
   * This is the structural half of "attach can never spawn": the launch
   * branch that would call `open`/`AfterFX.exe` is unreachable while this
   * is set. On Windows the mode refuses outright, because every `invoke`
   * there delivers the script by spawning `AfterFX.exe -r` — a process
   * creation the attach-only contract forbids. Windows attach goes
   * through the in-AE dispatcher transport instead, whose file channel
   * spawns nothing.
   *
   * Mutually exclusive with `adopt`: adoption proves a recorded launch,
   * attach proves a live census target; a transport does one or the other.
   */
  readonly attach?: {
    /** Pin the attach to one pid; it must name a single in-scope instance. */
    readonly targetPid?: number;
  };
};

/**
 * The macOS bundle's `CFBundleShortVersionString` (`27.0x78`), or null when
 * it cannot be read. The AE prefs folder is keyed by `major.minor` of this
 * (`27.0`), so it is what the scripting-permission check needs.
 */
function macBundleVersion(bundle: string): string | null {
  try {
    const out = execFileSync(
      "plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(bundle, "Contents", "Info.plist"),
      ],
      { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const version = out.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Whether a visible top-level `AE_CApplication*` window belongs to a process
 * running `executable`. A window of another installed version that is already
 * open does not count: it says nothing about the one that is starting. AE creates
 * it hidden at start-up and shows it once its plug-ins, the scripting engine
 * among them, are loaded; a crash-recovery or other start-up dialog keeps it
 * hidden. The class name does not depend on the UI language.
 */
export function windowsMainWindowVisible(executable: string): boolean {
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System; using System.Text; using System.Runtime.InteropServices;",
    "public class A8nW {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    "  public static System.Collections.Generic.List<uint> Pids() {",
    "    var found = new System.Collections.Generic.List<uint>();",
    "    EnumWindows(delegate(IntPtr h, IntPtr l) {",
    "      var c = new StringBuilder(256); GetClassName(h, c, 256);",
    '      if (c.ToString().StartsWith("AE_CApplication") && IsWindowVisible(h)) { uint p; GetWindowThreadProcessId(h, out p); found.Add(p); }',
    "      return true; }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    "$want = $env:A8N_AE_EXECUTABLE.Replace('/', '\\').ToLowerInvariant()",
    "$hit = $false",
    "foreach ($p in [A8nW]::Pids()) {",
    '  $path = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).ExecutablePath',
    "  if ($path -and $path.Replace('/', '\\').ToLowerInvariant() -eq $want) { $hit = $true }",
    "}",
    "if ($hit) { 'yes' } else { 'no' }",
  ].join("\n");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, A8N_AE_EXECUTABLE: executable },
    });
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * The 8.3 short name of an existing directory, via Windows itself. Null when
 * the volume has no short names (8.3 creation can be disabled) or the lookup
 * fails.
 */
function windowsShortPath(directory: string): string | null {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // UTF-8 explicitly: PowerShell otherwise answers in the console code
        // page (CP932 on a Japanese system), which garbles a kana short name.
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
          "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:A8N_DIR).ShortPath",
      ],
      {
        encoding: "utf-8",
        timeout: 15_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, A8N_DIR: directory },
      },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Thrown before launching: `AfterFX.exe -r` would silently ignore this path. */
export class UnsupportedScriptPathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `After Effects cannot be given a script path that contains whitespace (\`AfterFX.exe -r\` drops it ` +
        `without an error), and no 8.3 short name is available for it: ${path}. ` +
        "Use a session directory whose path has no spaces, for example through the sessionRoot option.",
    );
    this.name = "UnsupportedScriptPathError";
    this.path = path;
  }
}

/** What the Windows launcher needs from a child process. */
export interface LauncherChild extends Pick<EventEmitter, "on"> {
  unref(): void;
  /** The launcher's process id. On a cold start it *is* After Effects. */
  readonly pid?: number | undefined;
}

export type SpawnLauncher = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly detached: boolean; readonly stdio: "ignore"; readonly windowsHide: boolean },
) => LauncherChild;



/** AE saves preferences and tears down plugins on quit; that takes seconds. */
export const EXIT_TIMEOUT_MS = 60_000;
const EXIT_POLL_MS = 250;







/** `ps` reports start times to the second, and clocks round. */
const START_SLACK_MS = 2_000;

/** A cold After Effects start can take a minute on a spinning disk. */
export const READINESS_TIMEOUT_MS = 180_000;

/**
 * How long `open` is given to produce a process the ownership check can
 * name. `open` returns once LaunchServices has accepted the launch; the
 * process itself appears in `ps` a moment later.
 */
export const MAC_HOST_OBSERVE_MS = 30_000;
const MAC_HOST_OBSERVE_POLL_MS = 250;

/**
 * Runs `DoScriptFile` against the application at a path, both taken from argv.
 *
 * Neither path is ever spliced into AppleScript source, so nothing needs
 * escaping. That forces the raw event code: with the target only known at run
 * time the compiler cannot look up the `DoScriptFile` term in AE's dictionary.
 * `miscfile` is the code AE's sdef declares for it.
 */
export const MAC_DO_SCRIPT_FILE = [
  "on run argv",
  // AppleScript's default 120 s would fail a long render that AE is still
  // running. The driver owns the call's deadline; osascript just waits.
  "  with timeout of 3600 seconds",
  "    tell application (item 1 of argv)",
  "      «event miscfile» (item 2 of argv)",
  "    end tell",
  "  end timeout",
  "end run",
];



/**
 * Waits for `work`, or rejects as soon as `signal` aborts. `work` itself is
 * not cancelled; it settles on its own.
 */
function untilAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(new Error("invocation abandoned: the call's deadline passed"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("invocation abandoned: the call's deadline passed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A launcher process that failed, with what it said about why. */
export class ScriptInvocationError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(
      `${command} exited with code ${exitCode ?? "null"}` + (stderr.length > 0 ? `: ${stderr}` : ""),
    );
    this.name = "ScriptInvocationError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class ScriptInvocationTransport implements HostTransport {
  readonly kind = "script-invocation";
  readonly #install: AfterEffectsInstall;
  readonly #platform: NodeJS.Platform;
  readonly #exitTimeoutMs: number;
  readonly #processes: () => readonly HostProcess[];
  readonly #now: () => number;
  readonly #spawnLauncher: SpawnLauncher;
  readonly #launchMacHost: () => Promise<number | undefined>;
  readonly #openMacApp: (bundle: string) => Promise<void>;
  readonly #macLaunchObserveMs: number;
  readonly #macLaunchPollMs: number;
  readonly #shortPath: (directory: string) => string | null;
  readonly #mainWindowVisible: (executable: string) => boolean;
  readonly #selfPid: number;
  /** Pids of the `AfterFX.exe -r` launchers this transport spawned. Each is a second AfterFX.exe for under a second. */
  readonly #launcherPids = new Set<number>();
  readonly #readyPollMs: number;
  /** Directory → the form of it `-r` can be given. */
  readonly #argumentDirs = new Map<string, string>();
  /**
   * The macOS login session that owns the After Effects this transport talks
   * to. Null when the platform is not macOS, or when the session could not be
   * identified — in which case a script for another user is refused rather
   * than sent somewhere unproven.
   */
  readonly #targetSession: MacSession | null;
  /** The uid whose processes this transport may address. */
  readonly #sessionUid: number;
  readonly #readTargetSession: () => MacSession | null;
  readonly #consoleUid: () => number;
  /** Host processes already running when launch() began. */
  #preexisting: readonly HostProcess[] | null = null;
  #launchBegan = 0;
  /** The process this session started, once the probe has answered. */
  #owned: HostProcess | null = null;
  #ownershipAtLaunch: HostOwnership = { kind: "unknown", evidence: "not launched" };
  #launched = false;
  /** The pid of the host process this transport itself started, if the start reported one. */
  #spawnedPid: number | undefined;
  /** macOS: the start time of the process #spawnedPid names, once `ps` first reported it. */
  #spawnedAt: number | undefined;
  #confirmed = false;
  /** The DoScriptFile still waiting on AE, if a call gave up on it. */
  #inFlight: Promise<void> | null = null;
  /** Set when this transport was asked to adopt a recorded host. */
  readonly #adopt: NonNullable<ScriptInvocationOptions["adopt"]> | null;
  /** Set when this transport is attach-only: `launch()` selects, never starts. */
  readonly #attach: NonNullable<ScriptInvocationOptions["attach"]> | null;
  /** The census target an attach-only launch selected, once proven at confirm. */
  #attached: HostProcess | null = null;
  readonly #macScriptingPermission: () => AeScriptingPermission | null;
  readonly #windowCensus: (() => WindowCensus) | undefined;

  constructor(options: ScriptInvocationOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.#platform = platform;
    this.#exitTimeoutMs = options.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
    this.#windowCensus = options.windowCensus;
    this.#processes = options.processes ?? (platform === "win32" ? windowsProcesses : psProcesses);
    this.#now = options.now ?? Date.now;
    this.#spawnLauncher = options.spawnLauncher ?? spawn;
    this.#launchMacHost = options.launchMacHost ?? (() => this.#openMacHost());
    this.#openMacApp = options.openMacApp ?? ((bundle) => this.#runInSession("open", [bundle]));
    this.#macLaunchObserveMs = options.macLaunchObserveMs ?? MAC_HOST_OBSERVE_MS;
    this.#macLaunchPollMs = options.macLaunchPollMs ?? MAC_HOST_OBSERVE_POLL_MS;
    this.#shortPath = options.shortPath ?? windowsShortPath;
    this.#mainWindowVisible = options.mainWindowVisible ?? windowsMainWindowVisible;
    this.#selfPid = options.selfPid ?? process.pid;
    this.#readyPollMs = options.readyPollMs ?? 500;
    this.#adopt = options.adopt ?? null;
    this.#attach = options.attach ?? null;
    if (this.#adopt !== null && this.#attach !== null) {
      throw new TypeError("adopt and attach are mutually exclusive transport modes");
    }
    if (
      this.#attach !== null &&
      this.#attach.targetPid !== undefined &&
      (!Number.isInteger(this.#attach.targetPid) || this.#attach.targetPid <= 0)
    ) {
      throw new TypeError("attach.targetPid must be a positive integer");
    }
    this.#macScriptingPermission =
      options.macScriptingPermission ?? (() => this.#defaultMacScriptingPermission());
    this.#install =
      options.install ??
      resolveInstall(platform, {
        ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
        ...(options.installRoot === undefined ? {} : { root: options.installRoot }),
      });
    this.#sessionUid =
      options.sessionUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
    this.#readTargetSession =
      options.readTargetSession ?? (() => readGuiSession(this.#sessionUid));
    this.#consoleUid = options.consoleUid ?? consoleSessionUid;
    this.#targetSession = platform === "darwin" ? this.#readTargetSession() : null;
  }

  get install(): AfterEffectsInstall {
    return this.#install;
  }

  /**
   * Whether this transport was built attach-only (#269). `launch()` then
   * selects a running instance and has no path to process creation — the
   * public `AfterEffects.attach` refuses a script transport without this.
   */
  get attachOnly(): boolean {
    return this.#attach !== null;
  }

  /** The login session this transport talks into, when it is macOS. */
  get targetSession(): MacSession | null {
    return this.#targetSession;
  }

  /**
   * The pid of the After Effects process this session is tied to, once it
   * is known: the owned host, or the census target an attach-only session
   * selected. Diagnostics evidence only — never proof of ownership.
   *
   * The GUI fallback needs the owned pid: a dialog is only ever closed in
   * the session of the process that raised it.
   */
  hostPid(): number | null {
    // An attach-only session names the census target it talks to; it is
    // diagnostics evidence, never ownership — `#owned` stays null.
    return this.#owned?.pid ?? this.#attached?.pid ?? null;
  }

  /**
   * The proven host process, for launch provenance. Only `#owned` counts:
   * a spawned-but-unproven pid is not identity a later session can adopt.
   */
  ownedProcess(): OwnedProcess | null {
    const owned = this.#owned;
    if (owned === null) {
      return null;
    }
    return {
      pid: owned.pid,
      startedAt: owned.startedAt,
      ...(owned.identity === undefined ? {} : { identity: owned.identity }),
      executable: owned.executable,
    };
  }

  /**
   * What this transport can attest for the capability handshake (#102).
   *
   * The host runs on this machine — that is what script invocation means —
   * so the controller's platform *is* the host's. The execution mode is
   * "isolated-user" only when the target session provably belongs to a
   * different uid; anything else is "local".
   */
  attestation(): Partial<HostAttestation> {
    const self = typeof process.getuid === "function" ? process.getuid() : null;
    const isolatedUser = self !== null && this.#sessionUid !== self;
    return {
      pid: this.hostPid(),
      ownedProcess: this.ownedProcess(),
      platform: { os: process.platform, arch: process.arch },
      executionMode: isolatedUser ? "isolated-user" : "local",
      sessionUid: this.#targetSession?.uid ?? null,
      sessionAsid: this.#targetSession?.asid ?? null,
      sessionUser: this.#targetSession?.username ?? null,
      // Every call runs the host script inside the GUI After Effects — an
      // Apple Event into a login session on macOS, `-r` handed to the
      // interactive instance on Windows — so dispatch needs that GUI
      // session reachable; there is no headless path on this transport.
      requiresGuiDelivery: true,
      // Session-scoped delivery refuses rather than fall back to the
      // console session, but only when the target is provably another
      // user's: a "local" target may be the console session itself, so the
      // refusal is not claimed there.
      refusesConsoleTarget: isolatedUser,
    };
  }

  /**
   * Whether the host process still exists, proven the same way ownership is:
   * pid *and* start time, so a reused pid is a different process.
   *
   * Only a process this transport can name gives a definite answer. An
   * attached or unproven host has no single process to check: with no
   * candidate of this install left in scope the host is gone; with
   * candidates present it is "unknown", never "alive" — one of them may be
   * a different After Effects than the one that answered.
   */
  hostState(): HostState {
    if (!this.#launched) {
      return "unknown";
    }
    const owned = this.#owned;
    if (owned !== null) {
      return this.#processState(owned);
    }
    const attached = this.#attached;
    if (attached !== null) {
      // Attach-only: the selected census target is the process this session
      // talks to. Same pid+start proof as ownership; "alive"/"gone" only.
      return this.#processState(attached);
    }
    const spawnedPid = this.#spawnedPid;
    // Only when the snapshot proved nothing else was running: on Windows a
    // launcher handed to an already-running AE exits normally, and its pid
    // being gone says nothing about the host that answered.
    if (spawnedPid !== undefined && this.#preexisting !== null && this.#preexisting.length === 0) {
      // Started by this transport but not yet proven by the probe: the pid
      // is still the best identity there is. It must have appeared after
      // launch began, and match the start time once one was pinned.
      let now: HostProcess[];
      try {
        now = this.#hostProcesses();
      } catch {
        return "unknown";
      }
      const match = now.find((p) => p.pid === spawnedPid);
      if (match === undefined) {
        return "gone";
      }
      const pinned = this.#spawnedAt;
      if (pinned !== undefined) {
        return Math.abs(match.startedAt - pinned) <= 1_000 ? "alive" : "gone";
      }
      return match.startedAt >= this.#launchBegan - START_SLACK_MS ? "alive" : "gone";
    }
    try {
      return this.#hostProcesses().length === 0 ? "gone" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** "alive"/"gone" for one identified process; "unknown" when the list cannot be read. */
  #processState(known: HostProcess): HostState {
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch {
      return "unknown";
    }
    return now.some((p) => sameProcess(this.#platform, p, known)) ? "alive" : "gone";
  }

  /**
   * The After Effects this transport is talking to, whether or not it has
   * answered a script yet.
   *
   * The GUI fallback needs this *before* the readiness probe has answered: a
   * modal dialog that blocks the host is exactly the reason the probe never
   * answers, so the process has to be findable in that state. On macOS the
   * host is started explicitly by `launch()`, but the ownership bookkeeping
   * waits for the probe, which a blocking dialog prevents.
   *
   * Only the process this transport itself started — the pid `launch()`
   * recorded, and the start time first seen for it — counts, and only while
   * it is the single instance of this install in the session. "The only
   * process that appeared after the snapshot" is deliberately not evidence:
   * it cannot tell the run's After Effects from one the human started a
   * moment later. Ownership itself stays as strict as it was: quitting still
   * requires the probe's proof.
   *
   * Every call re-reads the process list, for both the owned and the
   * spawned-but-unproven host: a pid is not an identity, and the process
   * can exit and have its pid reused between two calls — the GUI fallback
   * calls this immediately before each action it takes.
   */
  recoveryTargetPid(): number | null {
    const owned = this.#owned;
    if (owned !== null) {
      // The probe proved this pid *and* start time once; prove it again
      // now. Same process and still the only instance of this install in
      // scope, or no target: a reused pid or a second instance is
      // ambiguity, and ambiguity fails closed.
      let now: HostProcess[];
      try {
        now = this.#hostProcesses();
      } catch {
        return null;
      }
      const same = now.filter((p) => sameProcess(this.#platform, p, owned));
      return same.length === 1 && now.length === 1 ? owned.pid : null;
    }
    if (this.#platform !== "darwin" || this.#spawnedPid === undefined) {
      return null;
    }
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch {
      return null;
    }
    const match = now.find(
      (p) =>
        p.pid === this.#spawnedPid &&
        (this.#spawnedAt === undefined || Math.abs(p.startedAt - this.#spawnedAt) <= 1_000),
    );
    if (now.length !== 1 || match === undefined) {
      return null;
    }
    // Pinned on first sight, so a reused pid with a different start time is a
    // different process on every later call too.
    this.#spawnedAt = match.startedAt;
    return match.pid;
  }

  /**
   * The process this transport started but whose ownership the probe never
   * proved, with the start time the process list first reported for its pid.
   *
   * This is what a failed launch leaves a human: the pid this transport
   * itself spawned, not "an instance that appeared" — the same restriction
   * `recoveryTargetPid` uses, and for the same reason. If the pid now names a
   * process that started at another time, the one this session started is
   * gone and the pinned start time says so. A list that cannot be read keeps
   * the pid and leaves the start time unknown rather than guessing.
   *
   * It never proves ownership: `ownership()` stays "unknown" until the probe
   * answers, so nothing here may be quit.
   */
  pendingLaunch(): PendingLaunch | null {
    if (!this.#launched || this.#owned !== null || this.#spawnedPid === undefined) {
      return null;
    }
    let match: HostProcess | undefined;
    try {
      const now = this.#hostProcesses();
      match = now.find(
        (p) =>
          p.pid === this.#spawnedPid &&
          (this.#spawnedAt === undefined || Math.abs(p.startedAt - this.#spawnedAt) <= 1_000),
      );
    } catch {
      match = undefined;
    }
    if (match !== undefined && this.#spawnedAt === undefined) {
      this.#spawnedAt = match.startedAt;
    }
    const session = this.#targetSession;
    return {
      pid: this.#spawnedPid,
      startedAt: this.#spawnedAt ?? null,
      executable: this.#install.executable,
      presentAtLastLookup: match !== undefined,
      session:
        this.#platform === "darwin"
          ? {
              uid: this.#sessionUid,
              user: session?.username ?? null,
              asid: session?.asid ?? null,
            }
          : null,
    };
  }

  /** The session this transport talks into, in words a human can check. */
  #sessionDescription(): string {
    const session = this.#targetSession;
    if (session === null) {
      return `the session of uid ${this.#sessionUid} (not identified)`;
    }
    return `the session of ${session.username} (uid ${session.uid}, asid ${session.asid ?? "unknown"})`;
  }

  available(): Promise<boolean> {
    return Promise.resolve(existsSync(this.#install.executable));
  }

  /**
   * The selected install's scripting file/network permission, or null when
   * it cannot be evaluated honestly: the After Effects runs in another
   * account's session (its prefs are not readable), the executable is not
   * inside a bundle, the bundle version cannot be read, or the prefs file
   * or key is absent. Null is "unproven", never "allowed" — the launch
   * check only refuses on a proven "blocked".
   */
  #defaultMacScriptingPermission(): AeScriptingPermission | null {
    const self = typeof process.getuid === "function" ? process.getuid() : null;
    if (self === null || this.#sessionUid !== self) {
      return null;
    }
    const bundle = macAppBundle(this.#install.executable);
    if (bundle === null) {
      return null;
    }
    return aeScriptingPermission(macBundleVersion(bundle), currentUsername());
  }

  /**
   * Starts After Effects only if it is not already running.
   *
   * Launching is deliberately not awaited to completion: AE takes tens of
   * seconds to become scriptable on a cold start, and the readiness probe in
   * `AeDriver.start` is the thing that actually gates on usability. Blocking
   * here on process exit would report success before AE could answer.
   */
  async launch(): Promise<void> {
    if (this.#launched) {
      // One transport is one connection to one host. A second driver on it
      // must not re-decide ownership: the AE this transport started would by
      // then count as "already running".
      return;
    }
    if (this.#platform === "darwin") {
      // Before anything is started or addressed: with script file writes
      // disabled the host can open a result file but never fill it, so the
      // readiness probe could only ever time out (issue #188). A proven
      // "blocked" fails here with the remedy; anything unevaluated proceeds.
      const permission = this.#macScriptingPermission();
      if (permission?.state === "blocked") {
        throw new ScriptingPermissionError(
          `After Effects script file/network access is disabled for this account ` +
            `(Pref_SCRIPTING_FILE_NETWORK_SECURITY = "${permission.prefValue ?? "?"}" in ${permission.prefsDir}). ` +
            "The bridge writes requests and results as files, so every call would time out. " +
            'Enable "Allow Scripts to Write Files and Access Network" in After Effects ' +
            "(Settings > Scripting & Expressions) for the account that runs it, then retry.",
        );
      }
    }
    this.#launched = true;
    this.#launchBegan = this.#now();
    if (this.#attach !== null) {
      // Attach-only (#269): select a running instance or refuse. The spawn
      // branches below are unreachable from here — there is no code path
      // from this branch to `open`/`AfterFX.exe`.
      this.#selectAttachTarget();
      return;
    }
    if (this.#adopt !== null) {
      this.#adoptProcess();
      return;
    }
    if (this.#platform === "win32") {
      // Before anything is started: whatever is running now is not ours. A
      // list that cannot be read leaves ownership unproven, never assumed.
      try {
        this.#preexisting = this.#hostProcesses();
      } catch {
        this.#preexisting = null;
      }
    }
    if (this.#platform === "darwin") {
      // Whatever is running now was not started by this session. A process
      // list that cannot be read leaves ownership unproven, never assumed —
      // the same rule the Windows branch follows: the readiness probe below
      // is what decides whether the host answers.
      try {
        this.#preexisting = this.#hostProcesses();
      } catch {
        this.#preexisting = null;
      }
      if (this.#preexisting !== null && this.#preexisting.length === 0) {
        // Start it here rather than letting DoScriptFile start it on demand.
        // The Apple Event gives no pid, so "an After Effects appeared after
        // the snapshot" is all the evidence there would be — and that is
        // equally true of an instance the human starts a moment later. The
        // pid this call observes is what lets ownership be bound to it.
        this.#spawnedPid = await this.#launchMacHost();
      }
      return;
    }
    if (this.#platform !== "win32") {
      return;
    }
    // No arguments: this is After Effects itself, not a command that finishes.
    // Waiting for it to exit would hold the session until AE quit and the
    // readiness probe would never run, so only the start is awaited.
    this.#spawnedPid = await this.#startWindows([]);
  }

  /**
   * Windows: waits for AE's main window to be visible before any `-r` is sent.
   * Sending one earlier is no use (see `HostTransport.awaitScriptable`), and
   * re-sending it while waiting made things worse: each `-r` is a process, and
   * one started a second AE instance. Elsewhere there is nothing to wait for.
   */
  async awaitScriptable(timeoutMs: number): Promise<boolean> {
    if (this.#platform !== "win32") {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#mainWindowVisible(this.#install.executable)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((done) => setTimeout(done, this.#readyPollMs));
    }
  }

  /**
   * Whether the transport can prove which instance answered.
   *
   * Windows cannot aim `-r` at a process. macOS aims its Apple Event at a
   * session, but a session may already hold an After Effects this session
   * did not start, so the driver leaves a marker in the instance that
   * answers the probe and requires that marker before it quits anything.
   */
  get verifiesDestination(): boolean {
    return this.#platform === "win32" || this.#platform === "darwin";
  }

  /**
   * Validates the recorded host an adoption names, against the live process
   * list. Throws on anything short of proof; on success `#owned` names the
   * process so `confirmLaunched` can re-verify it once the probe answers.
   * Nothing is started here: a refused or stale record leaves the machine
   * exactly as it was.
   */
  #adoptProcess(): void {
    const adopt = this.#adopt;
    if (adopt === null) {
      return;
    }
    const refuse = `cannot adopt the recorded After Effects`;
    if (adopt.executable !== this.#install.executable) {
      throw new Error(
        `${refuse}: the record names ${adopt.executable}, which is not this install's executable ${this.#install.executable}`,
      );
    }
    if (adopt.startedAt === null) {
      throw new Error(`${refuse}: the record has no process start time, so the pid alone cannot prove identity`);
    }
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch (error) {
      throw new Error(
        `${refuse}: the process list could not be read (${errorMessage(error)})`,
      );
    }
    const recorded: HostProcess = {
      pid: adopt.pid,
      startedAt: adopt.startedAt,
      executable: adopt.executable,
      ...(adopt.identity === null || adopt.identity === undefined ? {} : { identity: adopt.identity }),
    };
    const match = now.find((p) => sameProcess(this.#platform, p, recorded));
    if (match === undefined) {
      throw new Error(`${refuse}: pid ${adopt.pid} with the recorded start time is not among the running instances`);
    }
    if (now.length !== 1) {
      throw new Error(
        `${refuse}: ${now.length} instances of this install are running, so the recorded pid cannot be told apart ` +
          "from another After Effects",
      );
    }
    this.#owned = match;
    this.#spawnedPid = match.pid;
    this.#spawnedAt = match.startedAt;
    this.#preexisting = now;
  }

  /**
   * Attach-only target selection (#269), run by `launch()` in place of every
   * spawn branch. One census decides: the process `targetPid` names, or the
   * single in-scope instance when nothing is pinned. Anything short of one
   * provable target is an `AttachTargetError` — never a launch, never a
   * guess between two After Effects.
   */
  #selectAttachTarget(): void {
    const attach = this.#attach;
    if (attach === null) {
      return;
    }
    if (this.#platform === "win32") {
      // Every `invoke` on Windows is `AfterFX.exe -r <script>`: delivering
      // the probe itself would create a process, so script invocation has
      // no attach-only lane here. The in-AE dispatcher channel spawns
      // nothing and is the attach path on this platform.
      throw new AttachTargetError(
        "unsupported",
        "attach-only is not available through script invocation on Windows: every script delivery " +
          "spawns AfterFX.exe -r, which creates a process. Use transport \"in-ae-dispatcher\" " +
          "(a running After Effects with the dispatcher activated) or supply your own HostTransport.",
      );
    }
    let raw: readonly HostProcess[];
    try {
      raw = this.#processes();
    } catch (error) {
      throw new AttachTargetError(
        "unknown-target",
        `the After Effects process list could not be read (${errorMessage(error)}); ` +
          "which instance would answer cannot be proven, so nothing was sent",
        { cause: error },
      );
    }
    const candidates = this.#hostProcessesFrom(raw);
    // After Effects of this install that the session scope excluded — on
    // macOS that is another OS user's instance. Reported as wrong-session
    // rather than not-found: the AE exists, it is just not ours to drive.
    const foreignSession = raw.filter(
      (p) => p.executable === this.#install.executable && !candidates.includes(p),
    );
    const targetPid = attach.targetPid;
    let target: HostProcess;
    if (targetPid !== undefined) {
      const matches = candidates.filter((p) => p.pid === targetPid);
      if (matches.length === 1) {
        target = matches[0] as HostProcess;
      } else if (matches.length === 0) {
        const named = raw.filter((p) => p.pid === targetPid);
        if (named.some((p) => p.executable === this.#install.executable)) {
          throw new AttachTargetError(
            "wrong-session",
            `pid ${targetPid} is this install's After Effects but in a session this process cannot ` +
              `address (${this.#sessionDescription()}); attach refused rather than risk another user's AE`,
          );
        }
        throw new AttachTargetError(
          "not-found",
          `pid ${targetPid} is not a running ${this.#install.executable} After Effects; nothing was sent`,
        );
      } else {
        throw new AttachTargetError(
          "ambiguous",
          `pid ${targetPid} names ${matches.length} in-scope After Effects processes; nothing was sent`,
        );
      }
    } else if (candidates.length === 0) {
      if (foreignSession.length > 0) {
        throw new AttachTargetError(
          "wrong-session",
          `${foreignSession.length} After Effects process(es) of this install run in another login ` +
            `session (pids ${foreignSession.map((p) => p.pid).join(", ")}); this transport addresses ` +
            `${this.#sessionDescription()} only, so nothing was sent`,
        );
      }
      throw new AttachTargetError(
        "not-found",
        `no ${this.#install.executable} After Effects is running in ${this.#sessionDescription()}; ` +
          "attach never starts one — use launch() for that",
      );
    } else if (candidates.length > 1) {
      throw new AttachTargetError(
        "ambiguous",
        `${candidates.length} After Effects processes of this install are running ` +
          `(pids ${candidates.map((p) => p.pid).join(", ")}); pass target.pid to name one, nothing was sent`,
      );
    } else {
      target = candidates[0] as HostProcess;
    }
    this.#attached = target;
    this.#preexisting = candidates;
  }

  /**
   * The attach counterpart of `confirmAdopted`: the probe answered, now the
   * selected process must still be the same one — and, when no pid was
   * pinned, still the only in-scope instance. A target that exited, was
   * replaced, or gained a sibling downgrades to unknown: calls stay bound
   * to the engine that answered the probe by the session marker, but no
   * privileged operation is authorized against an unproven target.
   */
  #confirmAttach(): void {
    const attached = this.#attached;
    if (attached === null) {
      this.#ownershipAtLaunch = this.#unknownOwnership(
        "the attach target was lost before the probe answered",
      );
      return;
    }
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch (error) {
      this.#ownershipAtLaunch = this.#unknownOwnership(
        `could not re-check processes: ${errorMessage(error)}`,
      );
      return;
    }
    const same = now.filter((p) => sameProcess(this.#platform, p, attached));
    const pinned = this.#attach?.targetPid !== undefined;
    // A pinned pid is itself the disambiguator: the target must still be
    // present, other instances may coexist. Unpinned, the target must also
    // remain the only in-scope instance — a second AE started mid-attach
    // makes "which one answered" unprovable again.
    const proven = same.length === 1 && (pinned || now.length === 1);
    if (proven) {
      this.#attached = same[0] as HostProcess;
      this.#ownershipAtLaunch = {
        kind: "attached",
        evidence:
          `attached to pid ${attached.pid} (the process running since ` +
          new Date(attached.startedAt).toISOString() +
          "); it was already running and is not this session's to quit" +
          (this.#targetSession === null ? "" : ` in ${this.#sessionDescription()}`),
      };
      return;
    }
    this.#ownershipAtLaunch = this.#unknownOwnership(
      same.length === 0
        ? `the attached pid ${attached.pid} is gone; ${now.length} other instance(s) are running`
        : pinned
          ? `the attached pid ${attached.pid} can no longer be told apart (${now.length} instances)`
          : `${now.length} instances of this install are running, so the attached pid cannot be told apart`,
    );
  }

  /**
   * The adopt counterpart of `confirmLaunched`: ownership is claimed only
   * after the probe answered *and* the recorded process is still the same
   * single instance. A record that went stale between `launch()` and the
   * probe downgrades to unknown — the host is left running either way.
   */
  #confirmAdopted(): void {
    const adopt = this.#adopt;
    const owned = this.#owned;
    if (adopt === null || owned === null) {
      this.#ownershipAtLaunch = this.#unknownOwnership("adoption state was lost before the probe answered");
      return;
    }
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch (error) {
      this.#ownershipAtLaunch = this.#unknownOwnership(
        `could not re-check processes: ${errorMessage(error)}`,
      );
      return;
    }
    const same = now.filter((p) => sameProcess(this.#platform, p, owned));
    if (same.length === 1 && now.length === 1) {
      this.#owned = same[0] as HostProcess;
      this.#ownershipAtLaunch = {
        kind: "owned",
        evidence:
          `adopted pid ${owned.pid}: the process recorded` +
          (adopt.recordedAt === undefined ? "" : ` at ${adopt.recordedAt}`) +
          " is still the only instance of this install" +
          (this.#targetSession === null ? "" : ` in ${this.#sessionDescription()}`),
      };
      return;
    }
    this.#ownershipAtLaunch = this.#unknownOwnership(
      same.length === 0
        ? `the adopted pid ${owned.pid} is gone; ${now.length} other instance(s) are running`
        : `${now.length} instances of this install are running, so the adopted pid cannot be told apart`,
    );
  }

  confirmLaunched(): void {
    if (this.#confirmed) {
      return;
    }
    this.#confirmed = true;
    if (this.#attach !== null) {
      this.#confirmAttach();
      return;
    }
    if (this.#adopt !== null) {
      this.#confirmAdopted();
      return;
    }
    if ((this.#platform !== "darwin" && this.#platform !== "win32") || this.#preexisting === null) {
      this.#ownershipAtLaunch = this.#unknownOwnership(
        this.#preexisting === null
          ? "the processes running before launch could not be listed, so nothing can be tied to this session"
          : `no process ownership check on ${this.#platform}`,
      );
      return;
    }
    if (this.#preexisting.length > 0) {
      this.#ownershipAtLaunch = {
        kind: "attached",
        evidence: `already running before launch: pid ${this.#preexisting.map((p) => p.pid).join(", ")}`,
      };
      return;
    }
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch (error) {
      this.#ownershipAtLaunch = this.#unknownOwnership(
        `could not list processes: ${errorMessage(error)}`,
      );
      return;
    }
    const started = now.filter((p) => p.startedAt >= this.#launchBegan - START_SLACK_MS);
    if (this.#platform === "darwin") {
      // macOS has no `-r` to aim, and the Apple Event carries no pid. Only the
      // process this transport started itself — whose pid `launch()` recorded
      // — may be called ours. "The only instance that appeared after the
      // snapshot" is also true of one the human started a moment later (the
      // defect this replaced), so it is never evidence on its own.
      const spawnedPid = this.#spawnedPid;
      if (spawnedPid === undefined) {
        this.#ownershipAtLaunch = this.#unknownOwnership(
          "this session recorded no pid for the After Effects it started, so the instance that answered cannot be tied to it",
        );
        return;
      }
      if (now.length !== 1 || started.length !== 1) {
        this.#ownershipAtLaunch = this.#unknownOwnership(
          `after launch: ${now.length} instance(s), ${started.length} started since launch began; ` +
            `the process this session started is pid ${spawnedPid}, so no single instance can be tied to it`,
        );
        return;
      }
      const only = started[0] as HostProcess;
      if (only.pid !== spawnedPid) {
        this.#ownershipAtLaunch = this.#unknownOwnership(
          `the only instance (pid ${only.pid}) is not the process this session started (pid ${spawnedPid})`,
        );
        return;
      }
      this.#owned = only;
      this.#spawnedAt = only.startedAt;
      this.#ownershipAtLaunch = {
        kind: "owned",
        evidence:
          `pid ${only.pid} is the process this session started and is the only instance` +
          (this.#targetSession === null ? "" : ` in ${this.#sessionDescription()}`),
      };
      return;
    }
    if (this.#platform === "win32" && now.length === 1 && started.length === 1) {
      // Windows proves more than "the only one": it must be this install's
      // image, and the very process this transport spawned.
      const only = started[0] as HostProcess;
      if (only.identity === undefined) {
        this.#ownershipAtLaunch = {
          kind: "unknown",
          evidence: `the process list gave no full creation time for pid ${only.pid}`,
        };
        return;
      }
      if (!sameWindowsPath(only.executable, this.#install.executable)) {
        this.#ownershipAtLaunch = {
          kind: "unknown",
          evidence: `the only AfterFX.exe (pid ${only.pid}) is ${only.executable || "of unreadable path"}, not ${this.#install.executable}`,
        };
        return;
      }
      // Without the pid of the process this transport spawned, "the only
      // AfterFX.exe" could be anyone's, so nothing is claimed.
      if (this.#spawnedPid === undefined) {
        this.#ownershipAtLaunch = {
          kind: "unknown",
          evidence: `the launcher reported no pid, so the only AfterFX.exe (pid ${only.pid}) cannot be tied to this session`,
        };
        return;
      }
      if (this.#spawnedPid !== only.pid) {
        this.#ownershipAtLaunch = {
          kind: "unknown",
          evidence: `the only AfterFX.exe is pid ${only.pid}, not pid ${this.#spawnedPid}, which this session started`,
        };
        return;
      }
    }
    if (now.length === 1 && started.length === 1) {
      this.#owned = started[0] as HostProcess;
      this.#ownershipAtLaunch = {
        kind: "owned",
        evidence:
          `pid ${this.#owned.pid} started after launch began and is the only instance` +
          (this.#targetSession === null ? "" : ` in ${this.#sessionDescription()}`),
      };
      return;
    }
    this.#ownershipAtLaunch = {
      kind: "unknown",
      evidence: `after launch: ${now.length} instance(s), ${started.length} started since launch began`,
    };
  }

  ownership(): HostOwnership {
    const owned = this.#owned;
    if (this.#ownershipAtLaunch.kind !== "owned" || owned === null) {
      return this.#ownershipAtLaunch;
    }
    // Re-checked at the moment it matters: the process must still be the one
    // this session started (same pid *and* start time, so a reused pid does
    // not count) and the only instance of this install.
    let now: HostProcess[];
    try {
      now = this.#hostProcesses();
    } catch (error) {
      return this.#unknownOwnership(
        `could not re-check processes: ${errorMessage(error)}`,
      );
    }
    // Windows creation times are 100 ns kernel values, identical on every read
    // of the same process (checked), so the full value must match: a looser
    // match could only ever accept a reused pid. `ps` on macOS is whole seconds.
    const same = now.filter((p) => sameProcess(this.#platform, p, owned));
    if (same.length === 1 && now.length === 1) {
      return { kind: "owned", evidence: `pid ${owned.pid} is still the only instance` };
    }
    return this.#unknownOwnership(
      same.length === 0
        ? `pid ${owned.pid} this session started is gone; ${now.length} other instance(s)`
        : `${now.length} instances running`,
    );
  }

  /**
   * An ownership answer that claims nothing. On macOS it carries
   * `A8N-AE-004`: the run could not prove which After Effects it is talking
   * to, so the host is left running rather than quit.
   */
  #unknownOwnership(evidence: string): HostOwnership {
    return this.#platform === "darwin"
      ? { kind: "unknown", code: "A8N-AE-004", evidence }
      : { kind: "unknown", evidence };
  }

  #hostProcesses(): HostProcess[] {
    return this.#hostProcessesFrom(this.#processes());
  }

  /** The in-scope After Effects processes inside an already-read process list. */
  #hostProcessesFrom(all: readonly HostProcess[]): HostProcess[] {
    // Windows: any AfterFX.exe counts, whatever its path (see windowsProcesses).
    if (this.#platform === "darwin") {
      // macOS: only the After Effects of the session's own user. Another OS
      // user may have one running on the same machine; it is a different
      // instance in a different session, and neither addressed nor quit.
      return all.filter(
        (p) =>
          p.executable === this.#install.executable &&
          (p.uid === undefined || p.uid === this.#sessionUid),
      );
    }
    if (this.#platform !== "win32") {
      return all.filter((p) => p.executable === this.#install.executable);
    }
    // A `-r` launcher shows as a second AfterFX.exe for 0.3-0.7 s (measured) and
    // would make a quit right after a call look like "two instances". Only a
    // process this one spawned (known pid) and that is still its child is left
    // out; the AE this transport started is never one of them, and a stranger
    // that merely reuses a launcher's pid has another parent and still counts.
    return all.filter((p) => !(p.parentPid === this.#selfPid && this.#launcherPids.has(p.pid)));
  }

  async invoke(entryScriptPath: string, options: InvokeOptions = {}): Promise<void> {
    if (this.#platform === "win32") {
      // Not waited on: on a cold start `AfterFX.exe -r` *is* After Effects,
      // and when AE is already running it hands the script over and exits with
      // a status that says nothing about the script. The result file is the
      // authority, and the driver's deadline covers it.
      const launcherPid = await this.#startWindows(["-r", this.#windowsArgumentPath(entryScriptPath)]);
      if (launcherPid !== undefined && launcherPid !== this.#spawnedPid) {
        this.#launcherPids.add(launcherPid);
      }
      return;
    }
    if (this.#platform === "darwin") {
      const bundle = macAppBundle(this.#install.executable);
      if (bundle === null) {
        throw new Error(
          `cannot address After Effects by AppleScript: ${this.#install.executable} is not inside an .app bundle`,
        );
      }
      // One DoScriptFile at a time. A call that timed out leaves its script
      // running in AE; the next one waits for it rather than racing it.
      //
      // A `while`, not an `if`: several callers can be waiting on the same
      // promise, and both resume in the same tick when it settles. The check
      // and the send below are synchronous, so re-checking after every wait
      // is what makes "one at a time" hold with more than one waiter.
      while (this.#inFlight !== null) {
        // If the deadline passes during this wait, the script was never
        // sent. Saying "timed out" would claim the operation ran and did not
        // answer, which is not what happened: nothing ran at all.
        try {
          await untilAborted(this.#inFlight, options.signal);
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw new ScriptNotSentError(
              "the call was abandoned while it waited for the previous script to finish; " +
                "it was never sent to After Effects, so nothing ran",
            );
          }
          throw error;
        }
      }
      // DoScriptFile returns only when the script has finished. On a deadline
      // the call stops *waiting*, but osascript is left to finish: killing it
      // mid-script left AE refusing every later script ("1") and refusing to
      // quit (observed on 26.5x89), which only a forced exit cleared.
      const done = this.#runInSession("osascript", [
        ...MAC_DO_SCRIPT_FILE.flatMap((line) => ["-e", line]),
        bundle,
        entryScriptPath,
      ]);
      const tracked: Promise<void> = done.then(
        () => undefined,
        () => undefined,
      );
      this.#inFlight = tracked;
      void tracked.then(() => {
        if (this.#inFlight === tracked) {
          this.#inFlight = null;
        }
      });
      await untilAborted(done, options.signal);
      return;
    }
    throw new Error(
      `no After Effects automation transport for platform "${this.#platform}"; ` +
        "use the fake host from @ido-bata/ae-a8n/testing instead",
    );
  }

  /**
   * Waits for AE to exit after the driver's `app.quit`.
   *
   * `app.quit` returns while AE is still shutting down. A session launched in
   * that window sends its AppleEvent to the exiting process and fails with
   * -609 "connection is invalid" (observed on AE 26.5x89 with back-to-back
   * ae-test sessions), so on macOS close only returns once the process is
   * gone. It never kills AE: that would discard unsaved state and make the
   * next launch stop at the crash-recovery dialog.
   */
  async close(): Promise<void> {
    if (this.#platform !== "darwin" && this.#platform !== "win32") {
      return;
    }
    const deadline = Date.now() + this.#exitTimeoutMs;
    const owned = this.#owned;
    // The exact process, not the pid: a pid reused by another process means the
    // original is gone. A list that cannot be read throws out of here, so "could
    // not look" is never taken for "it exited".
    while (owned !== null && this.#hostProcesses().some((p) => sameProcess(this.#platform, p, owned))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `After Effects did not exit within ${this.#exitTimeoutMs} ms of app.quit; it was left running` +
            this.#quitBlockerDetail(owned),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    }
  }

  /**
   * Best-effort read-only observation of what the still-running host is
   * showing when `app.quit` did not take effect. ExtendScript `app.quit()`
   * returns while After Effects is still shutting down, and a modal dialog
   * (a save prompt, a missing-font notice, a sync nag) can hold the quit
   * open indefinitely — observed on AE 27.0.0 (issue #231). The report
   * names the windows the owned process still owns; that is an observation
   * of what remains on screen, not proof of what blocked the quit. A census
   * that cannot run contributes nothing; it never changes the outcome.
   */
  #quitBlockerDetail(owned: OwnedProcess): string {
    if (this.#platform !== "darwin") {
      return "";
    }
    try {
      const census = this.#windowCensus?.() ?? windowServerCensus(this.#quitCensusRunner());
      if (!census.available) {
        return "";
      }
      const titles = [
        ...new Set(
          census.windows
            .filter((w) => w.pid === owned.pid && w.name.trim() !== "")
            .map((w) => w.name.trim()),
        ),
      ].slice(0, 5);
      if (titles.length === 0) {
        return "";
      }
      return `; the process still owns window(s): ${titles.map((t) => JSON.stringify(t)).join(", ")}`;
    } catch {
      return "";
    }
  }

  /**
   * Runs the census where the host's windows live: inside the target login
   * session when it is known, locally otherwise — the read-only fallback for
   * a transport that could not identify a session.
   */
  #quitCensusRunner(): (program: string, args: readonly string[]) => string {
    const session = this.#targetSession ?? this.#readTargetSession();
    if (session === null) {
      return execFileCensusRunner();
    }
    return (program, args) => {
      const result = runInSession(session, program, [...args], { timeoutMs: 30_000 });
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `exit status ${result.status}`);
      }
      return result.stdout;
    };
  }

  /**
   * The path to give `-r`. After Effects drops a script path that contains
   * whitespace without any error (observed on 26.5x89: the process exits 0 and
   * nothing runs; the same file runs from File > Scripts > Run Script File), so
   * a directory with a space is replaced by its 8.3 short name, and a path that
   * cannot be made whitespace-free is refused up front instead of timing out.
   */
  #windowsArgumentPath(entry: string): string {
    if (!/\s/.test(entry)) {
      return entry;
    }
    const directory = win32.dirname(entry);
    const name = win32.basename(entry);
    let usable = this.#argumentDirs.get(directory);
    if (usable === undefined) {
      const short = /\s/.test(directory) ? this.#shortPath(directory) : directory;
      if (short === null || /\s/.test(short) || /\s/.test(name)) {
        throw new UnsupportedScriptPathError(entry);
      }
      usable = short;
      this.#argumentDirs.set(directory, usable);
    } else if (/\s/.test(name)) {
      throw new UnsupportedScriptPathError(entry);
    }
    return win32.join(usable, name);
  }

  /**
   * Starts `AfterFX.exe` and resolves once the process exists, not when it
   * exits. Rejects if it cannot be started at all (missing executable, access
   * denied). The child is detached and unreferenced so it neither keeps this
   * process alive nor dies with it, and it is never signalled: a launcher that
   * exits early (a hand-off to a running AE) is normal, and this transport has
   * no evidence about which process it would be killing.
   */
  #startWindows(args: readonly string[]): Promise<number | undefined> {
    const executable = this.#install.executable;
    return new Promise((resolve, reject) => {
      const child = this.#spawnLauncher(executable, args, {
        cwd: join(executable, ".."),
        detached: true,
        stdio: "ignore",
        // AfterFX.exe is a GUI application; hiding it would also hide any
        // dialog it raises.
        windowsHide: false,
      });
      // `on`, not `once`: an error after the spawn must still be handled.
      child.on("error", (error: Error) => {
        reject(new Error(`cannot start ${executable}: ${error.message}`, { cause: error }));
      });
      child.on("spawn", () => {
        child.unref();
        resolve(child.pid);
      });
    });
  }

  /**
   * Starts the macOS After Effects through LaunchServices (`open`) and
   * resolves with the pid of the process that appears, once it can be told
   * apart from anything else running. Resolves `undefined` when no single
   * new process of this install shows up in time: the launch is not proven,
   * and ownership stays "unknown" exactly as before.
   *
   * Why `open` and not the executable itself: a directly spawned AE is not
   * in LaunchServices until seconds into its own start-up, and the
   * readiness probe's Apple Event — addressed by bundle path — is resolved
   * by LaunchServices. Sent into that gap it makes LaunchServices start a
   * second instance (observed on AE 27.0: the spawned process never became
   * the scriptable app and exited on its own; the LaunchServices instance
   * owned the GUI children, issue #105). `open` goes through the same
   * registry the Apple Event consults, so the probe can only reach the
   * instance this launch created — verified on AE 27.0.0, where `open` plus
   * an immediate probe produced exactly one process.
   *
   * `open` reports no pid, so the started process is identified from the
   * process list: the single new process of this install that appeared
   * after launch began. None, or several, candidates never produce a pid —
   * two same-named processes is exactly the state this path exists to
   * avoid, so it is never picked between.
   */
  async #openMacHost(): Promise<number | undefined> {
    const bundle = macAppBundle(this.#install.executable);
    if (bundle === null) {
      throw new Error(
        `cannot start After Effects through LaunchServices: ${this.#install.executable} ` +
          "is not inside an .app bundle",
      );
    }
    await this.#openMacApp(bundle);
    const deadline = this.#now() + this.#macLaunchObserveMs;
    const knownPids = new Set((this.#preexisting ?? []).map((p) => p.pid));
    for (;;) {
      let now: HostProcess[] | null = null;
      try {
        now = this.#hostProcesses();
      } catch {
        now = null;
      }
      if (now !== null) {
        const fresh = now.filter(
          (p) => !knownPids.has(p.pid) && p.startedAt >= this.#launchBegan - START_SLACK_MS,
        );
        if (fresh.length === 1) {
          const only = fresh[0] as HostProcess;
          this.#spawnedAt = only.startedAt;
          return only.pid;
        }
        // None yet, or more than one: keep watching. A second same-bundle
        // process is the failure this path exists to avoid, so two
        // candidates are never picked between — the pid stays unrecorded
        // and ownership stays "unknown".
      }
      if (this.#now() >= deadline) {
        return undefined;
      }
      await new Promise((done) => setTimeout(done, this.#macLaunchPollMs));
    }
  }

  /**
   * Runs a command inside the session that owns the After Effects.
   *
   * On macOS an Apple Event is delivered to the application of the *sending*
   * session. A test that means to drive the After Effects of an isolated test
   * user and sends its event from the console session would drive a
   * different After Effects — or start one — and any GUI fallback would then
   * act on the console user's desktop.
   *
   * So the event is sent from inside the target session, and when that
   * session cannot be entered the call is refused.
   */
  #runInSession(command: string, args: readonly string[]): Promise<void> {
    const session = this.#targetSession;
    if (session === null) {
      const self = typeof process.getuid === "function" ? process.getuid() : -1;
      if (self !== this.#sessionUid) {
        throw new MacSessionError(
          `cannot address After Effects as uid ${this.#sessionUid}: that user has no login session this process ` +
            "can identify, so the destination of an Apple Event could not be proven. Nothing was sent.",
        );
      }
      // The caller's own session, and no other user's session is in play.
      return this.#run("/", command, args);
    }
    this.#assertSessionProof(session);
    return new Promise((resolve, reject) => {
      try {
        spawnInSession(session, command, args, {
          cwd: "/",
          onClose: (code, stderr) => {
            if (code === 0) {
              resolve();
              return;
            }
            reject(new ScriptInvocationError(command, code, summariseProcessOutput(stderr)));
          },
          onError: (error) => reject(error),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Re-proves the target session immediately before a command is sent.
   *
   * `#targetSession` was read once, at construction. Since then the user
   * may have logged out and back in (a new asid), the session may have
   * ended, or a fast user switch may have made it the console session —
   * the screen the human is looking at. `spawnInSession` re-checks only
   * *this* process's session and, on the root path, delivers by uid
   * alone, so without this check a stale proof would keep sending Apple
   * Events to whatever session the uid now owns. Any difference from the
   * proven identity — including an unreadable console owner, which cannot
   * show the target is not the console — refuses before anything is sent.
   */
  #assertSessionProof(proven: MacSession): void {
    const current = this.#readTargetSession();
    const consoleUid = this.#consoleUid();
    // The console check guards the cross-user path only: when this process
    // runs as the target's own user the Apple Event stays inside that
    // user's session whatever the console owner is — the normal local case,
    // where the target *is* the console session.
    const selfUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const crossUser = proven.uid !== selfUid;
    const unchanged =
      current !== null &&
      current.uid === proven.uid &&
      current.asid !== null &&
      current.asid === proven.asid &&
      current.kind === proven.kind &&
      (!crossUser || (consoleUid >= 0 && consoleUid !== proven.uid));
    if (unchanged) {
      return;
    }
    const now =
      current === null
        ? "no login session"
        : `asid ${current.asid ?? "unknown"}, kind ${current.kind}` +
          (crossUser && consoleUid === proven.uid ? ", and it is the console session" : "");
    throw new MacSessionError(
      `the login session this transport proved (uid ${proven.uid}, asid ${proven.asid ?? "unknown"}, ` +
        `kind ${proven.kind}) no longer holds — it now reads as ${now}` +
        `${crossUser && consoleUid < 0 ? "; the console owner could not be read" : ""}. ` +
        "Nothing was sent; re-prove the target session and retry.",
    );
  }

  /** Runs a process and resolves when it exits. A non-zero exit is an error. */
  #run(cwd: string, command: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      // Only the head is kept: a runaway process must not grow this without
      // bound, and the cause of a launcher failure is in the first lines.
      let stderr = "";
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length <= MAX_DIAGNOSTIC_CHARS) {
          stderr += chunk;
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
          if (code === 0) {
          resolve();
          return;
        }
        reject(new ScriptInvocationError(command, code, summariseProcessOutput(stderr)));
      });
    });
  }
}
