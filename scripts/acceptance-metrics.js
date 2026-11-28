/**
 * RC acceptance metrics (#435, `specs/release-acceptance/spec.md` §6/§7).
 *
 *   node scripts/acceptance-metrics.js \
 *     --ledger <attempt-ledger.jsonl> [--ledger ...] \
 *     [--trace <trace.jsonl> ...] [--evidence-index <gui-evidence index.json> ...] \
 *     [--manifest <run-manifest.json>] [--out <report.json>]
 *
 * Consumes the observability artifacts landed in #434
 * (`ae-a8n.attempt-ledger/v1` JSONL, `trace.jsonl` rows, teardown
 * verdicts, `ae-a8n.gui-evidence/v1` indexes) and evaluates the spec §6
 * performance budgets and §7 reproducibility conditions. Same
 * fail-closed posture as `scripts/evidence-gate.js`: every problem is a
 * named reason, unknown schema versions are rejected rather than
 * guessed, and a declared budget that cannot be measured denies.
 *
 * Budget values fall into three classes, reported honestly:
 *
 *   - `fixed`      — the spec pins the number (readiness default
 *                    180 000 ms, monitor interval 2 000 ms / TTL 30 000 ms,
 *                    recovery grace default 60 000 ms, 10 consecutive
 *                    passes, gui-evidence §11's <5% frame-drop proposal).
 *   - `manifest`   — declared in the run manifest before the run
 *                    (spec §6: budgets are pre-declared; post-hoc
 *                    relaxation is a contract change).
 *   - `provisional`— the spec fixes the dimension but leaves the number
 *                    to the pre-RC baseline. The script measures and
 *                    reports the baseline; it does NOT invent a
 *                    threshold. A `provisional` budget never denies.
 *
 * A budget the manifest declares but the artifacts cannot measure is
 * `budget-unmeasured:<name>` — fail-closed, matching the gate's
 * missing-evidence posture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const METRICS_SCHEMA_VERSION = 1;
export const METRICS_KIND = "ae-a8n.acceptance-metrics/v1";

export const ATTEMPT_LEDGER_KIND = "ae-a8n.attempt-ledger/v1";
export const GUI_EVIDENCE_KIND = "ae-a8n.gui-evidence/v1";

/** Spec §6 anchors — the numbers the spec itself fixes. */
export const FIXED = {
  /** `readinessTimeoutMs` default, `src/api/types.ts` / driver. */
  readinessTimeoutMs: 180_000,
  /** `DEFAULT_MONITOR_INTERVAL_MS`, `src/supervision/monitor.ts`. */
  monitorIntervalMs: 2_000,
  /** `DEFAULT_MONITOR_TTL_MS`, `src/supervision/state.ts`. */
  monitorTtlMs: 30_000,
  /** Driver default `recoveryGraceMs`, `src/driver/driver.ts`. */
  recoveryGraceMs: 60_000,
  /** Spec §6/§7 consecutive-success rule. */
  consecutiveRequired: 10,
  /** gui-evidence spec §11 proposal: <5% frame-drop at 30 fps. */
  recordingMaxFrameDropRatio: 0.05,
  recordingTargetFps: 30,
};

const BLOCKING_PHASES = new Set(["blocked", "recovering"]);
const RESOLUTION_PHASES = new Set(["resumed", "needs-human", "quarantined"]);

const ATTEMPT_OUTCOMES = new Set([
  "ok",
  "error",
  "indeterminate",
  "refused",
  "blocked",
  "environment",
]);

/** Spec §5.2/§7 verdict vocabulary; ledger `outcome` maps onto it. */
const SPEC_VERDICTS = new Set([
  "pass",
  "fail",
  "indeterminate",
  "blocked",
  "environment",
  "skipped",
  "not-applicable",
]);

const OUTCOME_TO_VERDICT = {
  ok: "pass",
  error: "fail",
  refused: "fail",
  indeterminate: "indeterminate",
  blocked: "blocked",
  environment: "environment",
};

/* ------------------------------------------------------------------ */
/* Loading / validation                                                */
/* ------------------------------------------------------------------ */

function readJsonLines(path) {
  const problems = [];
  /** @type {object[]} */
  const rows = [];
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return { rows, problems: [`unreadable:${path}:${String(error)}`] };
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      problems.push(`invalid-jsonl:${path}:${i + 1}:${String(error)}`);
    }
  }
  return { rows, problems };
}

/**
 * Parse an attempt ledger: line 1 must be the versioned envelope; every
 * later line an attempt record. Unknown kinds/versions are named
 * problems, never guessed (spec §3/§5.1).
 */
export function loadAttemptLedger(path) {
  const { rows, problems } = readJsonLines(path);
  const attempts = [];
  if (rows.length === 0) {
    return { envelope: null, attempts, problems };
  }
  const envelope = rows[0];
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.kind !== ATTEMPT_LEDGER_KIND ||
    envelope.schemaVersion !== 1
  ) {
    problems.push(`invalid-ledger:${path}:envelope`);
    return { envelope: null, attempts, problems };
  }
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const at = `${path}:${i + 1}`;
    if (row === null || typeof row !== "object" || row.type !== "attempt") {
      problems.push(`invalid-ledger:${at}:not-an-attempt`);
      continue;
    }
    if (typeof row.attemptId !== "string" || typeof row.feature !== "string") {
      problems.push(`invalid-ledger:${at}:identity`);
      continue;
    }
    if (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs)) {
      problems.push(`invalid-ledger:${at}:durationMs`);
      continue;
    }
    const outcome = row.outcome;
    if (typeof outcome !== "string" || !ATTEMPT_OUTCOMES.has(outcome)) {
      problems.push(`invalid-ledger:${at}:outcome`);
      continue;
    }
    attempts.push(row);
  }
  return { envelope, attempts, problems };
}

/** Parse a trace.jsonl: rows are flat TraceEvent objects. */
export function loadTrace(path) {
  const { rows, problems } = readJsonLines(path);
  const events = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const at = `${path}:${i + 1}`;
    if (row === null || typeof row !== "object" || typeof row.op !== "string") {
      problems.push(`invalid-trace:${at}`);
      continue;
    }
    if (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs)) {
      problems.push(`invalid-trace:${at}:durationMs`);
      continue;
    }
    events.push(row);
  }
  return { events, problems };
}

function loadJson(path, kind) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    if (doc === null || typeof doc !== "object") {
      return { doc: null, problems: [`invalid-document:${path}:not-an-object`] };
    }
    if (kind !== undefined && doc.kind !== kind) {
      return { doc: null, problems: [`invalid-document:${path}:kind`] };
    }
    return { doc, problems: [] };
  } catch (error) {
    return { doc: null, problems: [`unreadable:${path}:${String(error)}`] };
  }
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/** Nearest-rank percentile on an ascending-sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarizeDurations(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} input
 * @param {object[]} input.attempts   parsed attempt records (all ledgers)
 * @param {object[]} input.traceEvents parsed trace events (all traces)
 * @param {object[]} input.evidenceIndexes parsed gui-evidence docs
 * @param {object|null} input.manifest run manifest (§6 pre-declared budgets)
 * @param {boolean} input.recordingInCandidate manifest flag for RC-S14
 * @param {object[]} input.teardowns parsed teardown verdict docs (§10)
 */
export function evaluateAcceptanceMetrics({
  attempts,
  traceEvents,
  evidenceIndexes,
  manifest,
  recordingInCandidate,
  teardowns = [],
}) {
  const reasons = [];
  const notes = [];
  const budgets = [];
  const manifestBudgets =
    manifest !== null &&
    typeof manifest === "object" &&
    manifest.budgets !== null &&
    typeof manifest.budgets === "object"
      ? /** @type {Record<string, unknown>} */ (manifest.budgets)
      : {};

  const recordingRequested =
    recordingInCandidate === true || evidenceIndexes.length > 0;

  /* -- §6 readiness probe bound -------------------------------------- */
  {
    const launches = traceEvents.filter((e) => e.op === "session.launch");
    const bound =
      typeof manifestBudgets["readinessProbeMs"] === "number"
        ? manifestBudgets["readinessProbeMs"]
        : FIXED.readinessTimeoutMs;
    const basis =
      typeof manifestBudgets["readinessProbeMs"] === "number"
        ? "manifest"
        : "fixed (spec §6 readinessTimeoutMs default 180000)";
    const durations = launches
      .filter((e) => e.status === "ok")
      .map((e) => e.durationMs);
    const measured = summarizeDurations(durations);
    const failedLaunches = launches.filter((e) => e.status !== "ok");
    let status = "pass";
    if (durations.length === 0 && failedLaunches.length === 0) {
      status = "unmeasured";
      // Fail-closed only against a manifest-declared bound: the fixed
      // 180 s figure is the transport default, and a ledger-only or
      // attach-only input legitimately has no session.launch row.
      if (typeof manifestBudgets["readinessProbeMs"] === "number") {
        reasons.push("budget-unmeasured:readiness-probe");
      } else {
        notes.push("readiness-probe: no session.launch rows; bound unmeasured");
      }
    } else if (failedLaunches.length > 0) {
      // A failed readiness probe is already a scenario fail upstream;
      // the budget row reports it rather than double-denying.
      status = "unmeasured";
      notes.push(
        `readiness-probe: ${failedLaunches.length} session.launch row(s) did not succeed; ` +
          "the bound applies to successful launches only",
      );
    } else if (measured.max !== null && measured.max > bound) {
      status = "fail";
      reasons.push(
        `budget-breach:readiness-probe:max=${measured.max}ms>bound=${bound}ms`,
      );
    }
    // Named phases (spawn / OS observation / ExtendScript response /
    // handshake): the trace does not split session.launch into phases
    // today, so per-phase bounds are reported, never invented.
    const phased = launches.some(
      (e) => Array.isArray(e.stepTimings) && e.stepTimings.length > 0,
    );
    budgets.push({
      name: "readiness-probe",
      status,
      basis,
      boundMs: bound,
      measured,
      phases:
        typeof manifestBudgets["readinessPhases"] === "object" &&
        manifestBudgets["readinessPhases"] !== null
          ? manifestBudgets["readinessPhases"]
          : null,
      phasesMeasured: phased,
      note: phased
        ? undefined
        : "session.launch is not split into named readiness phases in " +
          "trace.jsonl today; per-phase bounds are unmeasurable until the " +
          "harness records stepTimings — spec §6 phase granularity gap",
    });
    if (!phased) {
      notes.push("readiness-probe: phase-level bounds unmeasured (see budget row note)");
    }
  }

  /* -- §6 representative op durationMs p50/p95 ------------------------ */
  {
    const declared = manifestBudgets["ops"];
    const declaredOps =
      declared !== null && typeof declared === "object"
        ? /** @type {Record<string, { p50Ms?: number; p95Ms?: number }>} */ (declared)
        : null;
    const byFeature = new Map();
    for (const a of attempts) {
      if (a.outcome !== "ok") continue;
      const list = byFeature.get(a.feature) ?? [];
      list.push(a.durationMs);
      byFeature.set(a.feature, list);
    }
    const features = [
      ...new Set([
        ...(declaredOps !== null ? Object.keys(declaredOps) : []),
        ...byFeature.keys(),
      ]),
    ].sort();
    for (const feature of features) {
      const budget = declaredOps?.[feature] ?? declaredOps?.["*"];
      const durations = byFeature.get(feature) ?? [];
      const measured = summarizeDurations(durations);
      if (budget === undefined) {
        budgets.push({
          name: `ops:${feature}`,
          status: durations.length === 0 ? "unmeasured" : "provisional",
          measured,
          note: "no manifest budget declared; measured baseline only (spec §6: numbers fixed per RC from pre-RC baseline)",
        });
        continue;
      }
      const boundP50 = typeof budget.p50Ms === "number" ? budget.p50Ms : null;
      const boundP95 = typeof budget.p95Ms === "number" ? budget.p95Ms : null;
      if (durations.length === 0) {
        budgets.push({
          name: `ops:${feature}`,
          status: "unmeasured",
          measured,
          bound: budget,
        });
        reasons.push(`budget-unmeasured:ops:${feature}`);
        continue;
      }
      const breaches = [];
      if (boundP50 !== null && measured.p50 !== null && measured.p50 > boundP50) {
        breaches.push(`p50=${measured.p50}ms>${boundP50}ms`);
      }
      if (boundP95 !== null && measured.p95 !== null && measured.p95 > boundP95) {
        breaches.push(`p95=${measured.p95}ms>${boundP95}ms`);
      }
      if (breaches.length > 0) {
        budgets.push({ name: `ops:${feature}`, status: "fail", measured, bound: budget, breaches });
        reasons.push(`budget-breach:ops:${feature}:${breaches.join(",")}`);
      } else {
        budgets.push({ name: `ops:${feature}`, status: "pass", measured, bound: budget });
      }
    }
    if (declaredOps === null) {
      notes.push(
        "ops: no manifest budgets declared; all features reported as provisional baselines",
      );
    }
  }

  /* -- §6 recovery wait bound ------------------------------------------ */
  {
    // From a transition into a blocking phase to the next transition
    // into resumed/needs-human/quarantined, using each row's
    // result.enteredAt (phase-entry wall clock) with the row ts as
    // fallback.
    const transitions = traceEvents
      .filter((e) => e.op === "supervision.transition")
      .map((e) => {
        const result = e.result ?? {};
        const enteredAt =
          typeof result.enteredAt === "string" ? result.enteredAt : e.ts;
        return { ts: e.ts, to: result.to, enteredAt };
      })
      .filter((t) => typeof t.to === "string");
    const waits = [];
    for (let i = 0; i < transitions.length; i += 1) {
      const t = transitions[i];
      if (t === undefined || !BLOCKING_PHASES.has(/** @type {string} */ (t.to))) continue;
      for (let j = i + 1; j < transitions.length; j += 1) {
        const r = transitions[j];
        if (r === undefined) continue;
        if (RESOLUTION_PHASES.has(/** @type {string} */ (r.to))) {
          const start = Date.parse(t.enteredAt);
          const end = Date.parse(r.enteredAt);
          if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            waits.push({ from: t.to, to: r.to, waitMs: end - start });
          }
          break;
        }
        if (BLOCKING_PHASES.has(/** @type {string} */ (r.to))) break;
      }
    }
    const measured = {
      ...summarizeDurations(waits.map((w) => w.waitMs)),
      waits,
    };
    const declared = manifestBudgets["recoveryWaitMs"];
    const grace =
      typeof manifestBudgets["recoveryGraceMs"] === "number"
        ? manifestBudgets["recoveryGraceMs"]
        : FIXED.recoveryGraceMs;
    const perClass =
      typeof manifestBudgets["recoveryPerClassMs"] === "number"
        ? manifestBudgets["recoveryPerClassMs"]
        : 0;
    const bound =
      typeof declared === "number" ? declared : grace + perClass;
    const basis =
      typeof declared === "number"
        ? "manifest"
        : `fixed anchor recoveryGraceMs=${grace} + per-class=${perClass}` +
          (perClass === 0 && typeof manifestBudgets["recoveryPerClassMs"] !== "number"
            ? " (per-class bound not declared — provisional)"
            : "");
    let status;
    if (waits.length === 0) {
      const declaredWait = typeof declared === "number";
      if (transitions.length === 0) {
        // No blocking state ever engaged: vacuous, not unmeasured.
        status = declaredWait ? "pass" : "unmeasured";
        notes.push("recovery-wait: no supervision.transition rows; nothing to bound");
      } else if (declaredWait) {
        status = "unmeasured";
        reasons.push("budget-unmeasured:recovery-wait");
      } else {
        status = "unmeasured";
        notes.push("recovery-wait: transitions present but no blocking→resolution pair measured");
      }
    } else if (measured.max !== null && measured.max > bound) {
      status = "fail";
      reasons.push(`budget-breach:recovery-wait:max=${measured.max}ms>bound=${bound}ms`);
    } else {
      status = typeof declared === "number" ? "pass" : "provisional";
    }
    budgets.push({
      name: "recovery-wait",
      status,
      basis,
      boundMs: bound,
      measured,
    });
  }

  /* -- §6 supervision detection latency ------------------------------- */
  {
    // The spec bound is monitor interval + observation latency +
    // classification confirm bound. The trace records phase transitions
    // but not the instant the blocking condition arose, so the true
    // detection latency is NOT measurable from these artifacts today.
    // What is measurable: publish→trace lag per transition and per-phase
    // dwell. Reported as provisional; a manifest-declared bound denies
    // as unmeasured rather than being judged on a proxy.
    const transitions = traceEvents.filter((e) => e.op === "supervision.transition");
    const lags = [];
    for (const e of transitions) {
      const enteredAt = e.result?.["enteredAt"];
      if (typeof enteredAt === "string") {
        const lag = Date.parse(e.ts) - Date.parse(enteredAt);
        if (!Number.isNaN(lag)) lags.push(lag);
      }
    }
    const measured = {
      transitionCount: transitions.length,
      publishToTraceMs: summarizeDurations(lags),
      note:
        "blocking-condition-arisal timestamp is not recorded in " +
        "trace.jsonl; detection latency proper is unmeasurable — " +
        "spec §6 gap (harness must timestamp the observed condition)",
    };
    const declared = manifestBudgets["detectionLatencyMs"];
    let status;
    if (typeof declared === "number") {
      status = "unmeasured";
      reasons.push("budget-unmeasured:supervision-detection-latency");
    } else {
      status = "provisional";
      notes.push(
        "supervision-detection-latency: no manifest bound declared; measured proxies only",
      );
    }
    budgets.push({
      name: "supervision-detection-latency",
      status,
      basis:
        "fixed anchors monitorIntervalMs=" +
        `${FIXED.monitorIntervalMs} + monitorTtlMs=${FIXED.monitorTtlMs}; ` +
        "observation/confirm components are manifest-declared per RC",
      boundMs: typeof declared === "number" ? declared : null,
      measured,
    });
  }

  /* -- §6 recording overhead (gui-evidence §11) ------------------------ */
  {
    if (!recordingRequested) {
      budgets.push({
        name: "recording-overhead",
        status: "unmeasured",
        note: "recording is not in the candidate and no evidence index was supplied (RC-S14 not-applicable)",
      });
    } else {
      const stats = [];
      for (const doc of evidenceIndexes) {
        const captureStats = doc?.captureStats;
        if (captureStats !== null && typeof captureStats === "object") {
          stats.push(captureStats);
        }
      }
      const dropBreaches = [];
      const overheads = [];
      let unmeasured = 0;
      for (const s of stats) {
        const requested = typeof s.requestedFps === "number" ? s.requestedFps : null;
        const achieved = typeof s.achievedFps === "number" ? s.achievedFps : null;
        if (requested !== null && achieved !== null && requested > 0) {
          const dropRatio = Math.max(0, 1 - achieved / requested);
          // The §11 proposal budgets <5% drop at the 30 fps target;
          // evaluate every segment against it.
          if (dropRatio > FIXED.recordingMaxFrameDropRatio) {
            dropBreaches.push({ requestedFps: requested, achievedFps: achieved, dropRatio });
          }
        } else {
          unmeasured += 1;
        }
        if (typeof s.measuredOverheadMs === "number") {
          overheads.push(s.measuredOverheadMs);
        }
      }
      const measured = {
        segments: stats.length,
        dropBreaches,
        measuredOverheadMs: summarizeDurations(overheads),
        unmeasuredSegments: unmeasured,
      };
      const declaredOverhead = manifestBudgets["recordingMaxOverheadMs"];
      let status = "provisional";
      const breaches = [];
      if (dropBreaches.length > 0) {
        // gui-evidence §11: a breach reports `degraded` with numbers —
        // an honest verdict, not a hidden loss and not a scenario fail.
        status = "degraded";
        breaches.push(
          `frame-drop ${dropBreaches.map((b) => `${(b.dropRatio * 100).toFixed(1)}%`).join(",")} > ${FIXED.recordingMaxFrameDropRatio * 100}% (gui-evidence §11 proposal)`,
        );
      }
      if (typeof declaredOverhead === "number") {
        const max = measured.measuredOverheadMs.max;
        if (max === null) {
          status = "unmeasured";
          reasons.push("budget-unmeasured:recording-overhead");
        } else if (max > declaredOverhead) {
          status = status === "degraded" ? "degraded" : "fail";
          breaches.push(`measuredOverheadMs max=${max}ms>${declaredOverhead}ms`);
          if (status === "fail") {
            reasons.push(`budget-breach:recording-overhead:max=${max}ms>${declaredOverhead}ms`);
          }
        }
      }
      budgets.push({
        name: "recording-overhead",
        status,
        basis:
          "gui-evidence spec §11 proposal (<5% frame-drop at 30 fps); " +
          "op-latency bound is provisional until the RC manifest declares it",
        bound: {
          maxFrameDropRatio: FIXED.recordingMaxFrameDropRatio,
          targetFps: FIXED.recordingTargetFps,
          ...(typeof declaredOverhead === "number"
            ? { maxMeasuredOverheadMs: declaredOverhead }
            : {}),
        },
        measured,
        breaches: breaches.length > 0 ? breaches : undefined,
      });
      if (stats.length === 0) {
        notes.push("recording-overhead: evidence index supplied but carries no captureStats");
      }
    }
  }

  /* -- §6/§7 consecutive success --------------------------------------- */
  const reproducibility = evaluateReproducibility({ attempts, manifest });
  budgets.push({
    name: "consecutive-success",
    status:
      reproducibility.groups.length === 0
        ? "unmeasured"
        : reproducibility.groups.every((g) => g.accepted)
          ? "pass"
          : "pending",
    bound: { required: FIXED.consecutiveRequired },
    measured: {
      groups: reproducibility.groups.map((g) => ({
        group: g.group,
        trailingPass: g.trailingPass,
        accepted: g.accepted,
      })),
    },
    note: "report-only aggregate; per-scenario acceptance is §12.3",
  });

  /* -- §10 teardown verdicts ------------------------------------------ */
  const teardownSummary = { clean: 0, residue: 0, unverifiable: 0 };
  for (const doc of teardowns) {
    const verdict = doc?.verdict;
    if (verdict === "clean" || verdict === "residue" || verdict === "unverifiable") {
      teardownSummary[verdict] += 1;
    } else {
      reasons.push("invalid-teardown:verdict");
      continue;
    }
    if (verdict !== "clean") {
      notes.push(
        `teardown:${doc.sessionId ?? "?"}: ${verdict} — ` +
          (Array.isArray(doc.items)
            ? doc.items
                .filter((i) => i && i.verdict !== "clean")
                .map((i) => `${i.area}=${i.verdict}${i.safetyRelevant ? "(safety)" : ""}`)
                .join(", ")
            : "no item detail"),
      );
    }
    const safetyResidue = Array.isArray(doc.items)
      ? doc.items.filter((i) => i && i.verdict === "residue" && i.safetyRelevant === true)
      : [];
    for (const item of safetyResidue) {
      reasons.push(
        `safety-residue:${doc.sessionId ?? "?"}:${item.area}`,
      );
    }
  }

  return {
    budgets,
    reproducibility,
    teardowns: teardownSummary,
    notes,
    verdict: {
      action: reasons.length === 0 ? "allow" : "deny",
      reasons,
    },
  };
}

/* ------------------------------------------------------------------ */
/* §7 reproducibility                                                  */
/* ------------------------------------------------------------------ */

/**
 * Aggregate attempts per scenario/feature. `blocked`, `environment`,
 * `skipped` and `indeterminate` never count as pass and break the
 * consecutive streak (spec §7/§11.1). Group key is `scenarioId` when
 * the record carries one (harness-level spec §5.2 records), else the
 * op-level `feature`.
 */
export function evaluateReproducibility({ attempts, manifest }) {
  const groups = new Map();
  for (const a of attempts) {
    const group =
      typeof a.scenarioId === "string" && a.scenarioId !== ""
        ? a.scenarioId
        : a.feature;
    const list = groups.get(group) ?? [];
    list.push(a);
    groups.set(group, list);
  }

  // Candidate/fixture binding (spec §3/§7): when records or the
  // manifest carry identity fields, every value must agree. Mixed
  // identity is a named deny, never averaged away.
  const identityProblems = [];
  const collect = (field, get) => {
    const values = new Set();
    for (const a of attempts) {
      const v = get(a);
      if (typeof v === "string" && v !== "") values.add(v);
    }
    if (values.size > 1) {
      identityProblems.push(`mixed-candidate:${field}`);
    }
    return [...values];
  };
  collect("commit", (a) => a.candidate?.commit ?? a.commit);
  collect("tarballSha256", (a) => a.candidate?.tarballSha256 ?? a.tarballSha256);
  collect("fixtureHash", (a) => a.fixture?.hash ?? a.fixtureHash);
  const manifestCandidate =
    manifest !== null && typeof manifest === "object" ? manifest.candidate : undefined;
  const manifestFixture =
    manifest !== null && typeof manifest === "object" ? manifest.fixture : undefined;
  if (manifestCandidate !== null && typeof manifestCandidate === "object") {
    for (const a of attempts) {
      const commit = a.candidate?.commit ?? a.commit;
      if (
        typeof commit === "string" &&
        commit !== "" &&
        typeof manifestCandidate.commit === "string" &&
        commit !== manifestCandidate.commit
      ) {
        identityProblems.push("candidate-mismatch:commit");
        break;
      }
    }
  }
  if (manifestFixture !== null && typeof manifestFixture === "object") {
    for (const a of attempts) {
      const hash = a.fixture?.hash ?? a.fixtureHash;
      if (
        typeof hash === "string" &&
        hash !== "" &&
        typeof manifestFixture.hash === "string" &&
        hash !== manifestFixture.hash
      ) {
        identityProblems.push("fixture-mismatch:hash");
        break;
      }
    }
  }

  const out = [];
  for (const [group, list] of [...groups.entries()].sort()) {
    let pass = 0;
    let fail = 0;
    let indeterminate = 0;
    let blocked = 0;
    let environment = 0;
    let skipped = 0;
    let notApplicable = 0;
    let anomalies = 0;
    let trailingPass = 0;
    // Trailing streak is computed over the attempt ORDER as recorded —
    // the ledger is append-only, so file order is attempt order.
    for (const a of list) {
      const verdict =
        typeof a.verdict === "string" && SPEC_VERDICTS.has(a.verdict)
          ? a.verdict
          : OUTCOME_TO_VERDICT[a.outcome] ?? "fail";
      if (verdict === "pass") {
        pass += 1;
        trailingPass += 1;
      } else {
        trailingPass = 0;
        if (verdict === "fail") fail += 1;
        else if (verdict === "indeterminate") indeterminate += 1;
        else if (verdict === "blocked") blocked += 1;
        else if (verdict === "environment") environment += 1;
        else if (verdict === "skipped") skipped += 1;
        else if (verdict === "not-applicable") notApplicable += 1;
      }
      if (a.anomaly !== undefined && a.anomaly !== null) anomalies += 1;
    }
    const total = list.length;
    out.push({
      group,
      attempts: total,
      pass,
      fail,
      indeterminate,
      blocked,
      environment,
      skipped,
      notApplicable,
      anomalies,
      successRate: total === 0 ? null : pass / total,
      indeterminateRate: total === 0 ? null : indeterminate / total,
      anomalyDetectionRate: total === 0 ? null : anomalies / total,
      trailingPass,
      accepted: trailingPass >= FIXED.consecutiveRequired,
    });
  }
  return { groups: out, identityProblems };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  /** @type {Record<string, string[]>} */
  const args = { ledger: [], trace: [], "evidence-index": [], teardown: [] };
  const singles = new Set(["manifest", "out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] ?? "";
    i += 1;
    if (singles.has(key)) {
      args[key] = [value];
    } else if (key in args) {
      args[key].push(value);
    }
  }
  return args;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const problems = [];

  const attempts = [];
  const traceEvents = [];
  const evidenceIndexes = [];
  const envelopes = [];

  for (const file of args.ledger) {
    const { envelope, attempts: rows, problems: p } = loadAttemptLedger(resolve(file));
    problems.push(...p);
    attempts.push(...rows);
    if (envelope !== null) envelopes.push(envelope);
  }
  for (const file of args.trace) {
    const { events, problems: p } = loadTrace(resolve(file));
    problems.push(...p);
    traceEvents.push(...events);
  }
  for (const file of args["evidence-index"]) {
    const { doc, problems: p } = loadJson(resolve(file), GUI_EVIDENCE_KIND);
    problems.push(...p);
    if (doc !== null) evidenceIndexes.push(doc);
  }
  const teardowns = [];
  for (const file of args.teardown) {
    const { doc, problems: p } = loadJson(resolve(file));
    problems.push(...p);
    if (doc !== null) teardowns.push(doc);
  }

  /** @type {object|null} */
  let manifest = null;
  if (args.manifest.length > 0) {
    const { doc, problems: p } = loadJson(resolve(args.manifest[0]), undefined);
    problems.push(...p);
    manifest = doc;
  }

  const recordingInCandidate =
    manifest !== null &&
    typeof manifest === "object" &&
    manifest.recordingInCandidate === true;

  if (attempts.length === 0 && traceEvents.length === 0) {
    problems.push("no-input: supply --ledger and/or --trace artifacts");
  }

  const result = evaluateAcceptanceMetrics({
    attempts,
    traceEvents,
    evidenceIndexes,
    teardowns,
    manifest,
    recordingInCandidate,
  });
  // Identity problems are fail-closed denials (spec §3/§7).
  const verdictReasons = [...result.reproducibility.identityProblems, ...result.verdict.reasons];

  const report = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    kind: METRICS_KIND,
    generatedAt: new Date().toISOString(),
    inputs: {
      ledgers: args.ledger,
      traces: args.trace,
      evidenceIndexes: args["evidence-index"],
      manifest: args.manifest[0] ?? null,
      envelopes,
    },
    budgets: result.budgets,
    reproducibility: result.reproducibility,
    teardowns: result.teardowns,
    notes: [...result.notes, ...problems],
    verdict: { action: problems.length > 0 || verdictReasons.length > 0 ? "deny" : "allow", reasons: verdictReasons },
  };

  const out = args.out[0];
  if (out !== undefined) {
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  for (const problem of problems) console.error(`::error::acceptance-metrics: ${problem}`);
  for (const reason of verdictReasons) console.error(`::error::acceptance-metrics: ${reason}`);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const budget of result.budgets) {
    console.log(`budget ${budget.name}: ${budget.status}`);
  }
  console.log(
    `acceptance metrics: ${attempts.length} attempts, ${result.reproducibility.groups.length} groups — ${report.verdict.action}`,
  );
  if (report.verdict.action !== "allow" || problems.length > 0) {
    process.exit(1);
  }
}
