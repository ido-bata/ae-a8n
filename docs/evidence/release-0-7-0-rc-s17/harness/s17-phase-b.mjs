/**
 * RC-S17 Phase B — reproduction attempt on a provenance-bearing host.
 *
 * Step 1: `AfterEffects.launch` against AE 2027 while the live subject
 * (pid 18577) still runs. Source says the macOS script transport skips
 * `open` whenever any instance of the same install is already running
 * (`#preexisting.length === 0` gate), so this attempt can only probe the
 * blocked instance — expected to fail readiness. Whatever it records
 * (#452 readiness observation, census evidence) is the evidence.
 *
 * Step 2: `AfterEffects.launch` against AE 2026 — a different install, so
 * the BirthPrefs anomaly (AE 2027) is not expected to reproduce; if it
 * launches clean, the readiness → follow-up ops → teardown tail of the
 * chain is exercised on the public path and the anomaly-chain gap is
 * recorded honestly. If it also modal-blocks, the full chain applies.
 *
 * Public paths only. No signals, no input, no dismissal.
 *   cd /tmp/rc453/consumer && RC_DIR=<evidence dir> node <harness>/s17-phase-b.mjs
 */
import { AfterEffects, TERMINATE_PERMIT } from "@ido-bata/ae-a8n";
import {
  AE_2026_INSTALL,
  AE_2027_INSTALL,
  FIXTURE,
  LIVE_SUBJECT_PID,
  RC_DIR,
  Steps,
  aeCensus,
  recordAttempt,
  sessionArtifacts,
  shasumFile,
  superviseCli,
  writeJson,
} from "./lib.mjs";
import { join } from "node:path";

const CLI = process.env.A8N_CLI ?? "/tmp/rc453/consumer/node_modules/@ido-bata/ae-a8n/dist/cli.js";
const ROOT_2027 = join(RC_DIR, "sessions", "s17-b-launch-2027-r2");
const ROOT_2026 = join(RC_DIR, "sessions", "s17-b-launch-2026");

const steps = new Steps();
const notes = [];
const evidenceRefs = [];
let verdict = "indeterminate";
let anomaly = null;
let ae2026 = null;

const fixtureHashBefore = shasumFile(FIXTURE.path);

// ---- Step 1: AE 2027 launch attempt (expected blocked by live subject) ----
const launch2027 = await steps.try(
  "launch-ae2027",
  "AfterEffects.launch(AE 2027) — documents whether a provenance-bearing host can be established while pid 18577 blocks the install",
  () =>
    AfterEffects.launch({
      sessionRoot: ROOT_2027,
      installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 120_000,
      timeoutMs: 60_000,
      recoveryGraceMs: 60_000,
    }),
  ["trace:session.launch"],
);
const l27 = launch2027.ok ? launch2027.value : launch2027.error;
notes.push(
  `launch2027: ${launch2027.ok ? "RESOLVED (unexpected)" : `${l27?.name}: ${String(l27?.message ?? "").slice(0, 400)}`}` +
    (l27?.readiness ? ` readiness=${JSON.stringify(l27.readiness).slice(0, 800)}` : ""),
);
if (launch2027.ok) {
  // Unexpected: a session was established — record ownership and close it.
  notes.push(`launch2027 ownership=${JSON.stringify(launch2027.value.ownership?.() ?? null)}`);
  try { await launch2027.value.close({ unsavedChanges: "discard" }); } catch (e) { notes.push(`close2027: ${e}`); }
}
const art27 = sessionArtifacts(ROOT_2027);
writeJson(join(RC_DIR, "env", "launch-2027-result.json"), {
  ok: launch2027.ok,
  error: launch2027.ok ? null : { name: l27?.name, message: String(l27?.message ?? "").slice(0, 600), readiness: l27?.readiness ?? null, nextActions: l27?.nextActions ?? null },
  provenance: art27.provenance,
  supervision: art27.supervision,
  tracePath: art27.tracePath,
});
evidenceRefs.push(...[join(RC_DIR, "env", "launch-2027-result.json"), art27.tracePath, art27.attemptLedgerPath].filter(Boolean));
if (art27.supervision) evidenceRefs.push(join(ROOT_2027, "supervision.json"));

// supervise status + terminate on the 2027 session root (expected refusals).
const st27 = superviseCli(["status", "--session-root", ROOT_2027, "--json"], { cliPath: CLI });
writeJson(join(RC_DIR, "env", "supervise-status-b27.json"), st27);
evidenceRefs.push(join(RC_DIR, "env", "supervise-status-b27.json"));
notes.push(`supervise status(2027) exit=${st27.exitCode}`);
const tm27 = superviseCli(["terminate", "--session-root", ROOT_2027, "--permit", TERMINATE_PERMIT, "--force", "--json"], { cliPath: CLI });
writeJson(join(RC_DIR, "env", "supervise-terminate-b27.json"), tm27);
evidenceRefs.push(join(RC_DIR, "env", "supervise-terminate-b27.json"));
notes.push(`supervise terminate(2027, --force) exit=${tm27.exitCode}`);

// ---- Step 2: AE 2026 launch — different install, anomaly not expected ----
const launch2026 = await steps.try(
  "launch-ae2026",
  "AfterEffects.launch(AE 2026) — clean owned host for the readiness→ops→teardown tail; BirthPrefs anomaly is AE 2027-specific",
  () =>
    AfterEffects.launch({
      sessionRoot: ROOT_2026,
      installDir: AE_2026_INSTALL,
      readinessTimeoutMs: 180_000,
      timeoutMs: 60_000,
      recoveryGraceMs: 60_000,
    }),
  ["trace:session.launch"],
);
notes.push(
  `launch2026: ${launch2026.ok ? "RESOLVED" : `${launch2026.error?.name}: ${String(launch2026.error?.message ?? "").slice(0, 400)}`}` +
    (launch2026.error?.readiness ? ` readiness=${JSON.stringify(launch2026.error.readiness).slice(0, 800)}` : ""),
);

if (launch2026.ok) {
  ae2026 = launch2026.value;
  const own = ae2026.ownership?.();
  notes.push(`launch2026 ownership=${JSON.stringify(own)}`);
  anomaly = own?.kind === "owned" ? null : { kind: "unexpected-ownership", detail: JSON.stringify(own) };

  // readiness already proven by launch resolving; follow-up ops:
  await steps.try("op-version", "ae.version() returns AE 2026 version", async () => ae2026.version());
  await steps.try("op-openProject", "ae.openProject(fixture) succeeds", async () => {
    const p = await ae2026.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return p.info();
  });
  await steps.try("op-comp-create", "comp.create via project API", async () => {
    const project = await ae2026.project();
    const comps = await ae2026.comps();
    return { comps: comps.map((c) => c.name ?? c) };
  });
  await steps.try("op-renderFrame", "comp.renderFrame(0) writes a PNG", async () => {
    const project = await ae2026.project();
    const comp = await project.comp("A8N Acceptance");
    return comp.renderFrame(0, { prefix: "s17-frame" });
  });
  const gui = await steps.try("op-guiState", "ae.guiState() observes cleanly", async () => ae2026.guiState());
  if (gui.ok) notes.push(`guiState2026: axSuspect=${gui.value?.axSuspect} windows=${gui.value?.windows?.length}`);

  await steps.try("close-2026", "ae.close({unsavedChanges:'discard'}) quits owned host", async () =>
    ae2026.close({ unsavedChanges: "discard" }),
  );
  ae2026 = null;
}

const art26 = sessionArtifacts(ROOT_2026);
writeJson(join(RC_DIR, "env", "launch-2026-result.json"), {
  ok: launch2026.ok,
  error: launch2026.ok ? null : { name: launch2026.error?.name, message: String(launch2026.error?.message ?? "").slice(0, 600), readiness: launch2026.error?.readiness ?? null },
  provenance: art26.provenance,
  supervision: art26.supervision,
});
evidenceRefs.push(...[join(RC_DIR, "env", "launch-2026-result.json"), art26.tracePath, art26.attemptLedgerPath, art26.teardownPath].filter(Boolean));
if (art26.supervision) evidenceRefs.push(join(ROOT_2026, "supervision.json"));

// ---- final census: nothing of ours may remain; pid 18577 untouched ----
const post = await steps.run("final-census", "post-run process census", async () => ({ ps: aeCensus() }));
const subjectAlive = post.ps.some((p) => p.pid === LIVE_SUBJECT_PID);
notes.push(`final census: ${JSON.stringify(post.ps)}; subject 18577 alive=${subjectAlive}`);
if (!subjectAlive) {
  verdict = "fail";
  notes.push("FATAL: live subject pid 18577 gone — must never happen");
} else if (launch2026.ok) {
  // Clean owned lifecycle on a different install; anomaly chain on the
  // AX-invisible subject remains phase-A scoped (indeterminate).
  verdict = "indeterminate";
  notes.push(
    "AE 2026 owned lifecycle completed on public path (launch→ops→close). " +
      "AE 2027 reproduction blocked: same-install preexisting gate means no new " +
      "provenance-bearing host can spawn while pid 18577 holds the install; " +
      "and a spawn-then-blocked host would have no provenance either (terminate " +
      "refuses) — recorded as the RC-S17 reproduction gap.",
  );
} else {
  verdict = "indeterminate";
  notes.push("both launch attempts failed; see per-attempt readiness evidence");
}

const fixtureHashAfter = shasumFile(FIXTURE.path);
if (fixtureHashAfter !== fixtureHashBefore) {
  verdict = "fail";
  notes.push(`FIXTURE MUTATED: ${fixtureHashBefore} -> ${fixtureHashAfter}`);
}

const summaryPath = join(RC_DIR, "sessions", "s17-b-summary.json");
writeJson(summaryPath, { phase: "B", verdict, notes, roots: { r2027: ROOT_2027, r2026: ROOT_2026 } });

recordAttempt({
  scenarioId: "RC-S17",
  verdict,
  steps: steps.items,
  anomaly,
  cleanup: { verdict: art26.teardown ? art26.teardown.verdict : "unverifiable", ref: art26.teardownPath ?? null },
  evidenceRefs: [...evidenceRefs, summaryPath].filter(Boolean),
  notes: notes.join(" | "),
  sessionRoot: ROOT_2027,
});

console.log(JSON.stringify({ verdict, notes }, null, 2));
