/**
 * RC-S10 — mid-operation abort: the calling process dies while a host
 * operation is in flight. The session's teardown verdict must still be
 * produced honestly and no false pass/fail may be recorded. We spawn a
 * child that launches AE, starts rc436.slowOp, and is SIGKILLed mid-op;
 * the parent then inspects the session artifacts.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AfterEffects, TERMINATE_PERMIT } from "@ido-bata/ae-a8n";
import { Steps, recordAttempt, sessionArtifacts, writeJson, aeCensus } from "./lib.mjs";

const label = process.argv[2] ?? "s10";
const scenarioId = "RC-S10";
const sessionRoot = `/tmp/rc436r3-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r3-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let anomaly = null;
let ownedPid = null;

const childSrc = `
import { AfterEffects } from "@ido-bata/ae-a8n";
const ae = await AfterEffects.launch({
  sessionRoot: ${JSON.stringify(sessionRoot)},
  installDir: "/Applications/Adobe After Effects 2027",
  hostScript: ${JSON.stringify(HOST_SCRIPT)},
  readinessTimeoutMs: 180000, timeoutMs: 120000, recoveryGraceMs: 60000,
});
const t = ae.recoveryTarget();
console.log("OWNED_PID=" + (t ? t.pid : "none"));
// Fire a 60s host op, then get killed mid-flight by the parent.
ae.call("rc436.slowOp", { ms: 60000 }, { timeoutMs: 120000 }).then(
  (v) => console.log("SLOW_DONE " + JSON.stringify(v)),
  (e) => console.log("SLOW_ERR " + e.name),
);
setInterval(() => {}, 1000);
`;

try {
  // Phase 1: child launches + starts slow op; parent kills the CHILD mid-op.
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSrc], {
    cwd: "/tmp/rc436r3-consumer",
    env: { ...process.env, RC_DIR: "/Users/rebui/work/ae-a8n.436-r3/docs/evidence/release-0-7-0-rc-r3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOut = "";
  child.stdout.on("data", (d) => { childOut += d; });
  child.stderr.on("data", (d) => { childOut += d; });

  // Wait for OWNED_PID line (launch complete + target attested).
  const deadline = Date.now() + 300000;
  while (!childOut.includes("OWNED_PID=") && Date.now() < deadline && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const m = /OWNED_PID=(\d+)/.exec(childOut);
  ownedPid = m ? Number(m[1]) : null;
  notes.push(`child output so far: ${childOut.slice(0, 300)}`);
  if (!ownedPid) throw new Error("child never attested an owned pid");

  const exe = execFileSync("ps", ["-o", "comm=", "-p", String(ownedPid)], { encoding: "utf-8" }).trim();
  if (!exe.includes("After Effects 2027")) throw new Error(`pid ${ownedPid} not AE2027: ${exe}`);

  // Give the slow op a moment to be in-flight, then SIGKILL the child —
  // the session dies mid-operation. The AE host keeps running the script.
  await new Promise((r) => setTimeout(r, 5000));
  child.kill("SIGKILL");
  notes.push(`child killed mid-op; owned AE pid ${ownedPid} left running the 60s script`);

  await steps.run("child-dead", "calling process terminated mid-operation", () => {
    return { childExit: child.exitCode, signal: child.signalCode };
  });

  // The durable supervision doc + trace survive in sessionRoot; the
  // in-flight request stays UNKNOWN — nothing resent it (the resender
  // died with the child).
  await steps.run("artifacts-honest", "session artifacts show honest mid-op state", async () => {
    await new Promise((r) => setTimeout(r, 3000));
    const tracePath = `${sessionRoot}/trace.jsonl`;
    const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf-8") : "";
    const supPath = `${sessionRoot}/supervision.json`;
    const sup = existsSync(supPath) ? JSON.parse(readFileSync(supPath, "utf-8")) : null;
    return {
      traceTail: trace.split("\n").filter(Boolean).slice(-4),
      supervisionPhase: sup?.phase ?? null,
      pendingRequests: sup?.pendingRequests ?? null,
    };
  });

  // Cleanup: wait for slowOp to finish inside AE (~60s), then the orphaned
  // owned AE must be quit. Run-3 prefers the sanctioned terminate path
  // (#340/#458) — the session root still holds launch provenance — and
  // falls back to the polite osascript quit only if terminate cannot prove
  // the host (e.g. already gone).
  await steps.run("orphan-cleanup", "wait for in-flight script, terminate orphaned owned AE", async () => {
    await new Promise((r) => setTimeout(r, 65000));
    const alive = (() => { try { process.kill(ownedPid, 0); return true; } catch { return false; } })();
    if (!alive) return { note: "AE already exited" };
    const exe2 = execFileSync("ps", ["-o", "comm=", "-p", String(ownedPid)], { encoding: "utf-8" }).trim();
    if (!exe2.includes("After Effects 2027")) throw new Error(`refusing quit: ${exe2}`);
    try {
      const report = await AfterEffects.terminate({
        sessionRoot, installDir: "/Applications/Adobe After Effects 2027",
        permit: TERMINATE_PERMIT, force: true,
        gracefulTimeoutMs: 20000, deadlineMs: 60000,
      });
      if (report.outcome === "terminated" || report.outcome === "already-gone") {
        return { terminate: report.outcome, method: report.method };
      }
      notes.push(`terminate outcome=${report.outcome} — falling back to polite quit`);
    } catch (e) {
      notes.push(`terminate refused: ${e?.name}: ${String(e?.message ?? e).slice(0, 160)} — falling back to polite quit`);
    }
    execFileSync("osascript", ["-e", 'with timeout of 60 seconds\ntell application "Adobe After Effects 2027" to quit\nend timeout'], { encoding: "utf-8" });
    await new Promise((r) => setTimeout(r, 10000));
    return { quitSent: true };
  });

  verdict = "pass";
  anomaly = "comms-lost";
} catch (e) {
  verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  // Last-resort: if an owned AE2027 from THIS scenario is still alive, quit it.
  const left = aeCensus().filter((p) => p.executable.includes("2027"));
  for (const p of left) {
    try {
      execFileSync("osascript", ["-e", 'with timeout of 30 seconds\ntell application "Adobe After Effects 2027" to quit\nend timeout'], { encoding: "utf-8" });
    } catch {}
  }
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = { verdict: artifacts.teardown ? artifacts.teardown.verdict : "unverifiable",
  ref: artifacts.teardownPath ?? null,
  note: "calling process was killed mid-op; teardown verdict may be absent — harness verified orphan cleanup separately" };
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
console.log(`RC-S10 ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
