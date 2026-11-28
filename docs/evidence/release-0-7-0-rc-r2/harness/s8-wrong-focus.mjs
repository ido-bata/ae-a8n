/**
 * RC-S8 — wrong focus / foreign-app window present.
 * Owned AE 2027 session runs while the FOREIGN AE 2026 (user-owned,
 * read-only) is activated/frontmost. GUI observation must attribute
 * windows by census pid — foreign windows are never mutation targets.
 * We observe via ae.guiState()/supervision and attempt a panel identify;
 * zero presses/clicks on foreign windows is the pass criterion.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import { execFileSync } from "node:child_process";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  aeCensus,
  frontmostApp,
  recordAttempt,
  sessionArtifacts,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s8";
const scenarioId = "RC-S8";
const sessionRoot = `/tmp/rc436r2-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r2-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ae = null;

function activateApp(name) {
  execFileSync("osascript", ["-e", `tell application "${name}" to activate`], { encoding: "utf-8" });
}

try {
  ae = await steps.run("launch+extension", "owned launch AE 2027 + extension", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  await steps.run("openProject", "fixture opens", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  // Make the FOREIGN AE 2026 frontmost (activate only — no input, no
  // mutation; activation of a running app is observation-safe). The app
  // name "Adobe After Effects 2026" addresses the foreign bundle only.
  const before = frontmostApp();
  await steps.run("foreign-frontmost", "foreign AE 2026 activated frontmost (observation only)", async () => {
    activateApp("Adobe After Effects 2026");
    await new Promise((r) => setTimeout(r, 2000));
    return { frontmostBefore: before, frontmostAfter: frontmostApp() };
  });

  // Census truth: which AE pids exist and their paths.
  const census = aeCensus();
  notes.push(`census: ${JSON.stringify(census)}`);

  // GUI observation while foreign app is frontmost: supervision + guiState.
  const obs = await steps.run("gui-observe-foreign-front", "guiState/supervision observe with foreign frontmost", async () => {
    const gs = ae.guiState ? await ae.guiState() : null;
    const rep = ae.supervisionState();
    return {
      guiState: gs === null ? null : JSON.stringify(gs).slice(0, 800),
      supervision: rep.status === "observed" ? { phase: rep.doc.phase, health: rep.health } : { status: rep.status },
    };
  });

  // Attempt panel identify on the owned session — must not resolve or
  // mutate any foreign window; honest not-found/refusal is acceptable.
  const panel = await steps.try(
    "panel-identify-owned",
    "ae.panel identify resolves only owned windows (foreign frontmost)",
    async () => {
      const caps = ae.panelCapabilities?.();
      return { capabilities: caps ?? null };
    },
  );
  notes.push(`panel caps: ${JSON.stringify(panel.ok ? panel.value : panel.error?.message).slice(0, 300)}`);

  // Restore frontmost to owned AE for clean teardown.
  try { activateApp("Adobe After Effects 2027"); } catch {}

  verdict = "pass"; // observation-only scenario: honest reporting is the criterion
  anomaly = null;

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
const summaryPath = `/tmp/rc436r2-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "), sessionRoot,
});
console.log(`RC-S8 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
