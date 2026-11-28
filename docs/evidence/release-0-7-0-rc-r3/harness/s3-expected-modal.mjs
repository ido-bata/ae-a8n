/**
 * RC-S3 — expected modal registered via ae.expectModal, resolved through
 * the audited press path. Uses the auto-safe `ae-a8n ui.alert` class shown
 * by ae.showModalDialog; the expectation is registered so evidence names it.
 */
import { AfterEffects, waitForSupervisionPhase } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  Steps,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s3";
const scenarioId = "RC-S3";
const sessionRoot = `/tmp/rc436r3-sessions/${label}`;
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;
let unregister = null;

try {
  ae = await steps.run("launch", "owned launch", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 90000,
    }));

  await steps.run("register-expectation", "ae.expectModal registers the ae-a8n ui.alert modal", () => {
    unregister = ae.expectModal({
      name: "rc-s3-expected-ui-alert",
      matches: (w) =>
        (w.subrole ?? "").toLowerCase() === "axdialog" &&
        w.texts.some((t) => /^\s*ae-a8n:/u.test(t)),
      resolve: { kind: "press", button: "OK" },
    });
    return { registered: true };
  });

  // showModalDialog blocks inside AE until the dialog closes; the recovery
  // path presses OK through the audited GUI press. Bounded by timeoutMs.
  const dialog = await steps.run(
    "expected-modal-resolve",
    "showModalDialog's ui.alert is classified expected and pressed; call completes",
    () => ae.showModalDialog("rc436 expected-modal probe", { timeoutMs: 120000 }),
  );

  await steps.run("supervision-post", "supervision returns to running/resumed", async () => {
    const out = await waitForSupervisionPhase({
      sessionDir: sessionRoot,
      phases: ["running", "resumed"],
      timeoutMs: 30000, pollMs: 1000,
    });
    return { status: out.status, phase: out.report?.status === "observed" ? out.report.doc.phase : null };
  });

  await steps.run("close", "close owned", () => ae.close({ unsavedChanges: "discard" }));
  ae = null;
  verdict = "pass";
} catch (e) {
  verdict = "fail";
  anomaly = "unknown-modal";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
  try {
    if (ae) {
      const rep = ae.supervisionState();
      notes.push(`supervision: ${JSON.stringify(rep?.status === "observed" ? { phase: rep.doc.phase, blocking: rep.doc.blocking } : rep).slice(0, 500)}`);
    }
  } catch {}
} finally {
  try { unregister?.(); } catch {}
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null };
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r3-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S3 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
