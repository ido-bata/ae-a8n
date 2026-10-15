/**
 * Locating the After Effects installation.
 *
 * Adobe installs into a version-stamped directory (`Adobe After Effects 2025`)
 * or app bundle, so a hard-coded path would break on every upgrade. The
 * highest version present wins.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const ADOBE_WINDOWS_ROOT = "C:\\Program Files\\Adobe";
export const MAC_APPLICATIONS_ROOT = "/Applications";

const AE_DIR_PATTERN = /^Adobe After Effects (.+)$/;

/** Orders the suffixes Adobe uses: years compare as years, everything else as text. */
function compareVersionSuffixes(a: string, b: string): number {
  const yearA = /^\d{4}$/.test(a);
  const yearB = /^\d{4}$/.test(b);
  if (yearA && yearB) {
    return Number(a) - Number(b);
  }
  if (yearA !== yearB) {
    // A calendar-year build is newer than a named release.
    return yearA ? 1 : -1;
  }
  return a.localeCompare(b);
}

export function sortVersionSuffixes(suffixes: readonly string[]): string[] {
  return [...suffixes].sort(compareVersionSuffixes);
}

/** Picks the newest `Adobe After Effects <version>` directory, or null. */
export function newestAeDirectory(entries: readonly string[]): string | null {
  const candidates = entries
    .map((entry) => AE_DIR_PATTERN.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] as string)
    .sort(compareVersionSuffixes);
  const newest = candidates.at(-1);
  return newest === undefined ? null : `Adobe After Effects ${newest}`;
}

/** Every `Adobe After Effects <version>` entry, newest first. */
export function aeDirectoriesNewestFirst(entries: readonly string[]): string[] {
  return entries
    .map((entry) => AE_DIR_PATTERN.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] as string)
    .sort(compareVersionSuffixes)
    .reverse()
    .map((suffix) => `Adobe After Effects ${suffix}`);
}

export type AfterEffectsInstall = {
  /** Path to the application executable. */
  readonly executable: string;
  /** Version directory or bundle name, e.g. `Adobe After Effects 2025`. */
  readonly versionName: string;
  /** `aerender.exe` / `aerender`, when the install ships one. */
  readonly renderExecutable: string | null;
};

export type ResolveOptions = {
  /** Override the detected install. Takes precedence over discovery. */
  readonly installDir?: string;
  /** Adobe root to scan. Defaults per platform; mainly a test seam. */
  readonly root?: string;
  /**
   * Where Windows says After Effects was installed (Uninstall registry
   * `InstallLocation`). Consulted only when the scanned root holds no usable
   * install. Mainly a test seam; defaults to asking the registry.
   */
  readonly registryLocations?: () => readonly string[];
};

export class AfterEffectsNotInstalledError extends Error {
  constructor(checked: readonly string[]) {
    super(
      `no After Effects installation found (looked in: ${checked.join(", ")}). ` +
        "Pass installDir explicitly if Adobe installed it somewhere unusual.",
    );
    this.name = "AfterEffectsNotInstalledError";
  }
}

/** An install at `<dir>\Support Files\AfterFX.exe`, or null when `dir` has no executable. */
function windowsInstallAt(dir: string): AfterEffectsInstall | null {
  const supportFiles = join(dir, "Support Files");
  const executable = join(supportFiles, "AfterFX.exe");
  if (!existsSync(executable)) {
    return null;
  }
  const render = join(supportFiles, "aerender.exe");
  return {
    executable,
    versionName: dir.split(/[\\/]/).at(-1) ?? dir,
    renderExecutable: existsSync(render) ? render : null,
  };
}

/**
 * Every usable install under `root`, newest first. An uninstall can leave a
 * version directory behind with no executable in it (a 17-file leftover was
 * seen next to the real install on Windows 11), so the newest *usable* install
 * wins rather than the newest name.
 */
function windowsInstallsUnder(root: string): AfterEffectsInstall[] {
  if (!existsSync(root)) {
    return [];
  }
  return aeDirectoriesNewestFirst(readdirSync(root))
    .map((name) => windowsInstallAt(join(root, name)))
    .filter((found): found is AfterEffectsInstall => found !== null);
}

/**
 * `InstallLocation` of every "Adobe After Effects" Uninstall entry. Adobe
 * records the Adobe root there (for example `D:\Adobe`), wherever the user chose to
 * install, so nothing machine-specific is assumed. Returns [] off Windows or
 * when the registry cannot be read.
 */
function registryInstallLocations(): string[] {
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
    "-ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Adobe After Effects*' } | " +
    "ForEach-Object { $_.InstallLocation }";
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function resolveWindows(root: string, registryLocations: () => readonly string[]): AfterEffectsInstall | null {
  const direct = windowsInstallsUnder(root)[0];
  if (direct !== undefined) {
    return direct;
  }
  // Nothing under the default root: ask where the installer put it. The
  // location is the Adobe root, or, for some installers, the install itself.
  const seen = new Set<string>();
  const found: AfterEffectsInstall[] = [];
  for (const location of registryLocations()) {
    const key = location.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const here = windowsInstallAt(location);
    found.push(...(here === null ? windowsInstallsUnder(location) : [here]));
  }
  return (
    found.sort((a, b) => compareVersionSuffixes(versionSuffix(a.versionName), versionSuffix(b.versionName))).at(-1) ??
    null
  );
}

function versionSuffix(versionName: string): string {
  return AE_DIR_PATTERN.exec(versionName)?.[1] ?? versionName;
}

/**
 * Executable names a macOS bundle may use, for a bundle whose Info.plist is
 * not XML. AE 2026 (26.5) ships `After Effects`; `AfterFX` is the Windows name
 * and is kept only as a last resort.
 */
const MAC_EXECUTABLE_FALLBACKS = ["After Effects", "AfterFX"];

/** The executable a macOS bundle launches, or null if it has none. */
function macBundleExecutable(bundle: string): string | null {
  const macos = join(bundle, "Contents", "MacOS");
  const candidates: string[] = [];
  try {
    const plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf-8");
    const declared = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (declared !== null) {
      candidates.push(declared[1] as string);
    }
  } catch {
    // Missing or binary plist: fall through to the known names.
  }
  candidates.push(...MAC_EXECUTABLE_FALLBACKS);
  for (const name of candidates) {
    const executable = join(macos, name);
    if (existsSync(executable)) {
      return executable;
    }
  }
  return null;
}

/**
 * Reads a macOS install from either its install directory
 * (`/Applications/Adobe After Effects 2026`, which holds the bundle and
 * `aerender`) or the bundle itself.
 */
function macInstallAt(path: string): AfterEffectsInstall | null {
  let installDir: string;
  let bundle: string;
  if (path.endsWith(".app")) {
    bundle = path;
    installDir = dirname(path);
  } else {
    installDir = path;
    bundle = join(path, `${basename(path)}.app`);
  }
  const executable = macBundleExecutable(bundle);
  if (executable === null) {
    return null;
  }
  const render = [join(installDir, "aerender"), join(bundle, "Contents", "Frameworks", "aerender")].find(
    (candidate) => existsSync(candidate),
  );
  return {
    executable,
    versionName: basename(bundle),
    renderExecutable: render ?? null,
  };
}

function resolveMac(root: string): AfterEffectsInstall | null {
  if (!existsSync(root)) {
    return null;
  }
  // An uninstall can leave a version directory behind with no bundle in it, so
  // the newest *usable* install wins rather than the newest name.
  for (const name of aeDirectoriesNewestFirst(readdirSync(root))) {
    const found = macInstallAt(join(root, name));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * The `.app` bundle an executable belongs to, or null when it is not inside
 * one. AppleScript addresses the bundle, not the executable.
 */
export function macAppBundle(executable: string): string | null {
  const macos = dirname(executable);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents" || !bundle.endsWith(".app")) {
    return null;
  }
  return bundle;
}

/**
 * Where to look when the Adobe root holds nothing. A root the caller named is
 * theirs to be exact about: if it holds no install that is an error, not a cue
 * to use some other install on the machine. Only the default root falls back.
 */
function windowsFallbackLocations(platform: NodeJS.Platform, options: ResolveOptions): () => readonly string[] {
  if (options.root !== undefined && options.registryLocations === undefined) {
    return () => [];
  }
  return options.registryLocations ?? (platform === "win32" ? registryInstallLocations : () => []);
}

export function resolveInstall(
  platform: NodeJS.Platform = process.platform,
  options: ResolveOptions = {},
): AfterEffectsInstall {
  if (options.installDir !== undefined) {
    return explicitInstall(platform, options.installDir);
  }
  const root = options.root ?? (platform === "darwin" ? MAC_APPLICATIONS_ROOT : ADOBE_WINDOWS_ROOT);
  const found =
    platform === "darwin"
      ? resolveMac(root)
      : resolveWindows(root, windowsFallbackLocations(platform, options));
  if (found === null) {
    throw new AfterEffectsNotInstalledError([root]);
  }
  return found;
}

function explicitInstall(platform: NodeJS.Platform, dir: string): AfterEffectsInstall {
  if (platform === "darwin") {
    const found = macInstallAt(dir);
    if (found === null) {
      throw new AfterEffectsNotInstalledError([dir]);
    }
    return found;
  }
  const found = windowsInstallAt(dir);
  if (found === null) {
    throw new AfterEffectsNotInstalledError([dir]);
  }
  return found;
}
