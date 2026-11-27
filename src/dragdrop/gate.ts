/**
 * The A-SAFETY gate for drag-drop mutations (#422,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§9/§13).
 *
 * Both drag kinds are `mutate-gui` target-scoped. The #411 real-host
 * PoC (`docs/evidence/realhost-2026-11-27/drag-alt-411/`) proved the
 * vehicles on owned AE 2027 — in-app CGEvent drags landed as reorder
 * and `vend=fileurl` NSDraggingSession file drops imported into the
 * Project panel — overturning #369's `unsupported` verdict, which was
 * scoped to drop-point UI state, not the mechanism.
 *
 * Class decision (recorded in the gates doc): `"drop-file"` is
 * permitted — the payload is restricted to existing regular files
 * (fixture files only), the drop point must be census-proven
 * topmost-owned inside the re-verified surface frame, foreign
 * apps/windows are refused before anything posts, and the DOM delta
 * oracle bounds the postcondition with no resend. `"element-drag"`
 * stays refused: the vehicle is proven but its blast radius inside
 * AE's UI (panel tear-off, arbitrary reorder) is wider than the
 * file-drop class and awaits its own A-SAFETY decision.
 *
 * This function is the single flip point, exactly like
 * `src/contextmenu/gate.ts`/`src/panels/gate.ts`: when the audit
 * clears a class, the permit is added here — not ad-hoc at call
 * sites.
 */

import type { DragDropMutationGate } from "./types.js";

/**
 * The production mutation gate for `ae.dragDrop()`. `drop-file` is
 * allowed under the #411-verified vehicle and the contract's
 * census/attribution/oracle chain; every other op refuses with the
 * audit citation.
 */
export function dragDropMutationGate(): DragDropMutationGate {
  return (op) => {
    if (op === "drop-file") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        `drag-drop ${op} is a mutate-gui class the A-SAFETY audit ` +
        "(docs/gui-supervision-safety-gates.md) keeps refused: the " +
        "element-drag vehicle is real-host proven (#411) but its " +
        "in-app blast radius (panel tear-off, arbitrary reorder) has " +
        "no dedicated class decision yet — drop-file is the only " +
        "permitted drag-drop op",
    };
  };
}
