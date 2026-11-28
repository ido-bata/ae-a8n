/**
 * RC-S5 — unknown/unmeasured modal → quarantined/A8N-SEC-class stop,
 * zero presses, structured evidence. Uses an extension ScriptUI dialog
 * that matches NO registered taxonomy class (no ae-a8n marker, custom
 * title/text) — the honest unknown case.
 */
import { AfterEffects, waitForSupervisionPhase, TERMINATE_PERMIT } from "@ido-bata/ae-a8n";
import { execFileSync } from "node:child_process";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s5";
const scenarioId = "RC-S5";
const sessionRoot = `/tmp/rc436r3-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r3-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;
let ownedPid = null;

function pidPath(pid) {
  try { return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8" }).trim(); }
  catch { return null; }
}

try {
  ae = await steps.run("launch+extension", "owned launch with rc436 extension", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 90000,
    }));

  const target = await steps.run("recoveryTarget", "owned pid attested", () => ae.recoveryTarget());
  ownedPid = target?.pid ?? null;

  const call = await steps.try(
    "unmarked-alert",
    "rc436.unmarkedAlert shows an unclassified modal; call times out unproven",
    () => ae.call("rc436.unmarkedAlert", {}, { timeoutMs: 30000 }),
  );
  notes.push(`unmarkedAlert call: ${call.ok ? "returned " + JSON.stringify(call.value) : call.error?.name}`);

  const sup = await steps.run("quarantine", "supervision reaches quarantined (bounded), zero presses", async () => {
    const out = await waitForSupervisionPhase({
      sessionDir: sessionRoot,
      phases: ["quarantined", "needs-human", "blocked", "resumed", "running"],
      timeoutMs: 120000, pollMs: 1000,
    });
    const rep = out.report?.status === "observed" ? out.report.doc : null;
    return {
      wait: out.status, phase: rep?.phase ?? null,
      blocking: rep?.blocking ?? null, evidence: rep?.evidence?.slice(0, 10) ?? null,
      nextActions: out.report?.nextActions?.slice(0, 5) ?? null,
    };
  });
  anomaly = "unknown-modal";

  // Pass = quarantined or needs-human reached; the window must never be pressed.
  if (sup?.phase === "quarantined" || sup?.phase === "needs-human") {
    verdict = "pass";
  } else {
    notes.push(`expected quarantined/needs-human, observed ${sup?.phase}`);
  }

  // Run-3: sanctioned terminate path (#340/#458) instead of a raw SIGKILL —
  // graceful first, permitted force second; provenance + supervision recorded.
  await steps.run("teardown-terminate-owned", "AfterEffects.terminate force on verified owned host (unclassified modal, no public dismissal)", async () => {
    const exe = ownedPid ? pidPath(ownedPid) : null;
    if (!exe || !exe.includes("After Effects 2027")) throw new Error(`refusing pid ${ownedPid}: ${exe}`);
    return AfterEffects.terminate({
      sessionRoot, installDir: AE_2027_INSTALL,
      permit: TERMINATE_PERMIT, force: true,
      gracefulTimeoutMs: 15000, deadlineMs: 60000,
    });
  });
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
const { aeCensus } = await import("./lib.mjs");
const leftover = aeCensus().filter((p) => p.executable.includes("2027"));
if (leftover.length > 0) cleanup.verdict = "residue";
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r3-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, ownedPid, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S5 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
