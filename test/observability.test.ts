/**
 * #434 observability foundation: the op telemetry wrapper, the
 * attempt-ledger projection and the teardown verdict — all exercised
 * against the in-memory trace recorder and tmp dirs (no AE, no GUI).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";
import { OpTelemetry, observeOp, StepTimer } from "../src/observability/telemetry.js";
import {
  ATTEMPT_LEDGER_FILE,
  attemptFromEvent,
  AttemptLedger,
  outcomeForEvent,
} from "../src/observability/attempt-ledger.js";
import { writeTeardownVerdict } from "../src/observability/teardown.js";
import { recordLaunchProvenance } from "../src/driver/launch-provenance.js";
import type { Session } from "../src/api/session.js";
import type { CloseResult } from "../src/api/index.js";

const roots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ae-a8n-obs-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTelemetry(root: string): {
  telemetry: OpTelemetry;
  trace: TraceRecorder;
  events: TraceEvent[];
} {
  const trace = new TraceRecorder();
  const events: TraceEvent[] = [];
  trace.subscribe((event) => events.push(event));
  const telemetry = new OpTelemetry({
    trace,
    sessionRoot: root,
    sessionId: "sess-test",
  });
  return { telemetry, trace, events };
}

function ledgerLines(root: string): Record<string, unknown>[] {
  const text = readFileSync(join(root, ATTEMPT_LEDGER_FILE), "utf-8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("OpTelemetry", () => {
  it("records a trace row and one ledger attempt per op", async () => {
    const root = tmpRoot();
    const { telemetry, events } = makeTelemetry(root);

    const result = await telemetry.run(
      "panel.resize",
      () => ({ width: 100, height: 50, matchesRequested: true }),
      {
        args: { width: 100, height: 50 },
        expected: { width: 100, height: 50 },
        actual: ({
          result: r,
        }: {
          result?: { width: number; height: number; matchesRequested: boolean } | undefined;
          error?: unknown;
        }) =>
          r === undefined
            ? undefined
            : { width: r.width, height: r.height, matchesRequested: r.matchesRequested },
      },
    );

    expect(result.matchesRequested).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.op).toBe("panel.resize");
    expect(events[0]?.status).toBe("ok");
    expect(events[0]?.requestId).toMatch(/^req-/);
    expect(events[0]?.expected).toEqual({ width: 100, height: 50 });

    const lines = ledgerLines(root);
    // envelope + one attempt
    expect(lines).toHaveLength(2);
    expect(lines[0]?.["kind"]).toBe("ae-a8n.attempt-ledger/v1");
    const attempt = lines[1];
    expect(attempt?.["type"]).toBe("attempt");
    expect(attempt?.["feature"]).toBe("panel.resize");
    expect(attempt?.["outcome"]).toBe("ok");
    expect(attempt?.["sessionId"]).toBe("sess-test");
    expect(attempt?.["actual"]).toMatchObject({ matchesRequested: true });
    expect(typeof attempt?.["durationMs"]).toBe("number");
    expect(typeof attempt?.["startedAt"]).toBe("string");
    expect(typeof attempt?.["endedAt"]).toBe("string");
  });

  it("records failures as first-class attempts with the error's code as outcome", async () => {
    const root = tmpRoot();
    const { telemetry } = makeTelemetry(root);

    class CodedError extends Error {
      readonly code = "refused";
      constructor(message: string) {
        super(message);
        this.name = "CodedError";
      }
    }

    await expect(
      telemetry.run("menuBar.invoke", () => {
        throw new CodedError("gate closed");
      }),
    ).rejects.toThrow("gate closed");

    const lines = ledgerLines(root);
    const attempt = lines[1];
    expect(attempt?.["outcome"]).toBe("refused");
    expect(attempt?.["error"]).toMatchObject({ name: "CodedError" });
  });

  it("maps an explicit outcome override (e.g. audit verdicts) onto the ledger", async () => {
    const root = tmpRoot();
    const { telemetry } = makeTelemetry(root);

    await telemetry.run(
      "input.key-press",
      () => ({ verdict: "indeterminate" as const, valueReadback: null, steps: [] }),
      { outcome: () => "indeterminate" },
    );

    const attempt = ledgerLines(root)[1];
    expect(attempt?.["outcome"]).toBe("indeterminate");
  });

  it("carries stepTimings from the settled result onto the attempt", async () => {
    const root = tmpRoot();
    const { telemetry } = makeTelemetry(root);

    await telemetry.run("input.type-sequential", () => ({
      stepTimings: [
        { stepId: "step-0:type-sequential", durationMs: 3, actual: { outcome: "posted" } },
      ],
    }));

    const attempt = ledgerLines(root)[1];
    const timings = attempt?.["stepTimings"] as { stepId: string }[] | undefined;
    expect(timings?.[0]?.stepId).toBe("step-0:type-sequential");
  });
});

describe("observeOp", () => {
  it("passes the result and error through untouched without telemetry", async () => {
    const value = { ok: 1 };
    await expect(observeOp(undefined, "x.y", undefined, () => value)).resolves.toBe(value);
    const boom = new Error("boom");
    await expect(
      observeOp(undefined, "x.y", undefined, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("StepTimer", () => {
  it("collects per-step timings without altering results", async () => {
    let tick = 1000;
    const timer = new StepTimer(() => tick);
    const out = await timer.timed("resolve", () => {
      tick += 5;
      return 42;
    });
    expect(out).toBe(42);
    timer.timedSync("gate", () => {
      tick += 2;
      return "g";
    });
    expect(timer.timings).toEqual([
      { stepId: "resolve", startedAt: new Date(1000).toISOString(), durationMs: 5 },
      { stepId: "gate", startedAt: new Date(1005).toISOString(), durationMs: 2 },
    ]);
  });
});

describe("AttemptLedger", () => {
  it("writes a versioned envelope then one attempt per event", () => {
    const root = tmpRoot();
    const ledger = new AttemptLedger({ sessionId: "s", sessionRoot: root });
    const event: TraceEvent = {
      seq: 7,
      ts: new Date("2026-01-01T00:00:01.000Z").toISOString(),
      op: "panel.measure",
      status: "ok",
      durationMs: 12,
    };
    const record = ledger.append(event);
    expect(record.attemptId).toBe("att-7");
    expect(record.outcome).toBe("ok");
    expect(ledger.appended).toBe(1);

    const lines = ledgerLines(root);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.["schemaVersion"]).toBe(1);
  });

  it("derives indeterminate from timeout status", () => {
    const outcome = outcomeForEvent({
      seq: 1,
      ts: new Date().toISOString(),
      op: "x",
      status: "timeout",
      durationMs: 1,
    });
    expect(outcome).toBe("indeterminate");
  });

  it("attemptFromEvent prefers args.requestId and event.requestId", () => {
    const base = {
      seq: 3,
      ts: new Date().toISOString(),
      op: "project.open",
      status: "ok" as const,
      durationMs: 5,
    };
    const withArgs = attemptFromEvent(
      { ...base, args: { requestId: "req-abc" } },
      { sessionId: "s", sessionRoot: "/r" },
    );
    expect(withArgs.requestId).toBe("req-abc");
    const withField = attemptFromEvent(
      { ...base, requestId: "req-def" },
      { sessionId: "s", sessionRoot: "/r" },
    );
    expect(withField.requestId).toBe("req-def");
  });
});

// -- teardown verdict -------------------------------------------------------

function fakeSession(root: string, events: TraceEvent[]): Session {
  mkdirSync(join(root, "artifacts"), { recursive: true });
  return {
    driver: {
      sessionRoot: root,
      sessionId: "sess-teardown",
      artifactsDir: join(root, "artifacts"),
    },
    events,
    trace: new TraceRecorder(),
  } as unknown as Session;
}

const CLEAN_CLOSE: CloseResult = {
  quit: true,
  ownership: { kind: "owned" } as CloseResult["ownership"],
};

describe("writeTeardownVerdict", () => {
  it("reports clean when nothing ran and the host quit", () => {
    const root = tmpRoot();
    const report = writeTeardownVerdict(fakeSession(root, []), CLEAN_CLOSE, {
      leaseStateRoot: join(root, "leases"),
    });
    expect(report.verdict).toBe("clean");
    expect(report.sessionId).toBe("sess-teardown");
    expect(report.reportPath).toBe(join(root, "teardown-sess-teardown.json"));
    const onDisk = JSON.parse(
      readFileSync(join(root, "teardown-sess-teardown.json"), "utf-8"),
    ) as { verdict: string };
    expect(onDisk.verdict).toBe("clean");
  });

  it("flags input cleanup residue as safety-relevant", () => {
    const root = tmpRoot();
    const events: TraceEvent[] = [
      {
        seq: 1,
        ts: new Date().toISOString(),
        op: "input.key-press",
        status: "ok",
        durationMs: 4,
        result: { cleanupAllRestored: false },
      },
    ];
    const report = writeTeardownVerdict(fakeSession(root, events), CLEAN_CLOSE, {
      leaseStateRoot: join(root, "leases"),
    });
    expect(report.verdict).toBe("residue");
    const input = report.items.find((item) => item.area === "input");
    expect(input?.verdict).toBe("residue");
    expect(input?.safetyRelevant).toBe(true);
  });

  it("is unverifiable when close itself failed", () => {
    const root = tmpRoot();
    const report = writeTeardownVerdict(
      fakeSession(root, []),
      { error: "transport lost" },
      { leaseStateRoot: join(root, "leases") },
    );
    expect(report.verdict).toBe("unverifiable");
    const process = report.items.find((item) => item.area === "process");
    expect(process?.verdict).toBe("unverifiable");
  });

  describe("quit timeout (#443)", () => {
    const QUIT_TIMEOUT =
      "After Effects did not exit within 60000 ms of app.quit; it was left running";
    const HOST = {
      pid: 4242,
      startedAt: 1_700_000_000_000,
      identity: "creation-1",
      executable: "/Applications/AE.app/Contents/MacOS/After Effects",
    };

    function provenance(
      root: string,
      host: {
        pid: number;
        startedAt: number;
        identity?: string;
        executable: string;
      } = HOST,
    ): void {
      recordLaunchProvenance(root, { transport: "script-invocation", host });
    }

    function censusWith(host = HOST) {
      return () => [
        {
          pid: host.pid,
          startedAt: host.startedAt,
          executable: host.executable,
          identity: host.identity,
        },
      ];
    }

    it("is residue when the recorded host is still running", () => {
      const root = tmpRoot();
      provenance(root);
      const report = writeTeardownVerdict(
        fakeSession(root, []),
        { error: QUIT_TIMEOUT, quitTimedOut: true },
        {
          leaseStateRoot: join(root, "leases"),
          processCensus: censusWith(),
        },
      );
      const process = report.items.find((item) => item.area === "process");
      expect(process?.verdict).toBe("residue");
      expect(process?.safetyRelevant).toBe(true);
      expect(process?.detail).toContain("terminate-owned-host");
      expect(report.verdict).toBe("residue");
    });

    it("is clean when the recorded host is gone — the quit landed late", () => {
      const root = tmpRoot();
      provenance(root);
      const report = writeTeardownVerdict(
        fakeSession(root, []),
        { error: QUIT_TIMEOUT, quitTimedOut: true },
        {
          leaseStateRoot: join(root, "leases"),
          processCensus: () => [],
        },
      );
      const process = report.items.find((item) => item.area === "process");
      expect(process?.verdict).toBe("clean");
      expect(process?.detail).toContain("quit landed after its budget");
    });

    it("is unverifiable without launch provenance to re-identify the host", () => {
      const root = tmpRoot();
      const report = writeTeardownVerdict(
        fakeSession(root, []),
        { error: QUIT_TIMEOUT, quitTimedOut: true },
        {
          leaseStateRoot: join(root, "leases"),
          processCensus: censusWith(),
        },
      );
      const process = report.items.find((item) => item.area === "process");
      expect(process?.verdict).toBe("unverifiable");
      expect(report.verdict).toBe("unverifiable");
    });

    it("is unverifiable when the census cannot be read", () => {
      const root = tmpRoot();
      provenance(root);
      const report = writeTeardownVerdict(
        fakeSession(root, []),
        { error: QUIT_TIMEOUT, quitTimedOut: true },
        {
          leaseStateRoot: join(root, "leases"),
          processCensus: () => {
            throw new Error("ps failed");
          },
        },
      );
      const process = report.items.find((item) => item.area === "process");
      expect(process?.verdict).toBe("unverifiable");
    });

    it("is unverifiable when the pid lives but the record has no start time", () => {
      const root = tmpRoot();
      // recordLaunchProvenance requires a start time; a record without one
      // is written directly, as an older or foreign writer could leave it.
      writeFileSync(
        join(root, "launch-provenance.json"),
        JSON.stringify({
          schema: "a8n.launch-provenance/v1",
          recordedAt: new Date().toISOString(),
          a8nVersion: "0.0.0-test",
          transport: "script-invocation",
          host: { ...HOST, startedAt: null, identity: null },
        }),
      );
      const report = writeTeardownVerdict(
        fakeSession(root, []),
        { error: QUIT_TIMEOUT, quitTimedOut: true },
        {
          leaseStateRoot: join(root, "leases"),
          processCensus: () => [
            { pid: HOST.pid, startedAt: 1, executable: HOST.executable },
          ],
        },
      );
      const process = report.items.find((item) => item.area === "process");
      expect(process?.verdict).toBe("unverifiable");
    });
  });

  it("flags an owned host that was not quit as process residue", () => {
    const root = tmpRoot();
    const report = writeTeardownVerdict(
      fakeSession(root, []),
      {
        quit: false,
        ownership: { kind: "owned" } as CloseResult["ownership"],
        reason: "already running",
      },
      { leaseStateRoot: join(root, "leases") },
    );
    const process = report.items.find((item) => item.area === "process");
    expect(process?.verdict).toBe("residue");
  });
});
