/**
 * `scripts/acceptance-metrics.js` — RC acceptance budget and
 * reproducibility evaluation (#435, spec §6/§7/§10/§11).
 *
 * Fixture ledgers/traces are built in-test; the fail-closed contract is:
 * declared-but-unmeasurable budgets deny, spec-fixed anchors enforce,
 * undeclared budgets report provisional baselines, and
 * blocked/environment/skipped/indeterminate never count as pass.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../scripts/acceptance-metrics.js", import.meta.url),
);
const metrics = (await import(pathToFileURL(scriptPath).href)) as {
  evaluateAcceptanceMetrics: (input: {
    attempts: Record<string, unknown>[];
    traceEvents?: Record<string, unknown>[];
    evidenceIndexes?: Record<string, unknown>[];
    teardowns?: Record<string, unknown>[];
    manifest?: Record<string, unknown> | null;
    recordingInCandidate?: boolean;
  }) => {
    budgets: { name: string; status: string; measured?: unknown; reasons?: string[] }[];
    reproducibility: {
      groups: {
        group: string;
        attempts: number;
        pass: number;
        blocked: number;
        environment: number;
        trailingPass: number;
        accepted: boolean;
      }[];
      identityProblems: string[];
    };
    teardowns: { clean: number; residue: number; unverifiable: number };
    verdict: { action: string; reasons: string[] };
  };
  loadAttemptLedger: (path: string) => {
    envelope: unknown;
    attempts: Record<string, unknown>[];
    problems: string[];
  };
  percentile: (sorted: number[], p: number) => number | null;
  FIXED: Record<string, number>;
};

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    type: "attempt",
    attemptId: "att-1",
    feature: "project.open",
    startedAt: "2026-11-28T00:00:00.000Z",
    endedAt: "2026-11-28T00:00:01.000Z",
    durationMs: 1000,
    outcome: "ok",
    sessionId: "s1",
    sessionRoot: "/tmp/s1",
    ...overrides,
  };
}

function traceEvent(op: string, durationMs: number, extra: Record<string, unknown> = {}) {
  return {
    seq: 1,
    ts: "2026-11-28T00:00:00.000Z",
    op,
    status: "ok",
    durationMs,
    ...extra,
  };
}

function budgetOf(result: ReturnType<typeof metrics.evaluateAcceptanceMetrics>, name: string) {
  const b = result.budgets.find((x) => x.name === name);
  expect(b, `budget ${name} missing`).toBeDefined();
  return b!;
}

describe("acceptance-metrics: ledger loading", () => {
  it("rejects a ledger with the wrong envelope kind or schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "a8n-ledger-"));
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, `${JSON.stringify({ kind: "other/v9", schemaVersion: 9 })}\n`);
    const { attempts, problems } = metrics.loadAttemptLedger(bad);
    expect(attempts).toHaveLength(0);
    expect(problems.join(" ")).toContain("invalid-ledger");
  });

  it("parses envelope + attempt rows and flags malformed rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "a8n-ledger-"));
    const file = join(dir, "attempt-ledger.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          schemaVersion: 1,
          kind: "ae-a8n.attempt-ledger/v1",
          sessionId: "s",
          sessionRoot: "/x",
          platform: "darwin",
          startedAt: "2026-11-28T00:00:00.000Z",
        }),
        JSON.stringify(attempt()),
        JSON.stringify({ type: "attempt", feature: "x" }), // missing ids/duration/outcome
        "{not json",
      ].join("\n"),
    );
    const { envelope, attempts, problems } = metrics.loadAttemptLedger(file);
    expect(envelope).not.toBeNull();
    expect(attempts).toHaveLength(1);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("acceptance-metrics: §6 budgets", () => {
  it("enforces the fixed readiness bound and reports phase gap honestly", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [traceEvent("session.launch", 200_000)],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    const b = budgetOf(result, "readiness-probe");
    expect(b.status).toBe("fail");
    expect(result.verdict.action).toBe("deny");
    expect(result.verdict.reasons.join(" ")).toContain("budget-breach:readiness-probe");
    expect((b as { note?: string }).note ?? "").toContain("phases");
  });

  it("passes readiness within the fixed bound", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [traceEvent("session.launch", 30_000)],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    expect(budgetOf(result, "readiness-probe").status).toBe("pass");
  });

  it("judges declared op p50/p95 budgets fail-closed", () => {
    const attempts = Array.from({ length: 20 }, (_, i) =>
      attempt({ attemptId: `a${i}`, durationMs: i < 10 ? 100 : 5000 }),
    );
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: { budgets: { ops: { "project.open": { p50Ms: 1000, p95Ms: 2000 } } } },
    });
    const b = budgetOf(result, "ops:project.open");
    expect(b.status).toBe("fail");
    expect(result.verdict.reasons.join(" ")).toContain("budget-breach:ops:project.open");
  });

  it("reports undeclared op budgets as provisional baselines, never denying", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [attempt({ durationMs: 42 })],
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    const b = budgetOf(result, "ops:project.open");
    expect(b.status).toBe("provisional");
    expect(result.verdict.action).toBe("allow");
  });

  it("denies a declared op budget that has no measured attempts", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: { budgets: { ops: { "comp.renderFrame": { p95Ms: 100 } } } },
    });
    expect(result.verdict.reasons).toContain("budget-unmeasured:ops:comp.renderFrame");
    expect(result.verdict.action).toBe("deny");
  });

  it("measures recovery wait from supervision transitions", () => {
    const transitions = [
      traceEvent("supervision.transition", 0, {
        result: { from: "running", to: "blocked", enteredAt: "2026-11-28T00:00:00.000Z" },
        ts: "2026-11-28T00:00:02.000Z",
      }),
      traceEvent("supervision.transition", 0, {
        result: { from: "blocked", to: "resumed", enteredAt: "2026-11-28T00:00:30.000Z" },
        ts: "2026-11-28T00:00:30.000Z",
      }),
    ];
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: transitions,
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    const b = budgetOf(result, "recovery-wait");
    expect(b.status).toBe("provisional"); // per-class bound undeclared
    const measured = b.measured as { waits: { waitMs: number }[] };
    expect(measured.waits[0]?.waitMs).toBe(30_000);
  });

  it("denies a manifest-declared detection latency as unmeasured (spec gap)", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [traceEvent("supervision.transition", 0, { result: { to: "blocked" } })],
      evidenceIndexes: [],
      teardowns: [],
      manifest: { budgets: { detectionLatencyMs: 5000 } },
    });
    expect(result.verdict.reasons).toContain("budget-unmeasured:supervision-detection-latency");
    expect(budgetOf(result, "supervision-detection-latency").status).toBe("unmeasured");
  });

  it("reports recording frame-drop breach as degraded, not a deny", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [],
      evidenceIndexes: [
        {
          kind: "ae-a8n.gui-evidence/v1",
          captureStats: { requestedFps: 30, achievedFps: 20, droppedFrames: 300 },
        },
      ],
      teardowns: [],
      manifest: null,
      recordingInCandidate: true,
    });
    const b = budgetOf(result, "recording-overhead");
    expect(b.status).toBe("degraded");
    expect(result.verdict.action).toBe("allow");
  });

  it("marks recording not-applicable when the capability is absent", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
      recordingInCandidate: false,
    });
    expect(budgetOf(result, "recording-overhead").status).toBe("unmeasured");
  });
});

describe("acceptance-metrics: §7 reproducibility", () => {
  it("counts blocked/environment/skipped as non-pass and breaks streaks", () => {
    const attempts = [
      ...Array.from({ length: 9 }, (_, i) => attempt({ attemptId: `p${i}`, outcome: "ok" })),
      attempt({ attemptId: "b1", outcome: "blocked" }),
      ...Array.from({ length: 3 }, (_, i) => attempt({ attemptId: `q${i}`, outcome: "ok" })),
    ];
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    const g = result.reproducibility.groups.find((x) => x.group === "project.open")!;
    expect(g.attempts).toBe(13);
    expect(g.pass).toBe(12);
    expect(g.blocked).toBe(1);
    expect(g.trailingPass).toBe(3);
    expect(g.accepted).toBe(false);
    expect(budgetOf(result, "consecutive-success").status).toBe("pending");
  });

  it("accepts a group after 10 consecutive passes", () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      attempt({ attemptId: `p${i}`, outcome: "ok" }),
    );
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    expect(result.reproducibility.groups[0]?.accepted).toBe(true);
    expect(budgetOf(result, "consecutive-success").status).toBe("pass");
  });

  it("refused and indeterminate outcomes never count as pass", () => {
    const attempts = [
      attempt({ attemptId: "a", outcome: "refused" }),
      attempt({ attemptId: "b", outcome: "indeterminate" }),
      attempt({ attemptId: "c", verdict: "skipped", outcome: "ok" }),
    ];
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    const g = result.reproducibility.groups[0]!;
    const gg = g as unknown as Record<string, number>;
    expect(gg["pass"]).toBe(0);
    expect(gg["fail"]).toBe(1);
    expect(gg["indeterminate"]).toBe(1);
    expect(gg["skipped"]).toBe(1);
    expect(g.trailingPass).toBe(0);
  });

  it("denies mixed candidate identity across attempts", () => {
    const attempts = [
      attempt({ attemptId: "a", candidate: { commit: "a".repeat(40) } }),
      attempt({ attemptId: "b", candidate: { commit: "b".repeat(40) } }),
    ];
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: null,
    });
    expect(result.reproducibility.identityProblems).toContain("mixed-candidate:commit");
  });

  it("denies candidate mismatch against the manifest", () => {
    const attempts = [attempt({ candidate: { commit: "b".repeat(40) } })];
    const result = metrics.evaluateAcceptanceMetrics({
      attempts,
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [],
      manifest: { candidate: { commit: "a".repeat(40) } },
    });
    expect(result.reproducibility.identityProblems).toContain("candidate-mismatch:commit");
  });
});

describe("acceptance-metrics: §10 teardown", () => {
  it("denies safety-relevant residue", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [
        {
          sessionId: "s1",
          verdict: "residue",
          items: [{ area: "input", verdict: "residue", safetyRelevant: true }],
        },
      ],
      manifest: null,
    });
    expect(result.verdict.reasons).toContain("safety-residue:s1:input");
    expect(result.verdict.action).toBe("deny");
    expect(result.teardowns.residue).toBe(1);
  });

  it("reports clean teardowns without denying", () => {
    const result = metrics.evaluateAcceptanceMetrics({
      attempts: [],
      traceEvents: [],
      evidenceIndexes: [],
      teardowns: [{ sessionId: "s1", verdict: "clean", items: [] }],
      manifest: null,
    });
    expect(result.teardowns.clean).toBe(1);
    expect(result.verdict.action).toBe("allow");
  });
});

describe("acceptance-metrics: statistics", () => {
  it("computes nearest-rank percentiles", () => {
    expect(metrics.percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(metrics.percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(metrics.percentile([], 50)).toBeNull();
  });
});
