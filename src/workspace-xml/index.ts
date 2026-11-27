/**
 * Read-only After Effects workspace XML reader (#362,
 * `specs/workspace-editing/spec.md` §8). Barrel for the public surface
 * W1 (#363) re-exports through `ae.workspace()`.
 */

export {
  compareVersionDirNames,
  discoverWorkspaceXml,
  resolveWorkspacePreferencesDir,
  WORKSPACE_STORE_NAMES,
  type DiscoverOptions,
  type ResolvePreferencesOptions,
} from "./paths.js";

export {
  extractWorkspaceNames,
  inspectWorkspaceXml,
  snapshotWorkspaceStore,
  workspaceXmlRef,
} from "./reader.js";

export {
  WorkspaceXmlError,
  type InspectedWorkspaceXml,
  type MissingWorkspaceStore,
  type WorkspaceDiscovery,
  type WorkspaceLayout,
  type WorkspaceStoreKind,
  type WorkspaceStoreSnapshot,
  type WorkspaceXmlErrorCode,
  type WorkspaceXmlFile,
  type WorkspaceXmlInspection,
  type WorkspaceXmlRef,
} from "./types.js";
