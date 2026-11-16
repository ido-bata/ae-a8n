/**
 * A launch that started After Effects but never proved it owns it.
 *
 * Measured on a real macOS helper session (2026-11-11, Aulymo #332): the
 * process was started, the readiness probe was denied with Apple Events error
 * `-1743`, and the run exited leaving After Effects running. The transport had
 * recorded the pid, but the driver threw the probe's error away and nothing
 * could say which process the run had left behind — and a later `stop()` would
 * have reported "never started".
 *
 * Provenance is not ownership. What is kept here is the identity of the
 * process this session started, so a human can find it; nothing is quit or
 * killed on the strength of it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffectsError, contextualise } from "../src/api/errors.js";
import { AeDriver, HostLeftRunningError } from "../src/driver/driver.js";
import { ScriptInvocationError } from "../src/driver/script-invocation.js";
import type {
  HostOwnership,
  HostTransport,
  InvokeOptions,
  PendingLaunch,
} from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-partial-launch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const STARTED_AT = Date.parse("2026-11-11T11:13:00Z");

const LAUNCH: PendingLaunch = {
  pid: 91135,
  startedAt: STARTED_AT,
  executable:
    "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects",
  presentAtLastLookup: true,
  session: { uid: 502, user: "test", asid: 100002 },
};

/** What `osascript` reports when TCC has not allowed the Apple Event. */
function denial(): ScriptInvocationError {
  return new ScriptInvocationError(
    "osascript",
    1,
    "execution error: Not authorized to send Apple events to Adobe After Effects 2027. (-1743)",
  );
}

/**
 * `launch()` succeeds, then every script is denied. `left` is what the
 * transport says it started and could not prove; null means the host was
 * already running and this session started nothing.
 */
class DeniedAfterStart implements HostTransport {
  readonly kind = "denied-after-start";
  launches = 0;
  invokes = 0;
  closes = 0;
  readonly denied = denial();

  constructor(private readonly left: PendingLaunch | null) {}

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  launch(): Promise<void> {
    this.launches += 1;
    return Promise.resolve();
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.invokes += 1;
    return Promise.reject(this.denied);
  }

  pendingLaunch(): PendingLaunch | null {
    return this.left;
  }

  ownership(): HostOwnership {
    return this.left === null
      ? { kind: "attached", evidence: "already running before launch: pid 7" }
      : { kind: "unknown", code: "A8N-AE-004", evidence: "the probe never proved which instance answered" };
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

function driverOn(transport: HostTransport): AeDriver {
  return new AeDriver({
    transport,
    sessionRoot: root,
    trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
  });
}

describe("a launch whose readiness probe was denied", () => {
  it("keeps the identity of the After Effects it started", async () => {
    const transport = new DeniedAfterStart(LAUNCH);
    const driver = driverOn(transport);

    const error = await driver.start().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(HostLeftRunningError);
    const left = error as HostLeftRunningError;
    expect(left.code).toBe("A8N-AE-005");
    expect(left.launch).toEqual(LAUNCH);
    expect(left.message).toContain("pid 91135");
    expect(left.message).toContain("-1743");
    expect(left.message).toContain("left running");
    expect(left.message).toContain("uid 502");
    expect(left.cause).toBe(transport.denied);

    // The trace is the surviving evidence when the caller's output is gone.
    const trace = readFileSync(join(root, "trace.jsonl"), "utf-8");
    expect(trace).toContain('"op":"session.launch"');
    expect(trace).toContain('"pid":91135');
    expect(trace).toContain(`"startedAt":${String(STARTED_AT)}`);
  });

  it("never quits, closes or re-sends anything on the strength of provenance", async () => {
    const transport = new DeniedAfterStart(LAUNCH);
    const driver = driverOn(transport);
    await expect(driver.start()).rejects.toBeInstanceOf(HostLeftRunningError);

    const stopped = await driver.stop();
    expect(stopped.quit).toBe(false);
    // Not "never started": a process was started and is still out there.
    expect(stopped.reason).not.toBe("never started");
    expect(stopped.reason).toContain("91135");
    expect(stopped.reason).toContain("left running");
    // One probe, no second Apple Event, no close.
    expect(transport.invokes).toBe(1);
    expect(transport.closes).toBe(0);
  });

  it("refuses to probe again from the same driver", async () => {
    const transport = new DeniedAfterStart(LAUNCH);
    const driver = driverOn(transport);
    await expect(driver.start()).rejects.toBeInstanceOf(HostLeftRunningError);

    await expect(driver.start()).rejects.toBeInstanceOf(HostLeftRunningError);
    expect(transport.invokes).toBe(1);
    expect(transport.launches).toBe(1);
  });

  it("says so instead of claiming the process is still running when it is gone", async () => {
    const gone: PendingLaunch = { ...LAUNCH, presentAtLastLookup: false };
    const driver = driverOn(new DeniedAfterStart(gone));

    const error = (await driver.start().then(
      () => null,
      (caught: unknown) => caught,
    )) as HostLeftRunningError;

    expect(error.message).toContain("not found");
    expect(error.message).not.toContain("still running");
  });

  it("rethrows the probe's own error when this session started no process", async () => {
    const transport = new DeniedAfterStart(null);
    const driver = driverOn(transport);

    const error = await driver.start().then(
      () => null,
      (caught: unknown) => caught,
    );

    // An attached host is somebody else's; the run left nothing behind.
    expect(error).toBe(transport.denied);
    expect(error).not.toBeInstanceOf(HostLeftRunningError);
    const stopped = await driver.stop();
    expect(stopped.reason).toBe("never started");
  });

  it("keeps the code and the identity through the public error layer", () => {
    const left = new HostLeftRunningError(LAUNCH, denial());
    let caught: unknown = null;
    try {
      contextualise("session.launch", left);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AfterEffectsError);
    expect(caught instanceof AfterEffectsError ? caught.code : null).toBe("A8N-AE-005");
    expect(caught instanceof AfterEffectsError ? caught.message : "").toContain("pid 91135");
    expect(caught instanceof AfterEffectsError ? caught.cause : null).toBe(left);
  });
});
