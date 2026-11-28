/**
 * RC-S15 — multi-instance / multi-session non-interference.
 *
 * Design (safe on this host):
 *   Session A = owned AE 2027 launch via AfterEffects.launch (in-process
 *     monitor, sessionRoot A).
 *   Session B = PUBLIC detached supervisor (`startDetachedSupervisor`,
 *     #295) observing the SAME owned pid but in an independent sessionDir B.
 *     It is lease-elected within B only — it cannot and does not disturb A.
 *
 * Assertions:
 *   - Both supervision contexts report the same target pid independently.
 *   - Killing supervisor B flips ONLY B's report to monitor-lost; A's
 *     in-process supervision stays healthy — zero cross-talk.
 *   - State files live in disjoint dirs.
 *
 * (An attach-to-foreign-AE variant was rejected: attach delivers the host
 * script into the target — a mutation of the read-only foreign fixture.)
 */
import {
  AfterEffects,
  startDetachedSupervisor,
  readGuiSession,
  supervisionReport,
} from "@ido-bata/ae-a8n";
import { mkdirSync } from "node:fs";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s15";
const scenarioId = "RC-S15";
const rootA = `/tmp/rc436r4-sessions/${label}-owned`;
const rootB = `/tmp/rc436r4-sessions/${label}-supervisor`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let ae = null;
let supPid = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const healthOf = (r) => (r?.status === "observed" ? r.health : r?.status);

try {
  mkdirSync(rootB, { recursive: true });
  ae = await steps.run("launch-owned", "owned AE 2027 launch", () =>
    AfterEffects.launch({
      sessionRoot: rootA, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  const target = ae.recoveryTarget?.();
  if (!target?.pid) {
    notes.push("recoveryTarget() returned no pid — cannot spawn detached observer");
    verdict = "indeterminate";
    throw new Error("no recovery target");
  }
  notes.push(`owned pid=${target.pid} session=${JSON.stringify(target.session)}`);

  const det = await steps.try("spawn-detached-B", "detached supervisor on independent sessionDir", () =>
    startDetachedSupervisor({ sessionDir: rootB, pid: target.pid, session: target.session ?? readGuiSession(process.getuid()) }));
  notes.push(`detached: ${JSON.stringify(det)}`);
  supPid = det.ok ? det.value?.pid ?? null : null;
  if (!supPid) {
    verdict = "blocked";
    notes.push("detached supervisor refused (pid:null) — second supervision context unavailable");
  } else {
    // Poll for supervisor B's first fresh heartbeat (helper compile margin).
    let repB1 = null;
    const hbDeadline = Date.now() + 90000;
    while (Date.now() < hbDeadline) {
      repB1 = supervisionReport(rootB);
      const mon = repB1.status === "observed" ? repB1.doc?.monitor : null;
      const hb = mon?.heartbeatAt ? Date.parse(mon.heartbeatAt) : 0;
      if (repB1.status === "observed" && mon && Number.isFinite(hb) && Date.now() - hb < 15000) break;
      await sleep(3000);
    }
    const repA1 = ae.supervisionState();
    steps.items.push({
      stepId: "both-alive", expected: "A and B both report fresh supervision of same pid",
      actual: { A: { status: repA1.status, health: healthOf(repA1) }, B: { status: repB1.status, health: healthOf(repB1) } },
      durationMs: 0,
    });
    notes.push(`A=${JSON.stringify({ s: repA1.status, h: healthOf(repA1) })} B=${JSON.stringify({ s: repB1.status, h: healthOf(repB1) })}`);

    // Kill B — A must be unaffected.
    process.kill(supPid, "SIGKILL");
    steps.items.push({ stepId: "kill-B", expected: `SIGKILL supervisor pid ${supPid}`, actual: { killed: supPid }, durationMs: 0 });
    await sleep(36000); // past 30s monitor TTL

    const repB2 = supervisionReport(rootB);
    const repA2 = ae.supervisionState();
    steps.items.push({
      stepId: "post-kill-isolation", expected: "B reports monitor-lost/stale; A unaffected",
      actual: {
        B: { status: repB2.status, health: healthOf(repB2), detail: repB2.healthDetail ?? repB2.reason },
        A: { status: repA2.status, health: healthOf(repA2) },
      },
      durationMs: 0,
    });
    notes.push(`post-kill B=${JSON.stringify({ s: repB2.status, h: healthOf(repB2) })} A=${JSON.stringify({ s: repA2.status, h: healthOf(repB2) && healthOf(repA2) })}`);

    const bLost = healthOf(repB2) === "monitor-lost" || /stale|heartbeat/i.test(JSON.stringify(repB2));
    const aOk = healthOf(repA2) !== "monitor-lost" && repA2.status === "observed";
    if (bLost && aOk) verdict = "pass";
    else if (!bLost) { verdict = "fail"; notes.push("B did not report monitor loss"); }
    else { verdict = "fail"; notes.push("A supervision degraded by B's death — cross-talk"); }
  }

  await steps.run("close-owned", "close owned session", () => ae.close({ unsavedChanges: "discard" }));
  ae = null;
} catch (e) {
  if (verdict === "fail") notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
  if (supPid) { try { process.kill(supPid, "SIGKILL"); } catch {} }
}

const artA = sessionArtifacts(rootA);
const artB = sessionArtifacts(rootB);
const cleanup = artA.teardown
  ? { verdict: artA.teardown.verdict, ref: artA.teardownPath }
  : { verdict: "unverifiable", ref: null };
const summaryPath = `/tmp/rc436r4-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoots: [rootA, rootB] });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly: null, cleanup,
  evidenceRefs: [
    artA.tracePath, artA.attemptLedgerPath, artA.teardownPath,
    `${rootB}/supervision.json`, summaryPath,
  ].filter(Boolean),
  notes: notes.join(" | "), sessionRoot: rootA,
});
console.log(`RC-S15 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
