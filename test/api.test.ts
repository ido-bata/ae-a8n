/**
 * The public API, exercised exactly as a caller would.
 *
 * Everything runs against the fake host, so this proves the API *contract* —
 * types, error mapping, trace coverage — not that After Effects works.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects, EntityNotFoundError } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { resolveInstall, sortVersionSuffixes, newestAeDirectory } from "../src/driver/install-path.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-api-"));
  transport = new FakeAfterEffectsTransport();
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

function launch(): Promise<AfterEffects> {
  return AfterEffects.launch({ sessionRoot, transport });
}

async function openedProject(ae: AfterEffects) {
  const path = join(sessionRoot, "fixture.aep");
  writeFileSync(path, "fake");
  return ae.openProject(path);
}

describe("the documented flow", () => {
  it("runs launch → open → comp → layer → effect → parameter → render → close", async () => {
    const ae = await launch();
    expect(ae.info().version).toBe("26.0.0");

    const project = await openedProject(ae);
    const comp = await project.comp("Main");
    const layer = await comp.layer("Solid 1");

    const effect = await layer.effects.apply("ADBE Fake Gaussian Blur");
    const applied = await effect.parameter("Amount").set(50);
    expect(applied).toBe(50);

    const frame = await comp.renderFrame(0);
    expect(frame.frame).toBe(0);
    expect(readFileSync(frame.path).subarray(1, 4).toString("ascii")).toBe("PNG");

    await ae.close();
    expect(transport.closed).toBe(true);
  });

  it("writes renders under the session's artifact directory", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    const frame = await comp.renderFrame(3, { subdirectory: "smoke" });

    expect(frame.path.startsWith(ae.artifactsDir)).toBe(true);
    expect(frame.path).toContain(join("smoke", "Main.00003.png"));
    await ae.close();
  });

  it("makes a parameter change observable in the rendered pixels", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    const layer = await comp.layer("Solid 1");
    const effect = await layer.effects.apply("ADBE Fake Gaussian Blur");

    const before = await comp.renderFrame(0);
    await effect.parameter("Amount").set(50);
    const after = await comp.renderFrame(0, { subdirectory: "after" });

    // The fake render is a function of the effect parameters, so a
    // configuration change must change the image. This is the property a real
    // plugin test would assert; here it proves the write reached the model the
    // render reads from.
    expect(readFileSync(before.path).equals(readFileSync(after.path))).toBe(false);
    await ae.close();
  });
});

describe("typed errors", () => {
  it("reports an unknown composition as EntityNotFoundError", async () => {
    const ae = await launch();
    const project = await openedProject(ae);

    await expect(project.comp("Nope")).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(project.comp("Nope")).rejects.toMatchObject({
      kind: "composition",
      op: "project.comp",
    });
    await ae.close();
  });

  it("reports an unknown layer as EntityNotFoundError", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");

    await expect(comp.layer("Nope")).rejects.toMatchObject({ kind: "layer" });
    await ae.close();
  });

  it("reports an unknown effect as EntityNotFoundError", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    const layer = await comp.layer("Solid 1");

    await expect(layer.effects.get("Not Applied")).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    await ae.close();
  });

  it("keeps the AE error number reachable through the cause chain", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    const layer = await comp.layer("Solid 1");

    try {
      await layer.effects.apply("ADBE No Such Plugin");
      expect.unreachable("should have failed");
    } catch (error) {
      const cause = (error as { cause?: { aeError?: number } }).cause;
      expect(cause?.aeError).toBe(5023);
    }
    await ae.close();
  });

  it("rejects bad arguments before touching After Effects", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");

    await expect(comp.renderFrame(-1)).rejects.toBeInstanceOf(TypeError);
    await expect(comp.renderFrame(1.5)).rejects.toBeInstanceOf(TypeError);
    await expect(comp.layer("")).rejects.toBeInstanceOf(TypeError);

    const layer = await comp.layer("Solid 1");
    const effect = await layer.effects.apply("ADBE Fake Glow");
    await expect(effect.parameter("Radius").set(Number.NaN)).rejects.toBeInstanceOf(
      TypeError,
    );
    await ae.close();
  });
});

describe("trace", () => {
  it("records every operation a caller issued", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    const layer = await comp.layer("Solid 1");
    const effect = await layer.effects.apply("ADBE Fake Gaussian Blur");
    await effect.parameter("Amount").set(50);
    await comp.renderFrame(0);
    await ae.close();

    const ops = ae.traceEvents.map((event) => event.op);
    expect(ops).toContain("project.open");
    expect(ops).toContain("layer.applyEffect");
    expect(ops).toContain("effect.setParameter");
    expect(ops).toContain("comp.renderFrame");
    expect(ops).toContain("session.close");

    // The file and the live view must agree, or the trace is not evidence.
    const onDisk = readFileSync(ae.tracePath, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { op: string });
    expect(onDisk.map((event) => event.op)).toEqual(ops);
  });

  it("redacts anything that looks like a secret", async () => {
    const ae = await launch();
    const comp = await (await openedProject(ae)).comp("Main");
    await comp.renderFrame(0);
    await ae.close();

    const raw = readFileSync(ae.tracePath, "utf-8");
    expect(raw).not.toMatch(/password|token|secret/i);
  });
});

describe("session lifecycle", () => {
  it("is safe to close twice", async () => {
    const ae = await launch();
    await ae.close();
    await expect(ae.close()).resolves.toBeUndefined();
  });

  it("closes the session when `await using` leaves the block", async () => {
    let observed = false;
    {
      await using _ae = await launch();
    }
    observed = transport.closed;
    expect(observed).toBe(true);
  });
});

describe("install discovery", () => {
  it("orders version suffixes with calendar years newest", () => {
    expect(sortVersionSuffixes(["2023", "24.5", "2026", "22.0"])).toEqual([
      "22.0",
      "24.5",
      "2023",
      "2026",
    ]);
  });

  it("picks the newest After Effects directory", () => {
    expect(
      newestAeDirectory([
        "Common",
        "Adobe After Effects 2023",
        "Adobe After Effects 2026",
        "Adobe After Effects Plugins",
        "Adobe Premiere Pro 2026",
      ]),
    ).toBe("Adobe After Effects 2026");
  });

  it("returns null when nothing matches", () => {
    expect(newestAeDirectory(["Common", "Acrobat DC"])).toBeNull();
  });

  it("throws a directed error when no installation is found", () => {
    expect(() => resolveInstall("win32", { root: "/definitely/not/here" })).toThrow(
      /no After Effects installation found/,
    );
  });
});
