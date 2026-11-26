/**
 * Boot supervision (#339): the window between the transport's `launch()`
 * process census and the readiness probe's first ExtendScript response.
 *
 * A startup modal can hold that window open for the whole readiness
 * budget, and before this change nothing observed it. The contract under
 * test:
 *
 * - The driver invokes a `bootSupervision` hook after `launch()` and
 *   before the probe; the hook is released when the launch fails, and a
 *   hook that throws never fails the launch.
 * - `startBootSupervision` starts a monitor only when the transport can
 *   prove pid *and* login session pre-probe — the same attestation the
 *   post-probe path requires — and `verifyPid` re-proves the pid on every
 *   observation. Ambiguity (no pid, no session, foreign session shape)
 *   yields no monitor, never a guessed target.
 * - The monitor lease still holds: a second monitor on the same session
 *   root is refused while the first lives.
 * - `AfterEffects.launch` wires the hook for transports that attest a
 *   pre-probe target (macOS lane; the durable document survives a failed
 *   launch as the last proven state).
 *
 * Everything here runs against fakes and injected seams — no After Effects
 * and no real GUI session is required or claimed.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AfterEffects,
} from "../src/api/index.js";
import {
  asBootSupervisionTransport,
  startBootSupervision,
} from "../src/api/launch.js";
import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { MacSession } from "../src/driver/mac-session.js";
import {
  SessionSupervision,
  type SessionSupervisionOptions,
} from "../src/driver/supervision-session.js";
import type {
  HostOwnership,
  HostTransport,
  InvokeOptions,
  PendingLaunch,
} from "../src/driver/transport.js";
import type { GuiProbe, ProbeSnapshot } from "../src/supervision/probe.js";
import { supervisionReport } from "../src/supervision/index.js";
import { supervisionStatePath } from "../src/supervision/state.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

const AQUA_SESSION: MacSession = {
  uid: 501,
  username: "tester",
  asid: 42,
  kind: "Aqua",
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-boot-sup-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A transport that attests a pre-probe target the way
 * `ScriptInvocationTransport` does: a pid the launch census proved and the
 * login session it lives in. `pid`/`session` are mutable so a test can play
 * census drift — a reused pid or a second instance — between calls.
 */
class AttestingTransport implements HostTransport {
  readonly kind = "attesting-fake";
  readonly events: string[] = [];
  pid: number | null = 4242;
  session: MacSession | null = AQUA_SESSION;
  invokeError: Error | null = null;
  hangInvoke = false;
  pending: PendingLaunch | null = null;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  launch(): Promise<void> {
    this.events.push("launch");
    return Promise.resolve();
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.events.push("invoke");
    if (this.hangInvoke) {
      return new Promise<void>(() => {});
    }
    return this.invokeError === null
      ? Promise.resolve()
      : Promise.reject(this.invokeError);
  }

  recoveryTargetPid(): number | null {
    return this.pid;
  }

  get targetSession(): MacSession | null {
    return this.session;
  }

  pendingLaunch(): PendingLaunch | null {
    return this.pending;
  }

  ownership(): HostOwnership {
    return { kind: "unknown", evidence: "probe never proved which instance answered" };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The in-repo fake host plus the pre-probe attestation
 * `ScriptInvocationTransport` provides: a pid the launch census proved and
 * the login session it lives in. Used where `driver.start()` must actually
 * answer the `app.info` probe — the bare `AttestingTransport` above cannot
 * produce a result file, so it only proves the hook's failure paths.
 */
class BootAttestingFakeTransport extends FakeAfterEffectsTransport {
  pidValue: number | null = 4242;
  sessionValue: MacSession | null = AQUA_SESSION;
  failInvoke = false;

  override invoke(entryScriptPath: string): Promise<void> {
    if (this.failInvoke) {
      return Promise.reject(new Error("probe denied (-1743)"));
    }
    return super.invoke(entryScriptPath);
  }

  recoveryTargetPid(): number | null {
    return this.pidValue;
  }

  get targetSession(): MacSession | null {
    return this.sessionValue;
  }
}

function driverOn(
  transport: HostTransport,
  options: { readinessTimeoutMs?: number; bootSupervision?: { start(): void; stop(): void } } = {},
): AeDriver {
  return new AeDriver({
    transport,
    sessionRoot: root,
    trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
    ...(options.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.bootSupervision === undefined
      ? {}
      : { bootSupervision: options.bootSupervision }),
  });
}

describe("asBootSupervisionTransport", () => {
  it("accepts a transport that attests pid and session, refuses one that cannot", () => {
    expect(asBootSupervisionTransport(new AttestingTransport())).not.toBeNull();
    // The in-repo fake names no pre-probe target: no monitor, honestly.
    expect(asBootSupervisionTransport(new FakeAfterEffectsTransport())).toBeNull();
  });
});

describe("startBootSupervision", () => {
  function beginCapture() {
    const calls: SessionSupervisionOptions[] = [];
    return {
      calls,
      start: (options: SessionSupervisionOptions) => {
        calls.push(options);
        return null;
      },
    };
  }

  it("starts nothing when the census cannot name a pid", () => {
    const transport = new AttestingTransport();
    transport.pid = null;
    const { calls, start } = beginCapture();
    const supervision = startBootSupervision({
      transport,
      sessionRoot: root,
      pendingRequests: () => [],
      start,
    });
    expect(supervision).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("starts nothing without a proven login session", () => {
    for (const session of [null, { ...AQUA_SESSION, kind: "Background" as const }]) {
      const transport = new AttestingTransport();
      transport.session = session;
      const { calls, start } = beginCapture();
      expect(
        startBootSupervision({
          transport,
          sessionRoot: root,
          pendingRequests: () => [],
          start,
        }),
      ).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("passes the attested pid/session and a census re-proof to the monitor", () => {
    const transport = new AttestingTransport();
    const pending = [
      { id: "req-1", method: "comp.create", since: "2026-11-26T00:00:00Z", state: "in-flight" as const },
    ];
    const { calls, start } = beginCapture();
    startBootSupervision({
      transport,
      sessionRoot: root,
      pendingRequests: () => pending,
      start,
    });
    expect(calls).toHaveLength(1);
    const options = calls[0]!;
    expect(options.sessionRoot).toBe(root);
    expect(options.pid).toBe(4242);
    expect(options.target).toEqual({ platform: "darwin", session: AQUA_SESSION });
    expect(options.pendingRequests?.()).toBe(pending);
    // verifyPid re-runs the census: same pid proves, drifted census does not.
    expect(options.verifyPid?.(4242)).toBe(true);
    transport.pid = 9999;
    expect(options.verifyPid?.(4242)).toBe(false);
    transport.pid = null;
    expect(options.verifyPid?.(4242)).toBe(false);
  });
});

describe("driver bootSupervision hook", () => {
  it("runs after launch() and before the probe's first invoke; not stopped on success", async () => {
    const transport = new BootAttestingFakeTransport();
    const order: string[] = [];
    const originalLaunch = transport.launch.bind(transport);
    transport.launch = async () => {
      order.push("launch");
      await originalLaunch();
    };
    const originalInvoke = transport.invoke.bind(transport);
    transport.invoke = (entryScriptPath: string) => {
      order.push("invoke");
      return originalInvoke(entryScriptPath);
    };
    const driver = driverOn(transport, {
      bootSupervision: {
        start: () => order.push("boot.start"),
        stop: () => order.push("boot.stop"),
      },
    });
    // The probe is the first invoke; the hook must already have run.
    const info = await driver.start();
    expect(info.version).toBeTruthy();
    expect(order[0]).toBe("launch");
    expect(order[1]).toBe("boot.start");
    expect(order.indexOf("boot.start")).toBeLessThan(order.indexOf("invoke"));
    expect(order).not.toContain("boot.stop");
    await driver.stop();
  });

  it("is released when the probe fails, and the launch error still surfaces", async () => {
    const transport = new AttestingTransport();
    transport.invokeError = new Error("probe denied (-1743)");
    let stops = 0;
    const driver = driverOn(transport, {
      bootSupervision: {
        start: () => {},
        stop: () => {
          stops += 1;
        },
      },
    });
    await expect(driver.start()).rejects.toThrow("probe denied");
    expect(stops).toBe(1);
  });

  it("is released when the probe hits its deadline", async () => {
    const transport = new AttestingTransport();
    transport.hangInvoke = true;
    let stops = 0;
    const driver = driverOn(transport, {
      readinessTimeoutMs: 60,
      bootSupervision: {
        start: () => {},
        stop: () => {
          stops += 1;
        },
      },
    });
    await expect(driver.start()).rejects.toBeInstanceOf(TimeoutError);
    expect(stops).toBe(1);
  });

  it("a hook that throws is traced, never fatal to the launch", async () => {
    const transport = new BootAttestingFakeTransport();
    const driver = driverOn(transport, {
      bootSupervision: {
        start: () => {
          throw new Error("observer broke");
        },
        stop: () => {},
      },
    });
    const info = await driver.start();
    expect(info.version).toBeTruthy();
    await driver.stop();
    expect(existsSync(join(root, "trace.jsonl"))).toBe(true);
  });
});

describe("boot monitor lease", () => {
  const CLEAN: ProbeSnapshot = { ok: true, windows: [], host: "none" };

  it("refuses a second monitor on the same session root while the first lives", () => {
    const probe: GuiProbe = { observe: () => CLEAN };
    const first = SessionSupervision.start({
      sessionRoot: root,
      pid: 4242,
      target: { platform: "win32", session: { sessionId: 3 } },
      platform: "win32",
      probe,
      verifyPid: () => true,
      intervalMs: 10,
    });
    try {
      expect(first).not.toBeNull();
      expect(existsSync(supervisionStatePath(root))).toBe(true);
      const second = SessionSupervision.start({
        sessionRoot: root,
        pid: 4242,
        target: { platform: "win32", session: { sessionId: 3 } },
        platform: "win32",
        probe,
        verifyPid: () => true,
        intervalMs: 10,
      });
      expect(second).toBeNull();
    } finally {
      first?.stop();
    }
  });
});

describe("AfterEffects.launch boot supervision wiring", () => {
  it.runIf(process.platform === "darwin")(
    "observes the pre-probe target and keeps one monitor after the probe",
    async () => {
      const sessionRoot = join(root, "session");
      const ae = await AfterEffects.launch({
        sessionRoot,
        transport: new BootAttestingFakeTransport(),
      });
      try {
        // The boot monitor published before the probe answered; the
        // post-probe path must not start a second one on the same root.
        const report = ae.supervisionState();
        expect(report.status).toBe("observed");
        expect(existsSync(supervisionStatePath(sessionRoot))).toBe(true);
      } finally {
        await ae.close();
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "leaves the last proven supervision state after a failed launch",
    async () => {
      const sessionRoot = join(root, "session-fail");
      const transport = new BootAttestingFakeTransport();
      transport.failInvoke = true;
      await expect(
        AfterEffects.launch({ sessionRoot, transport }),
      ).rejects.toThrow();
      // The monitor the boot hook started was released, but the document
      // it published survives: readers see the last proven state, then
      // monitor-lost once the heartbeat goes stale.
      const report = supervisionReport(sessionRoot);
      expect(report.status).toBe("observed");
    },
  );
});
