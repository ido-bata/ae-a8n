/**
 * Workspace-editing host readbacks (#359, parent #345 / program #337).
 *
 * `comp.time`, `Property.selected` and keyframe enumeration are the DOM
 * facts the W2 timeline oracle reads back after a GUI act. Everything here
 * is read-only on the host side — the fake's `_addKeyframe`/`time` setter
 * stand in for the scripting setup a real suite would do, never for the
 * asserted operation. Runs against the in-repo fake host: `automated test`
 * level, not real-host evidence.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects, type Comp, type Layer, type PropertyInfo } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import type { FakeComp, FakeProperty } from "../src/testing/fake-ae/object-model.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;
let ae: AfterEffects;

beforeEach(async () => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-readback-"));
  transport = new FakeAfterEffectsTransport();
  ae = await AfterEffects.launch({ sessionRoot, transport });
});

afterEach(async () => {
  await ae.close({ unsavedChanges: "discard" });
  rmSync(sessionRoot, { recursive: true, force: true });
});

async function mainComp(): Promise<Comp> {
  return (await ae.project()).comp("Main");
}

async function solidLayer(comp: Comp): Promise<Layer> {
  return comp.layer("Solid 1");
}

/** The fake's own handle on the default comp, for setup-only state. */
function fakeComp(): FakeComp {
  const comp = transport.app.project._comps()[0];
  if (comp === undefined) {
    throw new Error("the fake project has no comp");
  }
  return comp;
}

/** The fake's handle on a layer property, reached the way the host path is. */
function fakeProperty(layer: Layer, path: readonly string[]): FakeProperty {
  void layer;
  let node: unknown = fakeComp().layer("Solid 1");
  for (const segment of path) {
    node = (node as { property(name: string): unknown }).property(segment);
  }
  return node as FakeProperty;
}

describe("comp.time", () => {
  it("reads the current-time indicator in seconds and frames", async () => {
    const comp = await mainComp();
    expect(await comp.time()).toEqual({ comp: "Main", time: 0, frame: 0 });

    // Setup-only mutation on the fake, standing in for a GUI scrub's effect.
    fakeComp().time = 1.5;
    expect(await comp.time()).toEqual({ comp: "Main", time: 1.5, frame: 36 });
  });

  it("is read-only: the host exposes no setter", async () => {
    const comp = await mainComp();
    const before = await comp.time();
    fakeComp().time = 2;
    expect((await comp.time()).time).not.toBe(before.time);
  });
});

describe("project.state", () => {
  it("reports item count, dirty flag and the active item", async () => {
    const project = await ae.project();
    expect(await project.state()).toEqual({
      itemCount: 1,
      dirty: false,
      activeItem: null,
    });

    const comp = await mainComp();
    await comp.openInViewer();
    expect(await project.state()).toEqual({
      itemCount: 1,
      dirty: false,
      activeItem: { name: "Main", comp: true },
    });
  });
});

describe("layer.property", () => {
  it("describes a transform property with its selection and keyframe state", async () => {
    const layer = await solidLayer(await mainComp());
    const position = await layer.property(["ADBE Transform Group", "ADBE Position"]);

    expect(position).toMatchObject({
      name: "Position",
      matchName: "ADBE Position",
      kind: "value",
      valueType: "ThreeD_SPATIAL",
      selected: false,
      isTimeVarying: false,
      keyframes: [],
    });
    expect(position.value).toEqual([32, 32, 0]);
  });

  it("reads Property.selected back after it changes", async () => {
    const layer = await solidLayer(await mainComp());
    const opacity = () => layer.property(["ADBE Transform Group", "ADBE Opacity"]);

    expect((await opacity()).selected).toBe(false);
    fakeProperty(layer, ["ADBE Transform Group", "ADBE Opacity"]).selected = true;
    expect((await opacity()).selected).toBe(true);
  });

  it("enumerates keyframes with 1-based index, time and value", async () => {
    const layer = await solidLayer(await mainComp());
    const path = ["ADBE Transform Group", "ADBE Position"] as const;
    const position = fakeProperty(layer, path);
    position._addKeyframe(0, [10, 10, 0]);
    position._addKeyframe(1, [20, 20, 0]);
    position._addKeyframe(2.5, [30, 30, 0]);

    const info = await layer.property(path);
    expect(info.isTimeVarying).toBe(true);
    expect(info.keyframes).toEqual([
      { index: 1, time: 0, value: [10, 10, 0] },
      { index: 2, time: 1, value: [20, 20, 0] },
      { index: 3, time: 2.5, value: [30, 30, 0] },
    ]);
  });

  it("reaches an effect parameter through the property path", async () => {
    const comp = await mainComp();
    const layer = await solidLayer(comp);
    await layer.effects.apply("ADBE Fake Tint");

    const amount = await layer.property([
      "ADBE Effect Parade",
      "ADBE Fake Tint",
      "ADBE Fake Tint-0001",
    ]);
    expect(amount).toMatchObject({
      name: "Amount to Tint",
      kind: "value",
      valueType: "OneD",
      value: 0,
      isTimeVarying: false,
      keyframes: [],
    });
  });

  it("describes a group when the path ends at one", async () => {
    const layer = await solidLayer(await mainComp());
    const group = await layer.property(["ADBE Transform Group"]);
    expect(group).toMatchObject({ name: "Transform", kind: "group" });
    expect(group.isTimeVarying).toBeUndefined();
    expect(group.keyframes).toBeUndefined();
  });

  it("rejects an unknown path segment as EntityNotFoundError", async () => {
    const layer = await solidLayer(await mainComp());
    await expect(layer.property(["ADBE Transform Group", "No Such Property"])).rejects.toMatchObject({
      name: "EntityNotFoundError",
      kind: "property",
    });
  });

  it("rejects a path that continues past a leaf property", async () => {
    const layer = await solidLayer(await mainComp());
    await expect(
      layer.property(["ADBE Transform Group", "ADBE Opacity", "deeper"]),
    ).rejects.toThrow(/not a group|property path/i);
  });

  it("rejects an empty path before any host call", async () => {
    const layer = await solidLayer(await mainComp());
    await expect(layer.property([])).rejects.toThrow(TypeError);
  });
});

describe("effect parameter readbacks carry the same state", () => {
  it("reports selected and keyframes on effect.getParameter", async () => {
    const comp = await mainComp();
    const layer = await solidLayer(comp);
    const effect = await layer.effects.apply("ADBE Fake Gaussian Blur");

    const listed: PropertyInfo[] = await effect.parameters();
    const amount = listed.find((p) => p.matchName === "ADBE Fake Gaussian Blur-0001");
    expect(amount).toMatchObject({ kind: "value", selected: false, isTimeVarying: false, keyframes: [] });

    const viaPath = fakeProperty(layer, [
      "ADBE Effect Parade",
      "ADBE Fake Gaussian Blur",
      "ADBE Fake Gaussian Blur-0001",
    ]);
    viaPath._addKeyframe(0.5, 25);
    const info = await effect.parameter("ADBE Fake Gaussian Blur-0001").info();
    expect(info.isTimeVarying).toBe(true);
    expect(info.keyframes).toEqual([{ index: 1, time: 0.5, value: 25 }]);
  });
});
