/**
 * The A-SAFETY gate for drag-drop mutations (#422 file-drop, #427
 * element-drag; `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§9/§10).
 *
 * Both drag kinds are `mutate-gui` target-scoped. The #411 real-host
 * PoC (`docs/evidence/realhost-2026-11-27/drag-alt-411/`) proved the
 * vehicles on owned AE 2027 — in-app CGEvent drags landed as reorder
 * and `vend=fileurl` NSDraggingSession file drops imported into the
 * Project panel — overturning #369's `unsupported` verdict, which was
 * scoped to drop-point UI state, not the mechanism.
 *
 * Class decisions (recorded in the gates doc):
 *
 *   - `"drop-file"` — permitted (#422): payload restricted to existing
 *     regular files (fixture files only), drop point census-proven
 *     topmost-owned inside the re-verified surface frame, foreign
 *     apps/windows refused before anything posts, `project.items`
 *     DOM-delta oracle, no resend.
 *   - `"element-drag"` — permitted ONLY for the declared element
 *     classes proven on real host (#427, #411 + this ticket's e2e):
 *     `"project-item"` and `"timeline-layer"` reorder (DOM-delta
 *     oracle) and `"panel-tab"` dock→float tear-off (census
 *     window-count oracle — verified end-to-end on owned AE 2027).
 *     The request's `element` field selects both this permit and the
 *     readback oracle. `"other"` (any undeclared/arbitrary in-app
 *     drag) stays refused: same vehicle, unproven blast radius, no
 *     dedicated class decision.
 *
 * This function is the single flip point, exactly like
 * `src/contextmenu/gate.ts`/`src/panels/gate.ts`: when the audit
 * clears a class, the permit is added here — not ad-hoc at call
 * sites.
 */

import type {
  DragDropElementTarget,
  DragDropMutationGate,
} from "./types.js";

/**
 * The element classes the #427 A-SAFETY decision permits: the reorder
 * drags #411 reproduced on owned AE 2027 (`projectOrderChanged` twice,
 * `layerOrderChanged` once) plus the panel-tab dock→float tear-off
 * #427 verified end-to-end (census window count +1). Everything else
 * — undeclared/arbitrary in-app drags — stays refused.
 */
const PERMITTED_ELEMENT_TARGETS: readonly DragDropElementTarget[] = [
  "project-item",
  "timeline-layer",
  "panel-tab",
];

/**
 * The production mutation gate for `ae.dragDrop()`. `drop-file` and
 * the proven `element-drag` classes are allowed under the #411-verified
 * vehicle and the contract's census/attribution/oracle chain; every
 * other op refuses with the audit citation.
 */
export function dragDropMutationGate(): DragDropMutationGate {
  return (op, request) => {
    if (op === "drop-file") {
      return { allowed: true };
    }
    if (op === "element-drag") {
      const element =
        request !== undefined && request.kind === "element-drag"
          ? request.element
          : undefined;
      if (
        element !== undefined &&
        PERMITTED_ELEMENT_TARGETS.includes(element)
      ) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason:
          `drag-drop element-drag (${element ?? "undeclared"}) is a ` +
          "mutate-gui class the A-SAFETY audit " +
          "(docs/gui-supervision-safety-gates.md, #427) keeps refused: " +
          "only the real-host-proven targets (project-item, " +
          "timeline-layer, panel-tab dock→float) are permitted — " +
          "arbitrary in-app drags have no dedicated class decision",
      };
    }
    return {
      allowed: false,
      reason:
        `drag-drop ${String(op)} is a mutate-gui class the A-SAFETY audit ` +
        "(docs/gui-supervision-safety-gates.md) keeps refused: " +
        "drop-file and the proven element-drag classes are " +
        "the only permitted drag-drop ops",
    };
  };
}
