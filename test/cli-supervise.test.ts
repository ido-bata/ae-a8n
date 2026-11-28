/**
 * `ae-a8n supervise status` (#287): the CLI reads the same durable
 * supervision document every consumer reads, and its exit code is the
 * supervision answer — never a fabricated healthy one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli/run.js";
import { AfterEffectsError } from "../src/api/errors.js";
import { TERMINATE_PERMIT, type TerminateOptions, type TerminateReport } from "../src/api/types.js";
import { applySupervisionEvent, initialSupervisionDoc } from "../src/supervision/machine.js";
import { supervisionReport, writeSupervisionState } from "../src/supervision/state.js";
import type { CliEnvelope } from "../src/cli/envelope.js";

const roots: string[] = [];
function sessionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-supervise-cli-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      writeOut: (text: string) => void out.push(text),
      writeErr: (text: string) => void err.push(text),
    } satisfies Partial<CliDependencies>,
  };
}

function monitorRecord(at: Date) {
  return {
    ownerId: "monitor-1",
    pid: 1,
    pidStart: null,
    acquiredAt: at.toISOString(),
    heartbeatAt: at.toISOString(),
  };
}

/** A doc a live monitor would publish: running, fresh heartbeat, health ok. */
function liveDoc(now: Date) {
  return initialSupervisionDoc({ now, monitor: monitorRecord(now) });
}

function blockedDoc(now: Date) {
  const result = applySupervisionEvent(
    initialSupervisionDoc({ now }),
    {
      kind: "blocking-observed",
      blocking: {
        host: "none",
        windows: [
          {
            title: "Script Error",
            role: "AXWindow",
            subrole: null,
            texts: ["line 3"],
            buttons: ["OK"],
            blocking: true,
            tier: "unknown",
            dialogClass: null,
            code: "A8N-SEC-001",
          },
        ],
        detail: "1 blocking window(s): Script Error",
      },
      reason: "fixture",
      deadlineMs: 60_000,
    },
    now,
  );
  if (!result.ok) throw new Error("fixture");
  return result.doc;
}

describe("ae-a8n supervise status", () => {
  it("reports unavailable for an absent state file — never a clean bill", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir, "--json"], deps);
    expect(code).toBe(6);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("unknown");
    expect((envelope.facts as { status: string }).status).toBe("unavailable");
    void out;
  });

  it("reports a blocked phase with exit 3 and the window evidence", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, blockedDoc(new Date()));
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir, "--json"], deps);
    expect(code).toBe(3);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("blocked");
    const facts = envelope.facts as { status: string; doc: { phase: string; blocking: { detail: string } } };
    expect(facts.status).toBe("observed");
    expect(facts.doc.phase).toBe("blocked");
    expect(facts.doc.blocking.detail).toContain("Script Error");
    expect(envelope.nextActions.length).toBeGreaterThan(0);
  });

  it("reports running with exit 0", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, initialSupervisionDoc({ now: new Date() }));
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir], deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: running");
  });

  it("rejects a missing --session-root as usage", async () => {
    const { err, deps } = capture();
    const code = await runCli(["supervise", "status"], deps);
    expect(code).toBe(2);
    expect(err.join("")).toContain("--session-root");
  });

  it("reads the same durable document ae.supervisionState() reads", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, blockedDoc(new Date()));
    const now = new Date();
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "status", "--session-root", dir, "--json"],
      { ...deps, now: () => now },
    );
    expect(code).toBe(3);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    const facts = envelope.facts as { doc: unknown };
    // Identical durable state: the CLI report's document is the same one
    // the API-side reader returns for the same session root.
    const api = supervisionReport(dir, { now });
    if (api.status !== "observed") throw new Error("fixture produced no state");
    expect(facts.doc).toEqual(api.doc);
  });
});

describe("ae-a8n supervise watch", () => {
  it("emits the first state, then each transition — never a repeat", async () => {
    const dir = sessionRoot();
    const now = new Date();
    writeSupervisionState(dir, liveDoc(now));
    const blocked = applySupervisionEvent(
      liveDoc(now),
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
    const { out, deps } = capture();
    let sleeps = 0;
    const code = await runCli(["supervise", "watch", "--session-root", dir], {
      ...deps,
      now: () => now,
      superviseWatch: {
        maxTicks: 3,
        sleep: () => {
          sleeps += 1;
          if (sleeps === 1) {
            writeSupervisionState(dir, blocked.doc);
          }
          return Promise.resolve();
        },
      },
    });
    // The last observed report was blocked: exit 3, the supervision answer.
    expect(code).toBe(3);
    const lines = out.join("").trim().split("\n");
    // First emission (running) + the transition to blocked; the third tick
    // saw no change and printed nothing.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("running/ok");
    expect(lines[1]).toContain("blocked/ok");
    expect(lines[1]).toContain("→");
    expect(lines[1]).toContain("Script Error");
  });

  it("emits NDJSON events with the state machine's transition record", async () => {
    const dir = sessionRoot();
    const now = new Date();
    writeSupervisionState(dir, liveDoc(now));
    const blocked = applySupervisionEvent(
      liveDoc(now),
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
    const { out, deps } = capture();
    let sleeps = 0;
    const code = await runCli(["supervise", "watch", "--session-root", dir, "--json"], {
      ...deps,
      now: () => now,
      superviseWatch: {
        maxTicks: 2,
        sleep: () => {
          sleeps += 1;
          if (sleeps === 1) {
            writeSupervisionState(dir, blocked.doc);
          }
          return Promise.resolve();
        },
      },
    });
    expect(code).toBe(3);
    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "supervision", phase: "running", health: "ok" });
    expect(events[1]).toMatchObject({
      event: "supervision",
      phase: "blocked",
      health: "ok",
      transition: { from: "running", to: "blocked" },
    });
    // Every event carries the full report consumers can diff themselves.
    expect((events[1]!["report"] as { status: string }).status).toBe("observed");
  });

  it("reports unavailable once and exits unknown — never a clean bill", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(["supervise", "watch", "--session-root", dir], {
      ...deps,
      superviseWatch: { maxTicks: 2, sleep: () => Promise.resolve() },
    });
    expect(code).toBe(6);
    const lines = out.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unavailable/absent");
  });

  it("shows monitor-lost when the heartbeat goes stale", async () => {
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
    if (!beat.ok) throw new Error("fixture");
    writeSupervisionState(dir, beat.doc);
    const { out, deps } = capture();
    const now = new Date("2026-01-01T00:01:00.000Z");
    const code = await runCli(["supervise", "watch", "--session-root", dir], {
      ...deps,
      now: () => now,
      superviseWatch: { maxTicks: 1, sleep: () => Promise.resolve() },
    });
    // running phase but the monitor is gone: unknown, not ok.
    expect(code).toBe(6);
    expect(out.join("")).toContain("monitor-lost");
  });

  it("rejects a bad --interval-ms as usage", async () => {
    const dir = sessionRoot();
    const { err, deps } = capture();
    const code = await runCli(
      ["supervise", "watch", "--session-root", dir, "--interval-ms", "10"],
      deps,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("--interval-ms");
  });
});

describe("ae-a8n supervise terminate (#451)", () => {
  function report(over: Partial<TerminateReport> = {}): TerminateReport {
    return {
      outcome: "terminated",
      pid: 4242,
      method: "graceful",
      disappearanceProven: true,
      supervision: "recorded",
      phase: "blocked",
      evidence: ["quit Apple Event acknowledged", "census: pid 4242 gone"],
      ...over,
    };
  }

  it("requires the literal permit — a missing or wrong one is usage, never forwarded", async () => {
    const dir = sessionRoot();
    let called = false;
    for (const args of [
      ["supervise", "terminate", "--session-root", dir],
      ["supervise", "terminate", "--session-root", dir, "--permit", "yes"],
    ]) {
      const { err, deps } = capture();
      const code = await runCli(args, {
        ...deps,
        superviseTerminate: () => {
          called = true;
          return Promise.resolve(report());
        },
      });
      expect(code).toBe(2);
      expect(err.join("")).toContain(TERMINATE_PERMIT);
    }
    expect(called).toBe(false);
  });

  it("rejects --permit and --force on the read-only commands", async () => {
    const dir = sessionRoot();
    const { err, deps } = capture();
    const code = await runCli(
      ["supervise", "status", "--session-root", dir, "--permit", TERMINATE_PERMIT],
      deps,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("--permit");
    const second = capture();
    const code2 = await runCli(
      ["supervise", "watch", "--session-root", dir, "--force"],
      second.deps,
    );
    expect(code2).toBe(2);
    expect(second.err.join("")).toContain("--force");
  });

  it("runs the terminate seam with the owned-host permit and reports the outcome", async () => {
    const dir = sessionRoot();
    const seen: { current?: TerminateOptions } = {};
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "terminate", "--session-root", dir, "--permit", TERMINATE_PERMIT, "--force", "--json"],
      {
        ...deps,
        superviseTerminate: (options) => {
          seen.current = options;
          return Promise.resolve(report({ method: "forced" }));
        },
      },
    );
    expect(code).toBe(0);
    expect(seen.current).toBeDefined();
    expect(seen.current?.permit).toBe(TERMINATE_PERMIT);
    expect(seen.current?.force).toBe(true);
    expect(seen.current?.sessionRoot).toBe(dir);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("ok");
    const facts = envelope.facts as TerminateReport;
    expect(facts.outcome).toBe("terminated");
    expect(facts.method).toBe("forced");
    // Proven disappearance names the permitted rebuild — the designed next step.
    const rebuild = envelope.nextActions.find((a) => a.code === "session.rebuild");
    expect(rebuild?.allowed).toBe(true);
  });

  it("a surviving host exits blocked and withholds rebuild", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "terminate", "--session-root", dir, "--permit", TERMINATE_PERMIT, "--json"],
      {
        ...deps,
        superviseTerminate: () =>
          Promise.resolve(
            report({ outcome: "survived", method: "graceful", disappearanceProven: false, supervision: "not-proven", phase: null }),
          ),
      },
    );
    expect(code).toBe(3);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("blocked");
    const rebuild = envelope.nextActions.find((a) => a.code === "session.rebuild");
    expect(rebuild?.allowed).toBe(false);
    expect(rebuild?.reason.code).toBe("session-policy");
  });

  it("an unproven disappearance exits unknown — never a claimed death", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "terminate", "--session-root", dir, "--permit", TERMINATE_PERMIT, "--json"],
      {
        ...deps,
        superviseTerminate: () =>
          Promise.resolve(
            report({ outcome: "unproven", method: "none", disappearanceProven: false, supervision: "not-proven", phase: null }),
          ),
      },
    );
    expect(code).toBe(6);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("unknown");
    expect(envelope.nextActions.some((a) => a.kind === "human" && a.allowed === false)).toBe(true);
  });

  it("a refused terminate surfaces the API error's own nextActions", async () => {
    const dir = sessionRoot();
    const refused = new AfterEffectsError("no launch provenance for this session root", "session.terminate", {
      code: "A8N-SES-003",
      nextActions: [
        {
          kind: "automatic",
          allowed: true,
          code: "session.launch",
          action: "Launch a fresh owned session.",
          reason: { code: "permitted" },
        },
      ],
    });
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "terminate", "--session-root", dir, "--permit", TERMINATE_PERMIT, "--json"],
      {
        ...deps,
        superviseTerminate: () => Promise.reject(refused),
      },
    );
    expect(code).toBe(4);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("refused");
    expect(envelope.nextActions.map((a) => a.code)).toContain("session.launch");
  });

  it("human output names the outcome, method and evidence", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(
      ["supervise", "terminate", "--session-root", dir, "--permit", TERMINATE_PERMIT],
      {
        ...deps,
        superviseTerminate: () =>
          Promise.resolve(report({ outcome: "already-gone", method: "none" })),
      },
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("already-gone");
    expect(text).toContain("pid 4242");
    expect(text).toContain("AfterEffects.rebuild");
  });
});
