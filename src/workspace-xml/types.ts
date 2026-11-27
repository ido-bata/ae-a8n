/**
 * Shared types for the read-only After Effects workspace XML reader (#362).
 *
 * Scope authority: `specs/workspace-editing/spec.md` §8 — workspace
 * persistence is XML under the per-version preferences folder, and file
 * inspection is an `observe`-class channel that must stay read-only.
 *
 * Verification honesty: the on-disk layout below is documented by Adobe
 * helpx and community reports but **unverified** against a real install
 * until probed on a real host. Every result carries the layout label that
 * produced it so evidence never implies more than was checked.
 */

/** The two documented workspace stores under the version preferences dir. */
export type WorkspaceStoreKind = "modified" | "original";

/** Which discovery rule resolved the preferences directory. */
export type WorkspaceLayout =
  /** Caller supplied the exact version directory. */
  | "explicit"
  /** `~/Library/Preferences/Adobe/After Effects/<version>` (macOS). */
  | "darwin-library-preferences"
  /** `%APPDATA%/Adobe/After Effects/<version>` (Windows). */
  | "windows-appdata-roaming";

/**
 * The read-only evidence handle from spec §5 `WorkspaceTarget.xmlRef`.
 * This is identity-free evidence — a snapshot of what the file was when
 * read — never a handle to act on.
 */
export type WorkspaceXmlRef = {
  readonly path: string;
  readonly sha256: string;
};

/** One XML file discovered inside a workspace store. */
export type WorkspaceXmlFile = {
  readonly kind: WorkspaceStoreKind;
  /** Absolute path to the XML file. */
  readonly path: string;
  readonly fileName: string;
};

/** A store directory that was expected but absent. */
export type MissingWorkspaceStore = {
  readonly kind: WorkspaceStoreKind;
  /** The path that was probed (`<prefs>/<ModifiedWorkspaces|OriginalUserWorkspaces>`). */
  readonly expectedPath: string;
};

/** Result of resolving and enumerating the workspace XML stores. */
export type WorkspaceDiscovery = {
  /** The resolved per-version preferences directory. */
  readonly preferencesDir: string;
  readonly layout: WorkspaceLayout;
  /** Directory name chosen under the Adobe root, when layout resolution scanned. */
  readonly versionDir: string | null;
  /** Discovered XML files, sorted by kind then path. */
  readonly files: readonly WorkspaceXmlFile[];
  /** Stores probed but not present — reported, never silently dropped. */
  readonly missingStores: readonly MissingWorkspaceStore[];
};

/** Full read-only inspection of one workspace XML file. */
export type WorkspaceXmlInspection = {
  readonly path: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /**
   * Workspace display names extracted by the documented heuristic in
   * `reader.ts`. Empty means "no names found" — it is not proof the file
   * has no workspaces; the schema is unverified.
   */
  readonly workspaceNames: readonly string[];
  /** The spec §5 `xmlRef` evidence handle for this file. */
  readonly xmlRef: WorkspaceXmlRef;
};

/** One inspected file tagged with its store kind. */
export type InspectedWorkspaceXml = WorkspaceXmlInspection & {
  readonly kind: WorkspaceStoreKind;
};

/** Convenience snapshot: discovery plus per-file inspection. */
export type WorkspaceStoreSnapshot = {
  readonly preferencesDir: string;
  readonly layout: WorkspaceLayout;
  readonly versionDir: string | null;
  readonly files: readonly InspectedWorkspaceXml[];
  readonly missingStores: readonly MissingWorkspaceStore[];
};

/** Machine-readable failure reasons for the reader. */
export type WorkspaceXmlErrorCode =
  /** The OS has no documented workspace layout this reader knows. */
  | "unsupported-platform"
  /** The Adobe preferences root or an explicit override does not exist. */
  | "preferences-not-found"
  /** The preferences root exists but no usable version directory was found. */
  | "version-not-found"
  /** A probed workspace XML path exists but is not a regular file. */
  | "not-a-file"
  /** The file could not be read or hashed. */
  | "read-failed";

export class WorkspaceXmlError extends Error {
  readonly code: WorkspaceXmlErrorCode;

  constructor(code: WorkspaceXmlErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceXmlError";
    this.code = code;
  }
}
