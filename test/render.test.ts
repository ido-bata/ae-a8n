/**
 * Rendering one frame, the way a real AE can do it.
 *
 * At dd751e0 the host drove a render queue API that exists only in the fake
 * (`renderQueue.purge`, `new OutputModule`, `new RenderQueueItem`). On AE
 * 26.5x89 (ja) the render queue cannot be told to write PNG at all — no
 * "PNG Sequence" template, and "Format" is read-only to setSettings — so the
 * host uses `CompItem.saveFrameToPng`, which returns before the file exists
 * and renders at the viewer's resolution.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { decodePngSize } from "./png-size.js";
import { TraceRecorder } from "../src/trace/trace.js";

let dir: string;
let transport: FakeAfterEffectsTransport;
let driver: AeDriver;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "a8n-render-"));
  transport = new FakeAfterEffectsTransport();
  driver = new AeDriver({
    transport,
    sessionRoot: join(dir, "session"),
    trace: new TraceRecorder({ file: join(dir, "trace.jsonl") }),
    defaultTimeoutMs: 2_000,
    readinessTimeoutMs: 2_000,
  });
  await driver.start();
});

afterEach(async () => {
  await driver.stop({ unsavedChanges: "discard" });
  rmSync(dir, { recursive: true, force: true });
});

type Rendered = { path: string; frame: number; width: number; height: number };

function render(outputDir: string, frame = 0): Promise<Rendered> {
  return driver.call<Rendered>("comp.renderFrame", { comp: "Main", frame, outputDir });
}

describe("comp.renderFrame", () => {
  it("renders at full resolution whatever the viewer is set to, and restores it", async () => {
    const comp = transport.app.project.item(1);
    if (comp === undefined) throw new Error("fake has no comp");
    comp.resolutionFactor = [2, 2];

    const frame = await render(join(dir, "out"));

    expect({ width: frame.width, height: frame.height }).toEqual({ width: 64, height: 64 });
    expect(decodePngSize(frame.path)).toEqual({ width: 64, height: 64 });
    expect(comp.resolutionFactor).toEqual([2, 2]);
  });

  it("reports the size of the file it wrote, not the comp's", async () => {
    const frame = await render(join(dir, "out"), 3);
    expect(decodePngSize(frame.path)).toEqual({ width: frame.width, height: frame.height });
    expect(transport.app.project.item(1)?.renders.at(-1)?.frame).toBe(3);
  });

  it("names the cause when AE fails to write the frame", async () => {
    // wait() throws a message-less error; the cause is only on the result.
    transport.app.project.item(1)?.failNextSaveFrame();
    await expect(render(join(dir, "out"))).rejects.toThrow(
      /was not rendered: Operation failed with error code: 790/,
    );
  });

  it("says so when the output directory cannot be created", async () => {
    writeFileSync(join(dir, "blocked"), "");
    await expect(render(join(dir, "blocked", "out"))).rejects.toThrow(
      /cannot create output directory/,
    );
  });
});
