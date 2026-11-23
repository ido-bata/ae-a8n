/**
 * Host process enumeration for the script-invocation transport.
 *
 * Extracted from `script-invocation.ts` (#184): listing, parsing and
 * identity of After Effects processes is a self-contained concern — the
 * transport decides what to *do* with the list; this module only answers
 * "which AfterFX/After Effects processes exist, and are they the same
 * process as before". `script-invocation.ts` re-exports the public names
 * so existing import sites keep working.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export type HostProcess = {
  readonly pid: number;
  /** Start time, ms since the epoch (`ps` reports it to the second). */
  readonly startedAt: number;
  readonly executable: string;
  /**
   * Windows: the creation time exactly as the OS gave it (ISO, 100 ns). `startedAt`
   * has lost everything below a millisecond, so identity is judged on this.
   */
  readonly identity?: string;
  /** Windows: the parent process id, to tell the `-r` launchers this process spawned from other instances. */
  readonly parentPid?: number;
  /** macOS: the OS user that owns the process. */
  readonly uid?: number;
  /** macOS: the login session the process lives in, when the window server knows it. */
  readonly sessionId?: number | null;
};

/**
 * Running processes from `ps`. `lstart` is a fixed 24-character date, so the
 * executable path, which may contain spaces, is everything after it.
 *
 * The owning user is read as well: on macOS a second OS user may have an
 * After Effects of their own, and a process list that cannot say whose it is
 * cannot say which one a script is talking to.
 *
 * `LC_ALL=C` is not a detail: `ps` formats `lstart` in the login user's
 * locale, and a Japanese session prints `火 11/ 3 11:29:17 2026`. Parsed with
 * the English pattern that is *zero* processes, which reads as "After Effects
 * is not running" — measured on 2026-11-03, where that made `ownership()`
 * report `unknown` for a host the session had just launched, and `close()`
 * therefore refused to quit it. The locale is forced instead of the pattern
 * being widened, so the date keeps one spelling.
 */
export function psProcesses(): HostProcess[] {
  const text = execFileSync("ps", ["-axo", "pid=,uid=,lstart=,comm="], {
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  return parsePsProcesses(text);
}

/** The process listing `psProcesses` reads, parsed. Exported for tests. */
export function parsePsProcesses(text: string): HostProcess[] {
  const out: HostProcess[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S{3} \S{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    if (match === null) continue;
    out.push({
      pid: Number(match[1]),
      uid: Number(match[2]),
      startedAt: Date.parse(match[3] as string),
      executable: (match[4] as string).trim(),
    });
  }
  return out;
}

/**
 * Every `AfterFX.exe` on Windows, with the process creation time and the path
 * of its image ("" when Windows will not say, as for an elevated process).
 *
 * The census itself is deliberately unfiltered: it answers "which
 * AfterFX.exe images exist", and *which install* an image belongs to is the
 * consumer's question — `windowsSameInstall` scopes it. `AfterFX.exe -r`
 * delivery is per install: a running instance of another version is a
 * different product the script is never handed to (#323).
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
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); path = [string]$_.ExecutablePath }",
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
    const e = entry as { pid?: unknown; ppid?: unknown; started?: unknown; path?: unknown } | null;
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
    const identity = typeof e.started === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(e.started) ? e.started : null;
    const startedAt = identity === null ? Number.NaN : Date.parse(identity);
    if (identity === null || Number.isNaN(startedAt)) {
      throw new Error(`process list has no valid creation time for pid ${e.pid}: ${JSON.stringify(e.started)}`);
    }
    if (typeof e.path !== "string") {
      throw new Error(`process list has no path field for pid ${e.pid}`);
    }
    if (typeof e.ppid !== "number" || !Number.isInteger(e.ppid) || e.ppid < 0) {
      throw new Error(`process list has no valid parent pid for pid ${e.pid}: ${JSON.stringify(e.ppid)}`);
    }
    return { pid: e.pid, startedAt, executable: e.path.trim(), identity, parentPid: e.ppid };
  });
}

/**
 * Whether `candidate` is the very process `known` was. Windows: same pid and the
 * identical full creation time (100 ns); a list entry without one never matches.
 * macOS: same pid and a start time within `ps`' whole second.
 */
export function sameProcess(platform: NodeJS.Platform, candidate: HostProcess, known: HostProcess): boolean {
  if (candidate.pid !== known.pid) {
    return false;
  }
  if (platform === "win32") {
    return candidate.identity !== undefined && candidate.identity === known.identity;
  }
  return Math.abs(candidate.startedAt - known.startedAt) <= 1_000;
}

/** Whether two Windows image paths name the same file, as far as text can tell. */
export function sameWindowsPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return a.length > 0 && norm(a) === norm(b);
}

/**
 * Comparison key for a Windows path: `\` separators, empty segments
 * dropped, lowercase — the tolerance `sameWindowsPath` gives a pair,
 * applied where a prefix test is needed.
 */
function windowsPathKey(path: string): string {
  return path
    .replace(/\//g, "\\")
    .split("\\")
    .filter((segment) => segment.length > 0)
    .join("\\")
    .toLowerCase();
}

/**
 * The install directory prefix (`<dir>\`, normalized) that a Windows
 * install's `AfterFX.exe` lives under, or null when `installExecutable`
 * does not have the `<dir>\Support Files\AfterFX.exe` shape `resolveInstall`
 * always produces. Null means "cannot place the install", and callers fail
 * closed on it.
 */
function windowsInstallDirPrefix(installExecutable: string): string | null {
  const segments = installExecutable
    .replace(/\//g, "\\")
    .split("\\")
    .filter((segment) => segment.length > 0);
  if (
    segments.length < 3 ||
    segments[segments.length - 1]?.toLowerCase() !== "afterfx.exe" ||
    segments[segments.length - 2]?.toLowerCase() !== "support files"
  ) {
    return null;
  }
  return `${segments.slice(0, -2).join("\\").toLowerCase()}\\`;
}

/**
 * Whether a path segment is a DOS 8.3 short name (`ADOBEA~1`,
 * `PROGRA~1.EXE`). Such a segment can spell the same directory as its
 * long-name twin, so a prefix mismatch involving one is undecidable —
 * never proof of a different install (#332).
 */
function hasDos8x3Segment(path: string): boolean {
  return path
    .replace(/\//g, "\\")
    .split("\\")
    .some((segment) => /^[^\\.~]{1,8}~\d+(\..*)?$/i.test(segment));
}

/**
 * Whether a Windows `AfterFX.exe` image path belongs to the install that
 * `installExecutable` (`<dir>\Support Files\AfterFX.exe`) names — the
 * install-dir scope the script transport and session rebuild apply (#323).
 *
 *  - `true`: the image is under that install directory.
 *  - `false`: the image is provably another install's AfterFX.exe — a
 *    different version's After Effects, which `-r` delivery is never
 *    handed to and which is never this session's host.
 *  - `null`: undecidable — the install path has an unrecognized shape, the
 *    image path was not revealed (`""`), or either spelling carries a DOS
 *    8.3 short-name segment that a text comparison cannot resolve.
 *    Callers fail closed on `null`: it may be this install's, so it
 *    still counts.
 */
export function windowsSameInstall(imagePath: string, installExecutable: string): boolean | null {
  const prefix = windowsInstallDirPrefix(installExecutable);
  if (prefix === null) {
    return null;
  }
  const image = imagePath.trim();
  if (image === "") {
    return null;
  }
  if (windowsPathKey(image).startsWith(prefix)) {
    return true;
  }
  // A prefix miss is only proof of a different install when both spellings
  // are comparable: an 8.3 segment (`C:\ADOBEA~1\...`) can name the very
  // directory the long-name prefix does, and returning `false` there would
  // exclude a live same-install instance from the census (#332).
  if (hasDos8x3Segment(image) || hasDos8x3Segment(installExecutable)) {
    return null;
  }
  return false;
}

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
