/**
 * End-to-end through the real code path: request file → generated bootstrap →
 * ES3 host script → result file → driver poll.
 *
 * Only the peer supplying `app` is fake. Nothing between the driver and the
 * host script's dispatch table is stubbed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, HostUnavailableError } from "../src/driver/driver.js";
import { HostError, ProtocolError, parseRequestEnvelope, parseResultEnvelope } from "../src/protocol/envelope.js";
import { TraceRecorder, type TraceEvent } from "../src/trace/trace.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { createDefaultComp } from "../src/testing/fake-ae/object-model.js";

let sessionRoot: string;
let traceFile: string;
let transport: FakeAfterEffectsTransport;
let events: TraceEvent[];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-session-"));
  traceFile = join(sessionRoot, "trace.jsonl");
  transport = new FakeAfterEffectsTransport();
  events = [];
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

function makeDriver(): AeDriver {
  const trace = new TraceRecorder({ file: traceFile });
  trace.subscribe((event) => events.push(event));
  return new AeDriver({ transport, sessionRoot, trace });
}

function readTrace(): TraceEvent[] {
  return readFileSync(traceFile, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

describe("driver against the fake host", () => {
  it("launches and reports a readiness probe", async () => {
    const driver = makeDriver();
    const info = await driver.start();
    expect(info.version).toBe("26.0.0");
    expect(transport.launched).toBe(true);

    const launch = events.find((event) => event.op === "session.launch");
    expect(launch?.status).toBe("ok");
    expect(launch?.result).toMatchObject({ version: "26.0.0" });
  });

  it("opens a project and lists its compositions", async () => {
    const driver = makeDriver();
    await driver.start();

    const projectPath = join(sessionRoot, "fixture.aep");
    writeFileSync(projectPath, "fake project");

    const opened = await driver.call<{ file: string }>("project.open", { path: projectPath });
    expect(opened.file).toContain("fixture.aep");

    const comps = await driver.call<Array<{ name: string; layerCount: number }>>("project.comps");
    expect(comps).toEqual([
      expect.objectContaining({ name: "Main", layerCount: 1 }),
    ]);
  });

  it("walks comp → layer → effect → parameter and reads the value back", async () => {
    const driver = makeDriver();
    await driver.start();

    const layers = await driver.call<Array<{ name: string }>>("comp.layers", { name: "Main" });
    expect(layers).toEqual([{ name: "Solid 1", index: 1 }]);

    const applied = await driver.call<{ name: string; matchName: string; created: boolean }>(
      "layer.applyEffect",
      { comp: "Main", layer: "Solid 1", effect: "ADBE Fake Gaussian Blur" },
    );
    expect(applied).toEqual({
      name: "AE Fake Gaussian Blur",
      matchName: "ADBE Fake Gaussian Blur",
      created: true,
    });

    const set = await driver.call<{ name: string; value: number }>("effect.setParameter", {
      comp: "Main",
      layer: "Solid 1",
      effect: "ADBE Fake Gaussian Blur",
      parameter: "Amount",
      value: 50,
    });
    expect(set).toEqual({ name: "Amount", kind: "value", matchName: "ADBE Fake Gaussian Blur-0001", valueType: "OneD", value: 50 });

    const read = await driver.call<{ value: number }>("effect.getParameter", {
      comp: "Main",
      layer: "Solid 1",
      effect: "ADBE Fake Gaussian Blur",
      parameter: "Amount",
    });
    expect(read.value).toBe(50);
  });

  it("resolves an effect by display name as well as match name", async () => {
    const driver = makeDriver();
    await driver.start();

    await driver.call("layer.applyEffect", {
      comp: "Main",
      layer: "Solid 1",
      effect: "AE Fake Glow",
    });

    const effects = await driver.call<Array<{ name: string }>>("layer.effects", {
      comp: "Main",
      layer: "Solid 1",
    });
    expect(effects).toEqual([{ name: "AE Fake Glow", matchName: "ADBE Fake Glow" }]);
  });

  it("renders a frame to a real PNG on disk", async () => {
    const driver = makeDriver();
    await driver.start();

    const outputDir = join(sessionRoot, "renders");
    const rendered = await driver.call<{ path: string; frame: number }>("comp.renderFrame", {
      comp: "Main",
      frame: 0,
      outputDir,
    });

    expect(rendered.frame).toBe(0);
    expect(existsSync(rendered.path)).toBe(true);

    const png = readFileSync(rendered.path);
    // PNG signature.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("surfaces a host failure as a typed error, not a crash", async () => {
    const driver = makeDriver();
    await driver.start();

    await expect(
      driver.call("comp.info", { name: "Does Not Exist" }),
    ).rejects.toThrow(HostError);

    const failure = events.find((event) => event.status === "error");
    expect(failure?.error?.message).toContain("composition not found");
  });

  it("surfaces an unknown effect with AE's own error number", async () => {
    const driver = makeDriver();
    await driver.start();

    try {
      await driver.call("layer.applyEffect", {
        comp: "Main",
        layer: "Solid 1",
        effect: "ADBE No Such Plugin",
      });
      expect.unreachable("should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(HostError);
      expect((error as HostError).aeError).toBe(5023);
    }
  });

  it("writes a complete, replayable trace", async () => {
    const driver = makeDriver();
    await driver.start();
    await driver.call("layer.applyEffect", {
      comp: "Main",
      layer: "Solid 1",
      effect: "ADBE Fake Gaussian Blur",
    });
    await driver.call("effect.setParameter", {
      comp: "Main",
      layer: "Solid 1",
      effect: "ADBE Fake Gaussian Blur",
      parameter: "Amount",
      value: 25,
    });
    await driver.stop({ unsavedChanges: "discard" });

    const trace = readTrace();
    expect(trace.map((event) => event.op)).toEqual([
      "session.probe",
      "session.launch",
      "layer.applyEffect",
      "effect.setParameter",
      "session.quit",
      "session.close",
    ]);
    expect(trace.every((event) => event.status === "ok")).toBe(true);
    // Sequence numbers must be dense and ordered for the file to be replayable.
    expect(trace.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(trace[3]?.args).toMatchObject({ value: 25 });
  });

  it("records a failed operation in the trace with its error", async () => {
    const driver = makeDriver();
    await driver.start();
    await driver.call("comp.info", { name: "Nope" }).catch(() => undefined);

    const trace = readTrace();
    const last = trace.at(-1);
    expect(last?.status).toBe("error");
    // Named, so the API can tell "not found" from any other lookup failure.
    expect(last?.error?.name).toBe("NotFoundError");
    expect(last?.error?.message).toContain("composition not found");
  });

  it("rejects a call after close", async () => {
    const driver = makeDriver();
    await driver.start();
    await driver.stop();
    await expect(driver.call("app.info")).rejects.toThrow(/closed/);
  });

  it("refuses to start twice", async () => {
    const driver = makeDriver();
    await driver.start();
    await expect(driver.start()).rejects.toThrow(/already started/);
  });
});

describe("driver construction", () => {
  it("fails fast when the host script is missing", () => {
    const trace = new TraceRecorder();
    expect(
      () =>
        new AeDriver({
          transport,
          sessionRoot,
          trace,
          hostScriptPath: join(sessionRoot, "nope.js"),
        }),
    ).toThrow(HostUnavailableError);
  });

  it("records the transport kind in the session manifest", () => {
    makeDriver();
    const manifest = JSON.parse(
      readFileSync(join(sessionRoot, "a8n-session.json"), "utf-8"),
    ) as { transport: string; v: number };
    expect(manifest.transport).toBe("fake-in-process");
    expect(manifest.v).toBe(1);
  });
});

describe("protocol envelopes", () => {
  it("rejects a version mismatch in both directions", () => {
    expect(() => parseRequestEnvelope({ v: 2, id: "a", method: "m", params: {}, timeoutMs: 1 })).toThrow(
      ProtocolError,
    );
    expect(() =>
      parseResultEnvelope({ v: 2, id: "a", ok: true, durationMs: 0, result: null }),
    ).toThrow(ProtocolError);
  });

  it("requires a boolean ok field", () => {
    expect(() =>
      parseResultEnvelope({ v: 1, id: "a", durationMs: 0, result: null }),
    ).toThrow(/boolean "ok"/);
  });

  it("preserves AE error numbers across the wire", () => {
    const parsed = parseResultEnvelope({
      v: 1,
      id: "a",
      ok: false,
      durationMs: 0,
      error: { name: "Error", message: "nope", aeError: 5023, line: 12 },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.aeError).toBe(5023);
      expect(parsed.error.line).toBe(12);
    }
  });
});

describe("fake host defaults", () => {
  it("creates a comp the driver can open immediately", () => {
    const comp = createDefaultComp();
    expect(comp.name).toBe("Main");
    expect(comp.layer("Solid 1")?.index).toBe(1);
  });
});
