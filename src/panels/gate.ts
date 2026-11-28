/**
 * The A-SAFETY gate for panel mutations (#343/#358,
 * `docs/gui-supervision-safety-gates.md` §「panel mutation（#343 /
 * B-PLATFORM）」).
 *
 * The #358 class decision, recorded in that document: the
 * `mutate-gui` panel **resize/restore** class is permitted on macOS
 * for owned, census-attributed surfaces, through exactly one vehicle —
 * the direct `AXUIElementSetAttributeValue(kAXSizeAttribute)` act of
 * the compiled `window-ops` helper (`MacGuiRecovery.resizePanelWindow`),
 * which re-lists the pid's AX windows and re-verifies the expected
 * frame+title+subrole identity inside the session immediately before
 * the set. The evidence is `docs/evidence/realhost-2026-11-27/`
 * (#357 PoC + the #358 end-to-end run): resize → measure → restore
 * completed on a real ScriptUI palette of an owned AE 2027 with
 * AX/census/in-AE agreement in global display points.
 *
 * Explicitly NOT cleared by this decision:
 *
 *   - The System Events `set size` vehicle — disproved on real AE
 *     (AppleEvent -1712 timeout; enumeration sees almost nothing).
 *   - The `AXFocusedWindow` mutation path — observe-only; it is
 *     focus-dependent and has no production mutation vehicle.
 *   - Panel `move`/dock operations and every `ae.windowOps()` op —
 *     the window-ops gate (`src/windowops/gate.ts`) keeps its own
 *     fail-closed state pending its own unblock path.
 *   - Windows — `unsupported` by `panelForTarget` before this gate is
 *     ever consulted.
 *
 * The permit below is the single flip point the audit document names;
 * the controller additionally refuses on its own when no gate is wired
 * at all, so constructing `PanelController` directly cannot bypass this
 * policy by omission. Every permit still sits behind the unchanged
 * fail-closed layers: `attribution === "owned"` required, GUI lease +
 * audit, in-session identity re-verification, and `indeterminate` on
 * unknown outcome.
 */

import type { PanelMutationGate } from "./controller.js";

/**
 * The production mutation gate for `ae.panel()`. Permits `resize` and
 * `restore` — the #358-cleared class — and refuses anything else the
 * type ever grows into, fail-closed with the audit citation.
 */
export function panelMutationGate(): PanelMutationGate {
  return (op: string) => {
    if (op === "resize" || op === "restore") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        `panel ${op} is outside the mutate-gui class the #358 A-SAFETY ` +
        "decision cleared (docs/gui-supervision-safety-gates.md §panel " +
        "mutation): only resize/restore through the direct-AX " +
        "window-ops vehicle are permitted; observe the audit document " +
        "before expecting this to change",
    };
  };
}
