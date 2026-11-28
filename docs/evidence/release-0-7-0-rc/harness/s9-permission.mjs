/**
 * RC-S9 — permission denial (TCC/OS consent absent or revoked).
 *
 * Honest constraint: this shared host HAS the needed grants (Accessibility
 * for CGEvent/AX paths was exercised by earlier scenarios). Revoking TCC
 * non-destructively mid-run is not possible from the public API and would
 * endanger the foreign AE session. What CAN be verified on the public path:
 *
 *   1. The capability/permission surface reports grant state honestly
 *      (ae.capabilities / supervision facts name permission gaps).
 *   2. Any op that would need a missing grant refuses with a STRUCTURED
 *      reason — never a silent weaker path. We probe the most
 *      permission-sensitive available op (window census via windowOps
 *      observe) and record the actual outcome.
 *   3. Screen Recording denial is exercised for real by RC-S14
 *      (ae.record) — cross-referenced, not duplicated.
 *
 * Verdict rules: `pass` only if a real denial was observed AND handled
 * structurally; `blocked` when grants are present and denial cannot be
 * induced without host-level TCC surgery (documented, never faked).
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s9";
const scenarioId = "RC-S9";
const sessionRoot = `/tmp/rc436-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "blocked";
let ae = null;

try {
  ae = await steps.run("launch", "owned launch", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  const caps = await steps.run("capabilities", "capability surface", async () => {
    const hs = await ae.capabilities();
    return {
      ownership: hs.target.ownership,
      caps: hs.availableCapabilities.length,
      names: hs.availableCapabilities.map((c) => c.name ?? c).slice(0, 40),
    };
  });
  notes.push(`caps: ${JSON.stringify(caps).slice(0, 600)}`);

  // Probe the permission-sensitive observe path; record structured outcome.
  const probe = await steps.try("windowOps-observe", "windowOps observe returns data or structured refusal", async () => {
    return await ae.windowOps({ kind: "focused-window" });
  });
  notes.push(`windowOps probe: ${probe.ok ? "ok " + JSON.stringify(probe.value).slice(0, 300) : probe.error?.name + " " + String(probe.error?.message).slice(0, 250)}`);

  const rep = ae.supervisionState();
  notes.push(`supervision: ${JSON.stringify(rep.status === "observed" ? { phase: rep.doc?.phase, health: rep.health } : rep).slice(0, 300)}`);

  // Grants are present on this host → denial cannot be induced publicly.
  notes.push("TCC grants present on shared host; denial not inducible via public API without destructive tccutil reset — recorded blocked per spec §11, cross-ref RC-S14 for Screen Recording denial");
  verdict = "blocked";

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
console.log(`RC-S9 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
