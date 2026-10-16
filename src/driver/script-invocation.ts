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
 */

import { execFileSync, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import { macAppBundle, resolveInstall, type AfterEffectsInstall } from "./install-path.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "./transport.js";

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
  /** Running processes. Mainly a test seam. */
  readonly processes?: () => readonly HostProcess[];
  /** The clock ownership is judged against. Mainly a test seam. */
  readonly now?: () => number;
  /** Starts the Windows launcher. Mainly a test seam. */
  readonly spawnLauncher?: SpawnLauncher;
  /**
   * The 8.3 short form of a Windows directory, or null if it has none. Mainly a
   * test seam; defaults to asking Windows.
   */
  readonly shortPath?: (directory: string) => string | null;
  /**
   * Whether After Effects has shown its main window (Windows). Mainly a test
   * seam; defaults to asking Windows.
   */
  readonly mainWindowVisible?: () => boolean;
  /** How often that is asked while waiting. Mainly a test seam. */
  readonly readyPollMs?: number;
};

/**
 * Whether a top-level window of class `AE_CApplication*` is visible. AE creates
 * it hidden at start-up and shows it once its plug-ins, the scripting engine
 * among them, are loaded; a crash-recovery or other start-up dialog keeps it
 * hidden. The class name does not depend on the UI language.
 */
function windowsMainWindowVisible(): boolean {
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System; using System.Text; using System.Runtime.InteropServices;",
    "public class A8nW {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    "  public static bool Any() {",
    "    bool found = false;",
    "    EnumWindows(delegate(IntPtr h, IntPtr l) {",
    "      var c = new StringBuilder(256); GetClassName(h, c, 256);",
    '      if (c.ToString().StartsWith("AE_CApplication") && IsWindowVisible(h)) { found = true; }',
    "      return true; }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    "if ([A8nW]::Any()) { 'yes' } else { 'no' }",
  ].join("\n");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
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

export type HostProcess = {
  readonly pid: number;
  /** Start time, ms since the epoch (`ps` reports it to the second). */
  readonly startedAt: number;
  readonly executable: string;
};

/** AE saves preferences and tears down plugins on quit; that takes seconds. */
export const EXIT_TIMEOUT_MS = 60_000;
const EXIT_POLL_MS = 250;

/**
 * Running processes from `ps`. `lstart` is a fixed 24-character date, so the
 * executable path, which may contain spaces, is everything after it.
 */
function psProcesses(): HostProcess[] {
  const out: HostProcess[] = [];
  const text = execFileSync("ps", ["-axo", "pid=,lstart=,comm="], { encoding: "utf-8" });
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S{3} \S{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    if (match === null) continue;
    out.push({
      pid: Number(match[1]),
      startedAt: Date.parse(match[2] as string),
      executable: (match[3] as string).trim(),
    });
  }
  return out;
}

/**
 * Every `AfterFX.exe` on Windows, with the process creation time and the path
 * of its image ("" when Windows will not say, as for an elevated process).
 * Not filtered by path: any AfterFX.exe might be what a `-r` is handed to.
 *
 * Fail-closed. PowerShell returns one JSON document, `{"v":1,"processes":[...]}`,
 * and this validates every entry. An empty list is a real answer ("none running");
 * a command that failed, output that is not that document, a missing or invalid
 * pid or creation time, or a duplicate pid throws, so the caller claims nothing
 * instead of reasoning from the part of a list it could read.
 */
export function windowsProcesses(): HostProcess[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$list = @(Get-CimInstance Win32_Process -Filter \"Name='AfterFX.exe'\" | ForEach-Object {",
    "  if ($null -eq $_.CreationDate) { throw 'process without a creation time' }",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); path = [string]$_.ExecutablePath }",
    "})",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "ConvertTo-Json -InputObject ([pscustomobject]@{ v = 1; processes = $list }) -Compress -Depth 4",
  ].join("\n");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseWindowsProcessList(out);
}

/** Validates `windowsProcesses`' document; exported for tests. Throws on anything doubtful. */
export function parseWindowsProcessList(text: string): HostProcess[] {
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`process list is not JSON: ${text.slice(0, 80)}`);
  }
  const entries = (document as { v?: unknown; processes?: unknown } | null)?.processes;
  if ((document as { v?: unknown } | null)?.v !== 1 || !Array.isArray(entries)) {
    throw new Error(`process list is not the expected document: ${text.slice(0, 80)}`);
  }
  const seen = new Set<number>();
  return entries.map((entry: unknown) => {
    const e = entry as { pid?: unknown; started?: unknown; path?: unknown } | null;
    if (e === null || typeof e !== "object") {
      throw new Error("process list entry is not an object");
    }
    if (typeof e.pid !== "number" || !Number.isInteger(e.pid) || e.pid <= 0) {
      throw new Error(`process list has an invalid pid: ${JSON.stringify(e.pid)}`);
    }
    if (seen.has(e.pid)) {
      throw new Error(`process list repeats pid ${e.pid}`);
    }
    seen.add(e.pid);
    const startedAt = typeof e.started === "string" ? Date.parse(e.started) : Number.NaN;
    if (Number.isNaN(startedAt)) {
      throw new Error(`process list has no valid creation time for pid ${e.pid}: ${JSON.stringify(e.started)}`);
    }
    if (typeof e.path !== "string") {
      throw new Error(`process list has no path field for pid ${e.pid}`);
    }
    return { pid: e.pid, startedAt, executable: e.path.trim() };
  });
}

/** Whether two Windows image paths name the same file, as far as text can tell. */
function sameWindowsPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return a.length > 0 && norm(a) === norm(b);
}

/** `ps` reports start times to the second, and clocks round. */
const START_SLACK_MS = 2_000;

/** A cold After Effects start can take a minute on a spinning disk. */
export const READINESS_TIMEOUT_MS = 180_000;

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

/** Keeps a failure report bounded however much a process writes. */
export const MAX_DIAGNOSTIC_CHARS = 4_000;

/**
 * Trims process output into something safe to put in an error and a trace:
 * bounded in size, and with the home directory replaced so a shared trace
 * does not carry the user's account name.
 */
export function summariseProcessOutput(output: string, home: string = homedir()): string {
  let text = output.trim();
  if (home.length > 1) {
    text = text.split(home).join("~");
  }
  if (text.length > MAX_DIAGNOSTIC_CHARS) {
    const omitted = text.length - MAX_DIAGNOSTIC_CHARS;
    text = `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}… [${omitted} more characters]`;
  }
  return text;
}

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
  readonly #shortPath: (directory: string) => string | null;
  readonly #mainWindowVisible: () => boolean;
  readonly #readyPollMs: number;
  /** Directory → the form of it `-r` can be given. */
  readonly #argumentDirs = new Map<string, string>();
  /** Host processes already running when launch() began. */
  #preexisting: readonly HostProcess[] | null = null;
  #launchBegan = 0;
  /** The process this session started, once the probe has answered. */
  #owned: HostProcess | null = null;
  #ownershipAtLaunch: HostOwnership = { kind: "unknown", evidence: "not launched" };
  #launched = false;
  /** The pid of the `AfterFX.exe` this transport itself started, if the launcher said. */
  #spawnedPid: number | undefined;
  #confirmed = false;
  /** The DoScriptFile still waiting on AE, if a call gave up on it. */
  #inFlight: Promise<void> | null = null;

  constructor(options: ScriptInvocationOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.#platform = platform;
    this.#exitTimeoutMs = options.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
    this.#processes = options.processes ?? (platform === "win32" ? windowsProcesses : psProcesses);
    this.#now = options.now ?? Date.now;
    this.#spawnLauncher = options.spawnLauncher ?? spawn;
    this.#shortPath = options.shortPath ?? windowsShortPath;
    this.#mainWindowVisible = options.mainWindowVisible ?? windowsMainWindowVisible;
    this.#readyPollMs = options.readyPollMs ?? 500;
    this.#install =
      options.install ??
      resolveInstall(platform, {
        ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
        ...(options.installRoot === undefined ? {} : { root: options.installRoot }),
      });
  }

  get install(): AfterEffectsInstall {
    return this.#install;
  }

  available(): Promise<boolean> {
    return Promise.resolve(existsSync(this.#install.executable));
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
    this.#launched = true;
    this.#launchBegan = this.#now();
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
      // Whatever is running now was not started by this session.
      this.#preexisting = this.#hostProcesses();
      // On macOS `DoScriptFile` launches AE on demand, so there is nothing to do.
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
      if (this.#mainWindowVisible()) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((done) => setTimeout(done, this.#readyPollMs));
    }
  }

  confirmLaunched(): void {
    if (this.#confirmed) {
      return;
    }
    this.#confirmed = true;
    if ((this.#platform !== "darwin" && this.#platform !== "win32") || this.#preexisting === null) {
      this.#ownershipAtLaunch = {
        kind: "unknown",
        evidence: `no process ownership check on ${this.#platform}`,
      };
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
      this.#ownershipAtLaunch = {
        kind: "unknown",
        evidence: `could not list processes: ${error instanceof Error ? error.message : String(error)}`,
      };
      return;
    }
    const started = now.filter((p) => p.startedAt >= this.#launchBegan - START_SLACK_MS);
    if (this.#platform === "win32" && now.length === 1 && started.length === 1) {
      // Windows proves more than "the only one": it must be this install's
      // image, and the very process this transport spawned.
      const only = started[0] as HostProcess;
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
        evidence: `pid ${this.#owned.pid} started after launch began and is the only instance`,
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
      return {
        kind: "unknown",
        evidence: `could not re-check processes: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Windows creation times are 100 ns kernel values, identical on every read
    // of the same process (checked), so they must match exactly: a looser
    // match could only ever accept a reused pid. `ps` on macOS is whole seconds.
    const tolerance = this.#platform === "win32" ? 0 : 1_000;
    const same = now.filter((p) => p.pid === owned.pid && Math.abs(p.startedAt - owned.startedAt) <= tolerance);
    if (same.length === 1 && now.length === 1) {
      return { kind: "owned", evidence: `pid ${owned.pid} is still the only instance` };
    }
    return {
      kind: "unknown",
      evidence:
        same.length === 0
          ? `pid ${owned.pid} this session started is gone; ${now.length} other instance(s)`
          : `${now.length} instances running`,
    };
  }

  #hostProcesses(): HostProcess[] {
    const all = this.#processes();
    // Windows: any AfterFX.exe counts, whatever its path (see windowsProcesses).
    return this.#platform === "win32" ? [...all] : all.filter((p) => p.executable === this.#install.executable);
  }

  async invoke(entryScriptPath: string, options: InvokeOptions = {}): Promise<void> {
    if (this.#platform === "win32") {
      // Not waited on: on a cold start `AfterFX.exe -r` *is* After Effects,
      // and when AE is already running it hands the script over and exits with
      // a status that says nothing about the script. The result file is the
      // authority, and the driver's deadline covers it.
      await this.#startWindows(["-r", this.#windowsArgumentPath(entryScriptPath)]);
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
      if (this.#inFlight !== null) {
        await untilAborted(this.#inFlight, options.signal);
      }
      // DoScriptFile returns only when the script has finished. On a deadline
      // the call stops *waiting*, but osascript is left to finish: killing it
      // mid-script left AE refusing every later script ("1") and refusing to
      // quit (observed on 26.5x89), which only a forced exit cleared.
      const done = this.#run("/", "osascript", [
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
    while (owned !== null && this.#hostProcesses().some((p) => p.pid === owned.pid)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `After Effects did not exit within ${this.#exitTimeoutMs} ms of app.quit; it was left running`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    }
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
