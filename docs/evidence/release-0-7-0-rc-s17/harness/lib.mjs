/**
 * RC-S17 acceptance harness library — consumer-side helpers.
 *
 * Inherited from `release-0-7-0-rc-r2/harness/lib.mjs` (#436 run 2). Everything
 * here drives the packed tarball through the public API only
 * (`@ido-bata/ae-a8n` exports + `ae.*` session surface + `ae-a8n supervise`
 * CLI). This file produces the scenario-level attempt ledger required by
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
import { readdirSync } from "node:fs";

// Canonical home is the evidence dir; when harness copies run from a
// consumer install dir, RC_DIR is passed explicitly so ledger/fixture
// paths still bind to the committed evidence tree.
export const RC_DIR =
  process.env.RC_DIR ?? join(dirname(dirname(fileURLToPath(import.meta.url))));
export const LEDGER_PATH = join(RC_DIR, "scenario-ledger.jsonl");

/** Candidate identity — frozen at run start (spec §3). */
export const CANDIDATE = {
  commit: "e0712c4b7d6ab371a2a127cc944496f4c2353a6c",
  tarballSha256: "dd578f498b6d0b404b1e02167882efdb2429dda606077908f47ee12f696634fd",
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
/** Live RC-S17 subject: AppleScript-launched AE 2027, modal-blocked since 17:22 JST. */
export const LIVE_SUBJECT_PID = 18577;

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
    const out = execFileSync("ps", ["-axo", "pid=,uid=,comm="], { encoding: "utf-8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("After Effects") && l.includes("MacOS/After Effects"))
      .map((l) => {
        const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m ? { pid: Number(m[1]), uid: Number(m[2]), executable: m[3] } : null;
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

/** Read the teardown verdict + supervision doc a session left behind. */
export function sessionArtifacts(sessionRoot) {
  const out = { teardown: null, supervision: null, attemptLedger: null, trace: null, provenance: null };
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
      if (f === "launch-provenance.json") {
        out.provenance = JSON.parse(readFileSync(join(sessionRoot, f), "utf-8"));
      }
    }
  } catch {}
  return out;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Run the public `ae-a8n supervise` CLI from the packed consumer install. */
export function superviseCli(args, { cliPath, timeoutMs = 60_000 } = {}) {
  const started = new Date();
  const t0 = Date.now();
  try {
    const stdout = execFileSync("node", [cliPath, "supervise", ...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - t0, startedAt: started.toISOString() };
  } catch (e) {
    return {
      ok: false,
      exitCode: typeof e.status === "number" ? e.status : null,
      stdout: e.stdout ?? "",
      stderr: String(e.stderr ?? e.message ?? e),
      durationMs: Date.now() - t0,
      startedAt: started.toISOString(),
    };
  }
}

export { join };
