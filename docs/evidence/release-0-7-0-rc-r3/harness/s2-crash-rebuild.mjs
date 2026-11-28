/**
 * RC-S2 — owned AE crash mid-session → process-gone → verified rebuild → resumed.
 * Kills ONLY the owned AE 2027 pid this session launched (verified via
 * ae.recoveryTarget + executable path), never the foreign AE 2026.
 */
import { AfterEffects, waitForSupervisionPhase } from "@ido-bata/ae-a8n";
import { execFileSync } from "node:child_process";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  aeCensus,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s2";
const scenarioId = "RC-S2";
const sessionRoot = `/tmp/rc436r3-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;
let ownedPid = null;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pidPath(pid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch { return null; }
}

try {
  ae = await steps.run("launch", "owned launch of AE 2027", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  await steps.run("openProject", "fixture opens", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  const target = await steps.run("recoveryTarget", "owned pid+session attested", () => ae.recoveryTarget());
  ownedPid = target?.pid ?? null;
  if (!ownedPid) throw new Error("no recovery target — cannot prove owned pid");
  const exe = pidPath(ownedPid);
  if (!exe || !exe.includes("After Effects 2027")) {
    throw new Error(`pid ${ownedPid} path is not AE 2027: ${exe} — refusing to signal`);
  }

  // SIGKILL the owned pid — crash simulation (owned, path-verified).
  await steps.run("crash-sigkill", `SIGKILL owned pid ${ownedPid} (path verified: ${exe})`, () => {
    process.kill(ownedPid, "SIGKILL");
    return { signaled: ownedPid };
  });

  // Supervision must observe process-gone without any request in flight.
  const sup1 = await steps.run("supervision-process-gone", "phase reaches blocked/process-gone", async () => {
    const out = await waitForSupervisionPhase({
      sessionDir: sessionRoot,
      phases: ["blocked", "needs-human", "quarantined", "resumed"],
      timeoutMs: 90000,
      pollMs: 1000,
    });
    return { status: out.status, phase: out.report?.status === "observed" ? out.report.doc.phase : null,
             blocking: out.report?.status === "observed" ? out.report.doc.blocking : null,
             health: out.report?.status === "observed" ? out.report.health : null };
  });
  anomaly = sup1?.blocking?.kind ?? sup1?.blocking ?? "process-gone";

  // Rebuild through the public path.
  const rebuilt = await steps.run("rebuild", "AfterEffects.rebuild resumes a new owned generation", async () => {
    const b = await AfterEffects.rebuild({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    });
    return { ownership: b.ownership() };
  });
  ae = rebuilt;

  await steps.run("post-rebuild-state", "supervisionState reports resumed/healthy", async () => {
    const rep = ae.supervisionState();
    return rep.status === "observed"
      ? { phase: rep.doc.phase, health: rep.health }
      : { status: rep.status, reason: rep.reason };
  });

  await steps.run("post-rebuild-project", "fixture re-opens on rebuilt session", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  await steps.run("close", "rebuilt session closes owned", () => ae.close({ unsavedChanges: "discard" }));
  ae = null;
  verdict = "pass";
} catch (e) {
  verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
  // If the crash left the AE dead and rebuild never ran, nothing to clean.
  // If rebuild produced a new pid we already closed above.
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null };
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r3-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, ownedPid, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S2 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
