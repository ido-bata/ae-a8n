/**
 * Verified session rebuild after owned AE crash (#286,
 * specs/gui-supervision/spec.md US5).
 *
 * Every test runs against fakes: the supervision document, the
 * launch-provenance record, the process census, the GUI-session reader,
 * and — for the relaunch itself — the in-repo fake After Effects
 * transport driven through the real `openAfterEffects` path. Nothing here
 * touches a real After Effects; real-host verification is a separate gate.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openRebuiltSession, type RebuildDeps } from "../src/api/rebuild.js";
import { AfterEffectsError } from "../src/api/errors.js";
import { recordLaunchProvenance } from "../src/driver/launch-provenance.js";
import type { HostProcess } from "../src/driver/host-processes.js";
import type { MacSession } from "../src/driver/mac-session.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { acquireMonitorLease } from "../src/supervision/lease.js";
import {
  applySupervisionEvent,
  initialSupervisionDoc,
} from "../src/supervision/machine.js";
import { readSupervisionState, writeSupervisionState } from "../src/supervision/state.js";
import type {
  PendingRequest,
  SupervisionStateDoc,
} from "../src/supervision/types.js";

const T0 = Date.parse("2026-10-15T00:00:00Z");
const OLD_PID = 1111;
const OLD_STARTED_AT = T0 + 5_000;
const AE_EXECUTABLE = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const NEW_PID = 4242;
const NEW_STARTED_AT = T0 + 60_000;

const AQUA: MacSession = { uid: 501, username: "tester", asid: 42, kind: "Aqua" };

let sessionRoot: string;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-rebuild-"));
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

function processGoneDoc(pending: readonly PendingRequest[] = []): SupervisionStateDoc {
  const now = new Date("2026-11-01T00:00:00Z");
  const result = applySupervisionEvent(
    initialSupervisionDoc({ now }),
    {
      kind: "blocking-observed",
      blocking: {
        host: "process-gone",
        windows: [],
        detail: "host state: process-gone",
      },
      pendingRequests: pending,
      reason: "the After Effects process is gone",
    },
    now,
  );
  if (!result.ok) {
    throw new Error(`fixture transition refused: ${result.reason}`);
  }
  return result.doc;
}

function seedCrashedSession(options: {
  readonly pending?: readonly PendingRequest[];
  readonly provenance?: boolean;
} = {}): void {
  writeSupervisionState(sessionRoot, processGoneDoc(options.pending ?? []));
  if (options.provenance !== false) {
    recordLaunchProvenance(sessionRoot, {
      transport: "script-invocation",
      host: {
        pid: OLD_PID,
        startedAt: OLD_STARTED_AT,
        executable: AE_EXECUTABLE,
      },
    });
  }
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

function deps(overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    // The census sees no After Effects at all: the recorded pid is gone
    // and no sibling instance exists to be confused with the rebuild.
    processes: () => [],
    readGuiSession: () => AQUA,
    ...overrides,
  };
}

function pendingRequest(id: string, state: PendingRequest["state"] = "in-flight"): PendingRequest {
  return { id, method: "project.open", since: "2026-11-01T00:00:00Z", state };
}

function writeResult(id: string): void {
  const outbox = join(sessionRoot, "outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(
    join(outbox, `${id}.result.json`),
    JSON.stringify({ v: 1, id, ok: true, durationMs: 3, result: null }),
    "utf-8",
  );
}

async function expectRebuildRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AfterEffectsError);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected the rebuild to refuse with ${pattern}`);
}

function readDoc(): SupervisionStateDoc {
  const read = readSupervisionState(sessionRoot);
  if (read.kind !== "state") {
    throw new Error(`expected supervision state, got ${read.kind}`);
  }
  return read.doc;
}

describe("openRebuiltSession", () => {
  it("rebuilds an owned crashed session: verify → relaunch → ownership re-proven → resumed", async () => {
    seedCrashedSession();
    const transport = fakeTransport();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, deps());

    expect(rebuilt.rebuild.previousPid).toBe(OLD_PID);
    expect(rebuilt.rebuild.pid).toBe(NEW_PID);
    expect(rebuilt.rebuild.phase).toBe("resumed");
    expect(transport.launched).toBe(true);

    // Fresh provenance replaced the stale record: the new owned process.
    const provenance = JSON.parse(
      readFileSync(join(sessionRoot, "launch-provenance.json"), "utf-8"),
    ) as { host: { pid: number } };
    expect(provenance.host.pid).toBe(NEW_PID);

    // The durable document records the whole recovery.
    const doc = readDoc();
    expect(doc.phase).toBe("resumed");
    const transitions = doc.history.map((entry) => `${entry.from}→${entry.to}`);
    expect(transitions).toContain("blocked→recovering");
    expect(transitions).toContain("recovering→resumed");
    const reasons = doc.history.map((entry) => entry.reason).join("\n");
    expect(reasons).toContain("verified rebuild");
  });

  it("reconciles pending requests: recorded result resolves, the rest stay UNKNOWN and are never resent", async () => {
    seedCrashedSession({
      pending: [pendingRequest("req-done"), pendingRequest("req-lost", "timed-out")],
    });
    writeResult("req-done");
    const transport = fakeTransport();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, deps());

    expect(rebuilt.rebuild.pendingResolved).toBe(1);
    expect(rebuilt.rebuild.pendingUnknown).toBe(1);

    const doc = readDoc();
    // The resolved request left the pending list; the unresolved one is
    // marked unknown — evidence for a human, never a resend.
    expect(doc.pendingRequests.map((request) => request.id)).toEqual(["req-lost"]);
    expect(doc.pendingRequests[0]?.state).toBe("unknown");
    expect(doc.evidence.join("\n")).toContain("req-done");
    expect(doc.evidence.join("\n")).toContain("never resent");
  });

  it("refuses an attached session: no provenance, nothing is launched", async () => {
    // Supervision proved process-gone, but no launch provenance exists —
    // the shape an attached or unknown session leaves behind.
    writeSupervisionState(sessionRoot, processGoneDoc());
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /never proved it owned|no launch provenance/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses when supervision never proved process loss", async () => {
    seedCrashedSession();
    // Overwrite with a running document: no proven loss, no rebuild.
    writeSupervisionState(sessionRoot, initialSupervisionDoc({ now: new Date() }));
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /requires proven process loss/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses a quarantined session: a human must resolve it first", async () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const quarantined = applySupervisionEvent(
      processGoneDoc(),
      { kind: "quarantine", reason: "unclassifiable blocking window" },
      now,
    );
    if (!quarantined.ok) {
      throw new Error("fixture refused");
    }
    writeSupervisionState(sessionRoot, quarantined.doc);
    recordLaunchProvenance(sessionRoot, {
      transport: "script-invocation",
      host: { pid: OLD_PID, startedAt: OLD_STARTED_AT, executable: AE_EXECUTABLE },
    });
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /quarantined/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses while a live monitor still observes the dead host", async () => {
    seedCrashedSession();
    const lease = acquireMonitorLease(sessionRoot, {
      ownerId: "ae-a8n-detached-supervisor",
      pid: process.pid,
    });
    expect(lease.ok).toBe(true);
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /monitor lease is held/i,
    );
    expect(transport.launched).toBe(false);
    if (lease.ok) {
      lease.lease.release();
    }
  });

  it("refuses when the recorded process is still running (stale process-gone)", async () => {
    seedCrashedSession();
    const transport = fakeTransport();
    const stillAlive: HostProcess[] = [
      { pid: OLD_PID, startedAt: OLD_STARTED_AT, executable: AE_EXECUTABLE },
    ];

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps({ processes: () => stillAlive })),
      /still running/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses on a reused pid when the record has no start time", async () => {
    // A provenance document without startedAt cannot tell the original
    // process from a recycled pid: presence is ambiguity, never proof.
    writeSupervisionState(sessionRoot, processGoneDoc());
    writeFileSync(
      join(sessionRoot, "launch-provenance.json"),
      JSON.stringify({
        schema: "a8n.launch-provenance/v1",
        recordedAt: new Date().toISOString(),
        a8nVersion: "0.0.0-test",
        transport: "script-invocation",
        host: {
          pid: OLD_PID,
          startedAt: null,
          identity: null,
          executable: AE_EXECUTABLE,
          platform: process.platform,
        },
      }),
      "utf-8",
    );
    const transport = fakeTransport();
    const reusedPid: HostProcess[] = [
      { pid: OLD_PID, startedAt: T0 + 999_999, executable: "/unrelated/tool" },
    ];

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps({ processes: () => reusedPid })),
      /reused pid|cannot be told apart/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses when another instance of the install is running (ambiguous)", async () => {
    seedCrashedSession();
    const transport = fakeTransport();
    // A different pid running the same install: the crashed AE is gone,
    // but a rebuild could not prove which instance would answer.
    const sibling: HostProcess[] = [
      { pid: 2222, startedAt: T0 + 30_000, executable: AE_EXECUTABLE },
    ];

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps({ processes: () => sibling })),
      /other instance/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses when the process census cannot be read", async () => {
    seedCrashedSession();
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession(
        { sessionRoot, transport },
        deps({
          processes: () => {
            throw new Error("ps exploded");
          },
        }),
      ),
      /process list could not be read/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("refuses on corrupt provenance rather than treating it as absent", async () => {
    writeSupervisionState(sessionRoot, processGoneDoc());
    writeFileSync(join(sessionRoot, "launch-provenance.json"), "not json{", "utf-8");
    const transport = fakeTransport();

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /provenance is unusable/i,
    );
    expect(transport.launched).toBe(false);
  });

  it("fails closed when the rebuilt host cannot be proven owned — nothing is quit", async () => {
    seedCrashedSession();
    const transport = fakeTransport();
    // The relaunch answers but ownership comes back attached: the instance
    // may hold someone else's unsaved work, so it is left running.
    transport.ownershipKind = "attached";

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /could not be proven owned/i,
    );

    expect(transport.closed).toBe(false);
    const doc = readDoc();
    expect(doc.phase).toBe("needs-human");
    expect(doc.history.map((entry) => entry.to)).toContain("needs-human");
  });

  it("records recovery-failed when the relaunch itself fails", async () => {
    seedCrashedSession();
    const transport = fakeTransport();
    // A launch that never becomes usable: the driver probe cannot run.
    transport.launch = () => Promise.reject(new Error("cannot start After Effects"));

    await expectRebuildRefusal(
      openRebuiltSession({ sessionRoot, transport }, deps()),
      /./,
    );

    const doc = readDoc();
    // The recovery action was recorded as attempted and failed — the audit
    // trail shows the rebuild, not just its absence.
    const reasons = doc.history.map((entry) => entry.reason).join("\n");
    expect(reasons).toContain("verified rebuild");
    expect(reasons).toContain("rebuild failed");
    expect(["blocked", "needs-human"]).toContain(doc.phase);
  });
});
