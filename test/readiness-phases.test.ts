/**
 * Launch readiness phases and modal-blocked classification (#444), driven
 * through the real `AeDriver.start()` path against the in-repo fake
 * transport. The only things faked are the transport's scriptable wait and
 * the supervision report the boot monitor would publish.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AeDriver,
  HostLeftRunningError,
  HostUnavailableError,
  type ReadinessFailure,
} from "../src/driver/driver.js";
import type { LaunchPhaseTiming, PendingLaunch } from "../src/driver/transport.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";
import type { SupervisionReport, SupervisionWindow } from "../src/supervision/types.js";
import type { ProbeSnapshot } from "../src/supervision/probe.js";

let sessionRoot: string;
let traceFile: string;
let events: TraceEvent[];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-readiness-"));
  traceFile = join(sessionRoot, "trace.jsonl");
  events = [];
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

/**
 * A fake host whose `awaitScriptable` answers a scripted value — the seam
 * a real script-invocation transport exposes for "first ExtendScript
 * response" readiness.
 */
class ScriptableWaitTransport extends FakeAfterEffectsTransport {
  scriptableResult: boolean;
  #launchPhaseRows: LaunchPhaseTiming[] = [];

  constructor(scriptableResult: boolean) {
    super();
    this.scriptableResult = scriptableResult;
  }

  awaitScriptable(): Promise<boolean> {
    return Promise.resolve(this.scriptableResult);
  }

  launchPhases(): readonly LaunchPhaseTiming[] {
    return this.#launchPhaseRows;
  }

  recordLaunchPhase(stepId: string, durationMs = 1): void {
    this.#launchPhaseRows.push({
      stepId,
      startedAt: new Date().toISOString(),
      durationMs,
    });
  }
}

function makeDriver(
  transport: FakeAfterEffectsTransport,
  options: {
    report?: () => SupervisionReport | null;
    supervision?: { report(): SupervisionReport | null };
    observe?: () => ProbeSnapshot | Promise<ProbeSnapshot> | null;
  } = {},
): AeDriver {
  const trace = new TraceRecorder({ file: traceFile });
  trace.subscribe((event) => events.push(event));
  return new AeDriver({
    transport,
    sessionRoot,
    trace,
    ...(options.report === undefined && options.observe === undefined
      ? {}
      : {
          bootSupervision: {
            start: () => {},
            stop: () => {},
            ...(options.report === undefined ? {} : { report: options.report }),
            ...(options.observe === undefined ? {} : { observe: options.observe }),
          },
        }),
    ...(options.supervision === undefined ? {} : { supervision: options.supervision }),
  });
}

function launchEvents(): TraceEvent[] {
  return events.filter((event) => event.op === "session.launch");
}

function blockingWindow(overrides: Partial<SupervisionWindow> = {}): SupervisionWindow {
  return {
    title: "After Effects",
    role: "AXWindow",
    subrole: null,
    texts: ["A script error occurred"],
    buttons: ["OK"],
    blocking: true,
    tier: "human-required",
    dialogClass: "script-error",
    code: "A8N-DLG-001",
    ...overrides,
  };
}

function reportWith(
  windows: readonly SupervisionWindow[],
  host: "none" | "process-gone" | "unknown" | "busy-suspected" = "unknown",
): SupervisionReport {
  const now = new Date().toISOString();
  return {
    status: "observed",
    source: "state",
    doc: {
      schemaVersion: "ae-a8n.supervision/v1",
      sessionId: null,
      phase: "blocked",
      observationHealth: "ok",
      blocking: {
        host,
        windows,
        detail: `${windows.length} blocking window(s)`,
      },
      pendingRequests: [],
      enteredAt: now,
      deadline: now,
      evidence: [],
      monitor: null,
      history: [],
      updatedAt: now,
    },
    health: "ok",
    healthDetail: null,
    readAt: now,
    stateFile: join(sessionRoot, "supervision.json"),
    nextActions: [],
  };
}

function cleanReport(): SupervisionReport {
  const now = new Date().toISOString();
  return {
    status: "observed",
    source: "state",
    doc: {
      schemaVersion: "ae-a8n.supervision/v1",
      sessionId: null,
      phase: "running",
      observationHealth: "ok",
      blocking: null,
      pendingRequests: [],
      enteredAt: now,
      deadline: null,
      evidence: [],
      monitor: null,
      history: [],
      updatedAt: now,
    },
    health: "ok",
    healthDetail: null,
    readAt: now,
    stateFile: join(sessionRoot, "supervision.json"),
    nextActions: [],
  };
}

function stepIds(event: TraceEvent): string[] {
  return (event.stepTimings ?? []).map((timing) => timing.stepId);
}

describe("launch readiness phases (#444)", () => {
  it("records the named phases on a successful session.launch", async () => {
    const driver = makeDriver(new FakeAfterEffectsTransport());
    const info = await driver.start();
    expect(info.version).toBe("26.0.0");

    const launch = launchEvents().find((event) => event.status === "ok");
    expect(launch).toBeDefined();
    const ids = stepIds(launch!);
    // The spec §6 phases, in order: spawn → OS observation → first
    // ExtendScript response → capability handshake.
    expect(ids).toContain("process-spawn");
    expect(ids).toContain("extendscript-response");
    expect(ids).toContain("handshake");
    // The fake has no scriptable wait; the phase is recorded as skipped,
    // never silently absent.
    const scriptable = launch!.stepTimings!.find((t) => t.stepId === "scriptable-wait");
    expect(scriptable?.actual).toMatchObject({ skipped: expect.any(String) });
    expect(ids.indexOf("process-spawn")).toBeLessThan(ids.indexOf("extendscript-response"));
    expect(ids.indexOf("extendscript-response")).toBeLessThan(ids.indexOf("handshake"));
  });

  it("folds the transport's launch sub-phases into session.launch stepTimings", async () => {
    const transport = new ScriptableWaitTransport(true);
    transport.recordLaunchPhase("process-census");
    transport.recordLaunchPhase("process-start");
    const driver = makeDriver(transport);
    await driver.start();

    const launch = launchEvents().find((event) => event.status === "ok");
    const ids = stepIds(launch!);
    expect(ids).toContain("process-census");
    expect(ids).toContain("process-start");
    expect(ids.indexOf("process-spawn")).toBeLessThan(ids.indexOf("process-census"));
    expect(ids.indexOf("process-start")).toBeLessThan(ids.indexOf("scriptable-wait"));
  });
});

describe("readiness classification (#444)", () => {
  it("classifies a blocking window as modal-blocked:<class> and records it", async () => {
    const transport = new ScriptableWaitTransport(false);
    const window = blockingWindow();
    const driver = makeDriver(transport, {
      report: () => reportWith([window]),
    });

    const error = await driver.start().then(
      () => {
        throw new Error("start() should have failed");
      },
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HostUnavailableError);
    const readiness = (error as HostUnavailableError).readiness as ReadinessFailure;
    expect(readiness.reason).toBe("modal-blocked");
    expect(readiness.code).toBe("modal-blocked:script-error");
    expect(readiness.phase).toBe("scriptable-wait");
    expect(readiness.modal).toMatchObject({
      dialogClass: "script-error",
      tier: "human-required",
      title: "After Effects",
    });
    expect(errorMessage(error)).toContain("modal-blocked:script-error");

    const launch = launchEvents().find((event) => event.status === "error");
    expect(launch).toBeDefined();
    expect(launch!.result).toMatchObject({
      readiness: { reason: "modal-blocked", code: "modal-blocked:script-error" },
    });
    expect(stepIds(launch!)).toContain("scriptable-wait");
  });

  it("classifies a window no taxonomy class matched as modal-blocked:unclassified", async () => {
    const transport = new ScriptableWaitTransport(false);
    const window = blockingWindow({
      dialogClass: null,
      tier: "unknown",
      code: null,
      texts: ["CEggApp::BirthPrefs Messagebox"],
    });
    const driver = makeDriver(transport, {
      report: () => reportWith([window]),
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.reason).toBe("modal-blocked");
    expect(error.readiness?.code).toBe("modal-blocked:unclassified");
    expect(error.readiness?.modal?.dialogClass).toBeNull();
  });

  it("picks the human-required window over an unclassified one", async () => {
    const transport = new ScriptableWaitTransport(false);
    const windows = [
      blockingWindow({ title: "Mystery", dialogClass: null, tier: "unknown", code: null }),
      blockingWindow({ title: "Script error", dialogClass: "script-error" }),
    ];
    const driver = makeDriver(transport, { report: () => reportWith(windows) });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.code).toBe("modal-blocked:script-error");
    expect(error.readiness?.modal?.title).toBe("Script error");
  });

  it("classifies a silent but present host as timeout", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "alive";
    const driver = makeDriver(transport, { report: () => cleanReport() });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.reason).toBe("timeout");
    expect(error.readiness?.code).toBe("timeout");
    expect(error.readiness?.phase).toBe("scriptable-wait");
  });

  it("classifies a budget spent with no proven process as still-launching", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "unknown";
    const driver = makeDriver(transport, { report: () => cleanReport() });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.reason).toBe("still-launching");
    expect(error.readiness?.code).toBe("still-launching");
  });

  it("classifies a gone host as probe-failure", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "gone";
    const driver = makeDriver(transport, { report: () => cleanReport() });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.reason).toBe("probe-failure");
    expect(error.readiness?.code).toBe("probe-failure");
    expect(error.readiness?.detail).toContain("gone");
  });

  it("classifies a launch() failure that is not a timeout as probe-failure", async () => {
    class FailingLaunch extends FakeAfterEffectsTransport {
      override launch(): Promise<void> {
        return Promise.reject(new Error("launcher refused: no AE bundle"));
      }
    }
    const driver = makeDriver(new FailingLaunch(), { report: () => cleanReport() });

    // A launcher failure is not a HostUnavailableError — the original
    // error propagates — but the trace row still carries the structured
    // classification instead of an opaque total.
    const error = await driver.start().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("launcher refused");

    const launch = launchEvents().find((event) => event.status === "error");
    expect(launch).toBeDefined();
    expect(launch!.result).toMatchObject({
      readiness: {
        reason: "probe-failure",
        code: "probe-failure",
        phase: "process-spawn",
      },
    });
    expect((launch!.result as { readiness: ReadinessFailure }).readiness.detail).toContain(
      "launcher refused",
    );
    expect(stepIds(launch!)).toContain("process-spawn");
  });

  it("carries the classification on HostLeftRunningError when a spawned process is pending", async () => {
    class PendingLaunchTransport extends FakeAfterEffectsTransport {
      override launch(): Promise<void> {
        return Promise.reject(new Error("spawned but probe denied"));
      }
      pendingLaunch(): PendingLaunch {
        return {
          pid: 4242,
          startedAt: Date.now(),
          executable: "/Applications/After Effects.app",
          presentAtLastLookup: true,
          session: null,
        };
      }
    }
    const driver = makeDriver(new PendingLaunchTransport(), { report: () => cleanReport() });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostLeftRunningError;
    expect(error).toBeInstanceOf(HostLeftRunningError);
    expect(error.readiness?.code).toBe("probe-failure");
    expect(error.message).toContain("Readiness: probe-failure");
  });

  it("falls back to the post-probe supervision hook when no boot report exists", async () => {
    const transport = new ScriptableWaitTransport(false);
    const driver = makeDriver(transport, {
      supervision: { report: () => reportWith([blockingWindow()]) },
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.code).toBe("modal-blocked:script-error");
  });
});

describe("readiness failure observation (#452)", () => {
  /**
   * The #436 BirthPrefs shape: the WindowServer census lists windows for
   * the pid while the AX listing is empty — inside the probe's startup
   * grace this is degraded evidence, never a blocking window, so the
   * durable document stays blind and the wait classifies `timeout`.
   */
  const axEmptyCensusSnapshot: ProbeSnapshot = {
    ok: true,
    windows: [],
    host: "none",
    degraded: [
      "AX tree unserviceable: WindowServer reports 6 window(s) for this pid " +
        "while AX listed none attributable to it",
    ],
    census: {
      available: true,
      windowCount: 6,
      onScreenCount: 4,
      unaccountedWindowCount: 4,
      attributedWindowCount: 0,
      listingSuspect: true,
    },
  };

  it("attaches census evidence to a timeout so AX-invisible stays distinguishable", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "alive";
    let observes = 0;
    const driver = makeDriver(transport, {
      report: () => cleanReport(),
      observe: () => {
        observes += 1;
        return axEmptyCensusSnapshot;
      },
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    const readiness = error.readiness as ReadinessFailure;
    // Still `timeout`: census-positive + AX-empty inside grace is suspect
    // evidence, not a blocking verdict — the probe's own rules decided.
    expect(readiness.reason).toBe("timeout");
    expect(readiness.code).toBe("timeout");
    // Exactly one bounded read-only observation — never a restarted monitor.
    expect(observes).toBe(1);
    expect(readiness.observation).toMatchObject({
      unobservableModalSuspect: true,
      blockingWindowCount: 0,
      census: {
        available: true,
        windowCount: 6,
        onScreenCount: 4,
        unaccountedWindowCount: 4,
        attributedWindowCount: 0,
        listingSuspect: true,
      },
    });
    expect(readiness.observation?.degraded).toHaveLength(1);
    expect(readiness.detail).toContain("6 window(s)");
    expect(readiness.detail).toContain("consistent with an AX-invisible modal");
  });

  it("keeps the plain timeout wording when the census shows nothing suspect", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "alive";
    const driver = makeDriver(transport, {
      report: () => cleanReport(),
      observe: () => ({
        ok: true,
        windows: [],
        host: "none",
        census: {
          available: true,
          windowCount: 1,
          onScreenCount: 1,
          unaccountedWindowCount: 0,
          attributedWindowCount: 1,
          listingSuspect: false,
        },
      }),
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    const readiness = error.readiness as ReadinessFailure;
    expect(readiness.reason).toBe("timeout");
    expect(readiness.observation?.unobservableModalSuspect).toBe(false);
    expect(readiness.detail).toContain("cannot be ruled out");
    expect(readiness.detail).not.toContain("consistent with an AX-invisible modal");
  });

  it("records a probe that cannot observe as probeError, never a clean screen", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "alive";
    const driver = makeDriver(transport, {
      report: () => cleanReport(),
      observe: () => ({ ok: false, reason: "System Events lost the pid" }),
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    const readiness = error.readiness as ReadinessFailure;
    expect(readiness.reason).toBe("timeout");
    expect(readiness.observation).toMatchObject({
      probeError: "System Events lost the pid",
      census: null,
      unobservableModalSuspect: false,
    });
    expect(readiness.detail).toContain("cannot be ruled out");
  });

  it("carries no observation when the hook cannot answer", async () => {
    const transport = new ScriptableWaitTransport(false);
    transport.hostStateKind = "alive";
    const driver = makeDriver(transport, {
      report: () => cleanReport(),
      observe: () => null,
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    expect(error.readiness?.reason).toBe("timeout");
    expect(error.readiness?.observation).toBeUndefined();
  });

  it("attaches the observation to modal-blocked too — evidence, not a new verdict", async () => {
    const transport = new ScriptableWaitTransport(false);
    const driver = makeDriver(transport, {
      report: () => reportWith([blockingWindow()]),
      observe: () => axEmptyCensusSnapshot,
    });

    const error = (await driver.start().catch((thrown: unknown) => thrown)) as HostUnavailableError;
    const readiness = error.readiness as ReadinessFailure;
    expect(readiness.code).toBe("modal-blocked:script-error");
    expect(readiness.observation?.unobservableModalSuspect).toBe(true);
  });
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
