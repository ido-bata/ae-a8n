/**
 * Properties without a scriptable value (#18).
 *
 * On AE 26.5x89 reading `value` throws for PropertyValueType.NO_VALUE
 * (ADBE Tint-0004, ADBE Ramp-0008) and CUSTOM_VALUE (Levels' histogram,
 * Curves), and every effect carries a group (Compositing Options). Before the
 * fix one such property failed `effect.parameters()` for the whole effect.
 * The fake models all three the way the real host reported them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import {
  AfterEffects,
  AfterEffectsError,
  PropertyHasNoValueError,
  type Effect,
  type PropertyInfo,
} from "../src/index.js";
import { HostError } from "../src/protocol/envelope.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { TraceRecorder } from "../src/trace/trace.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;
let ae: AfterEffects;

beforeEach(async () => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-kinds-"));
  transport = new FakeAfterEffectsTransport();
  ae = await AfterEffects.launch({ sessionRoot, transport });
});

afterEach(async () => {
  await ae.close({ unsavedChanges: "discard" });
  rmSync(sessionRoot, { recursive: true, force: true });
});

async function effectOnSolid(id: string): Promise<Effect> {
  const path = join(sessionRoot, "fixture.aep");
  writeFileSync(path, "fake");
  const project = await ae.openProject(path);
  const layer = await (await project.comp("Main")).layer("Solid 1");
  return layer.effects.apply(id);
}

describe("effect.parameters()", () => {
  it("lists every property of an effect that has a NO_VALUE property and a group", async () => {
    const tint = await effectOnSolid("ADBE Fake Tint");
    const parameters = await tint.parameters();
    expect(parameters).toEqual([
      { name: "Amount to Tint", matchName: "ADBE Fake Tint-0001", kind: "value", valueType: "OneD", value: 0 },
      { name: "", matchName: "ADBE Fake Tint-0002", kind: "no-value", valueType: "NO_VALUE" },
      { name: "Compositing Options", matchName: "ADBE Effect Built In Params", kind: "group" },
    ]);
  });

  it("lists a CUSTOM_VALUE property without reading it", async () => {
    const levels = await effectOnSolid("ADBE Fake Levels");
    const kinds = (await levels.parameters()).map((p) => [p.matchName, p.kind]);
    expect(kinds).toEqual([
      ["ADBE Fake Levels-0001", "custom-value"],
      ["ADBE Fake Levels-0002", "value"],
      ["ADBE Effect Built In Params", "group"],
    ]);
  });

  it("carries a value exactly when kind is \"value\"", async () => {
    const tint = await effectOnSolid("ADBE Fake Tint");
    for (const parameter of await tint.parameters()) {
      expect("value" in parameter).toBe(parameter.kind === "value");
    }
  });

  it("narrows: value is a number once kind and valueType are checked", async () => {
    const tint = await effectOnSolid("ADBE Fake Tint");
    const values: number[] = (await tint.parameters()).flatMap((p: PropertyInfo) =>
      p.kind === "value" && p.valueType === "OneD" ? [p.value] : [],
    );
    expect(values).toEqual([0]);
  });
});

describe("info(), get(), set() on a property without a value", () => {
  const cases = [
    { effect: "ADBE Fake Tint", parameter: "ADBE Fake Tint-0002", kind: "no-value" },
    { effect: "ADBE Fake Levels", parameter: "ADBE Fake Levels-0001", kind: "custom-value" },
    { effect: "ADBE Fake Tint", parameter: "ADBE Effect Built In Params", kind: "group" },
  ] as const;

  it.each(cases)("info() describes $kind without failing", async ({ effect, parameter, kind }) => {
    const fx = await effectOnSolid(effect);
    const info = await fx.parameter(parameter).info();
    expect(info.kind).toBe(kind);
    expect(info.value).toBeUndefined();
  });

  it.each(cases)("get() rejects $kind with PropertyHasNoValueError", async ({ effect, parameter, kind }) => {
    const fx = await effectOnSolid(effect);
    const error = await fx.parameter(parameter).get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PropertyHasNoValueError);
    expect(error).toBeInstanceOf(AfterEffectsError);
    expect(error).toMatchObject({ kind, property: parameter, op: "effect.getParameter" });
  });

  it.each(cases)("set() rejects $kind before writing anything", async ({ effect, parameter, kind }) => {
    const fx = await effectOnSolid(effect);
    const project = transport.app.project;
    project.dirty = false; // the apply above was an edit; watch only the set

    const error = await fx.parameter(parameter).set(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PropertyHasNoValueError);
    expect(error).toMatchObject({ kind, property: parameter, op: "effect.setParameter" });
    // The host refused on its own check, not because AE threw on setValue.
    expect((error as PropertyHasNoValueError).cause).toBeInstanceOf(HostError);
    expect(((error as PropertyHasNoValueError).cause as HostError).name).toBe("NoValueError");
    expect(project.dirty).toBe(false);
  });
});

describe("parameters with a value", () => {
  it("read and write as before on an effect that also has properties without one", async () => {
    const tint = await effectOnSolid("ADBE Fake Tint");
    const amount = tint.parameter("ADBE Fake Tint-0001");
    expect(await amount.get()).toBe(0);
    expect(await amount.set(50)).toBe(50);
    expect(await amount.get()).toBe(50);
    expect(await amount.info()).toEqual({
      name: "Amount to Tint",
      matchName: "ADBE Fake Tint-0001",
      kind: "value",
      valueType: "OneD",
      value: 50,
    });
  });

  it("still reach the render; Compositing Options and value-less properties do not", async () => {
    const path = join(sessionRoot, "fixture.aep");
    writeFileSync(path, "fake");
    const project = await ae.openProject(path);
    const comp = await project.comp("Main");
    const bare = readFileSync((await comp.renderFrame(0, { prefix: "bare" })).path);

    const tint = await (await comp.layer("Solid 1")).effects.apply("ADBE Fake Tint");
    // At 0 the effect changes nothing. If the group's Effect Opacity (100) or
    // a value-less property took part, the fake render would differ.
    const atZero = readFileSync((await comp.renderFrame(0, { prefix: "zero" })).path);
    expect(atZero.equals(bare)).toBe(true);

    await tint.parameter("ADBE Fake Tint-0001").set(50);
    const atFifty = readFileSync((await comp.renderFrame(0, { prefix: "fifty" })).path);
    expect(atFifty.equals(bare)).toBe(false);
  });
});

describe("the bridge", () => {
  it("decodes the host's kind into HostError", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-kinds-driver-"));
    const fake = new FakeAfterEffectsTransport();
    const driver = new AeDriver({ transport: fake, sessionRoot: root, trace: new TraceRecorder() });
    try {
      await driver.start();
      const path = join(root, "fixture.aep");
      writeFileSync(path, "fake");
      await driver.call("project.open", { path });
      await driver.call("layer.applyEffect", { comp: "Main", layer: "Solid 1", effect: "ADBE Fake Tint" });
      const error = await driver
        .call("effect.setParameter", {
          comp: "Main",
          layer: "Solid 1",
          effect: "ADBE Fake Tint",
          parameter: "ADBE Fake Tint-0002",
          value: 1,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostError);
      expect(error).toMatchObject({ name: "NoValueError", kind: "no-value" });
    } finally {
      await driver.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
