/**
 * Window ops surface (#366, W4+ of `specs/workspace-editing/spec.md` §9)
 * — barrel.
 */

export {
  WindowOpsController,
  windowOpsFramesMatch,
  type WindowOpsControllerOptions,
} from "./controller.js";
export { windowOpsMutationGate } from "./gate.js";
export {
  resolveWindowTarget,
  windowOpsGuiState,
  type WindowOpsResolution,
} from "./resolve.js";
export {
  WindowOpsError,
  DEFAULT_WINDOW_OPS_POLL,
  type WindowOpsActRequest,
  type WindowOpsActResult,
  type WindowOpsActVerdict,
  type WindowOpsCensusView,
  type WindowOpsErrorCode,
  type WindowOpsListing,
  type WindowOpsMutationGate,
  type WindowOpsOp,
  type WindowOpsPollOptions,
  type WindowOpsState,
  type WindowOpsSurfaceOps,
  type WindowOpsWindowInfo,
  type WindowOpResult,
} from "./types.js";
export {
  darwinWindowOpsOps,
  DarwinWindowOpsError,
  sessionWindowCensus,
  sessionWindowOpsExec,
  DARWIN_WINDOW_OPS_HELPERS,
  type DarwinWindowOpsExec,
  type DarwinWindowOpsHelper,
  type DarwinWindowOpsOptions,
} from "./darwin.js";
