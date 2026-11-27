/**
 * The A-SAFETY gate for context-menu acts (#368,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Right-click posting and menu-item presses are both `mutate-gui`: the
 * right-click is a real CGEvent/SendInput post inside the target
 * session, and the item press mutates AE's UI state. The audit cleared
 * exactly one GUI mutation — the macOS `ae-a8n ui.alert` press — and
 * the workspace spec keeps every `mutate-gui` op behind the
 * lease+audit+gate chain pending A-SAFETY clearance. Until a
 * context-menu class is cleared, every act refuses — fail-closed, with
 * the refusal naming the governing documents so the reason is
 * traceable. Additionally, whether a CGEvent right-button post opens
 * AE's context menus at all is unverified on a real host (spec §11).
 *
 * This function is the single flip point, exactly like
 * `src/filedialog/gate.ts`: when the audit clears a context-menu class,
 * the permit is added here — not ad-hoc at call sites.
 */

import type { ContextMenuMutationGate } from "./controller.js";

/**
 * The production mutation gate for context-menu acts. Always refuses
 * today; the reason cites the audit and the unverified vehicle.
 */
export function contextMenuMutationGate(): ContextMenuMutationGate {
  return (op) => ({
    allowed: false,
    reason:
      `context-menu ${op} is a mutate-gui class the A-SAFETY audit ` +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "whether the CGEvent right-button post and the context-menu AX " +
      "surface work on a real After Effects is unverified (spec §11) — " +
      "observing and classifying remain contract-level only",
  });
}
