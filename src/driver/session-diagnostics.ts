/**
 * Host-side evidence collection for an abnormal session end.
 *
 * The trace records what *we* sent; this collects what the *host* left
 * behind: crash reports the OS wrote, Adobe-side logs touched while the
 * session ran, and the session trace itself. Everything lands under the
 * session's artifact directory — read-only with respect to After Effects
 * and to the user's files (reports are copied, never moved), and nothing
 * is uploaded anywhere.
 *
 * Honesty rules, same as ownership: a directory that cannot be read is a
 * note in the report, not an empty list that looks like "no crashes". A
 * platform with no collector reports `notes`, not silence.
 *
 * Collection contract:
 *
 * - Scope: only files that identify as After Effects — the crash-report
 *   name pattern, and host logs whose path relative to the scanned
 *   directory carries an AE token. A log written by Photoshop during the
 *   same window is not collected.
 * - Attribution: every entry is `"session"` only when its content proves
 *   this session's host pid; everything else is `"app"` — After Effects
 *   and the session window, but not provably *this* session's process.
 *   An empty `crashReports` list is not evidence of a clean exit: a kill
 *   or a quit leaves none either.
 * - Safety: symbolic links are never followed or copied, reads go
 *   through `O_NOFOLLOW` file descriptors so a swapped path cannot redirect
 *   the copy, and total collected bytes are bounded.
 * - Sensitivity: the bundle is NOT sanitised. Logs can contain user names,
 *   absolute paths, project names and serial numbers. It is written only
 *   under the session artifact directory and never leaves the machine —
 *   review before sharing it anywhere.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import type { HostOwnership, HostState } from "./transport.js";

/**
 * How firmly a collected file is tied to this session.
 *
 * - `"session"`: the file's own content names this session's host pid.
 * - `"app"`: the file identifies After Effects and was touched inside the
 *   session window, but nothing proves it belongs to *this* session's
 *   process — another AE instance, or another run, could have written it.
 */
export type EvidenceAttribution = "session" | "app";

/** One file found on disk and copied (or tailed) into the bundle. */
export type DiagnosticsFile = {
  /** Path of the copy inside the bundle, when one was made. */
  readonly bundlePath: string | null;
  /** Where it was found. */
  readonly sourcePath: string;
  readonly bytes: number;
  /** True when only the tail of the file was collected. */
  readonly truncated: boolean;
  readonly attribution: EvidenceAttribution;
};

export type CrashReportEntry = DiagnosticsFile & {
  readonly name: string;
  readonly modifiedAt: string;
};

export type SessionDiagnostics = {
  readonly collectedAt: string;
  readonly sessionRoot: string;
  readonly artifactsDir: string;
  /** Directory the collected files were written to. */
  readonly bundleDir: string;
  readonly host: {
    /**
     * What the transport could prove *at collection time* — not necessarily
     * what it looked like when the operation timed out. A process can be
     * gone now and was alive then; the two facts are kept separate on
     * purpose.
     */
    readonly state: HostState;
    readonly ownership: HostOwnership;
    /** The owned pid, when the transport can name one. Diagnostics only. */
    readonly pid: number | null;
    readonly transport: string;
  };
  readonly crashReports: readonly CrashReportEntry[];
  readonly logs: readonly DiagnosticsFile[];
  readonly trace: {
    readonly sourcePath: string;
    readonly bundlePath: string | null;
    /** Lines in the trace file — the operation count a human can check. */
    readonly events: number;
    /** True when only the tail of the trace was copied into the bundle. */
    readonly truncated: boolean;
  } | null;
  /** What was searched and could not be read, or is not collected at all. */
  readonly notes: readonly string[];
};

/** Where a platform keeps host-crash and host-log evidence. */
export type DiagnosticSources = {
  /** Directories scanned for crash reports named like the AE binaries. */
  readonly crashReportDirs: readonly string[];
  readonly crashReportPattern: RegExp;
  /** Directories searched recursively for files touched during the session. */
  readonly logDirs: readonly string[];
  /**
   * Host-log files are collected only when their path *relative to the
   * scanned directory* (prefixed with that directory's own name) matches —
   * this is what keeps other Adobe applications' logs out of the bundle.
   * Matching the absolute path would let an AE-looking home directory name
   * pull in every Adobe log on the machine.
   */
  readonly logFilePattern: RegExp;
  /** Per-file cap on collected log bytes (the tail is kept). */
  readonly maxLogBytes: number;
  /** Cap on collected log files, newest first. */
  readonly maxLogFiles: number;
  /** Per-file cap on collected crash-report bytes (the tail is kept). */
  readonly maxCrashReportBytes: number;
  /** Cap on collected crash-report files, newest first. */
  readonly maxCrashReportFiles: number;
  /** Cap on the trace copy. */
  readonly maxTraceBytes: number;
  /** Cap on the total bytes copied into the bundle. */
  readonly maxBundleBytes: number;
};

/** Tokens that identify an After Effects path or report name. */
const AE_PATH_PATTERN = /after effects|afterfx|aerender/i;

/** macOS: DiagnosticReports plus the Adobe log/crash-database caches. */
export function darwinDiagnosticSources(home: string = homedir()): DiagnosticSources {
  return {
    crashReportDirs: [join(home, "Library", "Logs", "DiagnosticReports")],
    crashReportPattern: AE_PATH_PATTERN,
    logDirs: [
      join(home, "Library", "Logs", "Adobe"),
      // Sentry breadcrumbs live here and carry the signal sender — the one
      // piece of evidence that distinguishes "AE crashed" from "AE was
      // killed". Small files; the per-file cap bounds them like any log.
      // The directory's own name satisfies logFilePattern, so every file
      // under it is in scope; Logs/Adobe is not, so only AE paths there
      // are collected.
      join(home, "Library", "Caches", "Adobe", "After Effects"),
    ],
    logFilePattern: AE_PATH_PATTERN,
    maxLogBytes: 256 * 1024,
    maxLogFiles: 20,
    maxCrashReportBytes: 8 * 1024 * 1024,
    maxCrashReportFiles: 20,
    maxTraceBytes: 4 * 1024 * 1024,
    maxBundleBytes: 64 * 1024 * 1024,
  };
}

/** Platforms without a collector: the report says so instead of pretending. */
export function unsupportedDiagnosticSources(): DiagnosticSources {
  return {
    crashReportDirs: [],
    crashReportPattern: /(?!)/,
    logDirs: [],
    logFilePattern: /(?!)/,
    maxLogBytes: 0,
    maxLogFiles: 0,
    maxCrashReportBytes: 0,
    maxCrashReportFiles: 0,
    maxTraceBytes: 0,
    maxBundleBytes: 0,
  };
}

export function diagnosticSourcesFor(
  platform: NodeJS.Platform,
  home: string = homedir(),
): DiagnosticSources {
  return platform === "darwin" ? darwinDiagnosticSources(home) : unsupportedDiagnosticSources();
}

const MAX_WALK_DEPTH = 6;
/** Trace tail kept alongside the full copy, in lines. */
const TRACE_TAIL_LINES = 200;
/** How much of a file is scanned when attributing it to the host pid. */
const PID_SCAN_BYTES = 1024 * 1024;
/** How much of a trace file is read to produce the line tail. */
const TRACE_TAIL_SCAN_BYTES = 512 * 1024;
/** Cap on the written trace tail, and on any single line inside it. */
const TRACE_TAIL_MAX_BYTES = 256 * 1024;
const TRACE_TAIL_LINE_MAX = 4 * 1024;

/** O_NOFOLLOW where the platform has it; a plain read where it does not. */
const OPEN_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** O_NONBLOCK keeps a path swapped for a FIFO from blocking the open. */
const OPEN_NONBLOCK = constants.O_NONBLOCK ?? 0;

function safeName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * A bundle path that cannot collide: two collected files with the same
 * basename get `-2`, `-3`, … instead of one silently overwriting the
 * other's copy.
 */
function uniqueTarget(dir: string, name: string, used: Set<string>): string {
  const base = safeName(name);
  let candidate = base;
  for (let i = 2; used.has(candidate); i += 1) {
    candidate = `${base}-${i}`;
  }
  used.add(candidate);
  return join(dir, candidate);
}

/**
 * Opens `path` without following a final symbolic link, so a file swapped
 * for a link between listing and reading cannot redirect the copy outside
 * the intended tree. Throws on platforms/kernels that refuse (ELOOP).
 */
function openNoFollow(path: string): number {
  return openSync(path, constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK);
}

/**
 * Opens `path` and binds the read to the held descriptor: the fd must be a
 * regular file (a swap to a FIFO or device between listing and open is
 * refused, not blocked on or read), and callers take sizes from `fstat`
 * on this fd rather than from an earlier `lstat`.
 */
function openRegularNoFollow(path: string): number {
  const fd = openNoFollow(path);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`${path} is not a regular file`);
  }
  return fd;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** lstat that reports "missing" as null instead of throwing. */
function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `dir` is reached through a symbolic link in one of its
 * ancestors — the leaf check cannot see those. The resolved tree is still
 * searched (the filters apply the same), but the report says so.
 */
function reachedThroughLink(dir: string): boolean {
  try {
    return realpathSync(dir) !== resolve(dir);
  } catch {
    return false;
  }
}

/** Reads until the buffer is full or EOF — readSync is allowed to return short. */
function readFully(fd: number, buffer: Buffer, position: number): number {
  let got = 0;
  while (got < buffer.length) {
    const n = readSync(fd, buffer, got, buffer.length - got, position + got);
    if (n <= 0) {
      break;
    }
    got += n;
  }
  return got;
}

/** Reads up to `maxBytes` from the start of `source`. */
function readHead(source: string, maxBytes: number): string {
  const fd = openRegularNoFollow(source);
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const got = readFully(fd, buffer, 0);
    return buffer.subarray(0, got).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Reads up to `maxBytes` from the end of `source`. */
function readTail(source: string, maxBytes: number): string {
  const fd = openRegularNoFollow(source);
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const got = readFully(fd, buffer, size - buffer.length);
    return buffer.subarray(0, got).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Counts records without loading the whole file; a final partial line counts too. */
function countRecords(path: string): number {
  const fd = openRegularNoFollow(path);
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    let position = 0;
    let lastByte = -1;
    for (;;) {
      const got = readSync(fd, buffer, 0, buffer.length, position);
      if (got <= 0) {
        break;
      }
      for (let i = 0; i < got; i += 1) {
        if (buffer[i] === 0x0a) {
          count += 1;
        }
      }
      lastByte = buffer[got - 1] ?? -1;
      position += got;
    }
    if (size > 0 && lastByte !== 0x0a) {
      count += 1;
    }
    return count;
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies at most `maxBytes` from the *end* of `source` to `target`, through
 * a no-follow descriptor. `maxBytes` of 0 writes an empty file.
 */
function copyTail(source: string, target: string, maxBytes: number): { bytes: number; truncated: boolean } {
  const fd = openRegularNoFollow(source);
  try {
    const size = fstatSync(fd).size;
    const take = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(take);
    const got = take === 0 ? 0 : readFully(fd, buffer, size - take);
    writeFileSync(target, buffer.subarray(0, got));
    return { bytes: got, truncated: size > got };
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the file's head or tail names `pid` in a `"pid": N` JSON field —
 * the only content-level proof that a report belongs to this session's
 * host process. Crash reports keep `pid` in the body JSON, not the header.
 */
function fileNamesPid(path: string, pid: number): boolean {
  const pattern = new RegExp(`"pid"\\s*:\\s*${pid}(?![0-9.])`);
  try {
    return pattern.test(readHead(path, PID_SCAN_BYTES)) || pattern.test(readTail(path, PID_SCAN_BYTES));
  } catch {
    return false;
  }
}

/**
 * Depth-first listing that never follows symbolic links: `lstat` decides,
 * so a link inside a log directory cannot walk the collector outside the
 * tree the user pointed it at. Links are counted so the report can say
 * they were skipped rather than silently absent.
 */
function* walk(
  dir: string,
  depth: number,
  skippedLinks: { count: number },
  unreadableDirs: { count: number },
): Generator<string> {
  if (depth < 0) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // An unreadable directory is unknown contents, not empty contents —
    // the caller turns the count into a note.
    unreadableDirs.count += 1;
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = lstatOrNull(path);
    if (stat === null) {
      continue;
    }
    if (stat.isSymbolicLink()) {
      skippedLinks.count += 1;
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(path, depth - 1, skippedLinks, unreadableDirs);
    } else if (stat.isFile()) {
      yield path;
    }
  }
}

/**
 * Overrides for `diagnostics()`: where to look and which platform's
 * collector to use. Tests and downstream tools pass a fake `homeDir` or
 * `sources` so collection never touches the real user directories.
 */
export type DiagnosticsOptions = {
  readonly sources?: DiagnosticSources;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
};

export type CollectOptions = {
  readonly sessionRoot: string;
  readonly artifactsDir: string;
  /** Session trace file, when the driver writes one. */
  readonly tracePath?: string;
  readonly host: {
    readonly state: HostState;
    readonly ownership: HostOwnership;
    readonly pid: number | null;
    readonly transport: string;
  };
  /** Epoch ms: only files modified at or after this count as session evidence. */
  readonly since: number;
  readonly sources?: DiagnosticSources;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly now?: () => Date;
};

/**
 * Gathers host-side evidence into `<artifactsDir>/diagnostics/` and returns
 * the report. The bundle directory is rebuilt on each call: it is this
 * session's own artifact area, and a stale bundle would lie about what was
 * found *this* time.
 */
export function collectSessionDiagnostics(options: CollectOptions): SessionDiagnostics {
  const platform = options.platform ?? process.platform;
  const sources = options.sources ?? diagnosticSourcesFor(platform, options.homeDir ?? homedir());
  const now = options.now ?? (() => new Date());
  const bundleDir = join(options.artifactsDir, "diagnostics");
  const notes: string[] = [];

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(join(bundleDir, "crash-reports"), { recursive: true });
  mkdirSync(join(bundleDir, "logs"), { recursive: true });

  // The contract every report carries, so a shared bundle cannot be
  // mistaken for sanitised output.
  notes.push(
    "the diagnostics bundle is unsanitised: collected files can contain user names, absolute " +
      "paths, project names and serial numbers. It is written only under this session's artifact " +
      "directory and is never uploaded — review it before sharing.",
  );

  if (sources.crashReportDirs.length === 0 && sources.logDirs.length === 0) {
    notes.push(
      `no diagnostics collector for ${platform}: crash reports and host logs are not gathered on this platform`,
    );
  }

  // One budget for everything copied into the bundle. `take` is what is
  // left; each collection step gets min(per-file cap, take).
  let take = sources.maxBundleBytes;
  const budgetNote = "the bundle byte budget was exhausted; remaining files were not collected";
  let budgetSpent = false;
  const spend = (bytes: number): void => {
    take -= bytes;
    if (take <= 0 && !budgetSpent) {
      budgetSpent = true;
      notes.push(budgetNote);
    }
  };

  const crashReportsDir = join(bundleDir, "crash-reports");
  const crashNames = new Set<string>();
  const crashReports: CrashReportEntry[] = [];
  // Hard links can reach files outside the scanned tree that O_NOFOLLOW
  // cannot detect; they are skipped and counted rather than copied.
  let skippedHardLinks = 0;
  let crashFiles = 0;
  let crashFilesCapped = 0;
  for (const dir of sources.crashReportDirs) {
    const dirStat = lstatOrNull(dir);
    if (dirStat === null) {
      notes.push(`no crash-report directory at ${dir}`);
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      notes.push(`crash-report directory ${dir} is a symbolic link and was not searched`);
      continue;
    }
    if (!dirStat.isDirectory()) {
      notes.push(`crash-report path ${dir} is not a directory`);
      continue;
    }
    if (reachedThroughLink(dir)) {
      notes.push(`crash-report directory ${dir} is reached through a symbolic link; the resolved tree was searched`);
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      notes.push(`crash-report directory ${dir} could not be read: ${messageOf(error)}`);
      continue;
    }
    // Collect first, newest first, so the byte budget goes to the reports
    // most likely to explain the end — not to whatever readdir listed first.
    const found: { name: string; sourcePath: string; stat: Stats }[] = [];
    for (const name of names) {
      if (!sources.crashReportPattern.test(name)) {
        continue;
      }
      const sourcePath = join(dir, name);
      const stat = lstatOrNull(sourcePath);
      if (stat === null) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        notes.push(`crash report ${sourcePath} is a symbolic link and was not collected`);
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < options.since) {
        continue;
      }
      if (stat.nlink > 1) {
        skippedHardLinks += 1;
        continue;
      }
      found.push({ name, sourcePath, stat });
    }
    found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const allowed = Math.max(sources.maxCrashReportFiles - crashFiles, 0);
    crashFilesCapped += found.length - Math.min(found.length, allowed);
    for (const item of found.slice(0, allowed)) {
      if (take <= 0) {
        break;
      }
      crashFiles += 1;
      const target = uniqueTarget(crashReportsDir, item.name, crashNames);
      try {
        const copied = copyTail(item.sourcePath, target, Math.min(sources.maxCrashReportBytes, take));
        spend(copied.bytes);
        const attribution: EvidenceAttribution =
          options.host.pid !== null && fileNamesPid(item.sourcePath, options.host.pid) ? "session" : "app";
        crashReports.push({
          bundlePath: target,
          sourcePath: item.sourcePath,
          name: item.name,
          bytes: copied.bytes,
          truncated: copied.truncated,
          attribution,
          modifiedAt: item.stat.mtime.toISOString(),
        });
      } catch (error) {
        notes.push(`crash report ${item.sourcePath} could not be collected: ${messageOf(error)}`);
      }
    }
    if (take <= 0) {
      break;
    }
  }
  crashReports.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.name < b.name ? -1 : 1));
  if (crashFilesCapped > 0) {
    notes.push(
      `${crashFilesCapped} more crash report(s) matched but were not collected (cap ${sources.maxCrashReportFiles}, newest first)`,
    );
  }

  const logsDir = join(bundleDir, "logs");
  const logNames = new Set<string>();
  const logs: DiagnosticsFile[] = [];
  const skippedLinks = { count: 0 };
  const unreadableDirs = { count: 0 };
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const dir of sources.logDirs) {
    const dirStat = lstatOrNull(dir);
    if (dirStat === null) {
      notes.push(`no host-log directory at ${dir}`);
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      notes.push(`host-log directory ${dir} is a symbolic link and was not searched`);
      continue;
    }
    if (!dirStat.isDirectory()) {
      notes.push(`host-log path ${dir} is not a directory`);
      continue;
    }
    if (reachedThroughLink(dir)) {
      notes.push(`host-log directory ${dir} is reached through a symbolic link; the resolved tree was searched`);
    }
    // The scope test runs on the path relative to this root, prefixed by
    // the root's own name: `Logs/Adobe` only matches files that name AE
    // themselves, while `Caches/Adobe/After Effects` matches everything
    // under it because the directory is already AE-specific.
    const scopeRoot = basename(dir);
    for (const path of walk(dir, MAX_WALK_DEPTH, skippedLinks, unreadableDirs)) {
      const scoped = join(scopeRoot, relative(dir, path));
      if (!sources.logFilePattern.test(scoped)) {
        continue;
      }
      const stat = lstatOrNull(path);
      if (stat === null) {
        continue;
      }
      if (stat.isFile() && stat.mtimeMs >= options.since) {
        if (stat.nlink > 1) {
          skippedHardLinks += 1;
          continue;
        }
        candidates.push({ path, mtimeMs: stat.mtimeMs });
      }
    }
  }
  if (skippedLinks.count > 0) {
    notes.push(`${skippedLinks.count} symbolic link(s) under the host-log directories were not followed`);
  }
  if (unreadableDirs.count > 0) {
    notes.push(
      `${unreadableDirs.count} host-log director${unreadableDirs.count === 1 ? "y" : "ies"} could not be read; their contents are unknown, not absent`,
    );
  }
  if (skippedHardLinks > 0) {
    notes.push(
      `${skippedHardLinks} hard-linked file(s) were not collected: a hard link can reach outside the scanned tree`,
    );
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const candidate of candidates.slice(0, sources.maxLogFiles)) {
    if (take <= 0) {
      break;
    }
    const target = uniqueTarget(logsDir, candidate.path, logNames);
    try {
      const copied = copyTail(candidate.path, target, Math.min(sources.maxLogBytes, take));
      spend(copied.bytes);
      logs.push({
        bundlePath: target,
        sourcePath: candidate.path,
        bytes: copied.bytes,
        truncated: copied.truncated,
        // Path scope + the session window is all a log can offer: nothing
        // in a log line proves it came from this session's process.
        attribution: "app",
      });
    } catch (error) {
      notes.push(`log ${candidate.path} could not be collected: ${messageOf(error)}`);
    }
  }
  if (candidates.length > sources.maxLogFiles) {
    notes.push(
      `${candidates.length - sources.maxLogFiles} more host-log file(s) touched during the session were not collected (cap ${sources.maxLogFiles})`,
    );
  }

  if (crashReports.length === 0 && sources.crashReportDirs.length > 0) {
    notes.push(
      "no crash reports matched the After Effects binaries and the session window; a kill or a " +
        "clean quit leaves none either, so an empty list is not evidence of how the host ended",
    );
  }
  if (options.host.state === "gone") {
    notes.push(
      "the host process was absent at collection time; crash reports, when present, are the OS's " +
        "account of the end and may still be pending — process absence and report generation are verified separately",
    );
  }

  let trace: SessionDiagnostics["trace"] = null;
  if (options.tracePath !== undefined) {
    const traceStat = lstatOrNull(options.tracePath);
    if (traceStat === null) {
      notes.push(`no session trace at ${options.tracePath}`);
    } else if (traceStat.isSymbolicLink()) {
      notes.push(`session trace at ${options.tracePath} is a symbolic link and was not collected`);
    } else if (!traceStat.isFile()) {
      notes.push(`session trace at ${options.tracePath} is not a regular file`);
    } else {
      try {
        const target = join(bundleDir, "trace.jsonl");
        const allowance = Math.min(sources.maxTraceBytes, Math.max(take, 0));
        let bundlePath: string | null = null;
        let truncated = traceStat.size > 0;
        if (allowance > 0) {
          const copied = copyTail(options.tracePath, target, allowance);
          spend(copied.bytes);
          bundlePath = target;
          truncated = copied.truncated;
        } else {
          notes.push("the session trace was not copied: the bundle byte budget was already exhausted");
        }
        // The line tail is read from the source's own tail so a huge trace
        // does not have to be loaded whole, then bounded per line and in
        // total — and charged to the same bundle budget as everything else.
        const tailText = readTail(options.tracePath, TRACE_TAIL_SCAN_BYTES);
        const lines = tailText
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(-TRACE_TAIL_LINES)
          .map((line) => (line.length > TRACE_TAIL_LINE_MAX ? `${line.slice(0, TRACE_TAIL_LINE_MAX)}…[line truncated]` : line));
        let tail = Buffer.from(`${lines.join("\n")}\n`, "utf-8");
        if (tail.length > TRACE_TAIL_MAX_BYTES) {
          tail = tail.subarray(tail.length - TRACE_TAIL_MAX_BYTES);
          notes.push(`the trace tail was truncated to its last ${TRACE_TAIL_MAX_BYTES} bytes`);
        }
        const tailAllowance = Math.min(tail.length, Math.max(take, 0));
        if (tailAllowance > 0) {
          writeFileSync(join(bundleDir, "trace-tail.jsonl"), tail.subarray(tail.length - tailAllowance));
          spend(tailAllowance);
        } else {
          notes.push("the trace tail was not written: the bundle byte budget was already exhausted");
        }
        trace = {
          sourcePath: options.tracePath,
          bundlePath,
          events: countRecords(options.tracePath),
          truncated,
        };
      } catch (error) {
        notes.push(`session trace could not be collected: ${messageOf(error)}`);
      }
    }
  }

  const summary: SessionDiagnostics = {
    collectedAt: now().toISOString(),
    sessionRoot: options.sessionRoot,
    artifactsDir: options.artifactsDir,
    bundleDir,
    host: options.host,
    crashReports,
    logs,
    trace,
    notes,
  };
  writeFileSync(join(bundleDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  return summary;
}
