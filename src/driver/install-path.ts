/**
 * Locating the After Effects installation.
 *
 * Adobe installs into a version-stamped directory (`Adobe After Effects 2025`)
 * or app bundle, so a hard-coded path would break on every upgrade. The
 * highest version present wins.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

function resolveWindows(root: string): AfterEffectsInstall | null {
  if (!existsSync(root)) {
    return null;
  }
  const newest = newestAeDirectory(readdirSync(root));
  if (newest === null) {
    return null;
  }
  const supportFiles = join(root, newest, "Support Files");
  const executable = join(supportFiles, "AfterFX.exe");
  if (!existsSync(executable)) {
    return null;
  }
  const render = join(supportFiles, "aerender.exe");
  return {
    executable,
    versionName: newest,
    renderExecutable: existsSync(render) ? render : null,
  };
}

function resolveMac(root: string): AfterEffectsInstall | null {
  if (!existsSync(root)) {
    return null;
  }
  const newest = newestAeDirectory(readdirSync(root));
  if (newest === null) {
    return null;
  }
  const bundle = join(root, `${newest}.app`);
  const executable = join(bundle, "Contents", "MacOS", "AfterFX");
  if (!existsSync(executable)) {
    return null;
  }
  const render = join(bundle, "Contents", "Frameworks", "aerender");
  return {
    executable,
    versionName: `${newest}.app`,
    renderExecutable: existsSync(render) ? render : null,
  };
}

export function resolveInstall(
  platform: NodeJS.Platform = process.platform,
  options: ResolveOptions = {},
): AfterEffectsInstall {
  if (options.installDir !== undefined) {
    return explicitInstall(platform, options.installDir);
  }
  const root = options.root ?? (platform === "darwin" ? MAC_APPLICATIONS_ROOT : ADOBE_WINDOWS_ROOT);
  const found = platform === "darwin" ? resolveMac(root) : resolveWindows(root);
  if (found === null) {
    throw new AfterEffectsNotInstalledError([root]);
  }
  return found;
}

function explicitInstall(platform: NodeJS.Platform, dir: string): AfterEffectsInstall {
  const executable =
    platform === "darwin"
      ? join(dir, "Contents", "MacOS", "AfterFX")
      : join(dir, "Support Files", "AfterFX.exe");
  if (!existsSync(executable)) {
    throw new AfterEffectsNotInstalledError([dir]);
  }
  const render =
    platform === "darwin"
      ? join(dir, "Contents", "Frameworks", "aerender")
      : join(dir, "Support Files", "aerender.exe");
  return {
    executable,
    versionName: dir.split(/[\\/]/).at(-1) ?? dir,
    renderExecutable: existsSync(render) ? render : null,
  };
}
