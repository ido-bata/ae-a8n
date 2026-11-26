/**
 * The A-SAFETY gate for panel mutations (#343,
 * `docs/gui-supervision-safety-gates.md` §「mutation 有効化の判定」).
 *
 * The audit's verdict for this slice: panel `resize`/`restore` is a
 * `mutate-gui` class that is **not enabled**. The only GUI mutation the
 * audit cleared is the macOS `ae-a8n ui.alert` press; there is no
 * auto-safe panel class, and no real-host run has yet proven that an
 * After Effects panel honors the resize vehicle (`set size` via System
 * Events). Until both change, every panel mutation refuses — fail-closed,
 * with the refusal naming this document so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears a
 * panel mutation class, the permit is added here — not ad-hoc at call
 * sites. The controller additionally refuses on its own when no gate is
 * wired at all, so constructing `PanelController` directly cannot bypass
 * this policy by omission.
 */

import type { PanelMutationGate } from "./controller.js";

/**
 * The production mutation gate for `ae.panel()`. Always refuses today;
 * the reason cites the audit so a caller can find the unblock conditions.
 */
export function panelMutationGate(): PanelMutationGate {
  return () => ({
    allowed: false,
    reason:
      "panel resize/restore is a mutate-gui class the A-SAFETY audit " +
      "(docs/gui-supervision-safety-gates.md) has not enabled: no panel " +
      "mutation is in the auto-safe set and real-host verification that " +
      "After Effects panels honor the resize vehicle is still outstanding",
  });
}
