/**
 * A call that never reached After Effects.
 *
 * One macOS `DoScriptFile` runs at a time. A call issued while the previous
 * script is still running has to wait for it, and if its deadline passes
 * during that wait the script was never sent: nothing ran. Reporting that as
 * a timeout would claim the operation ran and did not answer, which sends the
 * reader looking in the wrong place — and it would wrongly invite a recovery
 * that waits for a result of an operation that never started.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { HostRecovery } from "../src/driver/recovery.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { ScriptNotSentError } from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-not-sent-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A host whose scripts never get sent: the queue wait was cut short. */
class NotSentTransport implements HostTransport {
  readonly kind = "not-sent";

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async launch(): Promise<void> {
    // Nothing to start.
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    return Promise.reject(
      new ScriptNotSentError(
        "the call was abandoned while it waited for the previous script to finish; " +
          "it was never sent to After Effects, so nothing ran",
      ),
    );
  }

  ownership(): HostOwnership {
    return { kind: "owned", evidence: "not-sent test host" };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("a call that was never sent", () => {
  it("is not reported as a timeout", async () => {
    const driver = new AeDriver({
      transport: new NotSentTransport(),
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
      defaultTimeoutMs: 200,
    });
    const error = await driver.call("app.info", {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ScriptNotSentError);
    expect(error).not.toBeInstanceOf(TimeoutError);
  });

  it("does not run a recovery for an operation that never started", async () => {
    let attempts = 0;
    const recovery: HostRecovery = {
      attempt: () => {
        attempts += 1;
        return Promise.resolve({ recovered: false, evidence: "nothing to recover" });
      },
    };
    const driver = new AeDriver({
      transport: new NotSentTransport(),
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
      defaultTimeoutMs: 200,
      recovery,
    });
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(ScriptNotSentError);
    expect(attempts).toBe(0);
  });
});
