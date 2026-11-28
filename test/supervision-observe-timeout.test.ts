/**
 * #450 — observation session commands must stay well under the monitor
 * lease TTL. RC run-2 measured the failure mode: a foreign AE exit+restart
 * stalled the AX query to its 60s `execFileSync` timeout, the monitor tick
 * could not complete, and the durable heartbeat went stale while the
 * lease kept beating — a live supervisor reported `monitor-lost`.
 *
 * `boundedObservationRunSession` clamps every session command an
 * observation path runs, so a hung query degrades the tick instead of
 * stalling it past the freshness window.
 */

import { describe, expect, it } from "vitest";

import {
  boundedObservationRunSession,
  MacGuiRecovery,
  OBSERVATION_SESSION_COMMAND_TIMEOUT_MS,
} from "../src/driver/gui-recovery.js";
import type { runInSession, SessionCommandResult } from "../src/driver/mac-session.js";

const SESSION = { uid: 502, username: "test", asid: 100040, kind: "Aqua" } as const;

function recoveryWith(runSession: typeof runInSession): MacGuiRecovery {
  return new MacGuiRecovery({
    session: SESSION,
    pid: 4242,
    allowConsoleSession: true,
    readTargetSession: () => SESSION,
    verifyProcess: () => true,
    census: () => ({ available: false, reason: "no census in test" }),
    lease: {
      acquire: () => ({ path: "/fake/lease", release: () => {} }),
      audit: () => {},
    },
    runSession,
  });
}

function stubRunSession(
  seen: { timeoutMs?: number | undefined; input?: string | undefined }[],
): typeof runInSession {
  return (_session, _command, _args, options) => {
    seen.push({ timeoutMs: options?.timeoutMs, input: options?.input });
    const result: SessionCommandResult = {
      status: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    };
    return result;
  };
}

describe("boundedObservationRunSession", () => {
  it("clamps the mutation-path 60s AX timeout to the observation bound", () => {
    const seen: { timeoutMs?: number | undefined; input?: string | undefined }[] = [];
    const bounded = boundedObservationRunSession(stubRunSession(seen));

    const gui = recoveryWith(bounded);
    // #osascript always asks for 60_000; the observation bound must win.
    expect(gui.accessibilityQuery(["return 1"], [], "observe")).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(OBSERVATION_SESSION_COMMAND_TIMEOUT_MS);
  });

  it("bounds a caller that passes no timeout at all", () => {
    const seen: { timeoutMs?: number | undefined }[] = [];
    const bounded = boundedObservationRunSession(stubRunSession(seen));
    bounded(SESSION, "cmd", []);
    expect(seen.map((entry) => entry.timeoutMs)).toEqual([
      OBSERVATION_SESSION_COMMAND_TIMEOUT_MS,
    ]);
  });

  it("never raises a tighter caller timeout", () => {
    const seen: { timeoutMs?: number | undefined }[] = [];
    const bounded = boundedObservationRunSession(stubRunSession(seen));
    bounded(SESSION, "cmd", [], { timeoutMs: 2_000 });
    expect(seen.map((entry) => entry.timeoutMs)).toEqual([2_000]);
  });

  it("keeps the observation bound inside the monitor freshness window", () => {
    // Two bounded session commands per tick (AX listing + census) plus
    // slack must finish well under DEFAULT_MONITOR_LEASE_TTL_MS (30s), or
    // a persistently hung target still reports monitor-lost.
    const tickWorstCaseMs = OBSERVATION_SESSION_COMMAND_TIMEOUT_MS * 2 + 5_000;
    expect(tickWorstCaseMs).toBeLessThan(30_000);
  });
});
