/**
 * RC-S17 Phase A — observe + classify the live AX-invisible anomaly subject
 * (AE 2027 pid 18577, modal-blocked in CEggApp::BirthPrefs →
 * UI_MessageBox::RunModal since 17:22 JST, launched via AppleScript so it
 * carries NO launch provenance).
 *
 * Public paths only:
 *   - windowServerCensus / censusForPid / execFileCensusRunner (exported)
 *   - MacGuiRecovery.listWindows / capture / captureWindowById (exported)
 *   - AfterEffects.attach (expected to fail: host never answers probe)
 *   - AfterEffects.terminate (expected refusal: no provenance)
 *   - `ae-a8n supervise status|terminate` CLI (public CLI)
 *
 * Read-only observation of pid 18577; nothing is sent to it, no input, no
 * signal, no dismiss. Run from the packed-consumer dir so the import is the
 * tarball bytes:
 *   cd /tmp/rc453/consumer && RC_DIR=<evidence dir> node <harness>/s17-phase-a.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AfterEffects,
  MacGuiRecovery,
  TERMINATE_PERMIT,
  censusForPid,
  execFileCensusRunner,
  listAppInstances,
  readGuiSession,
  windowServerCensus,
} from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
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
const SESSION_ROOT = join(RC_DIR, "sessions", "s17-a-attach-18577");
const SHOTS = join(RC_DIR, "sessions", "s17-a-subject-18577");
mkdirSync(SHOTS, { recursive: true });

const steps = new Steps();
const notes = [];
const evidenceRefs = [];
let verdict = "indeterminate";
let anomaly = null;

const baseline = {
  at: new Date().toISOString(),
  ps: aeCensus(),
  lsappinfo: null,
};
try {
  baseline.lsappinfo = execFileSync("lsappinfo", ["list"], { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 })
    .split("\n")
    .filter((l) => l.includes("After Effects"));
} catch (e) {
  baseline.lsappinfo = `unreadable: ${e}`;
}
writeJson(join(RC_DIR, "env", "baseline-phase-a.json"), baseline);
evidenceRefs.push(join(RC_DIR, "env", "baseline-phase-a.json"));

// Save a fresh `sample` stack for the record (read-only).
try {
  const stack = execFileSync("sample", [String(LIVE_SUBJECT_PID), "3"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const stackPath = join(RC_DIR, "env", "birthprefs-modal-stack-18577.txt");
  writeJson(stackPath, { note: "sample output stored as JSON string", capturedAt: new Date().toISOString() });
  // overwrite with raw text instead — simpler to read
  const { writeFileSync } = await import("node:fs");
  writeFileSync(stackPath, stack, "utf-8");
  evidenceRefs.push(stackPath);
} catch (e) {
  notes.push(`sample failed: ${String(e).slice(0, 200)}`);
}

// 1. Process + login-session census (public exports).
const procAndSession = await steps.run(
  "census-process-session",
  "pid 18577 is a live AE 2027 process in an Aqua session",
  async () => {
    const instances = listAppInstances().filter((i) => i.pid === LIVE_SUBJECT_PID || /After Effects/.test(i.name));
    const ps = aeCensus();
    const uid = ps.find((p) => p.pid === LIVE_SUBJECT_PID)?.uid ?? null;
    const session = uid === null ? null : readGuiSession(uid);
    return { ps, instances, session };
  },
);
const targetInstance = procAndSession.instances.find((i) => i.pid === LIVE_SUBJECT_PID) ?? null;
const session =
  targetInstance !== null
    ? readGuiSession(targetInstance.uid)
    : procAndSession.session;

// 2. WindowServer census for the pid (public export, read-only).
const census = await steps.run(
  "windowserver-census",
  "census lists the modal window(s) for pid 18577",
  async () => {
    const all = windowServerCensus(execFileCensusRunner());
    const forPid = censusForPid(all, LIVE_SUBJECT_PID);
    return { available: all.available, reason: all.reason ?? null, total: all.windows?.length ?? 0, forPid };
  },
);

// 3. AX + census observation through the public recovery surface.
//    listWindows() is read-only; allowConsoleSession is required because
//    the target lives in the console session — observation never mutates.
const guiState = await steps.run(
  "gui-observation-listWindows",
  "MacGuiRecovery.listWindows reports axSuspect + census-unaccounted windows",
  async () => {
    if (session === null) throw new Error("no MacSession for the subject");
    const gui = new MacGuiRecovery({
      session,
      pid: LIVE_SUBJECT_PID,
      allowConsoleSession: true,
      screenshotDir: SHOTS,
      ownerId: "ae-a8n-rc-s17",
    });
    const state = gui.listWindows();
    return {
      pid: state.pid,
      frontmost: state.frontmost,
      axSuspect: state.axSuspect,
      axSuspectReason: state.axSuspectReason,
      axForeignWindowCount: state.axForeignWindowCount,
      axUnmatchedWindowCount: state.axUnmatchedWindowCount,
      windowServer: state.windowServer,
      axUnaccountedWindows: state.axUnaccountedWindows,
      axUnaccountedCensusWindows: state.axUnaccountedCensusWindows,
      windows: state.windows.map((w) => ({
        index: w.index,
        role: w.role,
        title: w.title,
        subrole: w.subrole,
        blocking: w.blocking,
        texts: w.texts,
        buttons: w.buttons,
      })),
    };
  },
);
const guiStatePath = join(RC_DIR, "env", "gui-state-18577.json");
writeJson(guiStatePath, guiState);
evidenceRefs.push(guiStatePath);
if (guiState.axSuspect === true) {
  anomaly = {
    kind: "ax-invisible-modal",
    detail: guiState.axSuspectReason ?? "AX reported no window attributable to the pid while the census lists windows",
  };
}

// 4. Session screenshot + per-census-window captures (#451 read-only path).
const captures = await steps.run(
  "census-window-captures",
  "session screenshot + captureWindowById per unaccounted census row",
  async () => {
    if (session === null) return { skipped: "no session" };
    const gui = new MacGuiRecovery({
      session,
      pid: LIVE_SUBJECT_PID,
      allowConsoleSession: true,
      screenshotDir: SHOTS,
      ownerId: "ae-a8n-rc-s17",
    });
    const out = { sessionShot: null, windows: [] };
    try {
      const p = join(SHOTS, "session.png");
      gui.capture(p);
      out.sessionShot = p;
    } catch (e) {
      out.sessionShotError = String(e?.message ?? e).slice(0, 300);
    }
    for (const ws of guiState.axUnaccountedCensusWindows ?? []) {
      const row = { layer: ws.layer, onScreen: ws.onScreen, name: ws.name, windowNumber: ws.windowNumber ?? null };
      if (ws.windowNumber !== undefined && ws.windowNumber !== null) {
        try {
          const p = join(SHOTS, `window-${ws.windowNumber}.png`);
          gui.captureWindowById(p, ws.windowNumber);
          row.path = p;
        } catch (e) {
          row.error = String(e?.message ?? e).slice(0, 300);
        }
      } else {
        row.error = "no windowNumber — uncapturable via captureWindowById";
      }
      out.windows.push(row);
    }
    return out;
  },
);
writeJson(join(RC_DIR, "env", "census-captures-18577.json"), captures);
for (const w of captures.windows ?? []) if (w.path) evidenceRefs.push(w.path);
if (captures.sessionShot) evidenceRefs.push(captures.sessionShot);

// 5. Attach attempt — expected to fail: the modal-blocked host never
//    answers the readiness probe, so no session is established.
const attach = await steps.try(
  "attach-attempt",
  "AfterEffects.attach({pid:18577}) refuses/fails — host never answers probe",
  () =>
    AfterEffects.attach({
      target: { pid: LIVE_SUBJECT_PID },
      sessionRoot: SESSION_ROOT,
      installDir: AE_2027_INSTALL,
      readinessTimeoutMs: 30_000,
      timeoutMs: 15_000,
    }),
);
notes.push(
  `attach: ${attach.ok ? "UNEXPECTED SUCCESS" : `${attach.error?.name}: ${String(attach.error?.message ?? "").slice(0, 300)}`}`,
);
const attachArtifacts = sessionArtifacts(SESSION_ROOT);

// 6. supervise status on the (failed-attach) session root.
const status = superviseCli(["status", "--session-root", SESSION_ROOT, "--json"], { cliPath: CLI });
writeJson(join(RC_DIR, "env", "supervise-status-a.json"), status);
evidenceRefs.push(join(RC_DIR, "env", "supervise-status-a.json"));
notes.push(`supervise status exit=${status.exitCode} stdout=${status.stdout.slice(0, 300).replace(/\n/g, " | ")}`);

// 7. Library terminate — expected refusal: no launch provenance.
const libTerminate = await steps.try(
  "library-terminate-refusal",
  "AfterEffects.terminate refuses: no launch provenance for pid 18577",
  () => AfterEffects.terminate({ sessionRoot: SESSION_ROOT, permit: TERMINATE_PERMIT }),
);
notes.push(
  `AfterEffects.terminate: ${libTerminate.ok ? `UNEXPECTED ${JSON.stringify(libTerminate.value).slice(0, 300)}` : `${libTerminate.error?.name}: ${String(libTerminate.error?.message ?? "").slice(0, 300)}`}`,
);

// 8. CLI terminate — expected refusal (exit 4), then with --force (still refused: provenance gate precedes force).
const cliTerminate = superviseCli(
  ["terminate", "--session-root", SESSION_ROOT, "--permit", TERMINATE_PERMIT, "--json"],
  { cliPath: CLI },
);
writeJson(join(RC_DIR, "env", "supervise-terminate-a.json"), cliTerminate);
evidenceRefs.push(join(RC_DIR, "env", "supervise-terminate-a.json"));
notes.push(`supervise terminate exit=${cliTerminate.exitCode} ${cliTerminate.stdout.slice(0, 300).replace(/\n/g, " | ")}`);

const cliTerminateForce = superviseCli(
  ["terminate", "--session-root", SESSION_ROOT, "--permit", TERMINATE_PERMIT, "--force", "--json"],
  { cliPath: CLI },
);
writeJson(join(RC_DIR, "env", "supervise-terminate-a-force.json"), cliTerminateForce);
evidenceRefs.push(join(RC_DIR, "env", "supervise-terminate-a-force.json"));
notes.push(`supervise terminate --force exit=${cliTerminateForce.exitCode}`);

// 9. Post-checks: subject must be untouched and still running.
const post = await steps.run("post-observation-census", "pid 18577 still alive, unmodified", async () => ({
  ps: aeCensus(),
  alive: aeCensus().some((p) => p.pid === LIVE_SUBJECT_PID),
}));
if (!post.alive) {
  verdict = "fail";
  notes.push("FATAL: subject pid 18577 no longer running — unexpected");
} else {
  // Phase A demonstrated: detection (axSuspect + census evidence) and the
  // fail-closed terminate refusal. The scenario chain continues in Phase B;
  // this attempt's verdict is indeterminate — it is phase-scoped evidence,
  // not a scenario pass.
  verdict = "indeterminate";
  notes.push(
    "phase-A scope complete: AX-invisible anomaly detected via public observation surface; " +
      "terminate correctly refused (no launch provenance — AppleScript-launched host). " +
      "Full detect→exit→readiness→ops→teardown chain continues in the Phase B attempt.",
  );
}

const summaryPath = join(RC_DIR, "sessions", "s17-a-summary.json");
writeJson(summaryPath, {
  phase: "A",
  subject: LIVE_SUBJECT_PID,
  verdict,
  sessionRoot: SESSION_ROOT,
  attachArtifacts: {
    provenance: attachArtifacts.provenance,
    supervision: attachArtifacts.supervision !== null,
    trace: attachArtifacts.tracePath ?? null,
  },
  notes,
});

recordAttempt({
  scenarioId: "RC-S17",
  verdict,
  steps: steps.items,
  anomaly,
  cleanup: { verdict: "unverifiable", ref: null },
  evidenceRefs: [...evidenceRefs, summaryPath, attachArtifacts.tracePath].filter(Boolean),
  notes: notes.join(" | "),
  sessionRoot: SESSION_ROOT,
});

console.log(JSON.stringify({ verdict, notes, guiState: { axSuspect: guiState.axSuspect, axSuspectReason: guiState.axSuspectReason, windowServer: guiState.windowServer, unaccounted: (guiState.axUnaccountedCensusWindows ?? []).length } }, null, 2));
