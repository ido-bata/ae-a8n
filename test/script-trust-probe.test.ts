/**
 * scripts/script-trust-probe.mjs (Issue #125): the prefs-file parser and
 * the snapshot differ are the parts a wrong answer would hide in, so they
 * are tested here against fixture trees. The probe itself is exercised
 * end-to-end only on a real Mac — see docs/script-trust-measurement.md.
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const probe = (await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/script-trust-probe.mjs", import.meta.url))).href
)) as {
  SCHEMA_VERSION: number;
  DEFAULT_KEY_PATTERN: RegExp;
  extractPrefsEntries: (text: string, keyPattern?: RegExp, allKeys?: boolean) => Record<string, string>;
  defaultRoots: (platform?: string, env?: NodeJS.ProcessEnv, home?: string, extraRoots?: string[]) => Array<Record<string, unknown>>;
  takeSnapshot: (options?: Record<string, unknown>) => Promise<{
    files: Array<Record<string, unknown>>;
    roots: Array<Record<string, unknown>>;
    unreadable: unknown[];
  }>;
  diffSnapshots: (before: unknown, after: unknown) => {
    addedFiles: string[];
    removedFiles: string[];
    changedFiles: Array<Record<string, unknown>>;
    summary: Record<string, number>;
  };
};

const temps: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "a8n-trust-probe-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

const PREFS = [
  '["Main Pref Section v2"]',
  '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "0"',
  '"Pref_SOMETHING_ELSE" = "keep me out"',
  '["Other Section"]',
  '"Pref_SCRIPTING_TRUSTED_FOLDERS" = "/Users/x/staging"',
  '"Pref_SCRIPTING_TRUSTED_SCRIPTS" = "/a/one.jsx;/b/two.jsx"',
  '"Unrelated Key" = "value"',
  "",
].join("\n");

describe("extractPrefsEntries", () => {
  it("keeps only keys matching the script/security pattern, with section prefixes", () => {
    const entries = probe.extractPrefsEntries(PREFS);
    expect(entries["Main Pref Section v2 :: Pref_SCRIPTING_FILE_NETWORK_SECURITY"]).toBe("0");
    expect(entries["Other Section :: Pref_SCRIPTING_TRUSTED_FOLDERS"]).toBe("/Users/x/staging");
    expect(entries["Other Section :: Pref_SCRIPTING_TRUSTED_SCRIPTS"]).toBe("/a/one.jsx;/b/two.jsx");
    expect(Object.keys(entries)).toHaveLength(3);
    expect(Object.values(entries)).not.toContain("keep me out");
  });

  it("unescapes quoted values and tolerates CRLF", () => {
    const text = '"Pref_SCRIPTING_SECRET" = "a\\"b"\r\n';
    const entries = probe.extractPrefsEntries(text);
    expect(entries["Pref_SCRIPTING_SECRET"]).toBe('a"b');
  });

  it("allKeys records every pair", () => {
    const entries = probe.extractPrefsEntries(PREFS, undefined, true);
    expect(entries["Main Pref Section v2 :: Pref_SOMETHING_ELSE"]).toBe("keep me out");
    expect(entries["Other Section :: Unrelated Key"]).toBe("value");
  });
});

describe("defaultRoots", () => {
  it("scans the AE preferences tree and matching top-level files on macOS", () => {
    const roots = probe.defaultRoots("darwin", {}, "/Users/someone");
    expect(roots).toHaveLength(2);
    expect(String(roots[0]!.path)).toBe("/Users/someone/Library/Preferences/Adobe/After Effects");
    expect(roots[0]!.kind).toBe("ae-prefs-tree");
    expect(String(roots[1]!.path)).toBe("/Users/someone/Library/Preferences");
    expect((roots[1]!.match as RegExp).test("com.adobe.AfterEffects.plist")).toBe(true);
    expect((roots[1]!.match as RegExp).test("com.apple.finder.plist")).toBe(false);
  });

  it("appends extra roots verbatim", () => {
    const roots = probe.defaultRoots("darwin", {}, "/h", ["/tmp/extra"]);
    expect(roots).toHaveLength(3);
    expect(roots[2]).toEqual({ path: "/tmp/extra", kind: "extra" });
  });
});

describe("takeSnapshot + diffSnapshots", () => {
  it("detects a changed prefs key and reports it as a prefs diff", async () => {
    const root = tempDir();
    const verDir = join(root, "26.5");
    mkdirSync(verDir, { recursive: true });
    const prefsPath = join(verDir, "Adobe After Effects 26.5 Prefs.txt");
    writeFileSync(prefsPath, PREFS);
    writeFileSync(join(verDir, "unrelated.bin"), "same");

    const options = { roots: [{ path: root, kind: "ae-prefs-tree" }] };
    const before = await probe.takeSnapshot(options);
    expect(before.files.map((f) => f.path)).toContain(prefsPath);

    // Simulate AE recording one approved folder after a consumer run.
    writeFileSync(
      prefsPath,
      PREFS.replace('"/Users/x/staging"', '"/Users/x/staging;/Users/x/other-session/staging"'),
    );
    const after = await probe.takeSnapshot(options);

    const diff = probe.diffSnapshots(before, after);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(1);
    const changed = diff.changedFiles[0]!;
    expect(changed.path).toBe(prefsPath);
    const prefs = changed.prefs as Array<{ key: string; before: string | null; after: string | null; change: string }>;
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.key).toBe("Other Section :: Pref_SCRIPTING_TRUSTED_FOLDERS");
    expect(prefs[0]!.change).toBe("changed");
    expect(prefs[0]!.after).toContain("/Users/x/other-session/staging");
  });

  it("reports added and removed files, and mtime-only touches without a prefs diff", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), '"Pref_SCRIPTING_X" = "1"');
    writeFileSync(join(root, "b.txt"), "x");
    writeFileSync(join(root, "gone.txt"), "y");
    const options = { roots: [{ path: root, kind: "ae-prefs-tree" }] };
    const before = await probe.takeSnapshot(options);

    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "new.txt"), '"Pref_SCRIPTING_Y" = "2"');
    // Same content, new mtime: touch b.txt well away from its creation time.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "b.txt"), later, later);
    const after = await probe.takeSnapshot(options);

    const diff = probe.diffSnapshots(before, after);
    expect(diff.addedFiles).toEqual([join(root, "new.txt")]);
    expect(diff.removedFiles).toEqual([join(root, "gone.txt")]);
    const touched = diff.changedFiles.find((f) => f.path === join(root, "b.txt"));
    expect(touched).toBeDefined();
    expect(touched!.contentChanged).toBe(false);
    expect(touched!.prefs).toBeUndefined();
  });

  it("records a missing root as absent instead of failing", async () => {
    const snapshot = await probe.takeSnapshot({
      roots: [{ path: join(tempDir(), "does-not-exist"), kind: "ae-prefs-tree" }],
    });
    expect(snapshot.roots[0]!.present).toBe(false);
    expect(snapshot.files).toHaveLength(0);
  });
});
