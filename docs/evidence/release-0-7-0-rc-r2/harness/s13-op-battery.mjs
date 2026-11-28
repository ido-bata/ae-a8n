/**
 * RC-S13 — representative op battery with budgets.
 * One owned session; a fixed battery of public-path ops whose step
 * durationMs feed acceptance-metrics.js p50/p95 vs §6 budgets.
 * Ops chosen to cover: session facts, project/comp/layer reads, a
 * mutation-class render, evidence/recording surface presence.
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

const label = process.argv[2] ?? "s13";
const scenarioId = "RC-S13";
const sessionRoot = `/tmp/rc436r2-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let ae = null;

try {
  ae = await steps.run("launch", "owned launch", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  await steps.run("capabilities", "capabilities", async () => (await ae.capabilities()).availableCapabilities.length);
  await steps.run("version", "version", async () => ae.version());
  await steps.run("diagnostics", "diagnostics", async () => {
    const d = await ae.diagnostics?.();
    return d ? Object.keys(d).length : "no diagnostics api";
  });
  await steps.run("openProject", "open fixture", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });
  await steps.run("project-state", "project.state", async () => {
    const p = await ae.project();
    return p.state();
  });
  await steps.run("comp-list", "ae.comps", async () => (await ae.comps()).length);
  await steps.run("comp-get", "project.comp", async () => {
    const p = await ae.project();
    const c = await p.comp("A8N Acceptance");
    return c.name;
  });
  await steps.run("layers", "comp.layers", async () => {
    const p = await ae.project();
    const c = await p.comp("A8N Acceptance");
    const layers = await c.layers();
    return layers.length;
  });
  await steps.run("renderFrame", "renderFrame(1)", async () => {
    const p = await ae.project();
    const c = await p.comp("A8N Acceptance");
    return comp_render(c);
    async function comp_render(comp) { return comp.renderFrame(1, { prefix: `${label}-battery` }); }
  });
  await steps.run("supervision", "supervisionState", async () => {
    const r = ae.supervisionState();
    return r.status;
  });
  await steps.run("evidence-index", "artifacts dir listing", async () => {
    const { readdirSync } = await import("node:fs");
    return readdirSync(ae.artifactsDir).slice(0, 10);
  });

  await steps.run("close", "close owned", () => ae.close({ unsavedChanges: "discard" }));
  ae = null;
  verdict = "pass";
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
const summaryPath = `/tmp/rc436r2-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly: null, cleanup,
  evidenceRefs: [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath, summaryPath].filter(Boolean),
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S13 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
