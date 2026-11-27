/**
 * The A-SAFETY gate for menu invoke (#360,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §13).
 *
 * Menu invoke is a `mutate-gui` class. The audit cleared exactly one GUI
 * mutation — the macOS `ae-a8n ui.alert` press — and the workspace spec
 * keeps every `mutate-gui` op behind the lease+audit+gate chain pending
 * A-SAFETY clearance. Until a menu-invoke class is cleared, every invoke
 * refuses — fail-closed, with the refusal naming the governing documents
 * so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears a menu
 * invoke class, the permit is added here — not ad-hoc at call sites.
 * The controller additionally refuses on its own when no gate is wired
 * at all, so constructing `MenuController` directly cannot bypass this
 * policy by omission. The observe surface (enumerate, checkmark
 * readback) is gate-independent by design.
 */

import type { MenuMutationGate } from "./controller.js";

/**
 * The production mutation gate for menu invoke. Always refuses today;
 * the reason cites the audit so a caller can find the unblock conditions.
 */
export function menuInvokeGate(): MenuMutationGate {
  return () => ({
    allowed: false,
    reason:
      "menu invoke is a mutate-gui class the A-SAFETY audit " +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "no real-host run has yet proven After Effects menu AX fidelity " +
      "either — enumeration and checkmark readback remain available",
  });
}
