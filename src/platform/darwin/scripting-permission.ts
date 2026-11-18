/**
 * The account's After Effects scripting file/network preference.
 *
 * `Pref_SCRIPTING_FILE_NETWORK_SECURITY` lives in the target account's own
 * AE prefs, keyed by `major.minor` of the app version (`26.5.3` → `26.5`).
 * `"1"` means scripts may write files and use the network, `"0"` means they
 * may not — verified on AE 26.5 and AE 27.0 (G0 evidence 2026-11-16, and the
 * AE 27 readiness-probe failure of issue #188). With `"0"`, ExtendScript's
 * `File.open("w")` creates the file but `File.write` emits nothing, so the
 * bridge's result files stay empty and every call times out.
 *
 * This module is shared by the read-only doctor probe (`adapter.ts`) and the
 * script-invocation transport's launch check, so the two cannot drift into
 * disagreeing about what "blocked" means.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** The account's AE prefs folder for an app version (`26.5.3` → `26.5`). */
export function aePrefsDir(version: string): string | null {
  const [major, minor] = version.split(".");
  if (major === undefined || minor === undefined) {
    return null;
  }
  return join(
    homedir(),
    "Library",
    "Preferences",
    "Adobe",
    "After Effects",
    `${major}.${minor}`,
  );
}

/** The current account, or null when the directory service will not say. */
export function currentUsername(): string | null {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export type AeScriptingPermission = {
  readonly state: "allowed" | "blocked" | "unreadable";
  readonly prefsDir: string;
  /** The raw pref value, for evidence strings. Null when unreadable. */
  readonly prefValue: string | null;
};

/**
 * `Pref_SCRIPTING_FILE_NETWORK_SECURITY` for one install version, read from
 * the target account's own AE prefs. Readable only when the target account
 * is the account this process runs as — another account's `~/Library`
 * cannot be read honestly, so the result is `null` there rather than a
 * guess. Same for a version that cannot be resolved to a prefs folder.
 *
 * A missing prefs file or key is "unreadable", not a verdict: it is never
 * treated as either allowed or blocked.
 */
export function aeScriptingPermission(
  version: string | null,
  targetUser: string | null,
): AeScriptingPermission | null {
  if (targetUser === null || targetUser !== currentUsername() || version === null) {
    return null;
  }
  const prefsDir = aePrefsDir(version);
  if (prefsDir === null) {
    return null;
  }
  const unreadable: AeScriptingPermission = {
    state: "unreadable",
    prefsDir,
    prefValue: null,
  };
  let entries: string[];
  try {
    entries = readdirSync(prefsDir);
  } catch {
    return unreadable;
  }
  const prefix = `Adobe After Effects ${version.split(".").slice(0, 2).join(".")} `;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".txt")) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(prefsDir, name), "utf-8");
    } catch {
      continue;
    }
    const match = /Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "([^"]+)"/.exec(text);
    if (match === null) {
      continue;
    }
    const value = match[1] ?? "";
    return {
      state: value === "1" ? "allowed" : value === "0" ? "blocked" : "unreadable",
      prefsDir,
      prefValue: value,
    };
  }
  return unreadable;
}
