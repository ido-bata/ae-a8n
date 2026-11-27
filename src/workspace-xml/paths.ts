/**
 * Path discovery for the After Effects workspace XML stores (#362).
 *
 * Documented layout (Adobe helpx + community reports; **unverified**
 * against a real install — spec §8):
 *
 *   macOS:    ~/Library/Preferences/Adobe/After Effects/<version>/
 *   Windows:  %APPDATA%/Adobe/After Effects/<version>/
 *
 * Under the version directory sit two stores, each either a directory of
 * XML files (the observed modern layout, e.g. `UserWorkspace_10.xml`) or —
 * tolerated for older/other reports — a single XML file:
 *
 *   ModifiedWorkspaces     user-customized / saved workspaces
 *   OriginalUserWorkspaces factory workspaces
 *
 * This module performs no writes. It only stats and lists.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceXmlError,
  type MissingWorkspaceStore,
  type WorkspaceDiscovery,
  type WorkspaceLayout,
  type WorkspaceStoreKind,
  type WorkspaceXmlFile,
} from "./types.js";

/** Store directory/file names under the version preferences directory. */
export const WORKSPACE_STORE_NAMES: Readonly<
  Record<WorkspaceStoreKind, string>
> = {
  modified: "ModifiedWorkspaces",
  original: "OriginalUserWorkspaces",
};

const ADOBE_PREFS_SEGMENTS = ["Adobe", "After Effects"] as const;

export type ResolvePreferencesOptions = {
  /** Defaults to `process.platform`. */
  readonly platform?: string;
  /** Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Defaults to `env.APPDATA ?? process.env.APPDATA`. */
  readonly appDataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit version directory name under the Adobe root (e.g. `"25.0"`).
   * When omitted, the newest subdirectory of the root is chosen.
   */
  readonly aeVersion?: string;
  /**
   * Explicit version preferences directory. Takes precedence over all
   * platform layout resolution; recorded as layout `"explicit"`.
   */
  readonly preferencesDir?: string;
};

export type DiscoverOptions = ResolvePreferencesOptions;

/**
 * Orders version directory names numerically, component by component
 * (`"10.0"` is newer than `"9.0"`, unlike a plain string compare).
 * Non-numeric components fall back to locale order.
 */
export function compareVersionDirNames(a: string, b: string): number {
  const partsA = a.split(/[.-]/);
  const partsB = b.split(/[.-]/);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const partA = partsA[i];
    const partB = partsB[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const numA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numB = /^\d+$/.test(partB) ? Number(partB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
      continue;
    }
    const cmp = partA.localeCompare(partB);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function adobePreferencesRoot(
  options: ResolvePreferencesOptions,
): { root: string; layout: WorkspaceLayout } {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const home = options.homeDir ?? homedir();
    return {
      root: join(home, "Library", "Preferences", ...ADOBE_PREFS_SEGMENTS),
      layout: "darwin-library-preferences",
    };
  }
  if (platform === "win32") {
    const env = options.env ?? process.env;
    const appData = options.appDataDir ?? env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new WorkspaceXmlError(
        "preferences-not-found",
        "cannot resolve the Windows workspace preferences root: APPDATA is not set",
      );
    }
    return {
      root: join(appData, ...ADOBE_PREFS_SEGMENTS),
      layout: "windows-appdata-roaming",
    };
  }
  throw new WorkspaceXmlError(
    "unsupported-platform",
    `no documented After Effects workspace layout for platform "${platform}"`,
  );
}

/**
 * Resolves the per-version preferences directory that contains the
 * workspace stores. Throws `WorkspaceXmlError` when the layout cannot be
 * resolved — discovery failure is explicit, never a silent empty result.
 */
export function resolveWorkspacePreferencesDir(
  options: ResolvePreferencesOptions = {},
): { preferencesDir: string; layout: WorkspaceLayout; versionDir: string | null } {
  if (options.preferencesDir !== undefined) {
    if (!existsSync(options.preferencesDir)) {
      throw new WorkspaceXmlError(
        "preferences-not-found",
        `explicit preferencesDir does not exist: ${options.preferencesDir}`,
      );
    }
    return {
      preferencesDir: options.preferencesDir,
      layout: "explicit",
      versionDir: null,
    };
  }

  const { root, layout } = adobePreferencesRoot(options);
  if (!existsSync(root)) {
    throw new WorkspaceXmlError(
      "preferences-not-found",
      `After Effects preferences root not found: ${root}`,
    );
  }

  if (options.aeVersion !== undefined) {
    const dir = join(root, options.aeVersion);
    if (!existsSync(dir)) {
      throw new WorkspaceXmlError(
        "version-not-found",
        `After Effects version directory "${options.aeVersion}" not found under ${root}`,
      );
    }
    return { preferencesDir: dir, layout, versionDir: options.aeVersion };
  }

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionDirNames);
  const newest = entries.at(-1);
  if (newest === undefined) {
    throw new WorkspaceXmlError(
      "version-not-found",
      `no version directories under ${root}`,
    );
  }
  return {
    preferencesDir: join(root, newest),
    layout,
    versionDir: newest,
  };
}

function listStoreFiles(
  kind: WorkspaceStoreKind,
  storePath: string,
): WorkspaceXmlFile[] {
  const stat = statSync(storePath);
  if (stat.isFile()) {
    // Tolerated variant: the store name is itself a single XML file.
    return [
      {
        kind,
        path: storePath,
        fileName: storePath.split(/[\\/]/).pop() ?? storePath,
      },
    ];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return readdirSync(storePath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((fileName) => ({
      kind,
      path: join(storePath, fileName),
      fileName,
    }));
}

const STORE_KIND_ORDER: readonly WorkspaceStoreKind[] = ["modified", "original"];

/**
 * Resolves the preferences directory and enumerates every workspace XML
 * file under `ModifiedWorkspaces` / `OriginalUserWorkspaces`. Absent
 * stores are reported in `missingStores`, not thrown — a store that was
 * never written is data, not an error.
 */
export function discoverWorkspaceXml(
  options: DiscoverOptions = {},
): WorkspaceDiscovery {
  const resolved = resolveWorkspacePreferencesDir(options);

  const files: WorkspaceXmlFile[] = [];
  const missingStores: MissingWorkspaceStore[] = [];
  for (const kind of STORE_KIND_ORDER) {
    const storePath = join(
      resolved.preferencesDir,
      WORKSPACE_STORE_NAMES[kind],
    );
    if (!existsSync(storePath)) {
      missingStores.push({ kind, expectedPath: storePath });
      continue;
    }
    files.push(...listStoreFiles(kind, storePath));
  }
  files.sort((a, b) =>
    a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind.localeCompare(b.kind),
  );

  return {
    preferencesDir: resolved.preferencesDir,
    layout: resolved.layout,
    versionDir: resolved.versionDir,
    files,
    missingStores,
  };
}
