/**
 * RC-436 acceptance harness library — consumer-side helpers.
 *
 * Everything here drives the packed tarball through the public API only
 * (`@ido-bata/ae-a8n` exports + `ae.*` session surface). This file produces
 * the scenario-level attempt ledger required by
 * `specs/release-acceptance/spec.md` §5.2: one record per scenario attempt
 * with steps[], verdict, anomaly, recovery, cleanup and evidenceRefs.
 *
 * The op-level ledger (`<sessionRoot>/attempt-ledger.jsonl`, #434) is
 * produced by the package itself; this file only groups attempts into
 * scenario verdicts — it never edits or rewrites those rows.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname, platform, arch, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical home is the evidence dir; when harness copies run from a
// consumer install dir, RC_DIR is passed explicitly so ledger/fixture
// paths still bind to the committed evidence tree.
export const RC_DIR =
  process.env.RC_DIR ?? join(dirname(dirname(fileURLToPath(import.meta.url))));
export const LEDGER_PATH = join(RC_DIR, "scenario-ledger.jsonl");

/** Candidate identity — frozen at run start (spec §3). */
export const CANDIDATE = {
  commit: "60523c28d3b664b7c273f03fbbaf4ed16c5e741b",
  tarballSha256: "467b523be2c3bba2130f52db4fc258d099875ebcf9e4ce2e82d6531f2f75f6e4",
  package: "@ido-bata/ae-a8n",
  version: "0.6.0",
};

export const PLATFORM = {
  lane: "macos",
  os: `${platform()} ${release()}`,
  arch: arch(),
  host: hostname(),
};

export const FIXTURE = {
  id: "fixture.aep",
  path: join(RC_DIR, "fixtures", "fixture.aep"),
  sha256: "84d5d91112fcbef9d0cea461afc4e99d06a88822084e9dfb6cf59a63f96768c0",
};

export const AE_2027_INSTALL = "/Applications/Adobe After Effects 2027";
export const AE_2026_INSTALL = "/Applications/Adobe After Effects 2026";
export const FOREIGN_AE_2026_PID = 7966; // observed at run start; re-verify per use

const SCHEMA_VERSION = 1;
const KIND = "ae-a8n.rc-scenario-attempt/v1";

/* ---------------- scenario ledger (spec §5) ---------------- */

let ledgerInitialised = false;

function ledgerEnvelope() {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    spec: "specs/release-acceptance/spec.md",
    candidate: CANDIDATE,
    platform: PLATFORM,
    fixture: FIXTURE,
    startedAt: new Date().toISOString(),
  };
}

export function initLedger() {
  if (ledgerInitialised) return;
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  if (!existsSync(LEDGER_PATH)) {
    appendFileSync(LEDGER_PATH, `${JSON.stringify(ledgerEnvelope())}\n`, "utf-8");
  }
  ledgerInitialised = true;
}

const VERDICT_TO_OUTCOME = {
  pass: "ok",
  fail: "error",
  indeterminate: "indeterminate",
  blocked: "blocked",
  environment: "environment",
  // No dedicated outcome exists for these; `blocked` is the honest
  // non-pass bucket and `verdict` carries the precise label (the metrics
  // evaluator prefers `verdict` when present).
  skipped: "blocked",
  "not-applicable": "blocked",
};

/**
 * Append one scenario attempt record (spec §5.2). `steps` is an array of
 * { stepId, startedAt, durationMs, expected, actual, evidenceRefs? }.
 */
export function recordAttempt({
  scenarioId,
  verdict,
  steps = [],
  anomaly = null,
  recovery = null,
  cleanup = null,
  evidenceRefs = [],
  notes = "",
  sessionId = null,
  sessionRoot = null,
  startedAt = null,
  endedAt = null,
}) {
  initLedger();
  const start = startedAt ?? steps[0]?.startedAt ?? new Date().toISOString();
  const end = endedAt ?? new Date().toISOString();
  const durationMs =
    steps.length > 0
      ? steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
      : Math.max(0, Date.parse(end) - Date.parse(start));
  const record = {
    schemaVersion: SCHEMA_VERSION,
    type: "attempt",
    attemptId: `rc-${scenarioId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    scenarioId,
    feature: scenarioId,
    verdict,
    outcome: VERDICT_TO_OUTCOME[verdict] ?? "error",
    startedAt: start,
    endedAt: end,
    durationMs,
    steps,
    anomaly,
    recovery,
    cleanup,
    evidenceRefs,
    candidate: CANDIDATE,
    platform: PLATFORM,
    fixture: FIXTURE,
    sessionId,
    sessionRoot,
    notes,
  };
  appendFileSync(LEDGER_PATH, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

/* ---------------- step timing ---------------- */

export class Steps {
  constructor() {
    this.items = [];
  }
  async run(stepId, expected, fn, evidenceRefs = []) {
    const startedAt = new Date();
    const t0 = Date.now();
    let actual;
    let error = null;
    try {
      actual = await fn();
    } catch (e) {
      error = e;
      actual = { error: e?.name ?? "Error", message: String(e?.message ?? e).slice(0, 500) };
    }
    const durationMs = Date.now() - t0;
    this.items.push({
      stepId,
      startedAt: startedAt.toISOString(),
      durationMs,
      expected,
      actual,
      evidenceRefs,
      ...(error ? { error: { name: error.name, message: String(error.message).slice(0, 500) } } : {}),
    });
    if (error) throw error;
    return actual;
  }
  /** Run without failing the scenario on error; returns {ok, value|error}. */
  async try(stepId, expected, fn, evidenceRefs = []) {
    try {
      const value = await this.run(stepId, expected, fn, evidenceRefs);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e, step: this.items[this.items.length - 1] };
    }
  }
}

/* ---------------- environment probes ---------------- */

export function shasumFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function aeCensus() {
  // Census by executable path — `pgrep -fl "After Effects"` also matches
  // osascript wrappers; match the real binary path per platform.
  try {
    const out = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf-8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("After Effects") && l.includes("MacOS/After Effects"))
      .map((l) => {
        const m = /^(\d+)\s+(.*)$/.exec(l);
        return m ? { pid: Number(m[1]), executable: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function clipboardDigest() {
  try {
    const out = execFileSync("pbpaste", [], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return { sha256: createHash("sha256").update(out, "utf-8").digest("hex"), bytes: Buffer.byteLength(out, "utf-8") };
  } catch (e) {
    return { error: String(e) };
  }
}

export function inputSourceBaseline() {
  try {
    const out = execFileSync("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"], {
      encoding: "utf-8",
    });
    return out;
  } catch (e) {
    return `unreadable: ${e}`;
  }
}

export function frontmostApp() {
  try {
    return execFileSync("osascript", [
      "-e",
      'tell application "System Events" to get name of first process whose frontmost is true',
    ], { encoding: "utf-8" }).trim();
  } catch (e) {
    return `unreadable: ${e}`;
  }
}

import { readdirSync } from "node:fs";

/** Read the teardown verdict + supervision doc a session left behind. */
export function sessionArtifacts(sessionRoot) {
  const out = { teardown: null, supervision: null, attemptLedger: null, trace: null };
  if (!sessionRoot || !existsSync(sessionRoot)) return out;
  try {
    for (const f of readdirSync(sessionRoot)) {
      if (f.startsWith("teardown-") && f.endsWith(".json")) {
        out.teardown = JSON.parse(readFileSync(join(sessionRoot, f), "utf-8"));
        out.teardownPath = join(sessionRoot, f);
      }
      if (f === "supervision.json") {
        out.supervision = JSON.parse(readFileSync(join(sessionRoot, f), "utf-8"));
      }
      if (f === "attempt-ledger.jsonl") out.attemptLedgerPath = join(sessionRoot, f);
      if (f === "trace.jsonl") out.tracePath = join(sessionRoot, f);
    }
  } catch {}
  return out;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export { join };
