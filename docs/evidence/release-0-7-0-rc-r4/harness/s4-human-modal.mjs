/**
 * RC-S4 — human-required modal (unsaved-changes save prompt).
 * An extension method dirties the project and calls
 * app.project.close(PROMPT_TO_SAVE_CHANGES): AE raises its native
 * save-changes dialog — a human-required class automation must never
 * press. Expected: supervision reaches needs-human (bounded), zero
 * presses on the window. The owned AE is then killed (verified pid) —
 * the dialog has no public dismissal path by design.
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

const label = process.argv[2] ?? "s4";
const scenarioId = "RC-S4";
const sessionRoot = `/tmp/rc436r4-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r4-consumer/ext/rc436-host.jsx";
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
  ae = await steps.run("launch+extension", "owned launch with rc436 extension host script", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 90000,
    }));

  await steps.run("extension-declared", "extension methods declared", () => ae.extensionMethods());

  const target = await steps.run("recoveryTarget", "owned pid attested", () => ae.recoveryTarget());
  ownedPid = target?.pid ?? null;

  // Fire the prompt; the call will time out behind the modal — that IS the
  // scenario. timeoutMs bounds the first wait; recovery classifies instead
  // of resending.
  const call = await steps.try(
    "prompt-save-call",
    "rc436.promptSave raises the native save prompt; call outcome unproven/timeout",
    () => ae.call("rc436.promptSave", {}, { timeoutMs: 30000 }),
  );
  notes.push(`promptSave call: ${call.ok ? "returned " + JSON.stringify(call.value) : call.error?.name + ": " + String(call.error?.message).slice(0, 200)}`);

  const sup = await steps.run("needs-human", "supervision reaches needs-human (bounded), never presses", async () => {
    const out = await waitForSupervisionPhase({
      sessionDir: sessionRoot,
      phases: ["needs-human", "quarantined", "blocked", "resumed", "running"],
      timeoutMs: 120000, pollMs: 1000,
    });
    const rep = out.report?.status === "observed" ? out.report.doc : null;
    return {
      wait: out.status,
      phase: rep?.phase ?? null,
      blocking: rep?.blocking ?? null,
      evidence: rep?.evidence?.slice(0, 8) ?? null,
    };
  });
  anomaly = sup?.blocking?.kind ?? sup?.blocking ?? "human-required-modal";

  // Verdict logic: needs-human (or quarantined) = pass; running/resumed
  // means the dialog was dismissed by something = fail.
  if (sup?.phase === "needs-human" || sup?.phase === "quarantined") {
    verdict = "pass";
  } else {
    notes.push(`expected needs-human/quarantined, observed ${sup?.phase}`);
  }

  // Cleanup: the modal cannot be dismissed through the public API (by
  // design). Run-3 uses the sanctioned terminate path (#340/#458):
  // graceful quit first (expected to be refused by the modal), then the
  // explicitly-permitted force kill — same SIGKILL semantics as run-2 but
  // through the audited public path with provenance + supervision record.
  await steps.run("teardown-terminate-owned", "AfterEffects.terminate force on verified owned host (modal has no public dismissal)", async () => {
    const exe = ownedPid ? pidPath(ownedPid) : null;
    if (!exe || !exe.includes("After Effects 2027")) {
      throw new Error(`refusing to signal pid ${ownedPid}: path ${exe}`);
    }
    return AfterEffects.terminate({
      sessionRoot, installDir: AE_2027_INSTALL,
      permit: TERMINATE_PERMIT, force: true,
      gracefulTimeoutMs: 15000, deadlineMs: 60000,
    });
  });
  ae = null; // session is dead; do not close()
} catch (e) {
  verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null, note: "session killed with host; teardown evaluated by harness below" };
// Harness-level teardown check: is any AE 2027 still alive?
const { aeCensus } = await import("./lib.mjs");
const census = aeCensus();
const leftover = census.filter((p) => p.executable.includes("2027"));
if (leftover.length > 0) {
  cleanup.verdict = cleanup.verdict === "clean" ? "residue" : cleanup.verdict;
  cleanup.note = (cleanup.note ?? "") + ` AE2027 still running: ${JSON.stringify(leftover)}`;
}
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r4-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, ownedPid, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S4 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
