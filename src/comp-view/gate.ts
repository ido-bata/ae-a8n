/**
 * The A-SAFETY gate for comp-view mutations (#367,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Comp-view pan and zoom are `mutate-gui` acts delivered as real mouse
 * input or an authorized session-stream chord. The audit cleared
 * exactly one GUI mutation — the macOS `ae-a8n ui.alert` press — and the
 * workspace spec keeps every `mutate-gui` op behind the lease+audit+gate
 * chain pending A-SAFETY clearance. Until a comp-view-mutation class is
 * cleared, every op refuses — fail-closed, with the refusal naming the
 * governing documents so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears a
 * comp-view mutation class, the permit is added here — not ad-hoc at
 * call sites. The controller additionally refuses on its own when no
 * gate is wired at all, so constructing `CompViewController` directly
 * cannot bypass this policy by omission.
 */

import type { CompViewMutationGate } from "./controller.js";

/**
 * The production mutation gate for comp-view ops. Always refuses today;
 * the reason cites the audit so a caller can find the unblock conditions.
 */
export function compViewMutationGate(): CompViewMutationGate {
  return () => ({
    allowed: false,
    reason:
      "comp-view pan/zoom is a mutate-gui class the A-SAFETY audit " +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "additionally the mouse-drag vehicle, the comp viewer's AX " +
      "fidelity and capture-diff semantics on a real host are all " +
      "unverified (spec §11)",
  });
}
