/**
 * RC-S14 — recording overhead (only when recording is in the candidate — it is).
 * ae.record.start/stop on the owned session; measure captureStats from the
 * gui-evidence index. Screen Recording TCC may deny → honest fail/blocked.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import { existsSync, readFileSync } from "node:fs";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s14";
const scenarioId = "RC-S14";
const sessionRoot = `/tmp/rc436r4-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;

try {
  ae = await steps.run("launch", "owned launch", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  await steps.run("openProject", "fixture opens", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  const rec = await steps.try("record-start", "ae.record.start opens a bounded segment", async () => {
    return await ae.record.start("screen", { maxDurationMs: 20000, fps: 30 });
  });
  notes.push(`record.start: ${rec.ok ? JSON.stringify(rec.value).slice(0, 300) : rec.error?.name + " " + String(rec.error?.message).slice(0, 250)}`);

  if (rec.ok) {
    // Concurrent mutate op while recording (overhead measurement).
    const t0 = Date.now();
    await steps.try("mutate-while-recording", "renderFrame during recording", async () => {
      const project = await ae.project();
      const comp = await project.comp("A8N Acceptance");
      return comp.renderFrame(1, { prefix: `${label}-rec-frame` });
    });
    const mutateMs = Date.now() - t0;
    notes.push(`mutate-while-recording wall: ${mutateMs}ms`);

    await steps.try("record-stop", "ae.record.stop finalizes the segment", async () => {
      return await ae.record.stop(rec.value?.id ?? rec.value?.segmentId ?? "seg-001");
    });
  }

  // Read the evidence index for captureStats.
  const idxPath = `${sessionRoot}/artifacts/evidence-index.json`;
  const stats = existsSync(idxPath)
    ? JSON.parse(readFileSync(idxPath, "utf-8")).segments?.map((s) => s.captureStats).filter(Boolean)
    : null;
  notes.push(`captureStats: ${JSON.stringify(stats).slice(0, 500)}`);

  if (rec.ok) verdict = "pass";
  else verdict = rec.error?.name === "RecordingError" || /permission|denied|screen/i.test(String(rec.error?.message)) ? "blocked" : "fail";

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
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath, idxPathSafe(sessionRoot)].filter(Boolean);
function idxPathSafe(root) { return `${root}/artifacts/evidence-index.json`; }
const summaryPath = `/tmp/rc436r4-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S14 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
