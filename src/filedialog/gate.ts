/**
 * The A-SAFETY gate for file-dialog acts (#365,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Confirm, cancel and filename entry are all `mutate-gui` — filename
 * entry additionally `shared-state` (prior-state save/restore is the
 * B-IME input contract's job, #371). The audit cleared exactly one GUI
 * mutation — the macOS `ae-a8n ui.alert` press — and the workspace spec
 * keeps every `mutate-gui` op behind the lease+audit+gate chain pending
 * A-SAFETY clearance. Until a file-dialog class is cleared, every act
 * refuses — fail-closed, with the refusal naming the governing
 * documents so the reason is traceable.
 *
 * This function is the single flip point, exactly like
 * `src/menus/gate.ts`: when the audit clears a dialog-act class, the
 * permit is added here — not ad-hoc at call sites. The observe surface
 * (`awaitFileDialog`) is gate-independent by design: waiting and
 * classifying presses nothing.
 */

import type { FileDialogMutationGate } from "./controller.js";

/**
 * The production mutation gate for file-dialog acts. Always refuses
 * today; the reason cites the audit and the missing B-IME vehicle.
 */
export function fileDialogMutationGate(): FileDialogMutationGate {
  return (op) => ({
    allowed: false,
    reason:
      op === "enter-filename"
        ? "filename entry is a mutate-gui shared-state class: the A-SAFETY " +
          "audit (docs/gui-supervision-safety-gates.md) has not enabled it, " +
          "and the B-IME OS text-input posters it requires have not landed " +
          "on any platform (#372 macOS / #373 Windows)"
        : `file-dialog ${op} is a mutate-gui class the A-SAFETY audit ` +
          "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
          "workspace-editing spec (§13) keeps gated pending that clearance; " +
          "no real-host run has yet proven After Effects' native picker AX " +
          "fidelity either — awaiting and classifying the dialog remain available",
  });
}
