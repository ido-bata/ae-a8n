/**
 * The A-SAFETY gate for Effect Controls mutations (#367,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Effect Controls fold/unfold and GUI parameter entry are `mutate-gui`
 * acts — clicks inside a re-verified pane frame plus, for value entry,
 * an authorized session-stream chord. The audit cleared exactly one GUI
 * mutation — the macOS `ae-a8n ui.alert` press — and the workspace spec
 * keeps every `mutate-gui` op behind the lease+audit+gate chain pending
 * A-SAFETY clearance. Until an effect-controls-mutation class is
 * cleared, every op refuses — fail-closed, with the refusal naming the
 * governing documents so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears an
 * effect-controls mutation class, the permit is added here — not
 * ad-hoc at call sites. The controller additionally refuses on its own
 * when no gate is wired at all, so constructing
 * `EffectControlsController` directly cannot bypass this policy by
 * omission.
 */

import type { EffectControlsMutationGate } from "./controller.js";

/**
 * The production mutation gate for Effect Controls ops. Always refuses
 * today; the reason cites the audit so a caller can find the unblock
 * conditions.
 */
export function effectControlsMutationGate(): EffectControlsMutationGate {
  return () => ({
    allowed: false,
    reason:
      "Effect Controls fold/parameter entry is a mutate-gui class the " +
      "A-SAFETY audit (docs/gui-supervision-safety-gates.md) has not " +
      "enabled and the workspace-editing spec (§13) keeps gated pending " +
      "that clearance; additionally the session-stream value-entry " +
      "vehicle (B-IME poster + focus proof + global-input authorization) " +
      "and real-host AX fidelity of the Effect Controls panel are all " +
      "unverified (spec §11)",
  });
}
