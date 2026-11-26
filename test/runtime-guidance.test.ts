/**
 * Runtime guidance conformance (#341, parent program #337 US-A4).
 *
 * Pins the machine-readable contract an agent that never read the
 * supervision Skill relies on: every runtime surface — the supervision
 * report, the CLI envelope's `nextActions[]`, and typed API errors —
 * answers "what may happen next" with `kind` / `allowed` / `code` /
 * `reason.code`, never with prose alone.
 *
 * Scenarios: normal, known-modal, unknown dialog, permission, timeout,
 * rebuild failure, and recovered-but-original-request-FAILED. Plus the
 * negative cases: unknown/corrupt schema and the invariant that no
 * `allowed: true` action ever recommends an out-of-permission operation,
 * arbitrary shell, or OCR-derived instructions.
 *
 * Verification level: `automated test` against the in-repo state machine,
 * fake transport and CLI harness — no real After Effects involved.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openRebuiltSession } from "../src/api/rebuild.js";
import {
  AfterEffectsError,
  HostQuarantinedError,
  contextualise,
} from "../src/api/errors.js";
import { nextActionsOf, type CliEnvelope } from "../src/cli/envelope.js";
import { runCli, type CliDependencies } from "../src/cli/run.js";
import { TimeoutError } from "../src/driver/driver.js";
import { ScriptNotSentError } from "../src/driver/transport.js";
import { diagnostic } from "../src/doctor/diagnostics.js";
import {
  NEXT_ACTION_REASON_CODES,
  type NextAction,
} from "../src/supervision/next-actions.js";
import {
  applySupervisionEvent,
  initialSupervisionDoc,
  type SupervisionEvent,
} from "../src/supervision/machine.js";
import { SupervisionSessionTracer } from "../src/supervision/session-trace.js";
import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";
import {
  supervisionReport,
  supervisionStatePath,
  writeSupervisionState,
} from "../src/supervision/state.js";
import type { BlockingInfo, SupervisionStateDoc } from "../src/supervision/types.js";

const roots: string[] = [];
function sessionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-guidance-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-11-20T00:00:00Z");

function monitor(at: Date) {
  return {
    ownerId: "monitor-test",
    pid: 4242,
    pidStart: "2026-11-20T00:00:00Z",
    acquiredAt: at.toISOString(),
    heartbeatAt: at.toISOString(),
  };
}

function docWith(
  events: readonly SupervisionEvent[],
  options: { monitor?: boolean } = {},
): SupervisionStateDoc {
  let doc = initialSupervisionDoc({
    now: NOW,
    ...(options.monitor === false ? {} : { monitor: monitor(NOW) }),
  });
  for (const event of events) {
    const result = applySupervisionEvent(doc, event, NOW);
    if (!result.ok) {
      throw new Error(`fixture transition refused: ${result.reason}`);
    }
    doc = result.doc;
  }
  return doc;
}

function blocking(host: BlockingInfo["host"], detail: string, tier: "auto-safe" | "unknown" | "human-required" = "unknown"): SupervisionEvent {
  return {
    kind: "blocking-observed",
    blocking: {
      host,
      windows:
        host === "none"
          ? [
              {
                title: "Script Error",
                role: "AXWindow",
                subrole: null,
                texts: ["line 3: boom"],
                buttons: ["OK"],
                blocking: true,
                tier,
                dialogClass: tier === "auto-safe" ? "script-error-ok" : null,
                code: tier === "auto-safe" ? null : "A8N-SEC-001",
              },
            ]
          : [],
      detail,
    },
    reason: "fixture",
    deadlineMs: 60_000,
  };
}

function reportFor(doc: SupervisionStateDoc) {
  const dir = sessionRoot();
  writeSupervisionState(dir, doc);
  return supervisionReport(dir, { now: NOW });
}

const REASON_SET = new Set<string>(NEXT_ACTION_REASON_CODES);

/** The contract invariants every nextActions array must satisfy. */
function expectWellFormed(actions: readonly NextAction[]): void {
  for (const action of actions) {
    expect(["automatic", "human"]).toContain(action.kind);
    expect(typeof action.allowed).toBe("boolean");
    expect(action.code.length).toBeGreaterThan(0);
    expect(REASON_SET.has(action.reason.code)).toBe(true);
    expect(typeof action.action).toBe("string");
    // The hard rule: automation is never offered an action it may not
    // perform, and a human action is never automation-allowed.
    if (action.kind === "human") {
      expect(action.allowed).toBe(false);
    }
    if (action.allowed) {
      expect(["permitted", "bounded-wait", "not-sent"]).toContain(action.reason.code);
    }
    // No OCR/screenshot/shell instructions may appear as automation
    // guidance — the contract prohibits those as decision paths.
    if (action.allowed) {
      expect(action.action).not.toMatch(/\b(ocr|screenshot|osascript|rm -rf|sudo)\b/i);
    }
  }
}

describe("supervision report nextActions", () => {
  it("normal: a healthy running session owes nothing", () => {
    const report = reportFor(docWith([], { monitor: true }));
    expect(report.status).toBe("observed");
    if (report.status !== "observed") return;
    expect(report.doc.phase).toBe("running");
    expect(report.health).toBe("ok");
    expect(report.nextActions).toEqual([]);
    expect(report.stateFile.endsWith("supervision.json")).toBe(true);
  });

  it("known-modal: a blocked auto-safe dialog offers bounded wait + inspect, never a press", () => {
    const report = reportFor(
      docWith([blocking("none", "1 blocking window(s): Script Error", "auto-safe")]),
    );
    if (report.status !== "observed") throw new Error("expected observed");
    expect(report.doc.phase).toBe("blocked");
    expectWellFormed(report.nextActions);
    const codes = report.nextActions.map((a) => a.code);
    expect(codes).toContain("supervision.blocked");
    const wait = report.nextActions.find((a) => a.code === "supervision.blocked");
    expect(wait?.kind).toBe("automatic");
    expect(wait?.allowed).toBe(true);
    expect(wait?.reason.code).toBe("bounded-wait");
    // No action recommends pressing the dialog: only wait/inspect are allowed.
    for (const action of report.nextActions.filter((a) => a.allowed)) {
      expect(["bounded-wait", "permitted", "not-sent"]).toContain(action.reason.code);
    }
  });

  it("unknown dialog: quarantined state withholds every mutating action", () => {
    const report = reportFor(
      docWith([
        blocking("none", "1 blocking window(s): Unknown", "unknown"),
        { kind: "quarantine", reason: "unmeasured dialog class" },
      ]),
    );
    if (report.status !== "observed") throw new Error("expected observed");
    expect(report.doc.phase).toBe("quarantined");
    expectWellFormed(report.nextActions);
    const human = report.nextActions.find((a) => a.code === "supervision.quarantined");
    expect(human?.kind).toBe("human");
    expect(human?.allowed).toBe(false);
    expect(human?.reason.code).toBe("unsafe-to-automate");
    // The only allowed actions are read-only.
    for (const action of report.nextActions.filter((a) => a.allowed)) {
      expect(action.code).toBe("supervision.state");
    }
  });

  it("needs-human: a measured human-required dialog stops automation explicitly", () => {
    const report = reportFor(
      docWith([
        blocking("none", "1 blocking window(s): Sign In", "human-required"),
        { kind: "needs-human", reason: "sign-in requires a person" },
      ]),
    );
    if (report.status !== "observed") throw new Error("expected observed");
    expect(report.doc.phase).toBe("needs-human");
    expectWellFormed(report.nextActions);
    const human = report.nextActions.find((a) => a.code === "supervision.needs-human");
    expect(human?.allowed).toBe(false);
    expect(human?.reason.code).toBe("requires-human");
  });

  it("recovered-but-original-FAILED: resumed with an unknown pending request never offers resend", () => {
    const doc = docWith(
      [
        {
          kind: "blocking-observed",
          blocking: { host: "none", windows: [], detail: "blocked" },
          pendingRequests: [
            { id: "req-1", method: "project.open", since: NOW.toISOString(), state: "timed-out" },
          ],
          reason: "fixture",
          deadlineMs: 60_000,
        },
        { kind: "recovery-started", reason: "fixture" },
        { kind: "recovery-succeeded", reason: "fixture" },
        // The timed-out request's outcome stays unknown: reconciled as
        // unproven, marked unknown — never resent.
        { kind: "request-outcome", requestId: "req-1", outcome: "unknown" },
      ],
      { monitor: true },
    );
    const report = reportFor(doc);
    if (report.status !== "observed") throw new Error("expected observed");
    expect(report.doc.phase).toBe("resumed");
    expectWellFormed(report.nextActions);
    const pending = report.nextActions.find((a) => a.code === "supervision.pending-unknown");
    expect(pending?.kind).toBe("human");
    expect(pending?.allowed).toBe(false);
    expect(pending?.reason.code).toBe("unknown-outcome");
    // No allowed action anywhere may retry or resend.
    for (const action of report.nextActions.filter((a) => a.allowed)) {
      expect(action.reason.code).not.toBe("not-sent");
      expect(action.action).not.toMatch(/re-?send|retry the (same|timed-out)/i);
    }
  });

  it("absent state: unavailable is explicit, with evidence path and guidance", () => {
    const dir = sessionRoot();
    const report = supervisionReport(dir, { now: NOW });
    expect(report.status).toBe("unavailable");
    if (report.status !== "unavailable") return;
    expect(report.source).toBe("absent");
    expect(report.stateFile).toBe(join(dir, "supervision.json"));
    expectWellFormed(report.nextActions);
    expect(report.nextActions.some((a) => a.reason.code === "evidence-unavailable")).toBe(true);
  });

  it("unknown schema: a future-version document is corrupt, never trusted", () => {
    const dir = sessionRoot();
    const doc = JSON.parse(
      JSON.stringify(docWith([], { monitor: true })),
    ) as Record<string, unknown>;
    doc["schemaVersion"] = "ae-a8n.supervision/v999";
    writeFileSync(supervisionStatePath(dir), `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    const report = supervisionReport(dir, { now: NOW });
    expect(report.status).toBe("unavailable");
    if (report.status !== "unavailable") return;
    expect(report.source).toBe("corrupt");
    expectWellFormed(report.nextActions);
    expect(report.nextActions.every((a) => a.allowed === false || a.code === "supervision.state")).toBe(true);
  });
});

describe("CLI envelope nextActions", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        writeOut: (text: string) => void out.push(text),
        writeErr: (text: string) => void err.push(text),
        now: () => NOW,
      } satisfies Partial<CliDependencies>,
    };
  }

  it("supervise status surfaces the report's own nextActions", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, docWith([blocking("none", "blocked", "unknown")], { monitor: true }));
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir, "--json"], deps);
    expect(code).toBe(3);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.nextActions.length).toBeGreaterThan(0);
    expectWellFormed(envelope.nextActions);
    // Same contract the API report carries — identical judgement fields.
    const report = supervisionReport(dir, { now: NOW });
    expect(envelope.nextActions.map((a) => `${a.kind}:${a.allowed}:${a.code}:${a.reason.code}`))
      .toEqual(report.nextActions.map((a) => `${a.kind}:${a.allowed}:${a.code}:${a.reason.code}`));
  });

  it("nextActionsOf maps diagnostic remedies onto the contract", () => {
    const human = diagnostic("A8N-PERM-004", {
      detail: "Adobe sign-in required",
      remedy: "Sign in to Adobe in the target session.",
      remedyKind: "human",
    });
    const auto = diagnostic("A8N-JOB-002", {
      detail: "stale lock",
      remedy: "Re-run with --force after checking.",
      remedyKind: "automatic",
    });
    const actions = nextActionsOf([human, auto]);
    expectWellFormed(actions);
    const signIn = actions.find((a) => a.code === "A8N-PERM-004");
    expect(signIn?.kind).toBe("human");
    expect(signIn?.allowed).toBe(false);
    expect(signIn?.reason.code).toBe("requires-human");
    const lock = actions.find((a) => a.code === "A8N-JOB-002");
    expect(lock?.kind).toBe("automatic");
    expect(lock?.allowed).toBe(true);
    expect(lock?.reason.code).toBe("permitted");
  });
});

describe("typed API errors carry nextActions", () => {
  function thrown(error: unknown): AfterEffectsError {
    try {
      contextualise("test.op", error);
    } catch (caught) {
      expect(caught).toBeInstanceOf(AfterEffectsError);
      return caught as AfterEffectsError;
    }
    throw new Error("contextualise did not throw");
  }

  it("permission: a quarantine-class failure never allows an automated grant", () => {
    const error = thrown(new HostQuarantinedError("a sign-in window blocked the probe"));
    expectWellFormed(error.nextActions ?? []);
    const grant = (error.nextActions ?? []).find((a) => a.allowed);
    // The only allowed action is read-only inspection.
    expect(grant?.code).toBe("A8N-SEC-001");
    const human = (error.nextActions ?? []).find((a) => a.kind === "human");
    expect(human?.allowed).toBe(false);
    expect(human?.reason.code).toBe("requires-permission");
  });

  it("timeout/modal: bounded wait and inspect are allowed; resend is not offered", () => {
    const error = thrown(new TimeoutError("app.info", 1000, "modal"));
    expect(error.hostCondition).toBe("modal");
    expectWellFormed(error.nextActions ?? []);
    expect((error.nextActions ?? []).some((a) => a.reason.code === "bounded-wait")).toBe(true);
    for (const action of (error.nextActions ?? []).filter((a) => a.allowed)) {
      expect(action.reason.code).not.toBe("not-sent");
    }
  });

  it("timeout/gone: rebuild is named but withheld until proofs hold", () => {
    const error = thrown(new TimeoutError("app.info", 1000, "gone"));
    expectWellFormed(error.nextActions ?? []);
    const rebuild = (error.nextActions ?? []).find((a) => a.code === "session.rebuild");
    expect(rebuild?.kind).toBe("automatic");
    expect(rebuild?.allowed).toBe(false);
    expect(rebuild?.reason.code).toBe("session-policy");
  });

  it("not-sent: the only failure class allowed to offer retry", () => {
    const error = thrown(new ScriptNotSentError("the channel closed before the request was written"));
    expectWellFormed(error.nextActions ?? []);
    const retry = (error.nextActions ?? []).find((a) => a.reason.code === "not-sent");
    expect(retry?.allowed).toBe(true);
    expect(retry?.kind).toBe("automatic");
  });
});

describe("rebuild refusal carries nextActions", () => {
  it("absent supervision state: launch is the permitted path, rebuild guidance is explicit", async () => {
    const dir = sessionRoot();
    let caught: unknown = null;
    try {
      await openRebuiltSession({ sessionRoot: dir }, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AfterEffectsError);
    const error = caught as AfterEffectsError;
    expectWellFormed(error.nextActions ?? []);
    const codes = (error.nextActions ?? []).map((a) => a.code);
    expect(codes).toContain("session.launch");
    expect(codes).toContain("session.rebuild");
    const launch = (error.nextActions ?? []).find((a) => a.code === "session.launch");
    expect(launch?.allowed).toBe(true);
    expect(launch?.reason.code).toBe("permitted");
  });
});

describe("session trace records guidance changes", () => {
  it("supervision.next-actions rows appear only when the offered set changes", () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, docWith([], { monitor: true }));
    const recorder = new TraceRecorder();
    const events: TraceEvent[] = [];
    recorder.subscribe((event) => events.push(event));
    const tracer = new SupervisionSessionTracer(recorder);
    const t0 = new Date("2026-11-20T00:00:10Z");
    tracer.noteReport(supervisionReport(dir, { now: t0 }));
    // running/ok owes no actions: the first row records the empty set.
    // (A paired health change is recorded after it — see noteReport.)
    const firstActions = events.filter((e) => e.op === "supervision.next-actions").at(-1);
    expect(firstActions).toBeDefined();
    expect((firstActions?.result?.["to"] as unknown[]).length).toBe(0);
    // Same report again: no duplicate row.
    const before = events.length;
    tracer.noteReport(supervisionReport(dir, { now: t0 }));
    expect(events.length).toBe(before);
    // A blocked phase changes the guidance set → a new row.
    const blocked = docWith([blocking("none", "blocked", "unknown")], { monitor: true });
    writeSupervisionState(dir, blocked);
    tracer.noteReport(supervisionReport(dir, { now: t0 }));
    const last = events.filter((e) => e.op === "supervision.next-actions").at(-1);
    const to = last?.result?.["to"] as { kind: string; code: string; allowed: boolean; reason: string }[];
    expect(to.some((a) => a.code === "supervision.quarantined" || a.code === "supervision.blocked")).toBe(true);
    for (const action of to) {
      expect(["automatic", "human"]).toContain(action.kind);
      expect(typeof action.allowed).toBe("boolean");
      expect(typeof action.reason).toBe("string");
    }
  });
});
