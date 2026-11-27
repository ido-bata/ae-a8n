/**
 * The A-SAFETY gate for workspace mutations (#363,
 * `docs/gui-supervision-safety-gates.md` +
 * `specs/workspace-editing/spec.md` §13).
 *
 * Workspace switch (menu invoke), panel arrange (drag) and window move
 * are all `mutate-gui` classes. The audit cleared exactly one GUI
 * mutation — the macOS `ae-a8n ui.alert` press — and the workspace spec
 * keeps every `mutate-gui` op behind the lease+audit+gate chain pending
 * A-SAFETY clearance. Until a workspace mutation class is cleared,
 * every op refuses — fail-closed, with the refusal naming the governing
 * documents so the reason is traceable.
 *
 * This function is the single flip point: when the audit clears a
 * workspace mutation class, the permit is added here — not ad-hoc at
 * call sites. The controller additionally refuses on its own when no
 * gate is wired at all, so constructing `WorkspaceController` directly
 * cannot bypass this policy by omission. The observe surface
 * (`observe`, `listWorkspaces`, `verifyRestore`) is gate-independent by
 * design.
 */

import type { WorkspaceMutationGate } from "./types.js";

/**
 * The production mutation gate for `ae.workspace()`. Always refuses
 * today; the reason cites the audit so a caller can find the unblock
 * conditions.
 */
export function workspaceMutationGate(): WorkspaceMutationGate {
  return () => ({
    allowed: false,
    reason:
      "workspace switch/arrange is a mutate-gui class the A-SAFETY audit " +
      "(docs/gui-supervision-safety-gates.md) has not enabled and the " +
      "workspace-editing spec (§13) keeps gated pending that clearance; " +
      "no real-host run has yet proven AE menu checkmarks, CGEvent drags " +
      "or workspace XML write timing either — observe, listWorkspaces and " +
      "verifyRestore remain available",
  });
}
