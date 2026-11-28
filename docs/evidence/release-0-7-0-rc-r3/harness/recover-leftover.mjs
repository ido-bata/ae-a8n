/**
 * RC-436 run-3 leftover recovery — PUBLIC safe-exit only (#458).
 *
 * Scans every session root under RC_SESSIONS_ROOT for a
 * `launch-provenance.json`. For each record whose pid is still alive and
 * whose executable path still names an After Effects install, runs
 * `AfterEffects.terminate` (permit "terminate-owned-host", force permitted
 * for the disposable owned environment) — the same body
 * `ae-a8n supervise terminate --force` wraps. Graceful-first; SIGKILL only
 * inside the product's own bounded force phase.
 *
 * Every recovery is appended to the scenario ledger as an RC-S17 attempt
 * (the anomaly-handling capability under test): detect (provenance +
 * census) → authorized safe-exit → census-verified gone. A refused or
 * unproven terminate is recorded honestly and the pid is left alone.
 *
 * Usage: node recover-leftover.mjs [--label <tag>]
 */
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AfterEffects, TERMINATE_PERMIT } from "@ido-bata/ae-a8n";
import { recordAttempt, writeJson, aeCensus } from "./lib.mjs";

const ROOT = process.env.RC_SESSIONS_ROOT ?? "/tmp/rc436r3-sessions";
const label = process.argv[process.argv.indexOf("--label") + 1] ||
  (process.argv.includes("--label") ? "x" : `sweep-${Date.now().toString(36)}`);

function* sessionRoots(dir, depth = 0) {
  if (depth > 2 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (existsSync(join(p, "launch-provenance.json"))) yield p;
    yield* sessionRoots(p, depth + 1);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pidPath(pid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch { return null; }
}
function installDirFor(executable) {
  const m = /(\/Applications\/Adobe After Effects \d+)/.exec(executable ?? "");
  return m ? m[1] : "/Applications/Adobe After Effects 2027";
}

const censusBefore = aeCensus();
const steps = [];
const notes = [];
const recovered = [];
let sawWork = false;

for (const root of sessionRoots(ROOT)) {
  // A session that already produced a teardown verdict closed cleanly;
  // its provenance was removed by design — nothing to recover.
  const hasTeardown = readdirSync(root).some((f) => f.startsWith("teardown-") && f.endsWith(".json"));
  if (hasTeardown) continue;
  let prov;
  try { prov = JSON.parse(readFileSync(join(root, "launch-provenance.json"), "utf-8")); }
  catch { continue; }
  const pid = prov?.host?.pid;
  if (!Number.isInteger(pid)) continue;
  const phase = prov.phase ?? "(unphased)";
  const alive = pidAlive(pid);
  const path = alive ? pidPath(pid) : null;
  const isAe = !!path && path.includes("MacOS/After Effects");
  steps.push({
    stepId: `inspect-${pid}`,
    expected: "provenance pid state classified",
    actual: { sessionRoot: root, phase, pid, alive, path, isAe },
    durationMs: 0,
  });
  if (!alive || !isAe) {
    notes.push(`pid ${pid} (${root}): ${alive ? "not an AE process" : "already gone"} — nothing to terminate`);
    continue;
  }
  sawWork = true;
  const t0 = Date.now();
  try {
    const report = await AfterEffects.terminate({
      sessionRoot: root,
      installDir: installDirFor(prov.host.executable),
      permit: TERMINATE_PERMIT,
      force: true,
      gracefulTimeoutMs: 20000,
      deadlineMs: 90000,
    });
    steps.push({
      stepId: `terminate-${pid}`,
      expected: "terminate reports terminated/already-gone with proven disappearance",
      actual: report,
      durationMs: Date.now() - t0,
    });
    recovered.push({ pid, root, outcome: report.outcome, method: report.method });
    notes.push(`pid ${pid}: terminate outcome=${report.outcome} method=${report.method} proven=${report.disappearanceProven}`);
  } catch (e) {
    steps.push({
      stepId: `terminate-${pid}`,
      expected: "terminate succeeds via public path",
      actual: { error: e?.name, message: String(e?.message ?? e).slice(0, 400) },
      durationMs: Date.now() - t0,
      error: { name: e?.name ?? "Error", message: String(e?.message ?? e).slice(0, 400) },
    });
    notes.push(`pid ${pid}: terminate REFUSED/failed: ${e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// Final census proof.
const censusAfter = aeCensus();
steps.push({
  stepId: "final-census",
  expected: "census after recovery",
  actual: { before: censusBefore, after: censusAfter },
  durationMs: 0,
});
notes.push(`census before=${JSON.stringify(censusBefore.map((p) => p.pid))} after=${JSON.stringify(censusAfter.map((p) => p.pid))}`);

// Stray detection: AE pids alive in census that NO session-root provenance
// claims. These cannot be terminated through the public path (no
// provenance = fail-closed by design, #458) — report them honestly so the
// operator can dispose via the polite quit path and the finding is ledgered.
const claimedPids = new Set();
for (const root of sessionRoots(ROOT)) {
  try {
    const prov = JSON.parse(readFileSync(join(root, "launch-provenance.json"), "utf-8"));
    if (Number.isInteger(prov?.host?.pid)) claimedPids.add(prov.host.pid);
  } catch {}
}
const unclaimed = censusAfter.filter(
  (p) => p.executable.includes("MacOS/After Effects") && !claimedPids.has(p.pid),
);
if (unclaimed.length > 0) {
  steps.push({
    stepId: "unclaimed-ae-pids",
    expected: "every live AE pid is claimed by a session provenance record",
    actual: unclaimed,
    durationMs: 0,
  });
  notes.push(`UNCLAIMED AE pids (no provenance — public terminate refuses by design): ${JSON.stringify(unclaimed)}`);
}

// Pass requires every recovered target proven gone; unrelated live AE
// (e.g. the foreign AE 2026 fixture) does not fail the sweep.
const recoveredPids = new Set(recovered.map((r) => r.pid));
const survivingTargets = censusAfter.filter((p) => recoveredPids.has(p.pid));
const stray2027 = unclaimed.filter((p) => p.executable.includes("After Effects 2027"));
const foundWork = sawWork || stray2027.length > 0;
const verdict = !foundWork
  ? "indeterminate"
  : survivingTargets.length === 0 && recovered.length > 0 && stray2027.length === 0
    ? "pass"
    : "fail";
if (!foundWork) notes.push("no live provenance-bearing or unclaimed AE2027 found — nothing to recover");

const summaryPath = `/tmp/rc436r3-sessions/recover-${label}-summary.json`;
writeJson(summaryPath, { label, verdict, recovered, censusBefore, censusAfter });
// A sweep that found nothing to terminate is not an RC-S17 attempt — it
// exercised no detect/exit/readiness chain. Only ledger real work.
if (foundWork) {
  recordAttempt({
    scenarioId: "RC-S17",
    verdict,
    steps,
    anomaly: "known-safe-modal",
    recovery: recovered.map((r) => ({ kind: "spawn-provenance-terminate", ...r })),
    cleanup: {
      verdict: survivingTargets.length === 0 &&
        !unclaimed.some((p) => p.executable.includes("After Effects 2027"))
        ? "clean" : "residue",
      ref: summaryPath,
    },
    evidenceRefs: [summaryPath],
    notes: `[modal-recovery sweep ${label}] ${notes.join(" | ")}`,
    sessionRoot: ROOT,
  });
}
console.log(`recover ${label}: ${verdict} recovered=${JSON.stringify(recovered)} censusAfter=${censusAfter.length}`);
process.exit(0);
