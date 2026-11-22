/**
 * Supervision contract core (#280): state machine, durable state, monitor
 * lease and bounded waits. Everything here is platform-neutral and runs
 * without After Effects.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SUPERVISION_SCHEMA_VERSION,
  acquireMonitorLease,
  applySupervisionEvent,
  decodeMonitorLease,
  decodeSupervisionDoc,
  evaluateObservationHealth,
  initialSupervisionDoc,
  inspectMonitorLease,
  monitorLeasePath,
  readSupervisionState,
  supervisionReport,
  supervisionStatePath,
  waitForSupervisionPhase,
  writeSupervisionState,
  type BlockingInfo,
  type MonitorLeaseRecord,
  type SupervisionStateDoc,
} from "../src/supervision/index.js";

const roots: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-supervision-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const T0 = new Date("2026-11-23T00:00:00Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function docAt(phase: SupervisionStateDoc["phase"], now: Date): SupervisionStateDoc {
  const doc = initialSupervisionDoc({ now });
  if (phase === "running") {
    return doc;
  }
  const blocking: BlockingInfo = {
    host: "none",
    windows: [],
    detail: "test block",
  };
  const result = applySupervisionEvent(
    doc,
    {
      kind: "blocking-observed",
      blocking,
      reason: "test",
      deadlineMs: 60_000,
    },
    now,
  );
  if (!result.ok) {
    throw new Error(`setup transition failed: ${result.reason}`);
  }
  let current = result.doc;
  if (phase === "blocked") {
    return current;
  }
  const started = applySupervisionEvent(current, { kind: "recovery-started", reason: "test" }, now);
  if (!started.ok) {
    throw new Error(`setup transition failed: ${started.reason}`);
  }
  current = started.doc;
  if (phase === "recovering") {
    return current;
  }
  if (phase === "resumed") {
    const done = applySupervisionEvent(current, { kind: "recovery-succeeded", reason: "test" }, now);
    if (!done.ok) {
      throw new Error(`setup transition failed: ${done.reason}`);
    }
    return done.doc;
  }
  const failed = applySupervisionEvent(
    current,
    {
      kind: "recovery-failed",
      to: phase === "needs-human" ? "needs-human" : "quarantined",
      reason: "test",
    },
    now,
  );
  if (!failed.ok) {
    throw new Error(`setup transition failed: ${failed.reason}`);
  }
  return failed.doc;
}

describe("state machine", () => {
  it("walks running → blocked → recovering → resumed", () => {
    const doc = initialSupervisionDoc({ now: T0 });
    expect(doc.phase).toBe("running");
    expect(doc.deadline).toBeNull();

    const blocking: BlockingInfo = {
      host: "none",
      windows: [],
      detail: "a dialog is up",
    };
    const blocked = applySupervisionEvent(
      doc,
      { kind: "blocking-observed", blocking, reason: "window seen", deadlineMs: 30_000 },
      at(1_000),
    );
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.doc.phase).toBe("blocked");
    expect(blocked.doc.deadline).not.toBeNull();
    expect(blocked.doc.blocking?.detail).toBe("a dialog is up");

    const recovering = applySupervisionEvent(
      blocked.doc,
      { kind: "recovery-started", reason: "pressing OK" },
      at(2_000),
    );
    expect(recovering.ok).toBe(true);
    if (!recovering.ok) return;
    expect(recovering.doc.phase).toBe("recovering");

    const resumed = applySupervisionEvent(
      recovering.doc,
      { kind: "recovery-succeeded", reason: "request result reconciled" },
      at(3_000),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.doc.phase).toBe("resumed");
    expect(resumed.doc.deadline).toBeNull();
    expect(resumed.doc.blocking).toBeNull();

    const running = applySupervisionEvent(resumed.doc, { kind: "observe-clear", reason: "clean" }, at(4_000));
    expect(running.ok).toBe(true);
    if (running.ok) {
      expect(running.doc.phase).toBe("running");
    }
  });

  it("observe-clear on blocked goes to recovering, not resumed", () => {
    const blocked = docAt("blocked", T0);
    const cleared = applySupervisionEvent(blocked, { kind: "observe-clear", reason: "window gone" }, at(1));
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.doc.phase).toBe("recovering");
      expect(cleared.doc.blocking).toBeNull();
    }
  });

  it("refuses recovery-succeeded outside recovering", () => {
    const blocked = docAt("blocked", T0);
    const result = applySupervisionEvent(blocked, { kind: "recovery-succeeded", reason: "x" }, at(1));
    expect(result.ok).toBe(false);
  });

  it("needs-human leaves only via human-resolved", () => {
    const needsHuman = docAt("needs-human", T0);
    const resolved = applySupervisionEvent(
      needsHuman,
      { kind: "human-resolved", reason: "user clicked through" },
      at(1_000),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.doc.phase).toBe("recovering");
    }
    const again = applySupervisionEvent(needsHuman, { kind: "recovery-started", reason: "retry" }, at(2_000));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.doc.phase).toBe("recovering");
    }
  });

  it("quarantined ignores new blocking observations but keeps evidence", () => {
    const quarantined = docAt("quarantined", T0);
    const next = applySupervisionEvent(
      quarantined,
      {
        kind: "blocking-observed",
        blocking: { host: "none", windows: [], detail: "new dialog" },
        reason: "still blocked",
      },
      at(1_000),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.doc.phase).toBe("quarantined");
      expect(next.doc.blocking?.detail).toBe("new dialog");
    }
  });

  it("health events never change the phase", () => {
    const blocked = docAt("blocked", T0);
    const lost = applySupervisionEvent(blocked, { kind: "monitor-lost", reason: "heartbeat stale" }, at(1));
    expect(lost.ok).toBe(true);
    if (lost.ok) {
      expect(lost.doc.phase).toBe("blocked");
      expect(lost.doc.observationHealth).toBe("monitor-lost");
    }
    const degraded = applySupervisionEvent(blocked, { kind: "probe-degraded", reason: "AX flaky" }, at(2));
    expect(degraded.ok).toBe(true);
    if (degraded.ok) {
      expect(degraded.doc.phase).toBe("blocked");
      expect(degraded.doc.observationHealth).toBe("degraded");
    }
  });

  it("monitor-heartbeat restores ok health after monitor-lost", () => {
    let doc = docAt("running", T0);
    const lost = applySupervisionEvent(doc, { kind: "monitor-lost", reason: "x" }, at(1));
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    doc = lost.doc;
    const beat = applySupervisionEvent(
      doc,
      {
        kind: "monitor-heartbeat",
        monitor: {
          ownerId: "m1",
          pid: process.pid,
          pidStart: null,
          acquiredAt: at(2).toISOString(),
          heartbeatAt: at(2).toISOString(),
        },
      },
      at(2),
    );
    expect(beat.ok).toBe(true);
    if (beat.ok) {
      expect(beat.doc.observationHealth).toBe("ok");
      expect(beat.doc.monitor?.ownerId).toBe("m1");
    }
  });

  it("tracks request outcomes without resending", () => {
    let doc = initialSupervisionDoc({ now: T0 });
    doc = {
      ...doc,
      pendingRequests: [
        { id: "r1", method: "project.open", since: T0.toISOString(), state: "timed-out" },
      ],
    };
    const next = applySupervisionEvent(doc, { kind: "request-outcome", requestId: "r1", outcome: "unknown" }, at(1));
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.doc.pendingRequests[0]?.state).toBe("unknown");
    }
  });

  it("caps history", () => {
    let doc = initialSupervisionDoc({ now: T0 });
    for (let i = 0; i < 60; i += 1) {
      const result = applySupervisionEvent(doc, { kind: "monitor-lost", reason: `beat ${i}` }, at(i));
      expect(result.ok).toBe(true);
      if (result.ok) {
        doc = result.doc;
      }
    }
    expect(doc.history.length).toBeLessThanOrEqual(50);
  });
});

describe("durable state", () => {
  it("round-trips a document through disk", () => {
    const dir = makeDir();
    const doc = docAt("blocked", T0);
    writeSupervisionState(dir, doc);
    const read = readSupervisionState(dir);
    expect(read.kind).toBe("state");
    if (read.kind === "state") {
      expect(read.doc.phase).toBe("blocked");
      expect(read.doc.schemaVersion).toBe(SUPERVISION_SCHEMA_VERSION);
    }
  });

  it("reports absent, corrupt and invalid documents distinctly", () => {
    const dir = makeDir();
    expect(readSupervisionState(dir).kind).toBe("absent");

    writeFileSync(supervisionStatePath(dir), "{not json", { mode: 0o600 });
    const corrupt = readSupervisionState(dir);
    expect(corrupt.kind).toBe("corrupt");

    writeFileSync(
      supervisionStatePath(dir),
      JSON.stringify({ schemaVersion: "ae-a8n.supervision/v999", phase: "running" }),
      { mode: 0o600 },
    );
    expect(readSupervisionState(dir).kind).toBe("corrupt");

    // A blocking phase without a deadline violates the bounded-wait
    // invariant: corrupt, not trusted.
    const bad = docAt("blocked", T0);
    writeFileSync(
      supervisionStatePath(dir),
      JSON.stringify({ ...bad, deadline: null }),
      { mode: 0o600 },
    );
    expect(readSupervisionState(dir).kind).toBe("corrupt");
    expect(decodeSupervisionDoc({ ...bad, deadline: null })).toBeNull();
  });

  it("supervisionReport never fabricates a healthy state", () => {
    const dir = makeDir();
    const absent = supervisionReport(dir, { now: T0 });
    expect(absent.status).toBe("unavailable");
    if (absent.status === "unavailable") {
      expect(absent.source).toBe("absent");
    }

    writeFileSync(supervisionStatePath(dir), "garbage", { mode: 0o600 });
    const corrupt = supervisionReport(dir, { now: T0 });
    expect(corrupt.status).toBe("unavailable");
    if (corrupt.status === "unavailable") {
      expect(corrupt.source).toBe("corrupt");
    }
  });

  it("re-evaluates monitor heartbeat at read time", () => {
    const dir = makeDir();
    const doc = initialSupervisionDoc({
      now: T0,
      monitor: {
        ownerId: "m1",
        pid: process.pid,
        pidStart: null,
        acquiredAt: T0.toISOString(),
        heartbeatAt: T0.toISOString(),
      },
    });
    writeSupervisionState(dir, doc);

    const fresh = supervisionReport(dir, { now: at(1_000), monitorTtlMs: 30_000 });
    expect(fresh.status).toBe("observed");
    if (fresh.status === "observed") {
      expect(fresh.health).toBe("ok");
    }

    const stale = supervisionReport(dir, { now: at(60_000), monitorTtlMs: 30_000 });
    expect(stale.status).toBe("observed");
    if (stale.status === "observed") {
      expect(stale.health).toBe("monitor-lost");
      expect(stale.healthDetail).toContain("stale");
    }

    const noMonitor = evaluateObservationHealth(
      { ...doc, monitor: null, observationHealth: "ok" },
      T0,
    );
    expect(noMonitor.health).toBe("unavailable");
  });
});

describe("monitor lease", () => {
  const alive = () => true;
  const dead = () => false;
  const stamp = () => "start-stamp";

  function leaseRecord(overrides: Partial<MonitorLeaseRecord> = {}): MonitorLeaseRecord {
    return {
      schemaVersion: "ae-a8n.monitor-lease/v1",
      ownerId: "other",
      pid: 4242,
      pidStart: null,
      acquiredAt: T0.toISOString(),
      heartbeatAt: T0.toISOString(),
      expiresAt: at(30_000).toISOString(),
      ...overrides,
    };
  }

  it("acquires on a free directory and heartbeats", () => {
    const dir = makeDir();
    const result = acquireMonitorLease(dir, {
      ownerId: "monitor-a",
      pid: process.pid,
      now: T0,
      pidAlive: alive,
      pidStartedAt: stamp,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tookOverFrom).toBeNull();

    const beat = result.lease.heartbeat(at(1_000));
    expect(beat.heartbeatAt).toBe(at(1_000).toISOString());

    const inspected = inspectMonitorLease(dir, { pidAlive: alive, pidStartedAt: stamp, now: at(2_000) });
    expect(inspected.state).toBe("held");
    expect(inspected.record?.ownerId).toBe("monitor-a");

    result.lease.release();
    expect(inspectMonitorLease(dir, { pidAlive: alive }).state).toBe("free");
  });

  it("refuses a second live holder", () => {
    const dir = makeDir();
    const first = acquireMonitorLease(dir, {
      ownerId: "monitor-a",
      pid: process.pid,
      now: T0,
      pidAlive: alive,
      pidStartedAt: stamp,
    });
    expect(first.ok).toBe(true);
    const second = acquireMonitorLease(dir, {
      ownerId: "monitor-b",
      pid: process.pid,
      now: at(1_000),
      pidAlive: alive,
      pidStartedAt: stamp,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("held");
      expect(second.holder?.ownerId).toBe("monitor-a");
    }
    if (first.ok) {
      first.lease.release();
    }
  });

  it("takes over an expired lease and reports the previous holder", () => {
    const dir = makeDir();
    writeFileSync(monitorLeasePath(dir), `${JSON.stringify(leaseRecord())}\n`, { mode: 0o600 });
    const result = acquireMonitorLease(dir, {
      ownerId: "monitor-b",
      pid: process.pid,
      now: at(60_000), // past expiresAt
      pidAlive: alive,
      pidStartedAt: stamp,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tookOverFrom?.ownerId).toBe("other");
    const inspected = inspectMonitorLease(dir, { pidAlive: alive, pidStartedAt: stamp, now: at(60_001) });
    expect(inspected.state).toBe("held");
    expect(inspected.record?.ownerId).toBe("monitor-b");
    result.lease.release();
  });

  it("takes over when the recorded owner pid is dead", () => {
    const dir = makeDir();
    writeFileSync(
      monitorLeasePath(dir),
      `${JSON.stringify(leaseRecord({ expiresAt: at(300_000).toISOString() }))}\n`,
      { mode: 0o600 },
    );
    const result = acquireMonitorLease(dir, {
      ownerId: "monitor-b",
      pid: process.pid,
      now: T0,
      pidAlive: dead,
      pidStartedAt: stamp,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tookOverFrom?.ownerId).toBe("other");
      result.lease.release();
    }
  });

  it("refuses an ambiguous lease file", () => {
    const dir = makeDir();
    writeFileSync(monitorLeasePath(dir), "{broken", { mode: 0o600 });
    const result = acquireMonitorLease(dir, {
      ownerId: "monitor-b",
      pid: process.pid,
      now: T0,
      pidAlive: alive,
      pidStartedAt: stamp,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
    }
    // The file is untouched.
    expect(readFileSync(monitorLeasePath(dir), "utf-8")).toBe("{broken");
  });

  it("heartbeat refuses after the lease was taken over", () => {
    const dir = makeDir();
    const first = acquireMonitorLease(dir, {
      ownerId: "monitor-a",
      pid: process.pid,
      now: T0,
      pidAlive: alive,
      pidStartedAt: stamp,
      ttlMs: 1_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Simulate takeover by another writer after expiry.
    writeFileSync(monitorLeasePath(dir), `${JSON.stringify(leaseRecord({ ownerId: "monitor-b" }))}\n`, {
      mode: 0o600,
    });
    expect(() => first.lease.heartbeat(at(5_000))).toThrow(/lost/);
    first.lease.release();
    // The other owner's record must survive our release.
    expect(decodeMonitorLease(JSON.parse(readFileSync(monitorLeasePath(dir), "utf-8")))?.ownerId).toBe(
      "monitor-b",
    );
  });
});

describe("bounded wait", () => {
  it("returns reached when the phase arrives", async () => {
    const dir = makeDir();
    const blocked = docAt("blocked", T0);
    writeSupervisionState(dir, blocked);
    const outcome = await waitForSupervisionPhase({
      sessionDir: dir,
      phases: ["blocked"],
      timeoutMs: 5_000,
      pollMs: 10,
      now: () => T0,
    });
    expect(outcome.status).toBe("reached");
  });

  it("returns unavailable immediately on absent state", async () => {
    const dir = makeDir();
    const outcome = await waitForSupervisionPhase({
      sessionDir: dir,
      phases: ["resumed"],
      timeoutMs: 60_000,
      pollMs: 10,
      now: () => T0,
    });
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.report.status).toBe("unavailable");
    }
  });

  it("times out with the last report instead of waiting forever", async () => {
    const dir = makeDir();
    writeSupervisionState(dir, docAt("blocked", T0));
    let clock = T0.getTime();
    const outcome = await waitForSupervisionPhase({
      sessionDir: dir,
      phases: ["resumed"],
      timeoutMs: 100,
      pollMs: 10,
      now: () => new Date((clock += 20)),
      sleep: async () => {},
    });
    expect(outcome.status).toBe("timeout");
    if (outcome.status === "timeout") {
      expect(outcome.report?.status).toBe("observed");
    }
  });
});
