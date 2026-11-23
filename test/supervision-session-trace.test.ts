/**
 * `SupervisionSessionTracer` (#287): supervision phase transitions and
 * evaluated observation health — including monitor loss, which only a
 * reader can see — land in the session trace as change events, never as
 * a heartbeat flood and never as a second state store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySupervisionEvent,
  initialSupervisionDoc,
} from "../src/supervision/machine.js";
import { SupervisionSessionTracer } from "../src/supervision/session-trace.js";
import { writeSupervisionState } from "../src/supervision/state.js";
import type { SupervisionReport } from "../src/supervision/types.js";
import { supervisionReport } from "../src/supervision/state.js";
import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function sessionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-suptrace-"));
  roots.push(dir);
  return dir;
}

function harness() {
  const trace = new TraceRecorder();
  const events: TraceEvent[] = [];
  trace.subscribe((event) => events.push(event));
  return { trace, events, tracer: new SupervisionSessionTracer(trace) };
}

function ops(events: readonly TraceEvent[]): string[] {
  return events.map((event) => event.op);
}

describe("SupervisionSessionTracer phase transitions", () => {
  it("records the first publish as init→running and each later phase change once", () => {
    const { tracer, events } = harness();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const running = initialSupervisionDoc({ now });

    tracer.notePublished(running);
    tracer.notePublished(running); // same doc again: no duplicate row
    expect(ops(events)).toEqual(["supervision.transition"]);
    expect(events[0]!.result).toMatchObject({
      from: "init",
      to: "running",
    });

    const blocked = applySupervisionEvent(
      running,
      {
        kind: "blocking-observed",
        blocking: {
          host: "none",
          windows: [],
          detail: "1 blocking window(s): Script Error",
        },
        reason: "modal observed",
        deadlineMs: 60_000,
      },
      now,
    );
    if (!blocked.ok) throw new Error("fixture refused");
    tracer.notePublished(blocked.doc);
    tracer.notePublished(blocked.doc);
    expect(ops(events)).toEqual([
      "supervision.transition",
      "supervision.transition",
    ]);
    expect(events[1]!.result).toMatchObject({
      from: "running",
      to: "blocked",
      reason: "modal observed",
    });
  });
});

describe("SupervisionSessionTracer evaluated health", () => {
  function report(
    dir: string,
    now: Date,
  ): SupervisionReport {
    return supervisionReport(dir, { now });
  }

  it("records health changes a reader evaluates — including monitor-lost", () => {
    const dir = sessionRoot();
    const { tracer, events } = harness();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const fresh = new Date("2026-01-01T00:00:10.000Z");
    const stale = new Date("2026-01-01T00:02:00.000Z");

    // No state at all: unavailable is the honest first answer.
    tracer.noteReport(report(dir, t0));
    expect(events.at(-1)!.op).toBe("supervision.health");
    expect(events.at(-1)!.result).toMatchObject({
      from: "unobserved",
      to: "unavailable:absent",
    });

    // A live monitor publishes: health ok.
    const freshBeat = {
      ownerId: "monitor-1",
      pid: 42,
      pidStart: null,
      acquiredAt: fresh.toISOString(),
      heartbeatAt: fresh.toISOString(),
    };
    writeSupervisionState(dir, initialSupervisionDoc({ now: fresh, monitor: freshBeat }));
    tracer.noteReport(report(dir, fresh));
    expect(events.at(-1)!.result).toMatchObject({
      from: "unavailable:absent",
      to: "ok",
    });

    // Same report again: nothing new — heartbeats are not trace rows.
    const before = events.length;
    tracer.noteReport(report(dir, fresh));
    tracer.noteReport(report(dir, fresh));
    expect(events.length).toBe(before);

    // The monitor dies: the next read re-evaluates the stale heartbeat as
    // monitor-lost — the only place that transition can be recorded.
    tracer.noteReport(report(dir, stale));
    expect(events.at(-1)!.op).toBe("supervision.health");
    expect(events.at(-1)!.result).toMatchObject({
      from: "ok",
      to: "monitor-lost",
    });
  });

  it("records degraded observation as a health change, with its evidence", () => {
    const dir = sessionRoot();
    const { tracer, events } = harness();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const doc = initialSupervisionDoc({ now: t0 });
    const degraded = applySupervisionEvent(
      doc,
      { kind: "probe-degraded", reason: "AX tree unserviceable" },
      t0,
    );
    if (!degraded.ok) throw new Error("fixture refused");
    writeSupervisionState(dir, degraded.doc);
    // observationHealth is "degraded" but there is no monitor record, so
    // the evaluated health stays degraded (not folded into unavailable).
    tracer.noteReport(supervisionReport(dir, { now: t0 }));
    expect(events.at(-1)!.result).toMatchObject({
      from: "unobserved",
      to: "degraded",
    });
  });
});
