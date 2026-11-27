/**
 * Operation retry classification (#342, parent program #337 US-A2).
 *
 * Before the standard path decides what may happen after an uncertain
 * outcome, the operation's side-effect class is fixed — recorded in the
 * trace and the recovery evidence, and the contract downstream consumers
 * (ae-test, ae-devtools) branch on:
 *
 *   - `read-only` — the method only observes. Re-issuing it cannot
 *     duplicate a side effect, so a bounded re-check is always safe.
 *   - `verified-retry` — re-execution is certified to reach the same end
 *     state. Reserved: membership requires recorded idempotency evidence
 *     (a real-host observation or a contract proof), exactly like dialog
 *     tiers. No built-in method holds it today.
 *   - `unknown-side-effect` — the default. The outcome may be unproven;
 *     the request is NEVER resent while its execution is uncertain, and
 *     only a provably-not-sent delivery (`ScriptNotSentError`) may be
 *     retried — by the caller, never automatically.
 *
 * The classification is evidence-driven and conservative: a method not
 * listed as read-only is `unknown-side-effect`, and extension methods
 * (dispatched by name through `extension.call`) always land there.
 */

export type OperationRetryClass = "read-only" | "verified-retry" | "unknown-side-effect";

/**
 * Built-in host methods that only read state (`host/a8n-host.js`
 * dispatch table). Anything not listed — including every extension
 * method — is `unknown-side-effect`.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "app.info",
  "project.info",
  "project.items",
  "project.comps",
  "comp.info",
  "comp.layers",
  "comp.layer",
  "layer.effects",
  "layer.shapePaths",
  "layer.transform",
  "effect.parameters",
  "effect.getParameter",
  "menu.find",
]);

/**
 * Methods with recorded idempotency evidence. Empty today: no built-in
 * operation has the real-host proof the `verified-retry` class requires.
 * Add a method here only with the evidence recorded, same rule as
 * `DIALOG_TAXONOMY` tiers.
 */
const VERIFIED_RETRY_METHODS: ReadonlySet<string> = new Set();

/** The retry class of a dispatched method. Pure; never throws. */
export function classifyOperationRetry(method: string): OperationRetryClass {
  if (READ_ONLY_METHODS.has(method)) {
    return "read-only";
  }
  if (VERIFIED_RETRY_METHODS.has(method)) {
    return "verified-retry";
  }
  return "unknown-side-effect";
}
