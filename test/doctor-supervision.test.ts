/**
 * `doctor --session-root` supervision checks (#287): the diagnostics read
 * the same durable `supervision.json` as the API and `supervise` — and a
 * degraded or lost monitor is never reported as healthy.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliEnvelope } from "../src/cli/envelope.js";
import { runCli, type CliDependencies } from "../src/cli/run.js";
import { supervisionChecks } from "../src/doctor/supervision.js";
import { applySupervisionEvent, initialSupervisionDoc } from "../src/supervision/machine.js";
import { writeSupervisionState } from "../src/supervision/state.js";
import { FakeAdapter } from "../src/platform/fake-adapter.js";

const roots: string[] = [];
function sessionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-doctor-sup-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function liveDoc(now: Date) {
  return initialSupervisionDoc({
    now,
    monitor: {
      ownerId: "monitor-1",
      pid: 1,
      pidStart: null,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
    },
  });
}

describe("supervisionChecks", () => {
  it("absent state is a warning, never healthy", () => {
    const dir = sessionRoot();
    const checks = supervisionChecks(dir);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.code).toBe("A8N-SUP-003");
    expect(checks[0]!.severity).toBe("warning");
  });

  it("corrupt state is a warning, never healthy", () => {
    const dir = sessionRoot();
    writeFileSync(join(dir, "supervision.json"), "{ not json");
    const checks = supervisionChecks(dir);
    expect(checks[0]!.code).toBe("A8N-SUP-003");
    expect(checks[0]!.severity).toBe("warning");
  });

  it("a healthy running session is info", () => {
    const dir = sessionRoot();
    const now = new Date();
    writeSupervisionState(dir, liveDoc(now));
    const checks = supervisionChecks(dir, now);
    expect(checks[0]!.code).toBe("A8N-SUP-004");
    expect(checks[0]!.severity).toBe("info");
  });

  it("blocked is a warning", () => {
    const dir = sessionRoot();
    const now = new Date();
    const blocked = applySupervisionEvent(
      initialSupervisionDoc({ now }),
      {
        kind: "blocking-observed",
        blocking: { host: "none", windows: [], detail: "Script Error" },
        reason: "modal",
        deadlineMs: 60_000,
      },
      now,
    );
    if (!blocked.ok) throw new Error("fixture refused");
    writeSupervisionState(dir, blocked.doc);
    const checks = supervisionChecks(dir, now);
    expect(checks[0]!.code).toBe("A8N-SUP-002");
    expect(checks[0]!.severity).toBe("warning");
  });

  it("needs-human is a blocker — automation is stopped", () => {
    const dir = sessionRoot();
    const now = new Date();
    const blocked = applySupervisionEvent(
      initialSupervisionDoc({ now }),
      {
        kind: "blocking-observed",
        blocking: { host: "none", windows: [], detail: "Script Error" },
        reason: "modal",
        deadlineMs: 60_000,
      },
      now,
    );
    if (!blocked.ok) throw new Error("fixture refused");
    const human = applySupervisionEvent(
      blocked.doc,
      { kind: "needs-human", reason: "deadline elapsed, human required" },
      now,
    );
    if (!human.ok) throw new Error("fixture refused");
    writeSupervisionState(dir, human.doc);
    const checks = supervisionChecks(dir, now);
    expect(checks[0]!.code).toBe("A8N-SUP-001");
    expect(checks[0]!.severity).toBe("blocker");
  });

  it("a stale monitor heartbeat reports monitor-lost, not ok", () => {
    const dir = sessionRoot();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const stale = new Date("2025-12-31T23:00:00.000Z");
    const beat = applySupervisionEvent(
      initialSupervisionDoc({ now: t0 }),
      {
        kind: "monitor-heartbeat",
        monitor: {
          ownerId: "dead-monitor",
          pid: 1,
          pidStart: null,
          acquiredAt: stale.toISOString(),
          heartbeatAt: stale.toISOString(),
        },
      },
      t0,
    );
    if (!beat.ok) throw new Error("fixture refused");
    writeSupervisionState(dir, beat.doc);
    const checks = supervisionChecks(dir, new Date("2026-01-01T00:01:00.000Z"));
    expect(checks[0]!.code).toBe("A8N-SUP-003");
    expect(checks[0]!.detail).toContain("monitor-lost");
  });
});

describe("ae-a8n doctor --session-root", () => {
  function deps(adapter: FakeAdapter): Partial<CliDependencies> {
    return {
      select: () => ({ ok: true, adapter }),
    };
  }

  it("appends the supervision check to the platform diagnostics", async () => {
    const dir = sessionRoot();
    const adapter = new FakeAdapter("darwin");
    const out: string[] = [];
    const code = await runCli(["doctor", "--session-root", dir, "--json"], {
      ...deps(adapter),
      writeOut: (text: string) => void out.push(text),
    });
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.checks.some((c) => c.code === "A8N-SUP-003")).toBe(true);
    // Absent supervision state is a warning: doctor still exits 0.
    expect(code).toBe(0);
  });

  it("exits blocked when supervision reports needs-human", async () => {
    const dir = sessionRoot();
    const now = new Date();
    const blocked = applySupervisionEvent(
      initialSupervisionDoc({ now }),
      {
        kind: "blocking-observed",
        blocking: { host: "none", windows: [], detail: "Script Error" },
        reason: "modal",
        deadlineMs: 60_000,
      },
      now,
    );
    if (!blocked.ok) throw new Error("fixture refused");
    const human = applySupervisionEvent(
      blocked.doc,
      { kind: "needs-human", reason: "deadline elapsed, human required" },
      now,
    );
    if (!human.ok) throw new Error("fixture refused");
    writeSupervisionState(dir, human.doc);
    const adapter = new FakeAdapter("darwin");
    const out: string[] = [];
    const code = await runCli(["doctor", "--session-root", dir, "--json"], {
      ...deps(adapter),
      writeOut: (text: string) => void out.push(text),
    });
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("blocked");
    expect(envelope.checks.some((c) => c.code === "A8N-SUP-001")).toBe(true);
    expect(code).toBe(3);
  });
});
