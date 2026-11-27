/**
 * File-dialog surface (#365) — barrel.
 */

export { fileDialogButtonTitle, matchFileDialog, type FileDialogMatch } from "./classify.js";
export {
  FileDialogController,
  type AwaitFileDialogOptions,
  type FileDialogControllerOptions,
  type FileDialogMutationGate,
  type FileDialogMutationOp,
  type FileDialogOps,
  type FilenameEntryVerdict,
} from "./controller.js";
export {
  FileDialogError,
  type FileDialogActResult,
  type FileDialogErrorCode,
  type FileDialogResolution,
  type FileDialogTitles,
} from "./types.js";
