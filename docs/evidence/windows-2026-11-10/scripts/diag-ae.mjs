#!/usr/bin/env node
/**
 * Verification-only: delivers the read-only diagnostic into a real After Effects
 * and reports what came back.
 *
 * Why a job: the acceptance run of 2026-11-10 started After Effects from the job
 * channel and its scripts executed; the same script sent from an SSH session
 * produced no output and no process, so AE needs the interactive session to run
 * a script at all. This script is therefore submitted through the same channel.
 *
 * It refuses when After Effects is already running, starts it once, waits for
 * the diagnostic's own completion marker, then quits it normally and verifies
 * the process is gone. It never kills, never opens or saves a project, and
 * touches no dialog.
 *
 *   node diag-ae.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AE_EXE =
  process.env.A8N_AE_EXE ?? "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
const DIR = process.env.A8N_DIAG_DIR ?? "C:\\Users\\rebui\\AppData\\Local\\Temp\\a8n-diag-20261110T2345Z";
const DIAG = `${DIR}\\${process.argv[2] ?? "diag-dispatch.jsx"}`;
const QUIT = `${DIR}\\quit-ae.jsx`;
const DONE = join(DIR, process.argv[3] ?? "diag-4-done.txt");
const START_DEADLINE_MS = 85_000;
const QUIT_DEADLINE_MS = 45_000;

const startedAt = new Date();
const tag = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const outDir = join(tmpdir(), `a8n-diag-run-${tag}`);
mkdirSync(outDir, { recursive: true });

const find = (path) => (existsSync(path) ? readFileSync(path, "utf-8") : null);

function aeProcesses() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 15_000,
    });
    return out.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).length;
  } catch {
    return -1;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, deadlineMs, label) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await wait(500);
  }
  process.stdout.write(`[diag] ${label}: gave up after ${String(deadlineMs)}ms\n`);
  return false;
}

function sendScript(path) {
  // `-r` runs the script in the running instance, or starts one when alone.
  const child = spawn(AE_EXE, ["-r", path], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

const report = { schemaVersion: "1.0", kind: "ae-diagnostic", startedAt: startedAt.toISOString(), steps: [], findings: {} };

try {
  const before = aeProcesses();
  report.before = before;
  if (before !== 0) {
    throw new Error(
      before < 0
        ? "the process list could not be read, so ownership cannot be proven"
        : `After Effects was already running (${String(before)}); nothing was started`,
    );
  }

  for (const stale of ["diag-1-engine.txt", "diag-2-reproduce.txt", "diag-3-instrumented.txt", "diag-4-done.txt", "dispatch.txt", "result-a.json", "result-b.json", "obj-done.txt", "quit.txt"]) {
    try {
      execFileSync("cmd", ["/c", "del", "/q", join(DIR, stale)], { windowsHide: true, stdio: "ignore" });
    } catch {
      // absent is the normal case
    }
  }

  sendScript(DIAG);
  report.steps.push({ name: "sent diagnostic", at: new Date().toISOString() });
  const done = await until(() => existsSync(DONE), START_DEADLINE_MS, "diagnostic");
  report.steps.push({ name: "diagnostic finished", at: new Date().toISOString(), ok: done });
  report.processesAfterDiagnostic = aeProcesses();
  for (const name of readdirSync(DIR)) {
    if (!/\.(txt|json)$/.test(name)) {
      continue;
    }
    report.findings[name] = find(join(DIR, name));
  }

  sendScript(QUIT);
  report.steps.push({ name: "sent quit", at: new Date().toISOString() });
  const gone = await until(() => aeProcesses() === 0, QUIT_DEADLINE_MS, "quit");
  report.steps.push({ name: "process gone", at: new Date().toISOString(), ok: gone });
  report.processesAfterQuit = aeProcesses();
  report.findings["quit.txt"] = find(join(DIR, "quit.txt"));
  report.status = done && gone ? "ok" : "incomplete";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
}

report.finishedAt = new Date().toISOString();
report.durationMs = Date.now() - startedAt.getTime();
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "ok" ? 0 : 1;
