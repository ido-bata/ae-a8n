/**
 * The A-SAFETY gate for window ops (#366,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§9/§13).
 *
 * Move, resize, minimize/restore, maximize and focus are all
 * `mutate-gui`, target-scoped: they set real AX attributes on a real
 * window of the target pid. The audit cleared exactly one GUI mutation
 * — the macOS `ae-a8n ui.alert` press — and the workspace spec keeps
 * every `mutate-gui` op behind the lease+audit+gate chain pending
 * A-SAFETY clearance. Until a window-ops class is cleared, every op
 * refuses — fail-closed, with the refusal naming the governing
 * documents so the reason is traceable.
 *
 * This function is the single flip point, exactly like
 * `src/workspace/gate.ts`/`src/filedialog/gate.ts`: when the audit
 * clears a window-op class, the permit is added here — not ad-hoc at
 * call sites. The observe surface (`state()`) is gate-independent by
 * design: reading window state mutates nothing.
 */

import type { WindowOpsMutationGate } from "./types.js";

/**
 * The production mutation gate for window ops. Always refuses today;
 * the reason cites the audit and the unverified real-host fidelity.
 */
export function windowOpsMutationGate(): WindowOpsMutationGate {
  return (op) => ({
    allowed: false,
    reason:
      `window ${op} is a mutate-gui class the A-SAFETY audit ` +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "the window-ops helper's AX set semantics on a real After Effects " +
      "window are also unverified on a real host — observe (`state`) " +
      "remains available",
  });
}
