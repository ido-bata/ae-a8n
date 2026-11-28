/**
 * Docked-region pane deep AX walk (#361,
 * `specs/workspace-editing/spec.md` §6/§7) — the `docked-region` half of
 * the B-PANEL contract: bounded subtree walk, `axPath` re-resolution with
 * `stale-locator` drift detection, census-frame region bounding, and the
 * visible-row read surface W2/W3 build on. Observe-class only.
 */

export {
  axChildPath,
  axLeaf,
  axParentPath,
  boundAxTree,
  collectDescendants,
  DEFAULT_ROW_ROLES,
  enumeratePaneRows,
  nodeText,
  resolveAxPath,
  type AxWalkBounds,
  type BoundedAxTree,
  type DockedAxNode,
  type DockedPaneRow,
} from "./ax-node.js";

export {
  AX_PANE_WALK_SCRIPT,
  parsePaneWalkReport,
  type PaneWalkReport,
} from "./ax-script.js";

export {
  pickDockedPaneParent,
  resolveDockedPane,
  type DockedPaneLocator,
  type DockedPaneParent,
  type DockedPaneResolution,
  type DockedPaneWalkInfo,
} from "./resolve.js";

export {
  DEFAULT_DOCKED_PANE_BOUNDS,
  DockedPaneObserver,
  type DockedPaneBounds,
  type DockedPaneCensusView,
  type DockedPaneObserverOptions,
  type DockedPaneOps,
  type DockedPaneTree,
  type DockedPaneWalkRequest,
} from "./observer.js";
