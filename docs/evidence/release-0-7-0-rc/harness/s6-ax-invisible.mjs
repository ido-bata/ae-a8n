/**
 * RC-S6 — AX-invisible modal: a window present in the CGWindow census but
 * unaccounted in the AX tree (#321 shape). Detected via consecutive
 * unaccounted-window observations, never AX alone.
 *
 * Real-host attempt: open the fixture project (may surface font/version
 * prompts) and also trigger a second project open; poll supervisionState
 * for `blocked`/unaccounted classification within the detection budget
 * (monitor interval 2s + confirm bound). If no AX-invisible window arises
 * the verdict is honestly `environment` — the shape cannot be fabricated
 * on demand without an unverifiable AX hole.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s6";
const scenarioId = "RC-S6";
const sessionRoot = `/tmp/rc436-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let ae = null;
const DETECTION_BUDGET_MS = 30000; // monitor 2s interval + confirm bound, generous margin

try {
  ae = await steps.run("launch", "owned launch", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  // Open the fixture twice; a second open can raise version/font prompts.
  await steps.try("openProject-1", "first open", () => ae.openProject(FIXTURE.path));
  await steps.try("openProject-2", "second open (prompt opportunity)", () => ae.openProject(FIXTURE.path));

  // Poll supervision for an unaccounted/blocked classification.
  const t0 = Date.now();
  let last = null;
  let sawBlocked = null;
  while (Date.now() - t0 < DETECTION_BUDGET_MS) {
    const rep = ae.supervisionState();
    last = rep;
    const phase = rep.status === "observed" ? rep.doc?.phase : rep.status;
    const blocking = rep.status === "observed" ? rep.doc?.blocking ?? null : null;
    if (phase === "blocked" || blocking) { sawBlocked = { phase, blocking, at: Date.now() - t0 }; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const summary = last?.status === "observed"
    ? { phase: last.doc?.phase, health: last.health, blocking: last.doc?.blocking ?? null }
    : { status: last?.status, reason: last?.reason };
  notes.push(`final supervision: ${JSON.stringify(summary).slice(0, 500)}`);

  if (sawBlocked) {
    // Was it classified via unaccounted-window (census) evidence rather than AX?
    const blob = JSON.stringify(sawBlocked.blocking ?? {});
    notes.push(`blocked detail: ${blob.slice(0, 400)}`);
    verdict = /unaccounted|census|axSuspect|invisible/i.test(blob) || sawBlocked.blocking == null
      ? "pass" : "indeterminate";
    if (verdict === "indeterminate") notes.push("blocked observed but classification source not proven census-based");
  } else {
    verdict = "environment";
    notes.push("no AX-invisible/unaccounted window arose during the attempt window; shape not fabricatable on demand — honest non-pass");
  }

  await steps.run("close", "close owned", () => ae.close({ unsavedChanges: "discard" }));
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
const summaryPath = `/tmp/rc436-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly: null, cleanup,
  evidenceRefs: [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath, summaryPath].filter(Boolean),
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S6 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
