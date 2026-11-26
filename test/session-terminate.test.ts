/**
 * Terminate the owned host — the separate authorized path (#340,
 * specs/gui-supervision/spec.md US5).
 *
 * Every test runs against fakes: the launch-provenance record, the
 * supervision document, the monitor lease, the process census, the
 * terminate action itself, and — for the rebuild half of the chain — the
 * in-repo fake After Effects transport. Nothing touches a real After
 * Effects; real-host verification is a separate gate (#288).
 *
 * The fault-injection matrix this file pins: already-gone, hang with and
 * without force permission, signal failure, unreadable census, lease
 * contention and takeover, PID reuse, foreign/sibling instances,
 * attached/unknown sessions, quarantined/needs-human preservation, and
 * UNKNOWN pending requests surviving terminate → rebuild.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openRebuiltSession, type RebuildDeps } from "../src/api/rebuild.js";
import { AfterEffectsError } from "../src/api/errors.js";
import type { HostProcess } from "../src/driver/host-processes.js";
import type { TerminateHostRequest } from "../src/driver/host-terminate.js";
import type { MacSession } from "../src/driver/mac-session.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { terminateSessionHost, type TerminateDeps } from "../src/api/terminate.js";
import type { TerminateOptions } from "../src/api/types.js";
import { acquireMonitorLease, inspectMonitorLease } from "../src/supervision/lease.js";
import {
  applySupervisionEvent,
  initialSupervisionDoc,
} from "../src/supervision/machine.js";
import { readSupervisionState, writeSupervisionState } from "../src/supervision/state.js";
import type {
  PendingRequest,
  SupervisionPhase,
  SupervisionStateDoc,
} from "../src/supervision/types.js";

const T0 = Date.parse("2026-10-15T00:00:00Z");
const OLD_PID = 1111;
const OLD_STARTED_AT = T0 + 5_000;
const AE_EXECUTABLE =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const NEW_PID = 4242;
const NEW_STARTED_AT = T0 + 60_000;

const AQUA: MacSession = { uid: 501, username: "tester", asid: 42, kind: "Aqua" };

let sessionRoot: string;
let channelDir: string;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-terminate-"));
  channelDir = mkdtempSync(join(tmpdir(), "a8n-terminate-channel-"));
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  rmSync(channelDir, { recursive: true, force: true });
});

function recordedProcess(overrides: Partial<HostProcess> = {}): HostProcess {
  return {
    pid: OLD_PID,
    startedAt: OLD_STARTED_AT,
    executable: AE_EXECUTABLE,
    uid: 501,
    ...overrides,
  };
}

/**
 * Provenance host fields the fixtures may override. `startedAt` accepts
 * null because the stored schema allows it (platforms that cannot report
 * a start time); `recordLaunchProvenance` cannot write that shape, so the
 * document is written directly.
 */
type ProvenanceHost = {
  readonly pid?: number;
  readonly startedAt?: number | null;
  readonly identity?: string | null;
  readonly executable?: string;
};

/**
 * Writes a launch-provenance document naming platform `"darwin"`.
 *
 * The terminate/rebuild decision logic is platform-parameterized, and
 * every OS surface these tests exercise is already injected — the census
 * (`deps.processes`), the signal (`deps.terminateHost`), the GUI session
 * (`deps.readGuiSession`), and `deps.platform` itself. Pinning the
 * record to `"darwin"` keeps the darwin code path — uid-scoped census,
 * start-time process identity, the Aqua-session gate — exercised
 * identically on macOS, Linux and Windows CI. `recordLaunchProvenance`
 * would stamp `process.platform`, which makes the record disagree with
 * the injected platform everywhere but on a Mac.
 */
function seedProvenance(overrides: ProvenanceHost = {}): void {
  writeFileSync(
    join(sessionRoot, "launch-provenance.json"),
    `${JSON.stringify(
      {
        schema: "a8n.launch-provenance/v1",
        recordedAt: new Date(T0).toISOString(),
        a8nVersion: "0.0.0-test",
        transport: "script-invocation",
        host: {
          pid: overrides.pid ?? OLD_PID,
          startedAt:
            overrides.startedAt === undefined ? OLD_STARTED_AT : overrides.startedAt,
          identity: overrides.identity ?? null,
          executable: overrides.executable ?? AE_EXECUTABLE,
          platform: "darwin",
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function runningDoc(): SupervisionStateDoc {
  return initialSupervisionDoc({ now: new Date("2026-11-01T00:00:00Z") });
}

function phaseDoc(phase: SupervisionPhase): SupervisionStateDoc {
  const now = new Date("2026-11-01T00:00:00Z");
  let doc = runningDoc();
  if (phase === "blocked") {
    const blocked = applySupervisionEvent(
      doc,
      {
        kind: "blocking-observed",
        blocking: { host: "not-responding", windows: [], detail: "host is not responding" },
        reason: "host is not responding",
      },
      now,
    );
    if (!blocked.ok) throw new Error("fixture refused");
    doc = blocked.doc;
  } else if (phase === "needs-human" || phase === "quarantined") {
    const event =
      phase === "needs-human"
        ? ({ kind: "needs-human", reason: "a human must decide" } as const)
        : ({ kind: "quarantine", reason: "unclassifiable" } as const);
    const applied = applySupervisionEvent(doc, event, now);
    if (!applied.ok) throw new Error("fixture refused");
    doc = applied.doc;
  }
  return doc;
}

type SignalCall = { mode: "graceful" | "force"; pid: number };

type Harness = {
  deps: TerminateDeps;
  calls: SignalCall[];
  /** Mutable census backing `deps.processes`. */
  setProcesses(list: readonly HostProcess[] | (() => readonly HostProcess[])): void;
  /** Fail the census outright. */
  failCensus(message?: string): void;
  /** What the fake terminate action does to the census per mode. */
  onSignal?: (mode: "graceful" | "force") => void;
};

function harness(overrides: Partial<TerminateDeps> = {}): Harness {
  const calls: SignalCall[] = [];
  let processes: readonly HostProcess[] = [recordedProcess()];
  let censusError: string | null = null;
  const state: Harness = {
    calls,
    deps: {},
    setProcesses(list) {
      processes = typeof list === "function" ? list() : list;
      censusError = null;
    },
    failCensus(message = "ps exploded") {
      censusError = message;
    },
  };
  // A fake clock: `now` only moves when `sleep` is called, so waits are
  // deterministic and instant.
  let clock = 1_000_000;
  state.deps = {
    platform: "darwin",
    sessionUid: 501,
    processes: () => {
      if (censusError !== null) {
        throw new Error(censusError);
      }
      return processes;
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    pollIntervalMs: 100,
    terminateHost: (_platform, request: TerminateHostRequest) => {
      calls.push({ mode: request.mode, pid: request.pid });
      state.onSignal?.(request.mode);
      return Promise.resolve();
    },
    ...overrides,
  };
  return state;
}

function options(overrides: Partial<TerminateOptions> = {}): TerminateOptions {
  return {
    sessionRoot,
    permit: "terminate-owned-host",
    gracefulTimeoutMs: 1_000,
    deadlineMs: 5_000,
    ...overrides,
  };
}

async function expectTerminateRefusal(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AfterEffectsError);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected terminate to refuse with ${pattern}`);
}

function readDoc(): SupervisionStateDoc {
  const read = readSupervisionState(sessionRoot);
  if (read.kind !== "state") {
    throw new Error(`expected supervision state, got ${read.kind}`);
  }
  return read.doc;
}

describe("terminateSessionHost authorization gates", () => {
  it("refuses without the explicit permit — nothing is signalled", async () => {
    seedProvenance();
    const h = harness();
    await expectTerminateRefusal(
      terminateSessionHost(
        { sessionRoot, permit: "yes" as never },
        h.deps,
      ),
      /explicit permission/i,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an attached/unknown session: no provenance, nothing signalled", async () => {
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    await expectTerminateRefusal(
      terminateSessionHost(options(), h.deps),
      /never proved it owned|no launch provenance/i,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("refuses when the process census cannot be read — OS query unknown is never a guess", async () => {
    seedProvenance();
    const h = harness();
    h.failCensus("ps: operation not permitted");
    await expectTerminateRefusal(
      terminateSessionHost(options(), h.deps),
      /process list could not be read/i,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a possibly-reused pid: live pid under a start-time-less record is ambiguous", async () => {
    seedProvenance({ startedAt: null });
    const h = harness();
    // The recorded pid is alive but the record cannot prove it is the
    // same process — signalling it could kill a foreign process.
    h.setProcesses([recordedProcess()]);
    await expectTerminateRefusal(
      terminateSessionHost(options(), h.deps),
      /reused pid|cannot be told apart/i,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("refuses when a sibling instance of the install is running", async () => {
    seedProvenance();
    const h = harness();
    h.setProcesses([
      recordedProcess(),
      recordedProcess({ pid: 2222, startedAt: OLD_STARTED_AT + 1 }),
    ]);
    await expectTerminateRefusal(
      terminateSessionHost(options(), h.deps),
      /ambiguous|other instance/i,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("does not count another install's After Effects as a sibling", async () => {
    seedProvenance();
    const h = harness();
    h.onSignal = (mode) => {
      if (mode === "graceful") {
        h.setProcesses([]);
      }
    };
    h.setProcesses([
      recordedProcess(),
      recordedProcess({
        pid: 3333,
        executable: "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects",
      }),
    ]);
    const report = await terminateSessionHost(options(), h.deps);
    expect(report.outcome).toBe("terminated");
    expect(report.method).toBe("graceful");
  });
});

describe("terminateSessionHost outcomes", () => {
  it("reports already-gone without signalling and records process-gone for rebuild", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    h.setProcesses([]);

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("already-gone");
    expect(report.method).toBe("none");
    expect(report.disappearanceProven).toBe(true);
    expect(report.supervision).toBe("recorded");
    expect(h.calls).toHaveLength(0);

    const doc = readDoc();
    expect(doc.phase).toBe("blocked");
    expect(doc.blocking?.host).toBe("process-gone");
  });

  it("treats a reused pid as gone: the recorded start time proves the original died", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    // Same pid, different start time and a foreign executable: the
    // recorded AE is gone; the pid was recycled.
    h.setProcesses([
      recordedProcess({ startedAt: OLD_STARTED_AT + 999_999, executable: "/usr/bin/other" }),
    ]);

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("already-gone");
    expect(h.calls).toHaveLength(0);
    expect(readDoc().blocking?.host).toBe("process-gone");
  });

  it("terminates a hung host gracefully when the polite request works", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, phaseDoc("blocked"));
    const h = harness();
    h.onSignal = (mode) => {
      if (mode === "graceful") {
        h.setProcesses([]);
      }
    };

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("terminated");
    expect(report.method).toBe("graceful");
    expect(h.calls).toEqual([{ mode: "graceful", pid: OLD_PID }]);
    const doc = readDoc();
    expect(doc.phase).toBe("blocked");
    expect(doc.blocking?.host).toBe("process-gone");
  });

  it("reports survived — and never escalates — when force is not permitted", async () => {
    seedProvenance();
    const h = harness();
    // The host hangs: graceful changes nothing, census keeps listing it.
    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("survived");
    expect(report.method).toBe("graceful");
    expect(report.disappearanceProven).toBe(false);
    expect(report.supervision).toBe("not-proven");
    expect(h.calls).toEqual([{ mode: "graceful", pid: OLD_PID }]);
    // Nothing was written to supervision: the host may still be alive.
    expect(readSupervisionState(sessionRoot).kind).toBe("absent");
  });

  it("escalates to force only under explicit permission, then proves gone", async () => {
    seedProvenance();
    const h = harness();
    h.onSignal = (mode) => {
      if (mode === "force") {
        h.setProcesses([]);
      }
    };

    const report = await terminateSessionHost(options({ force: true }), h.deps);

    expect(report.outcome).toBe("terminated");
    expect(report.method).toBe("forced");
    expect(h.calls.map((call) => call.mode)).toEqual(["graceful", "force"]);
    expect(readDoc().blocking?.host).toBe("process-gone");
  });

  it("survives a signal that cannot be delivered — evidence, not a guess", async () => {
    seedProvenance();
    const h = harness({
      terminateHost: () => Promise.reject(new Error("osascript: connection invalid")),
    });

    const report = await terminateSessionHost(options({ force: true }), h.deps);

    expect(report.outcome).toBe("survived");
    expect(report.evidence.join("\n")).toContain("connection invalid");
    expect(readSupervisionState(sessionRoot).kind).toBe("absent");
  });

  it("reports unproven when the census dies mid-wait — never claims dead", async () => {
    seedProvenance();
    const h = harness();
    h.onSignal = () => {
      h.failCensus("ps: killed");
    };

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("unproven");
    expect(report.disappearanceProven).toBe(false);
    expect(report.evidence.join("\n")).toContain("could not be read");
  });
});

describe("terminateSessionHost supervision handoff", () => {
  it("defers to a live monitor: the lease holder owns the document", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    h.setProcesses([]);
    // A live monitor (this process stands in for it) holds the lease.
    const lease = acquireMonitorLease(sessionRoot, {
      ownerId: "ae-a8n-session",
      pid: process.pid,
    });
    expect(lease.ok).toBe(true);

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("already-gone");
    expect(report.supervision).toBe("deferred-to-monitor");
    // The document was not written under the live monitor's lease.
    expect(readDoc().phase).toBe("running");
    if (lease.ok) {
      lease.lease.release();
    }
  });

  it("takes over an expired monitor lease, records process-gone, and releases it", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    h.setProcesses([]);
    // A dead monitor's lease: pid that cannot be alive.
    const stale = acquireMonitorLease(sessionRoot, {
      ownerId: "ae-a8n-detached-supervisor",
      pid: 999_999,
    });
    expect(stale.ok).toBe(true);

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.supervision).toBe("recorded");
    const doc = readDoc();
    expect(doc.phase).toBe("blocked");
    expect(doc.blocking?.host).toBe("process-gone");
    // The lease was released: rebuild's free/expired check passes.
    expect(inspectMonitorLease(sessionRoot).state).toBe("free");
  });

  it("never downgrades quarantined or needs-human — evidence refreshes only", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, phaseDoc("quarantined"));
    const h = harness();
    h.setProcesses([]);

    const report = await terminateSessionHost(options(), h.deps);

    expect(report.outcome).toBe("already-gone");
    expect(report.supervision).toBe("recorded");
    const doc = readDoc();
    expect(doc.phase).toBe("quarantined");
    expect(doc.blocking?.host).toBe("process-gone");
  });

  it("keeps UNKNOWN pending requests untouched — they are never resent", async () => {
    seedProvenance();
    const pending: PendingRequest[] = [
      { id: "req-lost", method: "project.open", since: "2026-11-01T00:00:00Z", state: "unknown" },
    ];
    const doc = applySupervisionEvent(
      { ...runningDoc(), pendingRequests: pending },
      {
        kind: "blocking-observed",
        blocking: { host: "not-responding", windows: [], detail: "hang" },
        reason: "hang",
      },
      new Date(),
    );
    if (!doc.ok) throw new Error("fixture refused");
    writeSupervisionState(sessionRoot, doc.doc);
    const h = harness();
    h.setProcesses([]);

    await terminateSessionHost(options(), h.deps);

    const after = readDoc();
    expect(after.pendingRequests.map((request) => request.id)).toEqual(["req-lost"]);
    expect(after.pendingRequests[0]?.state).toBe("unknown");
  });
});

describe("terminate → rebuild chain", () => {
  function rebuildDeps(): RebuildDeps {
    return {
      // Same pinned platform as the provenance fixture and the terminate
      // harness: the darwin decision path on every CI host.
      platform: "darwin",
      processes: () => [],
      readGuiSession: () => AQUA,
      dispatcherChannelDir: channelDir,
    };
  }

  function fakeTransport(): FakeAfterEffectsTransport {
    const transport = new FakeAfterEffectsTransport();
    transport.ownedProcessValue = {
      pid: NEW_PID,
      startedAt: NEW_STARTED_AT,
      executable: AE_EXECUTABLE,
    };
    transport.hostPidValue = NEW_PID;
    return transport;
  }

  it("terminate proves disappearance, rebuild relaunches on the new generation", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    h.onSignal = (mode) => {
      if (mode === "graceful") {
        h.setProcesses([]);
      }
    };

    const terminated = await terminateSessionHost(options(), h.deps);
    expect(terminated.outcome).toBe("terminated");
    expect(terminated.supervision).toBe("recorded");

    const transport = fakeTransport();
    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, rebuildDeps());

    expect(rebuilt.rebuild.previousPid).toBe(OLD_PID);
    expect(rebuilt.rebuild.pid).toBe(NEW_PID);
    expect(rebuilt.rebuild.phase).toBe("resumed");
    // Script invocation needs no restaging: the verdict is ready.
    expect(rebuilt.rebuild.transportReady).toBe("ready");

    // New generation: fresh provenance names the new pid.
    const provenance = JSON.parse(
      readFileSync(join(sessionRoot, "launch-provenance.json"), "utf-8"),
    ) as { host: { pid: number } };
    expect(provenance.host.pid).toBe(NEW_PID);
    const doc = readDoc();
    expect(doc.phase).toBe("resumed");
  });

  it("rebuild still refuses while a live monitor holds the lease after terminate", async () => {
    seedProvenance();
    writeSupervisionState(sessionRoot, runningDoc());
    const h = harness();
    h.setProcesses([]);
    const lease = acquireMonitorLease(sessionRoot, {
      ownerId: "ae-a8n-session",
      pid: process.pid,
    });
    expect(lease.ok).toBe(true);

    const terminated = await terminateSessionHost(options(), h.deps);
    expect(terminated.supervision).toBe("deferred-to-monitor");

    const transport = fakeTransport();
    // Rebuild refuses: the document still reports the host running
    // (terminate deferred to the live monitor), so loss is unproven.
    // Nothing launches either way.
    await expect(
      openRebuiltSession({ sessionRoot, transport }, rebuildDeps()),
    ).rejects.toThrow(/proven process loss|monitor lease/i);
    expect(transport.launched).toBe(false);
    if (lease.ok) {
      lease.lease.release();
    }
  });
});
