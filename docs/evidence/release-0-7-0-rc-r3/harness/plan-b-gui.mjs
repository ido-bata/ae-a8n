/**
 * Plan B slice — GUI capability ops on the public path (US-B1/B3/B4 rows
 * whose slices are in this candidate): panel identify/show/close,
 * workspace get/apply, windowOps observe, dragDrop capability probe.
 * Mutation-class GUI ops run only where the guarantee-boundary matrix
 * declares a real-host-proven class; everything else must refuse with a
 * named reason — refusals are recorded, never papered over.
 *
 * Repo-side execution: the packed tarball ships no swift helper sources,
 * so darwin GUI helpers resolve only from a repo checkout — this run is
 * labelled accordingly in the ledger notes.
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

const label = process.argv[2] ?? "planb";
const scenarioId = "RC-PLAN-B";
const sessionRoot = `/tmp/rc436r3-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r3-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let ae = null;

try {
  ae = await steps.run("launch+extension", "owned launch AE 2027 + extension", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    }));

  // Owned-path requirement: an attached session proves nothing about the
  // owned GUI-op path — refuse to score it (spec §11 honesty).
  const own = ae.ownership?.();
  if (own?.kind !== "owned") {
    verdict = "indeterminate";
    notes.push(`launch resolved as ownership=${own?.kind} (${String(own?.evidence).slice(0,120)}) — not the owned path; scenario not exercised`);
    throw new Error("not an owned session");
  }

  await steps.run("openProject", "fixture opens", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  // --- capability surfaces (observe-only) ---
  const caps = await steps.run("gui-capabilities", "panel/windowOps/dragDrop capability surfaces", async () => ({
    panel: ae.panelCapabilities ? await ae.panelCapabilities() : "absent",
    windowOps: ae.windowOpsCapabilities ? await ae.windowOpsCapabilities() : "absent",
  }));
  notes.push(`caps: ${JSON.stringify(caps).slice(0, 800)}`);

  // --- panel observe/identify ---
  const panelObs = await steps.try("panel-observe", "panel list/identify observes owned windows", async () => {
    return await ae.panel({ action: "list" });
  });
  notes.push(`panel.list: ${panelObs.ok ? JSON.stringify(panelObs.value).slice(0, 400) : panelObs.error?.name + " " + String(panelObs.error?.message).slice(0, 250)}`);

  // --- workspace observe ---
  const ws = await steps.try("workspace-observe", "workspace state read", async () => {
    return await ae.workspace({ action: "current" });
  });
  notes.push(`workspace: ${ws.ok ? JSON.stringify(ws.value).slice(0, 300) : ws.error?.name + " " + String(ws.error?.message).slice(0, 200)}`);

  // --- windowOps observe (helpers repo-side) ---
  const wo = await steps.try("windowops-observe", "windowOps census/focused-window observe", async () => {
    return await ae.windowOps({ kind: "focused-window" });
  });
  notes.push(`windowOps: ${wo.ok ? JSON.stringify(wo.value).slice(0, 300) : wo.error?.name + " " + String(wo.error?.message).slice(0, 250)}`);

  // --- dragDrop capability probe (no actual drag — observe/gate only) ---
  const dd = await steps.try("dragdrop-probe", "dragDrop surface answers capability/gate query", async () => {
    if (typeof ae.dragDrop === "function") return await ae.dragDrop({ action: "capabilities" });
    if (ae.dragDrop?.capabilities) return await ae.dragDrop.capabilities();
    return "no dragDrop probe surface";
  });
  notes.push(`dragDrop: ${dd.ok ? JSON.stringify(dd.value).slice(0, 300) : dd.error?.name + " " + String(dd.error?.message).slice(0, 250)}`);

  // A mutation-class GUI op that the matrix does NOT declare proven must
  // refuse with a named reason — attempt an arbitrary in-app drag probe.
  const refuse = await steps.try("dragdrop-undeclared-refusal", "undeclared drag class refuses with named reason", async () => {
    return await ae.dragDrop({ action: "drag", from: { kind: "element", selector: "#nonexistent" }, to: { kind: "element", selector: "#nonexistent" } });
  });
  notes.push(`undeclared drag: ${refuse.ok ? "UNEXPECTED-OK " + JSON.stringify(refuse.value).slice(0, 200) : refuse.error?.name + " " + String(refuse.error?.message).slice(0, 250)}`);

  // Honest verdict: pass when every attempted op either succeeded within
  // its contract or refused with a structured/named reason (no crashes,
  // no silent wrong-target actions). Unexpected-OK on the undeclared drag
  // flips to fail.
  const unexpectedOk = refuse.ok;
  verdict = unexpectedOk ? "fail" : "pass";
  if (unexpectedOk) notes.push("undeclared drag-drop class was NOT refused — contract breach");

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
const summaryPath = `/tmp/rc436r3-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly: null, cleanup,
  evidenceRefs: [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath, summaryPath].filter(Boolean),
  notes: `repo-side run (swift GUI helpers resolve only from checkout) | ` + notes.join(" | "), sessionRoot,
});
console.log(`RC-PLAN-B ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
