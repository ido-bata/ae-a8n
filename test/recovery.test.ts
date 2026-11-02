/**
 * What the driver does when an operation times out and a recovery unblocks
 * the host.
 *
 * The rule under test: the operation that timed out is **not** sent again.
 * A timeout says the answer did not arrive in time, not that the work was
 * abandoned — the request may still be running inside After Effects, and
 * sending it twice would run it twice.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { HostRecovery } from "../src/driver/recovery.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A host that never answers by itself: the request is accepted and the
 * result appears only when the test says so.
 */
class BlockedTransport implements HostTransport {
  readonly kind = "blocked";
  invocations = 0;
  /** The id of the request that is waiting. */
  pendingId: string | null = null;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async launch(): Promise<void> {
    // Nothing to start.
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.invocations += 1;
    // The request file holds the id the driver will wait for.
    const inbox = join(root, "inbox");
    const file = readdirSync(inbox).find((name) => name.endsWith(".request.json"));
    this.pendingId = file === undefined ? null : file.replace(".request.json", "");
    // The result is never written here: the host is blocked.
    return Promise.resolve();
  }

  ownership(): HostOwnership {
    return { kind: "owned", evidence: "blocked test host" };
  }

  /** The blocked host finishes the request it already has. */
  finish(result: unknown): void {
    if (this.pendingId === null) {
      throw new Error("no request is pending");
    }
    writeFileSync(
      join(root, "outbox", `${this.pendingId}.result.json`),
      JSON.stringify({ v: 1, id: this.pendingId, ok: true, durationMs: 1, result }),
    );
  }

  close(): Promise<void> {
    // Nothing to close.
    return Promise.resolve();
  }
}

function startDriver(transport: HostTransport, recovery?: HostRecovery): AeDriver {
  const trace = new TraceRecorder({ file: join(root, "trace.jsonl") });
  const driver = new AeDriver({
    transport,
    sessionRoot: root,
    trace,
    defaultTimeoutMs: 200,
    ...(recovery === undefined ? {} : { recovery, recoveryGraceMs: 800 }),
  });
  return driver;
}

describe("a timeout followed by a recovery", () => {
  it("waits for the original request instead of sending it again", async () => {
    const transport = new BlockedTransport();
    let attempts = 0;
    const recovery: HostRecovery = {
      attempt: () => {
        attempts += 1;
        // Closing the dialog lets the host finish the request it already has.
        transport.finish({ version: "26.5x89" });
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const info = await driver.call<{ version: string }>("app.info", {});
    expect(info.version).toBe("26.5x89");
    expect(attempts).toBe(1);
    // One request, one invocation: the operation was not repeated.
    expect(transport.invocations).toBe(1);
  });

  it("reports the timeout when the recovery does not help", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => Promise.resolve({ recovered: false, evidence: "no dialog was found" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
  });

  it("does not repeat the operation when the recovery only half worked", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({ recovered: true, evidence: "pressed OK, but the host stayed quiet" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    // The request was sent once; the recovery waited for its result and gave up.
    expect(transport.invocations).toBe(1);
  });
});
