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
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { HostOwnership, HostState } from "./transport.js";

/** One file found on disk and copied (or tailed) into the bundle. */
export type DiagnosticsFile = {
  /** Path of the copy inside the bundle, when one was made. */
  readonly bundlePath: string | null;
  /** Where it was found. */
  readonly sourcePath: string;
  readonly bytes: number;
  /** True when only the tail of the file was collected. */
  readonly truncated: boolean;
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
  /** Per-file cap on collected log bytes (the tail is kept). */
  readonly maxLogBytes: number;
  /** Cap on collected log files, newest first. */
  readonly maxLogFiles: number;
};

/** macOS: DiagnosticReports plus the Adobe log/crash-database caches. */
export function darwinDiagnosticSources(home: string = homedir()): DiagnosticSources {
  return {
    crashReportDirs: [join(home, "Library", "Logs", "DiagnosticReports")],
    crashReportPattern: /after effects|afterfx|aerender/i,
    logDirs: [
      join(home, "Library", "Logs", "Adobe"),
      // Sentry breadcrumbs live here and carry the signal sender — the one
      // piece of evidence that distinguishes "AE crashed" from "AE was
      // killed". Small files; the per-file cap bounds them like any log.
      join(home, "Library", "Caches", "Adobe", "After Effects"),
    ],
    maxLogBytes: 256 * 1024,
    maxLogFiles: 20,
  };
}

/** Platforms without a collector: the report says so instead of pretending. */
export function unsupportedDiagnosticSources(): DiagnosticSources {
  return {
    crashReportDirs: [],
    crashReportPattern: /(?!)/,
    logDirs: [],
    maxLogBytes: 0,
    maxLogFiles: 0,
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

function safeName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Copies at most `maxBytes` from the *end* of `source` to `target`. */
function copyTail(source: string, target: string, maxBytes: number): { bytes: number; truncated: boolean } {
  const size = statSync(source).size;
  if (size <= maxBytes) {
    copyFileSync(source, target);
    return { bytes: size, truncated: false };
  }
  const fd = openSync(source, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    writeFileSync(target, buffer);
  } finally {
    closeSync(fd);
  }
  return { bytes: maxBytes, truncated: true };
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(path, depth - 1);
    } else if (stat.isFile()) {
      yield path;
    }
  }
}

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

  if (sources.crashReportDirs.length === 0 && sources.logDirs.length === 0) {
    notes.push(
      `no diagnostics collector for ${platform}: crash reports and host logs are not gathered on this platform`,
    );
  }

  const crashReports: CrashReportEntry[] = [];
  for (const dir of sources.crashReportDirs) {
    if (!existsSync(dir)) {
      notes.push(`no crash-report directory at ${dir}`);
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      notes.push(`crash-report directory ${dir} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const name of names) {
      if (!sources.crashReportPattern.test(name)) {
        continue;
      }
      const sourcePath = join(dir, name);
      let stat;
      try {
        stat = statSync(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < options.since) {
        continue;
      }
      const target = join(bundleDir, "crash-reports", safeName(name));
      try {
        copyFileSync(sourcePath, target);
        crashReports.push({
          bundlePath: target,
          sourcePath,
          name,
          bytes: stat.size,
          truncated: false,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (error) {
        notes.push(`crash report ${sourcePath} could not be copied: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  crashReports.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));

  const logs: DiagnosticsFile[] = [];
  const seen = new Set<string>();
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const dir of sources.logDirs) {
    if (!existsSync(dir)) {
      notes.push(`no host-log directory at ${dir}`);
      continue;
    }
    for (const path of walk(dir, MAX_WALK_DEPTH)) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.mtimeMs >= options.since) {
        candidates.push({ path, mtimeMs: stat.mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, sources.maxLogFiles)) {
    const target = join(bundleDir, "logs", safeName(candidate.path));
    try {
      const copied = copyTail(candidate.path, target, sources.maxLogBytes);
      logs.push({
        bundlePath: target,
        sourcePath: candidate.path,
        bytes: copied.bytes,
        truncated: copied.truncated,
      });
    } catch (error) {
      notes.push(`log ${candidate.path} could not be collected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (candidates.length > sources.maxLogFiles) {
    notes.push(
      `${candidates.length - sources.maxLogFiles} more host-log file(s) touched during the session were not collected (cap ${sources.maxLogFiles})`,
    );
  }

  let trace: SessionDiagnostics["trace"] = null;
  if (options.tracePath !== undefined && existsSync(options.tracePath)) {
    const target = join(bundleDir, "trace.jsonl");
    try {
      copyFileSync(options.tracePath, target);
      const text = readFileSync(options.tracePath, "utf-8");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      writeFileSync(join(bundleDir, "trace-tail.jsonl"), `${lines.slice(-TRACE_TAIL_LINES).join("\n")}\n`, "utf-8");
      trace = { sourcePath: options.tracePath, bundlePath: target, events: lines.length };
    } catch (error) {
      notes.push(`session trace could not be collected: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (options.tracePath !== undefined) {
    notes.push(`no session trace at ${options.tracePath}`);
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
