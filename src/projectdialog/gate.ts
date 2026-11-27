/**
 * The A-SAFETY gate for project-dialog round-trips (#368,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Open/Save through the native pickers is `mutate-gui` end to end: the
 * menu invoke, the dialog confirm and the shared-state filename entry
 * are each gated classes of their own surfaces (#360/#365/#371), and
 * this orchestration layer adds its own gate on top — fail-closed like
 * every sibling (`src/filedialog/gate.ts`, `src/menus/gate.ts`).
 *
 * Until the A-SAFETY audit clears the dialog/menu/input classes AND
 * the B-IME OS text-input posters land on a platform, every leg
 * refuses. This function is the single flip point for the
 * round-trip layer — permits are added here, never ad-hoc at call
 * sites.
 */

import type { ProjectDialogMutationGate } from "./controller.js";

/**
 * The production mutation gate for project-dialog legs. Always refuses
 * today; the reason cites the audit and the missing input vehicle.
 */
export function projectDialogMutationGate(): ProjectDialogMutationGate {
  return (op) => ({
    allowed: false,
    reason:
      `project-dialog ${op} is a mutate-gui class the A-SAFETY audit ` +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "the composed surfaces' own gates (menu invoke, dialog acts, " +
      "B-IME filename entry #372/#373) refuse independently — the " +
      "filename-entry vehicle has not landed on any platform",
  });
}
