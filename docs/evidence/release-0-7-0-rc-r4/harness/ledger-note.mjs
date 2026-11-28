/**
 * Append a scenario-ledger attempt from a JSON spec file (run 4).
 *
 * For evidence produced outside the per-scenario harness scripts —
 * consumer smoke checks, dispatcher acceptance, manual observations —
 * this records an honest attempt row (spec §5.2) referencing the
 * artifacts. Usage:
 *
 *   node ledger-note.mjs <spec.json>
 *
 * spec.json: { scenarioId, verdict, steps?, anomaly?, recovery?, cleanup?,
 *              evidenceRefs?, notes?, sessionRoot? }
 */
import { readFileSync } from "node:fs";
import { recordAttempt } from "./lib.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const rec = recordAttempt({
  scenarioId: spec.scenarioId,
  verdict: spec.verdict,
  steps: spec.steps ?? [],
  anomaly: spec.anomaly ?? null,
  recovery: spec.recovery ?? null,
  cleanup: spec.cleanup ?? null,
  evidenceRefs: spec.evidenceRefs ?? [],
  notes: spec.notes ?? "",
  sessionRoot: spec.sessionRoot ?? null,
});
console.log(`ledgered ${rec.attemptId} ${spec.scenarioId} ${spec.verdict}`);
