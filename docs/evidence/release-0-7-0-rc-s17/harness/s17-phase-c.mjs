/**
 * RC-S17 Phase C — durable supervision + every public exit path, on the
 * driver-spawned modal-blocked host (AE 2026 pid 37622, spawned by
 * `AfterEffects.launch` in Phase B, stuck in CEggApp::BirthPrefs →
 * UI_MessageBox::RunModal — the anomaly reproduced on a second install).
 *
 *   1. startDetachedSupervisor (public export) on the session root —
 *      observation-only monitor; publishes supervision.json.
 *   2. `ae-a8n supervise status` until the phase reflects the block
 *      (2-consecutive-observation rule + expired 5min startup grace).
 *   3. Every public exit path, each expected to refuse (no provenance —
 *      the readiness probe never succeeded):
 *        - ae-a8n supervise terminate [--force]
 *        - AfterEffects.terminate({permit})
 *        - AfterEffects.rebuild({sessionRoot})
 *        - AfterEffects.resume({sessionRoot})
 *   4. Read-only window observation + captures for pid 37622.
 *   5. Same detached-supervisor demonstration for the original subject
 *      pid 18577 (AppleScript-launched, never owned).
 *
 * No signals, no input, no dismissal — anywhere.
 *   cd /tmp/rc453/consumer && RC_DIR=<evidence dir> node <harness>/s17-phase-c.mjs
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  AfterEffects,
  MacGuiRecovery,
  TERMINATE_PERMIT,
  listAppInstances,
  readGuiSession,
  startDetachedSupervisor,
} from "@ido-bata/ae-a8n";
import {
  LIVE_SUBJECT_PID,
  RC_DIR,
  Steps,
  aeCensus,
  recordAttempt,
  sessionArtifacts,
  superviseCli,
  writeJson,
} from "./lib.mjs";

const CLI = process.env.A8N_CLI ?? "/tmp/rc453/consumer/node_modules/@ido-bata/ae-a8n/dist/cli.js";
const ROOT_2026 = join(RC_DIR, "sessions", "s17-b-launch-2026");
const ROOT_2027_ATTEMPT = join(RC_DIR, "sessions", "s17-a-attach-18577");
const OBS_18577 = join(RC_DIR, "sessions", "s17-c-supervised-18577");
const PID_2026 = 37622;
const SHOTS_2026 = join(RC_DIR, "sessions", "s17-c-subject-37622");
const SHOTS_18577 = join(RC_DIR, "sessions", "s17-c-subject-18577");

const steps = new Steps();
const notes = [];
const evidenceRefs = [];
let verdict = "indeterminate";
let anomaly = {
  kind: "ax-invisible-modal",
  detail: "BirthPrefs UI_MessageBox::RunModal reproduced on driver-spawned AE 2026 pid 37622 (79/79 main-thread samples); census-visible, AX-empty",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// uid/asid for both subjects (same login session, uid 501).
const uid = aeCensus().find((p) => p.pid === PID_2026)?.uid ?? 501;
const session = readGuiSession(uid);
if (session === null) throw new Error("no Aqua session for uid " + uid);

// 1. Detached supervisors — observation only.
const sup2026 = await steps.run("start-supervisor-37622", "detached supervisor spawns for pid 37622", async () => {
  const r = startDetachedSupervisor({ sessionDir: ROOT_2026, pid: PID_2026, session });
  return { supervisorPid: r.pid };
});
notes.push(`supervisor(37622) pid=${sup2026.supervisorPid}`);

// 2. Poll supervise status until phase leaves 'running' or ~90s.
let status26 = null;
const poll = await steps.run("supervise-status-poll", "supervision.json reflects the AX-invisible block", async () => {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const r = superviseCli(["status", "--session-root", ROOT_2026, "--json"], { cliPath: CLI });
    let doc = null;
    try { doc = JSON.parse(r.stdout)?.facts ?? null; } catch {}
    last = { exitCode: r.exitCode, phase: doc?.doc?.phase ?? null, health: doc?.health ?? null, healthDetail: doc?.healthDetail ?? null, blocking: doc?.doc?.blocking ?? null, nextActions: doc?.nextActions ?? null };
    // Wait for a LIVE monitor's verdict: a stale-heartbeat monitor-lost read
    // is the previous monitor's residue, not the detached supervisor's
    // answer — keep polling through it until the phase resolves or the
    // deadline passes.
    if (last.phase === "blocked" || last.phase === "needs-human" || last.phase === "quarantined") break;
    await sleep(5_000);
  }
  return last;
});
status26 = poll;
writeJson(join(RC_DIR, "env", "supervise-status-c26.json"), status26);
evidenceRefs.push(join(RC_DIR, "env", "supervise-status-c26.json"));
notes.push(`supervise status(37622): phase=${status26.phase} health=${status26.health} detail=${String(status26.healthDetail).slice(0, 200)}`);
if (status26.nextActions) notes.push(`nextActions: ${JSON.stringify(status26.nextActions).slice(0, 800)}`);

// 3. Every public exit path on the driver-spawned host — all expected to refuse.
const exits = {};
exits.cliTerminate = superviseCli(["terminate", "--session-root", ROOT_2026, "--permit", TERMINATE_PERMIT, "--json"], { cliPath: CLI });
writeJson(join(RC_DIR, "env", "supervise-terminate-c26.json"), exits.cliTerminate);
notes.push(`supervise terminate(37622) exit=${exits.cliTerminate.exitCode}`);

exits.cliTerminateForce = superviseCli(["terminate", "--session-root", ROOT_2026, "--permit", TERMINATE_PERMIT, "--force", "--json"], { cliPath: CLI });
writeJson(join(RC_DIR, "env", "supervise-terminate-c26-force.json"), exits.cliTerminateForce);
notes.push(`supervise terminate --force(37622) exit=${exits.cliTerminateForce.exitCode}`);

exits.apiTerminate = await steps.try("api-terminate-37622", "AfterEffects.terminate refuses (no provenance)", () =>
  AfterEffects.terminate({ sessionRoot: ROOT_2026, permit: TERMINATE_PERMIT, force: true }),
);
notes.push(`AfterEffects.terminate(37622): ${exits.apiTerminate.ok ? "UNEXPECTED OK" : exits.apiTerminate.error?.name + ": " + String(exits.apiTerminate.error?.message ?? "").slice(0, 250)}`);

exits.apiRebuild = await steps.try("api-rebuild-37622", "AfterEffects.rebuild refuses (no provenance / not process-gone)", () =>
  AfterEffects.rebuild({ sessionRoot: ROOT_2026, readinessTimeoutMs: 5_000, timeoutMs: 5_000 }),
);
notes.push(`AfterEffects.rebuild(37622): ${exits.apiRebuild.ok ? "UNEXPECTED OK" : exits.apiRebuild.error?.name + ": " + String(exits.apiRebuild.error?.message ?? "").slice(0, 250)}`);

exits.apiResume = await steps.try("api-resume-37622", "AfterEffects.resume refuses (no provenance)", () =>
  AfterEffects.resume({ sessionRoot: ROOT_2026, readinessTimeoutMs: 5_000, timeoutMs: 5_000 }),
);
notes.push(`AfterEffects.resume(37622): ${exits.apiResume.ok ? "UNEXPECTED OK" : exits.apiResume.error?.name + ": " + String(exits.apiResume.error?.message ?? "").slice(0, 250)}`);

// 4. Read-only observation + captures for pid 37622.
const obs26 = await steps.run("observe-37622", "MacGuiRecovery observation of driver-spawned blocked host", async () => {
  const gui = new MacGuiRecovery({ session, pid: PID_2026, allowConsoleSession: true, screenshotDir: SHOTS_2026, ownerId: "ae-a8n-rc-s17" });
  const state = gui.listWindows();
  const out = {
    pid: state.pid, frontmost: state.frontmost, axSuspect: state.axSuspect, axSuspectReason: state.axSuspectReason,
    windowServer: state.windowServer, axUnaccountedCensusWindows: state.axUnaccountedCensusWindows,
    axForeignWindowCount: state.axForeignWindowCount, axUnmatchedWindowCount: state.axUnmatchedWindowCount,
    windows: state.windows.map((w) => ({ role: w.role, title: w.title, blocking: w.blocking, texts: w.texts, buttons: w.buttons })),
    captures: [],
  };
  try { const p = join(SHOTS_2026, "session.png"); gui.capture(p); out.sessionShot = p; } catch (e) { out.sessionShotError = String(e?.message ?? e).slice(0, 200); }
  for (const ws of state.axUnaccountedCensusWindows) {
    const row = { layer: ws.layer, onScreen: ws.onScreen, name: ws.name, windowNumber: ws.windowNumber ?? null };
    if (ws.windowNumber != null) {
      try { const p = join(SHOTS_2026, `window-${ws.windowNumber}.png`); gui.captureWindowById(p, ws.windowNumber); row.path = p; }
      catch (e) { row.error = String(e?.message ?? e).slice(0, 200); }
    }
    out.captures.push(row);
  }
  return out;
});
writeJson(join(RC_DIR, "env", "gui-state-37622.json"), obs26);
evidenceRefs.push(...[join(RC_DIR, "env", "gui-state-37622.json"), obs26.sessionShot].filter(Boolean));
for (const c of obs26.captures ?? []) if (c.path) evidenceRefs.push(c.path);
notes.push(`observe(37622): axSuspect=${obs26.axSuspect} census=${obs26.windowServer?.windowCount} onScreen=${obs26.windowServer?.onScreenCount} unaccounted=${(obs26.axUnaccountedCensusWindows ?? []).length}`);

// 5. Detached supervisor for the original subject 18577.
const sup18577 = await steps.run("start-supervisor-18577", "detached supervisor spawns for pid 18577", async () => {
  const r = startDetachedSupervisor({ sessionDir: OBS_18577, pid: LIVE_SUBJECT_PID, session });
  return { supervisorPid: r.pid };
});
notes.push(`supervisor(18577) pid=${sup18577.supervisorPid}`);
const poll18577 = await steps.run("supervise-status-poll-18577", "supervision.json for pid 18577 reflects the block", async () => {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const r = superviseCli(["status", "--session-root", OBS_18577, "--json"], { cliPath: CLI });
    let doc = null;
    try { doc = JSON.parse(r.stdout)?.facts ?? null; } catch {}
    last = { exitCode: r.exitCode, phase: doc?.doc?.phase ?? null, health: doc?.health ?? null, healthDetail: doc?.healthDetail ?? null, blocking: doc?.doc?.blocking ?? null, nextActions: doc?.nextActions ?? null };
    if (last.phase === "blocked" || last.phase === "needs-human" || last.phase === "quarantined") break;
    await sleep(5_000);
  }
  return last;
});
writeJson(join(RC_DIR, "env", "supervise-status-c18577.json"), poll18577);
evidenceRefs.push(join(RC_DIR, "env", "supervise-status-c18577.json"));
notes.push(`supervise status(18577): phase=${poll18577.phase} health=${poll18577.health} detail=${String(poll18577.healthDetail).slice(0, 200)}`);

// 6. Final census + verdict.
const post = await steps.run("final-census", "post-run census", async () => ({ ps: aeCensus() }));
notes.push(`final census: ${JSON.stringify(post.ps)}`);
const bothAlive = post.ps.some((p) => p.pid === PID_2026) && post.ps.some((p) => p.pid === LIVE_SUBJECT_PID);

// Verdict reasoning:
// - Detection: demonstrated on both subjects (readiness failure + supervision
//   classification + axSuspect census evidence).
// - Recovery-or-safe-exit: NO public exit exists for either host — every
//   path refuses for lack of provenance. That is the honest RC-S17 outcome:
//   the chain cannot complete; the gap is the finding.
// - readiness→ops→teardown: not reachable while both hosts block their
//   installs (2027 blocked by 18577; 2026 now blocked by 37622).
if (!bothAlive) {
  verdict = "fail";
  notes.push("FATAL: a subject process disappeared unexpectedly");
} else {
  verdict = "fail";
  notes.push(
    "RC-S17 verdict: FAIL — detection and fail-closed refusals demonstrated, " +
      "but no public safe-exit exists for a host that never passed its readiness " +
      "probe: launch provenance is written only after the probe, so terminate/" +
      "rebuild/resume all refuse and the modal-blocked process is unstoppable " +
      "through public paths. readiness→follow-up ops→teardown unreachable. " +
      "Product gap filed separately.",
  );
}

const summaryPath = join(RC_DIR, "sessions", "s17-c-summary.json");
writeJson(summaryPath, { phase: "C", verdict, notes, exits: Object.fromEntries(Object.entries(exits).map(([k, v]) => [k, v?.ok === false ? { exitCode: v.exitCode } : v?.ok === true ? { exitCode: 0 } : { error: String(v?.error?.message ?? v?.error).slice(0, 200) }])) });

recordAttempt({
  scenarioId: "RC-S17",
  verdict,
  steps: steps.items,
  anomaly,
  recovery: null,
  cleanup: { verdict: "residue", ref: null },
  evidenceRefs: [...evidenceRefs, summaryPath].filter(Boolean),
  notes: notes.join(" | "),
  sessionRoot: ROOT_2026,
});

console.log(JSON.stringify({ verdict, notes, status26: { phase: status26?.phase, health: status26?.health }, status18577: { phase: poll18577?.phase, health: poll18577?.health } }, null, 2));
