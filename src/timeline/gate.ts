/**
 * The A-SAFETY gate for timeline mutations (#364,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §5/§13).
 *
 * Timeline scrub, row selection and keyframe navigation are all
 * `mutate-gui` acts delivered as real mouse input. The audit cleared
 * exactly one GUI mutation — the macOS `ae-a8n ui.alert` press — and the
 * workspace spec keeps every `mutate-gui` op behind the lease+audit+gate
 * chain pending A-SAFETY clearance. Until a timeline-mutation class is
 * cleared, every op refuses — fail-closed, with the refusal naming the
 * governing documents so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears a
 * timeline mutation class, the permit is added here — not ad-hoc at call
 * sites. The controller additionally refuses on its own when no gate is
 * wired at all, so constructing `TimelineController` directly cannot
 * bypass this policy by omission. The observe surface (pane rows, DOM
 * readback) is gate-independent by design.
 */

import type { TimelineMutationGate } from "./controller.js";

/**
 * The production mutation gate for timeline ops. Always refuses today;
 * the reason cites the audit so a caller can find the unblock conditions.
 */
export function timelineMutationGate(): TimelineMutationGate {
  return () => ({
    allowed: false,
    reason:
      "timeline scrub/selection/keyframe navigation is a mutate-gui class " +
      "the A-SAFETY audit (docs/gui-supervision-safety-gates.md) has not " +
      "enabled and the workspace-editing spec (§13) keeps gated pending " +
      "that clearance; additionally the B-IME mouse-drag vehicle and " +
      "real-host proof that comp.time tracks a GUI scrub are still " +
      "outstanding (spec §11)",
  });
}
