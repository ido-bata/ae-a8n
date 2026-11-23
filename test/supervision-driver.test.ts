/**
 * Driver ↔ supervision integration (#285): a blocking phase observed while
 * a request waits triggers the same recovery the timeout path runs — before
 * the deadline, never a resend — and a quarantine surfaces as an answer,
 * not a timeout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, HostQuarantinedError } from "../src/driver/driver.js";
import type { HostRecovery, RecoveryContext } from "../src/driver/recovery.js";
import type { InvokeOptions } from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import {
  applySupervisionEvent,
  initialSupervisionDoc,
} from "../src/supervision/machine.js";
import type {
  SupervisionReport,
  SupervisionStateDoc,
} from "../src/supervision/types.js";

class SlowTransport extends FakeAfterEffectsTransport {
  delayMs = 0;

  /**
   * Resolve `invoke` immediately and run the host script `delayMs` later —
   * the shape the dispatcher/native transports have in production, where
   * invoke returns at enqueue time and the result arrives while the driver
   * is still polling. That is the window supervision early recovery covers.
   */
  override invoke(entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    setTimeout(() => {
      // `invoke` is not async and can throw synchronously; the deferred
      // script is fire-and-forget either way — only its result file counts.
      try {
        void Promise.resolve(super.invoke(entryScriptPath)).catch(() => undefined);
      } catch {
        // A synchronous throw is the same dead end: no result will come.
      }
    }, this.delayMs);
    return Promise.resolve();
  }
}

/**
 * A transport whose `invoke` never settles and ignores the abort signal —
 * the worst case #296 covers: the caller must still be released at the
 * deadline, and a proven block must release it earlier.
 */
class HangTransport extends FakeAfterEffectsTransport {
  /** Invocations before the hang starts; the launch probe must pass. */
  hangAfter = 1;
  #count = 0;

  override invoke(entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.#count += 1;
    if (this.#count > this.hangAfter) {
      return new Promise<void>(() => {});
    }
    return super.invoke(entryScriptPath);
  }
}

function blockedDoc(): SupervisionStateDoc {
  const now = new Date();
  const result = applySupervisionEvent(
    initialSupervisionDoc({ now }),
    {
      kind: "blocking-observed",
      blocking: {
        host: "none",
        windows: [
          {
            title: "mystery",
            role: "AXWindow",
            subrole: null,
            texts: [],
            buttons: [],
            blocking: true,
            tier: "unknown",
            dialogClass: null,
            code: "A8N-SEC-001",
          },
        ],
        detail: "test block",
      },
      reason: "test",
    },
    now,
  );
  if (!result.ok) {
    throw new Error(`fixture transition refused: ${result.reason}`);
  }
  return result.doc;
}

function blockedReport(doc: SupervisionStateDoc): SupervisionReport {
  return {
    status: "observed",
    source: "state",
    doc,
    health: "ok",
    healthDetail: null,
    readAt: new Date().toISOString(),
  };
}

let sessionRoot: string;
let transport: SlowTransport;
let attempts: RecoveryContext[];
let report: SupervisionReport | null;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-supdrv-"));
  transport = new SlowTransport();
  attempts = [];
  report = null;
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

function makeDriver(
  recovery?: HostRecovery,
  options: { readonly hang?: boolean; readonly timeoutMs?: number } = {},
) {
  const trace = new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") });
  const active = options.hang === true ? new HangTransport() : transport;
  return new AeDriver({
    transport: active,
    sessionRoot,
    trace,
    supervision: { report: () => report },
    ...(recovery === undefined ? {} : { recovery }),
    defaultTimeoutMs: options.timeoutMs ?? 5_000,
    recoveryGraceMs: 300,
  });
}

const recovered: HostRecovery = {
  attempt: (context) => {
    attempts.push(context);
    return Promise.resolve({ recovered: true, evidence: "pressed OK on the measured dialog" });
  },
};

describe("supervision-aware result waits (#285)", () => {
  it("runs recovery as soon as a blocking phase is observed, then returns the original result", async () => {
    const driver = makeDriver(recovered);
    await driver.start();
    transport.delayMs = 400;
    report = blockedReport(blockedDoc());

    const began = Date.now();
    const info = await driver.call<{ version: string }>("app.info", {}, { timeoutMs: 5_000 });
    // The block was seen during the wait — the call resolved on the
    // request's own result, well inside its budget, not on a timeout.
    expect(info.version).toBe("26.0.0");
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.method).toBe("app.info");
  });

  it("surfaces a quarantine as an answer, not a timeout", async () => {
    const quarantined: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "quarantined" as const,
          code: "A8N-SEC-001" as const,
          evidence: "unmeasured blocking window; nothing was pressed",
        }),
    };
    const driver = makeDriver(quarantined);
    await driver.start();
    transport.delayMs = 400;
    report = blockedReport(blockedDoc());

    const error = await driver
      .call("app.info", {}, { timeoutMs: 5_000 })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(HostQuarantinedError);
    expect(attempts).toHaveLength(0);
  });

  it("does not consult supervision when no monitor report exists", async () => {
    const driver = makeDriver(recovered);
    await driver.start();
    transport.delayMs = 0;
    // report stays null: the wait behaves exactly as before.
    const info = await driver.call<{ version: string }>("app.info");
    expect(info.version).toBe("26.0.0");
    expect(attempts).toHaveLength(0);
  });
});

describe("invoke-internal hangs (#296)", () => {
  it("releases an abort-ignoring transport at the deadline even with no supervision", async () => {
    const driver = makeDriver(undefined, { hang: true, timeoutMs: 300 });
    await driver.start();
    const began = Date.now();
    const error = await driver
      .call("app.info", {}, { timeoutMs: 300 })
      .then(() => null, (e: unknown) => e);
    // Without the deadline race this wait would never return.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("moves to recovery before the deadline when supervision proves a block", async () => {
    const driver = makeDriver(recovered, { hang: true, timeoutMs: 4_000 });
    await driver.start();
    report = blockedReport(blockedDoc());

    const began = Date.now();
    const error = await driver
      .call("app.info", {}, { timeoutMs: 4_000 })
      .then(() => null, (e: unknown) => e);
    // The block was seen during the invoke wait: recovery ran and the
    // caller got a bounded structured answer, not an infinite hang.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  }, 20_000);
});
