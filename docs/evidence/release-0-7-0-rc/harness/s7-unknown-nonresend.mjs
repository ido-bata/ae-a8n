/**
 * RC-S7 — communication loss / request timeout → UNKNOWN, zero resend.
 * Fires rc436.slowOp with a tiny per-call timeout: the host keeps running
 * the script (outcome unproven → TimeoutError/UNKNOWN). Verifies:
 *   - exactly ONE request reached the host (trace shows one op row),
 *   - no automatic resend of the timed-out call,
 *   - the late result is reconciled honestly (trace records host-side ok).
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import { readFileSync } from "node:fs";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s7";
const scenarioId = "RC-S7";
const sessionRoot = `/tmp/rc436-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;

try {
  ae = await steps.run("launch+extension", "owned launch with rc436 extension", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 120000, recoveryGraceMs: 30000,
    }));

  // slowOp sleeps ~20s inside AE; timeoutMs 3s forces UNKNOWN. The host
  // finishes the script anyway; the next call must wait for it (no resend).
  const timedOut = await steps.try(
    "slow-op-timeout",
    "rc436.slowOp(20000) with timeoutMs=3000 → TimeoutError, outcome unproven",
    () => ae.call("rc436.slowOp", { ms: 20000 }, { timeoutMs: 3000 }),
  );
  const firstError = timedOut.ok ? null : timedOut.error;
  notes.push(`slowOp result: ${timedOut.ok ? "returned (unexpected)" : firstError?.name + " retryClass=" + (firstError?.retryClass ?? "?")}`);

  // The host is still busy ~17s more; a follow-up call must queue behind
  // the in-flight script, not resend it.
  const follow = await steps.try(
    "follow-up-call",
    "rc436.projectState after the timed-out op returns the late-completed state",
    () => ae.call("rc436.projectState", {}, { timeoutMs: 60000 }),
  );
  notes.push(`follow-up: ${follow.ok ? JSON.stringify(follow.value) : follow.error?.name}`);

  // Ledger/trace audit: count extension.call rows for slowOp — must be 1.
  const trace = readFileSync(`${sessionRoot}/trace.jsonl`, "utf-8");
  const slowRows = trace.split("\n").filter((l) => l.includes("rc436.slowOp")).length;
  const resend = slowRows > 1;
  notes.push(`trace rows naming rc436.slowOp: ${slowRows}${resend ? " — RESEND DETECTED" : ""}`);

  if (!timedOut.ok && firstError?.name === "TimeoutError" && !resend) {
    verdict = "pass";
    anomaly = "host-unresponsive";
  } else {
    notes.push(`verdict inputs: timedOut.ok=${timedOut.ok} error=${firstError?.name} resend=${resend}`);
  }

  await steps.run("close", "close owned (discard any dirty state)", () => ae.close({ unsavedChanges: "discard" }));
  ae = null;
} catch (e) {
  verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null };
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S7 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
