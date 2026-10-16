/**
 * Values are typed by After Effects' PropertyValueType (#21).
 *
 * On AE 26.5x89 a colour reads as [r, g, b, a], a point as [x, y], a 3D
 * point as [x, y, z], and a slider, checkbox or layer/mask index as a number.
 * `setValue` takes 2 for ThreeD (z → 0) and 3 for COLOR (alpha → 1), and
 * silently stores 0 when given `[]` for a OneD property. The fake models the
 * same; the host checks the shape before writing, so that coercion never
 * happens through this API.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AfterEffects,
  AfterEffectsError,
  ParameterValueError,
  type Effect,
  type ParameterValue,
  type PropertyInfo,
} from "../src/index.js";
import type { HostError } from "../src/protocol/envelope.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;
let ae: AfterEffects;

beforeEach(async () => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-values-"));
  transport = new FakeAfterEffectsTransport();
  ae = await AfterEffects.launch({ sessionRoot, transport });
});

afterEach(async () => {
  await ae.close({ unsavedChanges: "discard" });
  rmSync(sessionRoot, { recursive: true, force: true });
});

async function controls(): Promise<Effect> {
  const path = join(sessionRoot, "fixture.aep");
  writeFileSync(path, "fake");
  const project = await ae.openProject(path);
  const layer = await (await project.comp("Main")).layer("Solid 1");
  return layer.effects.apply("ADBE Fake Controls");
}

const id = (n: number) => `ADBE Fake Controls-000${n}`;

describe("reading", () => {
  it("reports valueType and a value shaped by it", async () => {
    const fx = await controls();
    const listed = await fx.parameters();
    expect(listed.map((p) => [p.matchName, p.kind, p.valueType, p.value])).toEqual([
      [id(1), "value", "OneD", 0],
      [id(2), "value", "TwoD_SPATIAL", [32, 32]],
      [id(3), "value", "ThreeD_SPATIAL", [32, 32, 0]],
      [id(4), "value", "COLOR", [1, 0, 0, 1]],
      [id(5), "value", "LAYER_INDEX", 0],
      ["ADBE Effect Built In Params", "group", undefined, undefined],
    ]);
  });

  it("narrows to a tuple of the right length by valueType", async () => {
    const fx = await controls();
    const colours = (await fx.parameters()).flatMap((p: PropertyInfo) =>
      p.kind === "value" && p.valueType === "COLOR" ? [p.value] : [],
    );
    const [r, g, b, a] = colours[0]!;
    expect([r, g, b, a]).toEqual([1, 0, 0, 1]);
  });

  it("get() returns the same shapes", async () => {
    const fx = await controls();
    expect(await fx.parameter(id(1)).get()).toBe(0);
    expect(await fx.parameter(id(2)).get()).toEqual([32, 32]);
    expect(await fx.parameter(id(4)).get()).toEqual([1, 0, 0, 1]);
  });

  it("names the value type of properties without one", async () => {
    const path = join(sessionRoot, "fixture.aep");
    writeFileSync(path, "fake");
    const layer = await (await (await ae.openProject(path)).comp("Main")).layer("Solid 1");
    const tint = await layer.effects.apply("ADBE Fake Tint");
    const levels = await layer.effects.apply("ADBE Fake Levels");
    expect(await tint.parameter("ADBE Fake Tint-0002").info()).toMatchObject({ kind: "no-value", valueType: "NO_VALUE" });
    expect(await levels.parameter("ADBE Fake Levels-0001").info()).toMatchObject({
      kind: "custom-value",
      valueType: "CUSTOM_VALUE",
    });
  });
});

describe("writing", () => {
  it.each<[string, number, ParameterValue, ParameterValue]>([
    ["OneD", 1, 42.5, 42.5],
    ["TwoD_SPATIAL", 2, [10, 20], [10, 20]],
    ["ThreeD_SPATIAL", 3, [1, 2, 3], [1, 2, 3]],
    ["ThreeD_SPATIAL from 2 (z = 0)", 3, [1, 2], [1, 2, 0]],
    ["COLOR", 4, [0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4]],
    ["COLOR from 3 (alpha = 1)", 4, [0.1, 0.2, 0.3], [0.1, 0.2, 0.3, 1]],
    ["LAYER_INDEX", 5, 1, 1],
  ])("writes %s and returns what the host holds", async (_label, n, written, held) => {
    const fx = await controls();
    expect(await fx.parameter(id(n)).set(written)).toEqual(held);
    expect(await fx.parameter(id(n)).get()).toEqual(held);
  });

  it.each<[string, number, ParameterValue]>([
    ["[] to OneD (AE would store 0)", 1, []],
    ["an array to OneD", 1, [1, 2]],
    ["a number to TwoD_SPATIAL", 2, 5],
    ["3 numbers to TwoD_SPATIAL", 2, [1, 2, 3]],
    ["1 number to ThreeD_SPATIAL", 3, [1]],
    ["2 numbers to COLOR", 4, [1, 2]],
    ["5 numbers to COLOR", 4, [1, 2, 3, 4, 5]],
    ["an array to LAYER_INDEX", 5, [1]],
  ])("refuses %s before writing", async (_label, n, bad) => {
    const fx = await controls();
    const before = await fx.parameter(id(n)).get();
    transport.app.project.dirty = false;

    const error = await fx.parameter(id(n)).set(bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParameterValueError);
    expect(error).toBeInstanceOf(AfterEffectsError);
    expect(error).toMatchObject({ property: id(n), op: "effect.setParameter" });
    expect(((error as ParameterValueError).cause as HostError).name).toBe("ValueShapeError");

    expect(transport.app.project.dirty).toBe(false);
    expect(await fx.parameter(id(n)).get()).toEqual(before);
  });

  it("names the value type in the error", async () => {
    const fx = await controls();
    const error = (await fx.parameter(id(4)).set(5).catch((e: unknown) => e)) as ParameterValueError;
    expect(error.valueType).toBe("COLOR");
    expect(error.message).toContain("3 or 4 numbers");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, [1, Number.NaN], ["1"] as unknown as number[], "1" as unknown as number])(
    "rejects %s with TypeError before sending anything",
    async (bad) => {
      const fx = await controls();
      const before = ae.traceEvents.length;
      await expect(fx.parameter(id(2)).set(bad)).rejects.toBeInstanceOf(TypeError);
      expect(ae.traceEvents.slice(before).some((e) => e.op === "effect.setParameter")).toBe(false);
    },
  );
});

describe("numeric parameters, as before", () => {
  it("read and write plain numbers", async () => {
    const path = join(sessionRoot, "fixture.aep");
    writeFileSync(path, "fake");
    const layer = await (await (await ae.openProject(path)).comp("Main")).layer("Solid 1");
    const blur = (await layer.effects.apply("ADBE Fake Gaussian Blur")).parameter("Amount");
    const written = await blur.set(60);
    expect(typeof written).toBe("number");
    expect(written).toBe(60);
    expect(await blur.get()).toBe(60);
  });
});
