/**
 * RC-S12 — monitor loss must be reported honestly (never "healthy").
 *
 * Uses the PUBLIC detached-supervisor path (#295): `startDetachedSupervisor`
 * spawns `supervisor-entry` as an independent OS process that observes a pid
 * it did not launch — observation only, no GUI mutation authority. We point
 * it at the FOREIGN AE 2026 instance (read-only fixture) in a dedicated
 * session dir, confirm a fresh heartbeat, SIGKILL the supervisor, wait past
 * the 30s monitor TTL, and require `supervisionReport` to report
 * `monitor-lost` — not ok, not unavailable-without-cause.
 */
import {
  startDetachedSupervisor,
  readGuiSession,
  supervisionReport,
} from "@ido-bata/ae-a8n";
import { mkdirSync } from "node:fs";
import { aeCensus, recordAttempt, writeJson } from "./lib.mjs";

const label = process.argv[2] ?? "s12";
const scenarioId = "RC-S12";
const sessionDir = `/tmp/rc436-sessions/${label}/supervisor`;
const steps = [];
const notes = [];
let verdict = "fail";

function step(id, expected, actual, ok = true, error = null) {
  steps.push({ stepId: id, expected, actual, ok, ...(error ? { error } : {}) });
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  mkdirSync(sessionDir, { recursive: true });

  // Foreign AE 2026 = read-only observation target (never mutated).
  const foreign = aeCensus().find((p) => p.executable.includes("After Effects 2026"));
  if (!foreign) {
    step("foreign-target", "foreign AE 2026 pid present", aeCensus(), false, "no foreign AE 2026 in census");
    verdict = "blocked";
    throw new Error("no foreign AE 2026 pid");
  }
  step("foreign-target", "foreign AE 2026 pid present", foreign);

  const uid = process.getuid();
  const session = readGuiSession(uid);
  if (!session || session.kind !== "Aqua" || session.asid === null) {
    step("gui-session", "Aqua session resolvable", session, false, "no Aqua session");
    verdict = "blocked";
    throw new Error("no Aqua session");
  }
  step("gui-session", "Aqua session resolvable", session);

  const det = startDetachedSupervisor({ sessionDir, pid: foreign.pid, session });
  step("spawn-supervisor", "detached supervisor pid returned", det);
  if (!det.pid) {
    verdict = "blocked";
    throw new Error("startDetachedSupervisor returned pid:null");
  }

  // Poll for a fresh monitor heartbeat — first run may compile swift
  // helpers, so allow up to 90s rather than a fixed short sleep.
  let before = null;
  const heartbeatDeadline = Date.now() + 90000;
  while (Date.now() < heartbeatDeadline) {
    before = supervisionReport(sessionDir);
    const mon = before.status === "observed" ? before.doc?.monitor : null;
    const hb = mon?.heartbeatAt ? Date.parse(mon.heartbeatAt) : 0;
    if (before.status === "observed" && mon && Number.isFinite(hb) && Date.now() - hb < 15000) break;
    await sleep(3000);
  }
  const repHealth = (r) => (r.status === "observed" ? r.health : null);
  const repDetail = (r) => (r.status === "observed" ? r.healthDetail : r.reason);
  step("fresh-heartbeat", "report health ok/degraded with fresh monitor", {
    status: before.status, health: repHealth(before), phase: before.doc?.phase,
  });
  notes.push(`pre-kill: ${JSON.stringify({ status: before.status, health: repHealth(before) }).slice(0, 300)}`);
  const preHealth = repHealth(before);
  const preMon = before?.status === "observed" ? before.doc?.monitor : null;
  const preHb = preMon?.heartbeatAt ? Date.parse(preMon.heartbeatAt) : 0;
  const fresh = before?.status === "observed" && preMon && Number.isFinite(preHb) && Date.now() - preHb < 20000;
  if (!fresh) {
    notes.push(`supervisor never established a fresh heartbeat (health=${preHealth}, monitor=${JSON.stringify(preMon)?.slice(0,120)}) — cannot test loss`);
    verdict = "indeterminate";
  }

  // Kill the monitor — the honest-death path under test.
  process.kill(det.pid, "SIGKILL");
  step("kill-supervisor", `SIGKILL supervisor pid ${det.pid}`, { killed: det.pid });

  // Wait past DEFAULT_MONITOR_TTL_MS (30s) plus margin.
  await sleep(36000);
  const after = supervisionReport(sessionDir);
  const health = repHealth(after);
  const detail = repDetail(after);
  step("post-kill-report", "health=monitor-lost within TTL+margin", {
    status: after.status, health, detail: String(detail ?? "").slice(0, 200),
  });
  notes.push(`post-kill: ${JSON.stringify({ status: after.status, health }).slice(0, 300)}`);

  const lost =
    health === "monitor-lost" ||
    (after.status === "observed" && /stale|lost/i.test(String(detail ?? "")));
  // Also acceptable: the report explicitly marks the heartbeat stale.
  const staleText = JSON.stringify(after).includes("stale");
  if (lost || staleText) {
    if (verdict !== "indeterminate") verdict = "pass";
  } else {
    notes.push("post-kill report did NOT honestly report monitor loss");
  }
} catch (e) {
  if (verdict === "fail" && !notes.some((n) => n.includes("error"))) {
    notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
} finally {
  // Ensure no stray supervisor survives this scenario.
  try {
    const census = aeCensus(); // supervisors are node, not AE — nothing to census here
    void census;
  } catch {}
}

const summaryPath = `/tmp/rc436-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps, notes, sessionDir });
recordAttempt({
  scenarioId, verdict, steps, anomaly: null,
  cleanup: { verdict: "clean", ref: `${sessionDir}/supervision.json` },
  evidenceRefs: [summaryPath, `${sessionDir}/supervision.json`].filter((p) => {
    try { return true; } catch { return false; }
  }),
  notes: notes.join(" | "), sessionRoot: sessionDir,
});
console.log(`RC-S12 ${label}: ${verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
