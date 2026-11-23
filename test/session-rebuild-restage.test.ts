/**
 * Transport re-staging on verified rebuild (#313).
 *
 * A rebuilt After Effects process starts with none of the delivery paths
 * the crashed one hosted. These tests pin the per-surface decisions —
 * script invocation needs nothing, a dispatcher activation bound to the
 * crashed pid is re-activated through the shared activation core, and
 * every outcome is reported honestly (`restaged` / `failed` / `unproven`)
 * instead of being implied by `resumed`.
 *
 * Everything runs against fakes: the supervision document, provenance
 * records, the process census, and an injected activation call. No real
 * After Effects is touched; real-host verification stays with #288.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openRebuiltSession, type RebuildDeps } from "../src/api/rebuild.js";
import { AfterEffectsError } from "../src/api/errors.js";
import { recordLaunchProvenance } from "../src/driver/launch-provenance.js";
import { recordDispatcherProvenance } from "../src/driver/dispatcher-provenance.js";
import {
  readSessionDispatcherActivations,
  recordSessionDispatcherActivation,
} from "../src/driver/session-dispatcher-activations.js";
import type { MacSession } from "../src/driver/mac-session.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { applySupervisionEvent, initialSupervisionDoc } from "../src/supervision/machine.js";
import { readSupervisionState, writeSupervisionState } from "../src/supervision/state.js";
import type { SupervisionStateDoc } from "../src/supervision/types.js";
import type { Session } from "../src/api/session.js";
import type { DispatcherActivation } from "../src/api/types.js";

const T0 = Date.parse("2026-10-15T00:00:00Z");
const OLD_PID = 1111;
const OLD_STARTED_AT = T0 + 5_000;
const AE_EXECUTABLE = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const NEW_PID = 4242;
const NEW_STARTED_AT = T0 + 60_000;

const AQUA: MacSession = { uid: 501, username: "tester", asid: 42, kind: "Aqua" };

let sessionRoot: string;
let channelDir: string;
let customChannelDir: string;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-restage-"));
  channelDir = mkdtempSync(join(tmpdir(), "a8n-channel-"));
  customChannelDir = mkdtempSync(join(tmpdir(), "a8n-channel-custom-"));
});

afterEach(() => {
  for (const dir of [sessionRoot, channelDir, customChannelDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function processGoneDoc(): SupervisionStateDoc {
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
      reason: "the After Effects process is gone",
    },
    now,
  );
  if (!result.ok) {
    throw new Error(`fixture transition refused: ${result.reason}`);
  }
  return result.doc;
}

function seedCrashedSession(): void {
  writeSupervisionState(sessionRoot, processGoneDoc());
  recordLaunchProvenance(sessionRoot, {
    transport: "script-invocation",
    host: {
      pid: OLD_PID,
      startedAt: OLD_STARTED_AT,
      executable: AE_EXECUTABLE,
    },
  });
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

type ActivateCall = { session: Session; channelDir: string };

function deps(overrides: Partial<RebuildDeps> = {}): {
  deps: RebuildDeps;
  activateCalls: ActivateCall[];
} {
  const activateCalls: ActivateCall[] = [];
  return {
    activateCalls,
    deps: {
      processes: () => [],
      readGuiSession: () => AQUA,
      dispatcherChannelDir: channelDir,
      activateDispatcher: (session, dir) => {
        activateCalls.push({ session, channelDir: dir });
        return Promise.resolve<DispatcherActivation>({
          channelDir: dir,
          instance: "inst-new",
          aeVersion: "26.5",
        });
      },
      ...overrides,
    },
  };
}

/** Provenance proving `pid` hosted the dispatcher on `dir`. */
function seedChannelProvenance(dir: string, pid: number): void {
  mkdirSync(dir, { recursive: true });
  recordDispatcherProvenance(dir, {
    host: {
      pid,
      startedAt: OLD_STARTED_AT,
      executable: AE_EXECUTABLE,
    },
    instance: "inst-old",
    activatedAt: T0 + 10_000,
    activationNonce: "a".repeat(32),
    session: null,
  });
}

describe("session dispatcher activation index", () => {
  it("records and reads channel directories, deduplicated", () => {
    expect(readSessionDispatcherActivations(sessionRoot)).toEqual({ kind: "absent" });
    recordSessionDispatcherActivation(sessionRoot, channelDir);
    recordSessionDispatcherActivation(sessionRoot, customChannelDir);
    recordSessionDispatcherActivation(sessionRoot, channelDir);
    const read = readSessionDispatcherActivations(sessionRoot);
    expect(read).toEqual({ kind: "ok", channelDirs: [customChannelDir, channelDir] });
  });

  it("reports a corrupt index instead of treating it as empty", () => {
    writeFileSync(join(sessionRoot, "dispatcher-activations.json"), "not json{", "utf-8");
    const read = readSessionDispatcherActivations(sessionRoot);
    expect(read.kind).toBe("corrupt");
  });
});

describe("openRebuiltSession transport re-staging", () => {
  it("reports the session transport not-required and re-activates a dispatcher bound to the crashed pid", async () => {
    seedCrashedSession();
    seedChannelProvenance(channelDir, OLD_PID);
    recordSessionDispatcherActivation(sessionRoot, channelDir);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    expect(rebuilt.rebuild.phase).toBe("resumed");
    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0]?.channelDir).toBe(channelDir);

    const sessionEntry = rebuilt.rebuild.transports.find(
      (entry) => entry.channelDir === undefined,
    );
    expect(sessionEntry?.status).toBe("not-required");
    const dispatcherEntry = rebuilt.rebuild.transports.find(
      (entry) => entry.channelDir === channelDir,
    );
    expect(dispatcherEntry?.status).toBe("restaged");
    expect(dispatcherEntry?.transport).toBe("in-ae-dispatcher");
  });

  it("finds a custom channelDir through the session activation index", async () => {
    seedCrashedSession();
    // The default channel has no provenance bound to the crashed pid; the
    // custom one does — only the index makes it discoverable.
    seedChannelProvenance(customChannelDir, OLD_PID);
    recordSessionDispatcherActivation(sessionRoot, customChannelDir);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    expect(activateCalls.map((call) => call.channelDir)).toEqual([customChannelDir]);
    const entry = rebuilt.rebuild.transports.find(
      (candidate) => candidate.channelDir === customChannelDir,
    );
    expect(entry?.status).toBe("restaged");
  });

  it("checks the default channel for pre-index sessions whose provenance names the crashed pid", async () => {
    seedCrashedSession();
    // No dispatcher-activations.json (sessions from before #313 never
    // wrote one), but the default channel's provenance still names the
    // crashed pid.
    seedChannelProvenance(channelDir, OLD_PID);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    expect(activateCalls.map((call) => call.channelDir)).toEqual([channelDir]);
    expect(
      rebuilt.rebuild.transports.find((entry) => entry.channelDir === channelDir)?.status,
    ).toBe("restaged");
  });

  it("does not re-activate a channel whose provenance names a different pid", async () => {
    seedCrashedSession();
    seedChannelProvenance(channelDir, 9999);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    expect(activateCalls).toHaveLength(0);
    expect(
      rebuilt.rebuild.transports.some((entry) => entry.channelDir === channelDir),
    ).toBe(false);
  });

  it("reports a failed re-activation honestly without failing the rebuild", async () => {
    seedCrashedSession();
    seedChannelProvenance(channelDir, OLD_PID);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps({
      activateDispatcher: () => Promise.reject(new Error("script-trust dialog is up")),
    });

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    // The session itself is proven and resumed; the dispatcher surface
    // is reported failed — never implied available.
    expect(rebuilt.rebuild.phase).toBe("resumed");
    expect(activateCalls).toHaveLength(0);
    const entry = rebuilt.rebuild.transports.find(
      (candidate) => candidate.channelDir === channelDir,
    );
    expect(entry?.status).toBe("failed");
    expect(entry?.detail).toContain("script-trust dialog");
  });

  it("reports unproven when the channel provenance cannot be read", async () => {
    seedCrashedSession();
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "provenance.json"), "{broken", "utf-8");
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    expect(activateCalls).toHaveLength(0);
    const entry = rebuilt.rebuild.transports.find(
      (candidate) => candidate.channelDir === channelDir,
    );
    expect(entry?.status).toBe("unproven");
    expect(entry?.detail).toContain("cannot be read");
  });

  it("reports unproven for a corrupt activation index and still checks the default channel", async () => {
    seedCrashedSession();
    writeFileSync(join(sessionRoot, "dispatcher-activations.json"), "{broken", "utf-8");
    seedChannelProvenance(channelDir, OLD_PID);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    const corrupt = rebuilt.rebuild.transports.find(
      (entry) => entry.channelDir === undefined && entry.transport === "in-ae-dispatcher",
    );
    expect(corrupt?.status).toBe("unproven");
    expect(corrupt?.detail).toContain("index is corrupt");
    // The default channel was still evaluated on its own evidence.
    expect(activateCalls.map((call) => call.channelDir)).toEqual([channelDir]);
  });

  it("records the restage outcome in the recovery-succeeded reason and the trace", async () => {
    seedCrashedSession();
    seedChannelProvenance(channelDir, OLD_PID);
    const transport = fakeTransport();
    const { deps: d } = deps();

    const rebuilt = await openRebuiltSession({ sessionRoot, transport }, d);

    const succeeded = readDocHistory().filter((entry) => entry.to === "resumed");
    expect(succeeded[0]?.reason).toContain("transport restage");
    expect(succeeded[0]?.reason).toContain("restaged");

    const trace = rebuilt.session.events.find((event) => event.op === "session.rebuild");
    const transports = (
      trace?.result as { transports?: readonly { status: string }[] } | undefined
    )?.transports;
    expect(transports?.some((entry) => entry.status === "restaged")).toBe(true);
  });

  it("never attempts re-staging when the rebuild refuses before relaunch", async () => {
    // Attached-shaped session: supervision proved process-gone but no
    // launch provenance exists, so nothing is spawned and no transport
    // surface is touched.
    writeSupervisionState(sessionRoot, processGoneDoc());
    seedChannelProvenance(channelDir, OLD_PID);
    const transport = fakeTransport();
    const { deps: d, activateCalls } = deps();

    await expect(
      openRebuiltSession({ sessionRoot, transport }, d),
    ).rejects.toBeInstanceOf(AfterEffectsError);
    expect(transport.launched).toBe(false);
    expect(activateCalls).toHaveLength(0);
  });
});

function readDocHistory(): { to: string; reason: string }[] {
  const read = readSupervisionState(sessionRoot);
  if (read.kind !== "state") {
    throw new Error(`expected supervision state, got ${read.kind}`);
  }
  return read.doc.history.map((entry) => ({ to: entry.to, reason: entry.reason }));
}
