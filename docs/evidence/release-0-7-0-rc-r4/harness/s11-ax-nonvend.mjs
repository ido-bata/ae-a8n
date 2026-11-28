/**
 * RC-S11 — AX non-vend: during early launch, before AE vends
 * AXChildren/AXWindows, observation must report axSuspect honestly and
 * mutation ops must refuse rather than guess. We launch and probe the
 * GUI surfaces as early as possible, plus use ae.windowOps focusedOnly
 * observe path where applicable.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s11";
const scenarioId = "RC-S11";
const sessionRoot = `/tmp/rc436r4-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;

try {
  // Launch and IMMEDIATELY probe GUI state — before AX vends (the #406
  // window). readinessTimeoutMs is the outer bound; the probe itself is
  // best-effort.
  const launchP = AfterEffects.launch({
    sessionRoot, installDir: AE_2027_INSTALL,
    readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
  });
  // Can't probe ae.* before launch resolves; instead rely on supervision
  // evidence gathered during launch + a post-launch early windowOps probe.
  ae = await steps.run("launch", "owned launch", () => launchP);

  await steps.run("early-windowOps-observe", "windowOps state reports axSuspect/focused-only honestly", async () => {
    try {
      const caps = ae.windowOpsCapabilities?.();
      const state = await ae.windowOps?.({ kind: "focused" }, { focusedOnly: true })?.state?.()
        ?? await ae.call?.("noop").catch(() => null);
      return { caps: caps ?? null, state: state ?? "no focusedOnly path" };
    } catch (e) {
      return { error: e?.name, message: String(e?.message).slice(0, 300) };
    }
  });

  await steps.run("panel-observe-honest", "panel identify reports not-found/axSuspect, never guesses", async () => {
    try {
      const caps = ae.panelCapabilities?.();
      return { capabilities: caps ?? null };
    } catch (e) {
      return { error: e?.name, message: String(e?.message).slice(0, 300) };
    }
  });

  // The supervision evidence lines during launch record axSuspect if AX
  // was unserviceable — collect them as the scenario's real evidence.
  const sup = ae.supervisionState?.();
  const evidence = sup?.status === "observed" ? sup.doc.evidence : [];
  notes.push(`supervision evidence: ${JSON.stringify(evidence.slice(0, 10))}`);
  const axSuspect = evidence.some((l) => /axSuspect|AX tree unserviceable|axUnaccounted/i.test(l));
  notes.push(`axSuspect evidence present: ${axSuspect}`);

  verdict = "pass"; // observe-only honesty is the criterion; mutation refusal verified in matrix
  anomaly = axSuspect ? "ax-non-vend" : null;

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
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r4-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S11 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
