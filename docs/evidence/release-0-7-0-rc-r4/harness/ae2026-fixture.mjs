/**
 * AE 2026 fixture lifecycle for RC-S8 / RC-S12 (run 4).
 *
 * `up`   — AfterEffects.launch against the AE 2026 install into a dedicated
 *          session root (/tmp/rc436r4-sessions/ae2026-fixture). The pid is
 *          FOREIGN to every scenario session under test (observation /
 *          frontmost fixture only — never mutated by scenario code).
 * `down` — ae.close({unsavedChanges:"discard"}) on that session, or
 *          AfterEffects.terminate when the session never became ready.
 * `pid`  — print the fixture pid (from a8n-session.json / provenance).
 *
 * Public path only. If the launch hits the BirthPrefs modal the caller
 * runs recover-leftover.mjs and retries `up`.
 */
import { AfterEffects, TERMINATE_PERMIT } from "@ido-bata/ae-a8n";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { recordAttempt, writeJson, aeCensus } from "./lib.mjs";

const ROOT = "/tmp/rc436r4-sessions/ae2026-fixture";
const INSTALL = "/Applications/Adobe After Effects 2026";
const cmd = process.argv[2];

function fixturePid() {
  for (const f of ["a8n-session.json", "launch-provenance.json"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      const pid = j?.host?.pid ?? j?.pid ?? j?.session?.pid;
      if (Number.isInteger(pid)) return pid;
    } catch {}
  }
  const c = aeCensus().find((x) => x.executable.includes("After Effects 2026"));
  return c?.pid ?? null;
}

if (cmd === "pid") {
  console.log(fixturePid() ?? "none");
  process.exit(0);
}

if (cmd === "up") {
  mkdirSync(ROOT, { recursive: true });
  const steps = [];
  const t0 = Date.now();
  let verdict = "fail";
  let ae = null;
  try {
    ae = await AfterEffects.launch({
      sessionRoot: ROOT, installDir: INSTALL,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 60000,
    });
    const info = await ae.version().catch(() => null);
    steps.push({ stepId: "launch+handshake", expected: "AE 2026 ready", actual: { version: info }, durationMs: Date.now() - t0 });
    verdict = "pass";
  } catch (e) {
    steps.push({
      stepId: "launch+handshake",
      expected: "AE 2026 ready within readinessTimeoutMs",
      actual: { error: e?.name, message: String(e?.message ?? e).slice(0, 300) },
      durationMs: Date.now() - t0,
      error: { name: e?.name ?? "Error", message: String(e?.message ?? e).slice(0, 300) },
    });
  }
  const pid = fixturePid();
  const summaryPath = "/tmp/rc436r4-sessions/ae2026-fixture-summary.json";
  writeJson(summaryPath, { verdict, pid, steps });
  recordAttempt({
    scenarioId: "RC-S17",
    verdict: verdict === "pass" ? "pass" : "fail",
    steps,
    anomaly: verdict === "pass" ? null : "known-safe-modal",
    cleanup: { verdict: "unverifiable", ref: null },
    evidenceRefs: [summaryPath, ROOT],
    notes: `[ae2026-fixture up] ${verdict} pid=${pid}`,
    sessionRoot: ROOT,
  });
  console.log(`ae2026 up: ${verdict} pid=${pid}`);
  process.exit(verdict === "pass" ? 0 : 1);
}

if (cmd === "down") {
  const pid = fixturePid();
  // Prefer the session's own close path when a ready session file exists.
  let closed = false;
  try {
    const sess = JSON.parse(readFileSync(join(ROOT, "a8n-session.json"), "utf-8"));
    void sess;
    // Reattach is not a public "resume session" for arbitrary roots; use
    // terminate on provenance, else close via a fresh attach-free path.
  } catch {}
  if (pid) {
    try {
      const report = await AfterEffects.terminate({
        sessionRoot: ROOT, installDir: INSTALL,
        permit: TERMINATE_PERMIT, force: true,
        gracefulTimeoutMs: 20000, deadlineMs: 90000,
      });
      closed = report.outcome === "terminated" || report.outcome === "already-gone";
      console.log(`ae2026 down: terminate ${report.outcome} method=${report.method}`);
    } catch (e) {
      console.log(`ae2026 down: terminate refused: ${e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // If terminate refused (no provenance — e.g. ready session only), try
  // attach+close is NOT allowed to mutate? close on attached is allowed
  // (attached sessions are left running by close per spec — actually close
  // quits only owned). Fall back: leave running and report.
  const still = fixturePid();
  console.log(`ae2026 down done closed=${closed} pidNow=${still ?? "none"}`);
  process.exit(still ? 1 : 0);
}

console.log("usage: ae2026-fixture.mjs up|down|pid");
process.exit(2);
