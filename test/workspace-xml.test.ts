/**
 * Tests for the read-only After Effects workspace XML reader (#362).
 *
 * All fixtures are synthetic XML written into tmp dirs — no After Effects
 * is involved, and the module under test must never write back. The real
 * AE path layout remains `unverified`; these tests cover the documented
 * layout resolution, discovery, hashing, and name extraction only.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareVersionDirNames,
  discoverWorkspaceXml,
  resolveWorkspacePreferencesDir,
  WORKSPACE_STORE_NAMES,
} from "../src/workspace-xml/paths.js";
import {
  extractWorkspaceNames,
  inspectWorkspaceXml,
  snapshotWorkspaceStore,
  workspaceXmlRef,
} from "../src/workspace-xml/reader.js";
import { WorkspaceXmlError } from "../src/workspace-xml/types.js";

const WORKSPACE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<WorkspaceSet version="1">
  <Workspace name="Standard"><panels /></Workspace>
  <Workspace name="My Render Layout"><panels /></Workspace>
</WorkspaceSet>
`;

const NAME_ELEMENT_XML = `<root><name>Fallback Layout</name></root>`;

function expectWorkspaceXmlError(
  fn: () => unknown,
  code: string,
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceXmlError);
    expect((error as WorkspaceXmlError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkspaceXmlError(${code}) but nothing threw`);
}

describe("workspace-xml reader", () => {
  let root: string;
  let prefsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ae-a8n-workspace-xml-"));
    prefsDir = join(
      root,
      "Library",
      "Preferences",
      "Adobe",
      "After Effects",
      "25.0",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeStore(
    versionDir: string,
    kind: "modified" | "original",
    files: Record<string, string>,
  ): void {
    const dir = join(
      root,
      "Library",
      "Preferences",
      "Adobe",
      "After Effects",
      versionDir,
      WORKSPACE_STORE_NAMES[kind],
    );
    mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, "utf-8");
    }
  }

  describe("preferences dir resolution", () => {
    it("resolves the documented macOS layout and picks the newest version", () => {
      writeStore("9.0", "modified", { "UserWorkspace_1.xml": WORKSPACE_XML });
      writeStore("10.0", "modified", { "UserWorkspace_2.xml": WORKSPACE_XML });

      const resolved = resolveWorkspacePreferencesDir({
        platform: "darwin",
        homeDir: root,
      });

      expect(resolved.layout).toBe("darwin-library-preferences");
      expect(resolved.versionDir).toBe("10.0");
      expect(resolved.preferencesDir).toBe(
        join(
          root,
          "Library",
          "Preferences",
          "Adobe",
          "After Effects",
          "10.0",
        ),
      );
    });

    it("resolves the documented Windows layout from APPDATA", () => {
      const appData = join(root, "AppData", "Roaming");
      const dir = join(appData, "Adobe", "After Effects", "25.0");
      mkdirSync(join(dir, WORKSPACE_STORE_NAMES.modified), {
        recursive: true,
      });

      const resolved = resolveWorkspacePreferencesDir({
        platform: "win32",
        appDataDir: appData,
      });

      expect(resolved.layout).toBe("windows-appdata-roaming");
      expect(resolved.preferencesDir).toBe(dir);
    });

    it("honours an explicit aeVersion", () => {
      writeStore("25.0", "modified", { "UserWorkspace_1.xml": WORKSPACE_XML });
      writeStore("24.0", "modified", { "UserWorkspace_2.xml": WORKSPACE_XML });

      const resolved = resolveWorkspacePreferencesDir({
        platform: "darwin",
        homeDir: root,
        aeVersion: "24.0",
      });

      expect(resolved.versionDir).toBe("24.0");
      expect(resolved.preferencesDir.endsWith("24.0")).toBe(true);
    });

    it("treats an explicit preferencesDir as layout explicit", () => {
      mkdirSync(prefsDir, { recursive: true });
      const resolved = resolveWorkspacePreferencesDir({
        preferencesDir: prefsDir,
      });
      expect(resolved.layout).toBe("explicit");
      expect(resolved.preferencesDir).toBe(prefsDir);
    });

    it("throws preferences-not-found when the root is absent", () => {
      expectWorkspaceXmlError(
        () =>
          resolveWorkspacePreferencesDir({
            platform: "darwin",
            homeDir: root,
          }),
        "preferences-not-found",
      );
    });

    it("throws version-not-found when no version directory exists", () => {
      mkdirSync(
        join(root, "Library", "Preferences", "Adobe", "After Effects"),
        { recursive: true },
      );
      expectWorkspaceXmlError(
        () =>
          resolveWorkspacePreferencesDir({
            platform: "darwin",
            homeDir: root,
          }),
        "version-not-found",
      );
    });

    it("throws version-not-found for an unknown explicit aeVersion", () => {
      writeStore("25.0", "modified", {
        "UserWorkspace_1.xml": WORKSPACE_XML,
      });
      expectWorkspaceXmlError(
        () =>
          resolveWorkspacePreferencesDir({
            platform: "darwin",
            homeDir: root,
            aeVersion: "99.0",
          }),
        "version-not-found",
      );
    });

    it("throws unsupported-platform for an unknown OS", () => {
      expectWorkspaceXmlError(
        () =>
          resolveWorkspacePreferencesDir({
            platform: "linux",
            homeDir: root,
          }),
        "unsupported-platform",
      );
    });

    it("throws preferences-not-found on win32 without APPDATA", () => {
      expectWorkspaceXmlError(
        () => resolveWorkspacePreferencesDir({ platform: "win32", env: {} }),
        "preferences-not-found",
      );
    });

    it("throws preferences-not-found for a missing explicit preferencesDir", () => {
      expectWorkspaceXmlError(
        () =>
          resolveWorkspacePreferencesDir({
            preferencesDir: join(root, "nope"),
          }),
        "preferences-not-found",
      );
    });
  });

  describe("version ordering", () => {
    it("orders dotted versions numerically", () => {
      const sorted = ["9.0", "10.0", "9.1", "10.1"].sort(compareVersionDirNames);
      expect(sorted).toEqual(["9.0", "9.1", "10.0", "10.1"]);
    });
  });

  describe("discovery", () => {
    it("enumerates both stores sorted by kind then path", () => {
      writeStore("25.0", "original", { "UserWorkspace_2.xml": WORKSPACE_XML });
      writeStore("25.0", "modified", {
        "UserWorkspace_10.xml": WORKSPACE_XML,
        "UserWorkspace_1.xml": WORKSPACE_XML,
      });

      const discovery = discoverWorkspaceXml({
        platform: "darwin",
        homeDir: root,
      });

      expect(discovery.missingStores).toEqual([]);
      expect(discovery.files.map((f) => [f.kind, f.fileName])).toEqual([
        ["modified", "UserWorkspace_1.xml"],
        ["modified", "UserWorkspace_10.xml"],
        ["original", "UserWorkspace_2.xml"],
      ]);
      expect(discovery.files[0]?.path.endsWith("UserWorkspace_1.xml")).toBe(
        true,
      );
    });

    it("reports absent stores without throwing", () => {
      writeStore("25.0", "modified", { "UserWorkspace_1.xml": WORKSPACE_XML });

      const discovery = discoverWorkspaceXml({
        platform: "darwin",
        homeDir: root,
      });

      expect(discovery.files).toHaveLength(1);
      expect(discovery.missingStores).toEqual([
        {
          kind: "original",
          expectedPath: join(prefsDir, WORKSPACE_STORE_NAMES.original),
        },
      ]);
    });

    it("tolerates a store that is a single XML file", () => {
      mkdirSync(prefsDir, { recursive: true });
      const filePath = join(prefsDir, WORKSPACE_STORE_NAMES.modified);
      writeFileSync(filePath, WORKSPACE_XML, "utf-8");

      const discovery = discoverWorkspaceXml({ preferencesDir: prefsDir });

      expect(discovery.files).toEqual([
        {
          kind: "modified",
          path: filePath,
          fileName: WORKSPACE_STORE_NAMES.modified,
        },
      ]);
    });
  });

  describe("inspection", () => {
    it("hashes, stats, and extracts workspace names", () => {
      const dir = join(prefsDir, WORKSPACE_STORE_NAMES.modified);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, "UserWorkspace_7.xml");
      writeFileSync(filePath, WORKSPACE_XML, "utf-8");

      const before = statSync(filePath);
      const inspection = inspectWorkspaceXml(filePath);

      expect(inspection.sha256).toBe(
        createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      );
      expect(inspection.sizeBytes).toBe(before.size);
      expect(inspection.mtimeMs).toBe(before.mtimeMs);
      expect(inspection.fileName).toBe("UserWorkspace_7.xml");
      expect(inspection.workspaceNames).toEqual([
        "Standard",
        "My Render Layout",
      ]);
      expect(inspection.xmlRef).toEqual({
        path: filePath,
        sha256: inspection.sha256,
      });
      expect(workspaceXmlRef(inspection)).toEqual(inspection.xmlRef);
    });

    it("throws read-failed for a missing file", () => {
      expectWorkspaceXmlError(
        () => inspectWorkspaceXml(join(root, "does-not-exist.xml")),
        "read-failed",
      );
    });

    it("throws not-a-file for a directory", () => {
      mkdirSync(join(prefsDir, "adir"), { recursive: true });
      expectWorkspaceXmlError(
        () => inspectWorkspaceXml(join(prefsDir, "adir")),
        "not-a-file",
      );
    });
  });

  describe("name extraction", () => {
    it("reads name attributes on workspace-ish tags", () => {
      expect(
        extractWorkspaceNames(
          `<root><Workspace name="A"/><x:UserWorkspace name='B'/></root>`,
        ),
      ).toEqual(["A", "B"]);
    });

    it("deduplicates and ignores non-workspace tags", () => {
      expect(
        extractWorkspaceNames(
          `<root><Panel name="Timeline"/><Workspace name="A"/><Workspace name="A"/></root>`,
        ),
      ).toEqual(["A"]);
    });

    it("falls back to name elements when no attribute matches", () => {
      expect(extractWorkspaceNames(NAME_ELEMENT_XML)).toEqual([
        "Fallback Layout",
      ]);
    });

    it("decodes XML entities in attribute values", () => {
      expect(
        extractWorkspaceNames(`<Workspace name="A &amp; B"/>`),
      ).toEqual(["A & B"]);
    });

    it("returns an empty list for unrelated XML", () => {
      expect(extractWorkspaceNames(`<root><a>1</a></root>`)).toEqual([]);
    });
  });

  describe("snapshot", () => {
    it("combines discovery and inspection per file", () => {
      writeStore("25.0", "modified", {
        "UserWorkspace_1.xml": WORKSPACE_XML,
        "UserWorkspace_2.xml": NAME_ELEMENT_XML,
      });

      const snapshot = snapshotWorkspaceStore({
        platform: "darwin",
        homeDir: root,
      });

      expect(snapshot.layout).toBe("darwin-library-preferences");
      expect(snapshot.versionDir).toBe("25.0");
      expect(snapshot.files).toHaveLength(2);
      expect(snapshot.files[0]?.kind).toBe("modified");
      expect(snapshot.files[0]?.workspaceNames).toEqual([
        "Standard",
        "My Render Layout",
      ]);
      expect(snapshot.files[1]?.workspaceNames).toEqual(["Fallback Layout"]);
      expect(snapshot.missingStores.map((s) => s.kind)).toEqual(["original"]);
    });
  });

  describe("read-only guarantee", () => {
    it("the module sources contain no filesystem write calls", () => {
      const forbidden =
        /\b(writeFileSync|writeFile|mkdirSync|rmSync|renameSync|appendFileSync|appendFile|createWriteStream|openSync|copyFileSync|cpSync|utimesSync|chmodSync|chownSync)\b/;
      for (const file of ["types.ts", "paths.ts", "reader.ts"]) {
        const source = readFileSync(
          new URL(`../src/workspace-xml/${file}`, import.meta.url),
          "utf-8",
        );
        expect(source).not.toMatch(forbidden);
      }
    });
  });
});
