/**
 * Read-only probe for Issue #125: what does After Effects persist when a
 * human approves a script (or a folder of scripts) in Settings →
 * Scripting & Expressions?
 *
 * This script NEVER writes inside the scanned trees and never touches AE,
 * TCC, or any preference it reads. Its only write is the snapshot/diff JSON
 * the caller asks for with `--out` (or stdout). It exists so a human can
 * answer the approval-granularity question on a real Mac:
 *
 *   node scripts/script-trust-probe.mjs snapshot --out before.json
 *   # ... run the consumer test that triggers the AE approval dialog ...
 *   node scripts/script-trust-probe.mjs snapshot --out after.json
 *   node scripts/script-trust-probe.mjs diff before.json after.json
 *
 * A changed file plus a changed `Pref_*`-style key is the evidence of what
 * AE recorded; which paths appear in the new value is the granularity
 * answer (one folder entry vs one entry per script file).
 *
 * Snapshot content policy: paths, sizes, mtimes and SHA-256 of every regular
 * file under the scanned roots, plus — for AE `.txt` preference files only —
 * `"key" = "value"` pairs whose key matches the script/security pattern
 * (override with `--key-pattern`, or `--all-keys` for every key; wider
 * extraction can capture paths or other local data, so keep snapshots on
 * the measured machine). Everything else stays a hash: the probe does not
 * copy preference contents into its output.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 1;

/**
 * Keys worth surfacing from AE `.txt` preference files: anything that could
 * record a script-trust or scripting-permission decision. The measurement
 * doc tells the operator to widen this (`--key-pattern` / `--all-keys`) if a
 * diff shows a changed file but no changed key — the approval may be stored
 * under a name this pattern does not anticipate.
 */
export const DEFAULT_KEY_PATTERN = /script|secur|trust|allow|permission|network/i;

const PREFS_LINE = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
const PREFS_SECTION = /^\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/;

function unescapePrefsString(text) {
  return text.replace(/\\(.)/g, "$1");
}

/**
 * Extract `"key" = "value"` pairs from an AE preferences `.txt` file.
 * Section headers are tracked so keys are reported as `Section :: key`.
 * Returns a flat object; later duplicates win, matching AE's own read.
 */
export function extractPrefsEntries(text, keyPattern = DEFAULT_KEY_PATTERN, allKeys = false) {
  const entries = {};
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = PREFS_SECTION.exec(line);
    if (sectionMatch !== null) {
      section = unescapePrefsString(sectionMatch[1]);
      continue;
    }
    const pair = PREFS_LINE.exec(line);
    if (pair === null) continue;
    const key = unescapePrefsString(pair[1]);
    const value = unescapePrefsString(pair[2]);
    if (!allKeys && !keyPattern.test(key)) continue;
    entries[section === "" ? key : `${section} :: ${key}`] = value;
  }
  return entries;
}

/**
 * Default scan roots for the running platform. `extraRoots` are appended
 * verbatim (must be absolute). On macOS this is the per-user AE preferences
 * tree — the same tree that holds `…環境設定.txt` / `…Prefs.txt` — plus any
 * top-level `~/Library/Preferences` file whose name mentions After Effects
 * (e.g. a `com.adobe.AfterEffects*.plist`). On Windows the AppData Roaming
 * tree is the equivalent; the registry is NOT scanned (see the measurement
 * doc for the manual check).
 */
export function defaultRoots(platform = process.platform, env = process.env, home = homedir(), extraRoots = []) {
  const roots = [];
  if (platform === "darwin") {
    roots.push({
      path: join(home, "Library", "Preferences", "Adobe", "After Effects"),
      kind: "ae-prefs-tree",
    });
    roots.push({
      path: join(home, "Library", "Preferences"),
      kind: "ae-prefs-dir",
      match: /after.?effects/i,
    });
  } else if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    roots.push({ path: join(appData, "Adobe", "After Effects"), kind: "ae-prefs-tree" });
    roots.push({ path: appData, kind: "ae-prefs-dir", match: /after.?effects/i });
  } else {
    roots.push({ path: home, kind: "ae-prefs-dir", match: /after.?effects/i });
  }
  for (const path of extraRoots) roots.push({ path, kind: "extra" });
  return roots;
}

async function hashFile(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function snapshotFile(rootPath, filePath, keyPattern, allKeys) {
  const info = await stat(filePath);
  const entry = {
    path: filePath,
    root: rootPath,
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    sha256: await hashFile(filePath),
  };
  if (basename(filePath).toLowerCase().endsWith(".txt")) {
    try {
      const text = await readFile(filePath, "utf-8");
      entry.prefs = extractPrefsEntries(text, keyPattern, allKeys);
    } catch {
      // Unreadable as text: the hash still stands; note it, do not fail.
      entry.prefsError = "not readable as UTF-8 text";
    }
  }
  return entry;
}

async function snapshotTree(root, keyPattern, allKeys, out) {
  const abs = resolve(root.path);
  if (!existsSync(abs)) {
    out.roots.push({ path: abs, kind: root.kind, present: false });
    return;
  }
  const info = await stat(abs);
  out.roots.push({ path: abs, kind: root.kind, present: true });
  if (info.isDirectory()) {
    if (root.kind === "ae-prefs-dir") {
      // Non-recursive: this root only contributes matching top-level files.
      let names;
      try {
        names = await readdir(abs);
      } catch (error) {
        out.unreadable.push({ path: abs, error: String(error) });
        return;
      }
      for (const name of names) {
        if (root.match !== undefined && !root.match.test(name)) continue;
        const filePath = join(abs, name);
        try {
          const st = await stat(filePath);
          if (st.isFile()) out.files.push(await snapshotFile(abs, filePath, keyPattern, allKeys));
        } catch (error) {
          out.unreadable.push({ path: filePath, error: String(error) });
        }
      }
      return;
    }
    const stack = [abs];
    while (stack.length > 0) {
      const dir = stack.pop();
      let names;
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        out.unreadable.push({ path: dir, error: String(error) });
        continue;
      }
      for (const dirent of names) {
        const filePath = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(filePath);
        } else if (dirent.isFile()) {
          try {
            out.files.push(await snapshotFile(abs, filePath, keyPattern, allKeys));
          } catch (error) {
            out.unreadable.push({ path: filePath, error: String(error) });
          }
        } else if (dirent.isSymbolicLink()) {
          // Record the link itself; do not follow it out of the tree.
          out.files.push({
            path: filePath,
            root: abs,
            size: 0,
            mtimeMs: Math.round((await stat(filePath)).mtimeMs),
            sha256: null,
            symlink: true,
          });
        }
      }
    }
  } else if (info.isFile()) {
    try {
      out.files.push(await snapshotFile(dirname(abs), abs, keyPattern, allKeys));
    } catch (error) {
      out.unreadable.push({ path: abs, error: String(error) });
    }
  }
}

/**
 * Take a snapshot of every configured root. Read-only by construction:
 * the only filesystem calls are stat/readdir/readFile.
 */
export async function takeSnapshot(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const keyPattern =
    options.keyPattern instanceof RegExp
      ? options.keyPattern
      : options.allKeys === true
        ? null
        : DEFAULT_KEY_PATTERN;
  const allKeys = options.allKeys === true;
  const roots = options.roots ?? defaultRoots(platform, env, home, options.extraRoots ?? []);

  const out = {
    schemaVersion: SCHEMA_VERSION,
    tool: "script-trust-probe",
    issue: 125,
    platform,
    takenAt: new Date().toISOString(),
    home,
    roots: [],
    files: [],
    unreadable: [],
  };
  for (const root of roots) {
    await snapshotTree(root, keyPattern, allKeys, out);
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function indexFiles(snapshot) {
  const map = new Map();
  for (const file of snapshot.files) {
    // `path` is already absolute; it is the identity across snapshots.
    map.set(file.path, file);
  }
  return map;
}

function diffPrefs(beforePrefs = {}, afterPrefs = {}) {
  const changes = [];
  const keys = new Set([...Object.keys(beforePrefs), ...Object.keys(afterPrefs)]);
  for (const key of [...keys].sort()) {
    const before = beforePrefs[key] ?? null;
    const after = afterPrefs[key] ?? null;
    if (before === after) continue;
    changes.push({
      key,
      before,
      after,
      change: before === null ? "added" : after === null ? "removed" : "changed",
    });
  }
  return changes;
}

/**
 * Compare two snapshots. Returns a plain report; exit-code policy lives in
 * the CLI (a diff is data, not a failure).
 */
export function diffSnapshots(before, after) {
  const beforeFiles = indexFiles(before);
  const afterFiles = indexFiles(after);
  const addedFiles = [];
  const removedFiles = [];
  const changedFiles = [];

  for (const [key, file] of afterFiles) {
    const prior = beforeFiles.get(key);
    if (prior === undefined) {
      addedFiles.push(file.path);
      continue;
    }
    const contentChanged = prior.sha256 !== file.sha256;
    const mtimeChanged = prior.mtimeMs !== file.mtimeMs;
    if (!contentChanged && !mtimeChanged && prior.size === file.size) continue;
    const keyChanges = diffPrefs(prior.prefs, file.prefs);
    changedFiles.push({
      path: file.path,
      contentChanged,
      sizeBefore: prior.size,
      sizeAfter: file.size,
      sha256Before: prior.sha256,
      sha256After: file.sha256,
      ...(keyChanges.length > 0 ? { prefs: keyChanges } : {}),
    });
  }
  for (const [key, file] of beforeFiles) {
    if (!afterFiles.has(key)) removedFiles.push(file.path);
  }

  addedFiles.sort();
  removedFiles.sort();
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: "script-trust-probe",
    issue: 125,
    before: { takenAt: before.takenAt, home: before.home },
    after: { takenAt: after.takenAt, home: after.home },
    addedFiles,
    removedFiles,
    changedFiles,
    unreadableBefore: before.unreadable ?? [],
    unreadableAfter: after.unreadable ?? [],
    summary: {
      added: addedFiles.length,
      removed: removedFiles.length,
      changed: changedFiles.length,
      changedWithPrefsDiff: changedFiles.filter((f) => f.prefs !== undefined).length,
    },
  };
}

function usage() {
  return [
    "usage:",
    "  node scripts/script-trust-probe.mjs snapshot --out <file.json> [--root <dir>]... [--key-pattern <regex>] [--all-keys]",
    "  node scripts/script-trust-probe.mjs diff <before.json> <after.json> [--out <file.json>]",
    "",
    "snapshot scans the AE preference roots (macOS: ~/Library/Preferences/Adobe/",
    "After Effects and matching top-level preference files) READ-ONLY and writes",
    "one JSON document. diff compares two snapshots and prints what changed.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--root" || arg === "--key-pattern") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      args[arg.slice(2)] = args[arg.slice(2)] === undefined ? value : [args[arg.slice(2)], value].flat();
      i += 1;
    } else if (arg === "--all-keys") {
      args.allKeys = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function rootsFromArgs(value) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((path) => {
    if (!isAbsolute(path)) throw new Error(`--root must be absolute: ${path}`);
    return path;
  });
}

async function writeJson(path, document) {
  const target = resolve(path);
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  return target;
}

/** Refuse to write inside a scanned root: the probe must stay read-only there. */
function assertOutsideRoots(target, snapshot) {
  const resolved = resolve(target);
  for (const root of snapshot.roots) {
    if (!root.present) continue;
    if (resolved === root.path || resolved.startsWith(root.path + sep)) {
      throw new Error(`refusing to write inside a scanned root: ${resolved}`);
    }
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "snapshot") {
    const args = parseArgs(rest);
    const extraRoots = rootsFromArgs(args.root);
    let keyPattern = DEFAULT_KEY_PATTERN;
    if (args["key-pattern"] !== undefined) {
      const raw = Array.isArray(args["key-pattern"]) ? args["key-pattern"][0] : args["key-pattern"];
      try {
        keyPattern = new RegExp(raw, "i");
      } catch {
        throw new Error(`invalid --key-pattern: ${raw}`);
      }
    }
    const snapshot = await takeSnapshot({
      extraRoots,
      allKeys: args.allKeys === true,
      keyPattern,
    });
    if (args.out !== undefined) {
      const outPath = Array.isArray(args.out) ? args.out[0] : args.out;
      assertOutsideRoots(outPath, snapshot);
      await writeJson(outPath, snapshot);
    }
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (command === "diff") {
    const args = parseArgs(rest);
    const [beforePath, afterPath] = args._;
    if (beforePath === undefined || afterPath === undefined || args._.length !== 2) {
      throw new Error(usage());
    }
    const before = JSON.parse(await readFile(beforePath, "utf-8"));
    const after = JSON.parse(await readFile(afterPath, "utf-8"));
    if (before.schemaVersion !== SCHEMA_VERSION || after.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("snapshot schemaVersion mismatch; re-take both snapshots with this probe");
    }
    const diff = diffSnapshots(before, after);
    if (args.out !== undefined) {
      const outPath = Array.isArray(args.out) ? args.out[0] : args.out;
      await writeJson(outPath, diff);
    }
    console.log(JSON.stringify(diff, null, 2));
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`script-trust-probe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
