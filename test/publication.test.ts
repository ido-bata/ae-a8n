/**
 * The result-publication failure chain.
 *
 * The bridge publishes a result by rename so a reader never sees half an
 * envelope. The host falls back to a direct write when the rename fails, and
 * *that* write is not atomic — so a poller that treated the first read as final
 * would turn a transient publication failure into a permanent
 * `ProtocolError`:
 *
 *   rename fails → direct write → poller reads part of it → ProtocolError
 *
 * That path is reachable, so it is executed here rather than argued about, by
 * making `File.rename` fail on demand inside the real host script.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import type { HostTransport } from "../src/driver/transport.js";
import { createSessionPaths, probeResult, type SessionPaths } from "../src/protocol/workspace.js";
import { TraceRecorder } from "../src/trace/trace.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { failNextRenames, resetRenameFaults } from "../src/testing/fake-ae/es3-runtime.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-publish-"));
  transport = new FakeAfterEffectsTransport();
  resetRenameFaults();
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  resetRenameFaults();
});

function makeDriver(
  overrides: { transport?: HostTransport; timeoutMs?: number; readinessTimeoutMs?: number } = {},
): AeDriver {
  return new AeDriver({
    transport: overrides.transport ?? transport,
    sessionRoot,
    trace: new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") }),
    ...(overrides.timeoutMs === undefined ? {} : { defaultTimeoutMs: overrides.timeoutMs }),
    ...(overrides.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: overrides.readinessTimeoutMs }),
  });
}

function stagingLeftovers(paths: SessionPaths): string[] {
  const found: string[] = [];
  for (const dir of [paths.outbox, paths.inbox, paths.staging]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".part")) {
        found.push(join(dir, name));
      }
    }
  }
  return found;
}

describe("when the rename succeeds", () => {
  it("completes the call and leaves no staging file behind", async () => {
    const d = makeDriver();
    await d.start();
    await expect(d.call("app.info")).resolves.toMatchObject({ version: expect.any(String) });
    expect(stagingLeftovers(createSessionPaths(sessionRoot))).toEqual([]);
    await d.stop();
  });
});

describe("when the rename fails", () => {
  it("absorbs transient failures by retrying, and stays atomic", async () => {
    // The host retries a fixed number of times; two failures must not be enough
    // to push it onto the non-atomic path, so no `.part` file should survive.
    failNextRenames(2);
    const d = makeDriver();
    await d.start();
    await expect(d.call("app.info")).resolves.toBeDefined();
    expect(stagingLeftovers(createSessionPaths(sessionRoot))).toEqual([]);
    await d.stop();
  });

  it("completes the call anyway when every attempt fails", async () => {
    // More failures than the host retries, so the direct-write fallback is
    // genuinely taken — and the result must still be correct, not truncated.
    failNextRenames(99);
    const d = makeDriver();
    await d.start();
    await expect(d.call("app.info")).resolves.toMatchObject({ version: expect.any(String) });
    await d.stop();
  });

  it("produces a result the driver can still read, through the fallback", async () => {
    // The strongest form of the test: a full round trip where publication was
    // non-atomic and the operation still succeeded.
    failNextRenames(99);
    const d = makeDriver();
    await d.start();

    const project = join(sessionRoot, "fixture.aep");
    writeFileSync(project, "fake");
    await d.call("project.open", { path: project });
    const comps = await d.call<Array<{ name: string }>>("project.comps");
    expect(comps).toEqual([expect.objectContaining({ name: "Main" })]);
    await d.stop();
  });
});

describe("reading a result that is not yet whole", () => {
  it("distinguishes absent, unreadable, and read", () => {
    const paths = createSessionPaths(sessionRoot);
    expect(probeResult(paths, "nope").state).toBe("absent");

    const target = join(paths.outbox, "partial.result.json");
    writeFileSync(target, '{"v":1,"id":"partial","ok":tr', "utf-8");
    expect(probeResult(paths, "partial").state).toBe("unreadable");

    writeFileSync(target, '{"v":1,"id":"partial","ok":true,"durationMs":1,"result":null}', "utf-8");
    expect(probeResult(paths, "partial").state).toBe("read");
  });

  it("does not raise for a half-written file — that is the regression", () => {
    const paths = createSessionPaths(sessionRoot);
    writeFileSync(join(paths.outbox, "partial.result.json"), '{"v":1,"id":"x","ok":tr', "utf-8");
    expect(() => probeResult(paths, "partial")).not.toThrow();
  });

  it("still validates a result that parses but violates the protocol", () => {
    // Parseable but wrong is the driver's error, not the reader's: a bad
    // version must not be silently retried until the deadline.
    const paths = createSessionPaths(sessionRoot);
    writeFileSync(
      join(paths.outbox, "wrong.result.json"),
      '{"v":99,"id":"x","ok":true,"durationMs":0,"result":null}',
      "utf-8",
    );
    const probe = probeResult(paths, "wrong");
    expect(probe.state).toBe("read");
  });
});

describe("when a result never becomes readable", () => {
  /**
   * Runs a real operation, then corrupts the result the host just published.
   * The driver must report the *cause* rather than a bare timeout, because
   * "timed out" would send a reader looking at the host when the problem is on
   * the wire.
   */
  function corruptingTransport(inner: FakeAfterEffectsTransport, outbox: string): HostTransport {
    return {
      kind: "corrupting",
      available: () => inner.available(),
      launch: () => inner.launch(),
      close: () => inner.close(),
      invoke(entry: string): Promise<void> {
        return inner.invoke(entry).then(() => {
          const newest = readdirSync(outbox)
            .filter((name) => name.endsWith(".result.json"))
            .map((name) => join(outbox, name))
            .sort();
          const last = newest.at(-1);
          if (last !== undefined) {
            writeFileSync(last, "{ truncated", "utf-8");
          }
        });
      },
    };
  }

  it("reports an unparseable result, not a timeout", async () => {
    const outbox = createSessionPaths(sessionRoot).outbox;
    const d = makeDriver({
      transport: corruptingTransport(transport, outbox),
      // The readiness probe has its own, much larger budget; without lowering
      // it here the test would wait the full cold-start allowance.
      readinessTimeoutMs: 300,
    });

    await expect(d.start()).rejects.toThrow(/was never parseable/);
  });

  it("keeps the cause in the trace, not just the thrown message", async () => {
    const outbox = createSessionPaths(sessionRoot).outbox;
    const d = makeDriver({
      transport: corruptingTransport(transport, outbox),
      readinessTimeoutMs: 300,
    });
    await expect(d.start()).rejects.toThrow(/was never parseable/);

    const trace = (await import("node:fs")).readFileSync(join(sessionRoot, "trace.jsonl"), "utf-8");
    expect(trace).toContain("ProtocolError");
    expect(trace).toContain("was never parseable");
  });
});
