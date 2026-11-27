/**
 * The A-SAFETY gate for panel mutations (#343,
 * `docs/gui-supervision-safety-gates.md` §「mutation 有効化の判定」).
 *
 * The audit's verdict for this slice: panel `resize`/`restore` is a
 * `mutate-gui` class that is **not enabled**. The only GUI mutation the
 * audit cleared is the macOS `ae-a8n ui.alert` press; there is no
 * auto-safe panel class. The real-host vehicle question is now
 * answered (issue #357, `docs/evidence/realhost-2026-11-27/`): the
 * System Events `set size` vehicle times out on AE and the AX window
 * enumeration is empty until the app has been frontmost, while the
 * direct `AXUIElementSetAttributeValue` vehicle (the window-ops
 * helper's `act` path, and `AXFocusedWindow` for the focused window)
 * resized/moved/restored a real ScriptUI palette with census +
 * in-AE readback agreement. That evidence goes to the A-SAFETY review
 * for a class decision — it does not flip this gate by itself. Until
 * the audit clears a panel mutation class, every panel mutation
 * refuses — fail-closed, with the refusal naming this document so the
 * reason is traceable.
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
      "mutation is in the auto-safe set. The real-host vehicle question " +
      "is answered (#357 evidence, realhost-2026-11-27): System Events " +
      "`set size` times out on AE while the direct AXUIElement vehicle " +
      "works — the remaining step is the A-SAFETY class decision and " +
      "spec revision tracked by #358, not more vehicle proof",
  });
}
