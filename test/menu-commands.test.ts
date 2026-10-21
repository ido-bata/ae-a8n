/**
 * Menu commands, the process environment, and the scene-building calls a
 * plugin's end-to-end test needs (#45), against the fake host.
 *
 * The fake's menu handlers stand in for a plugin's command hook. This proves
 * the API and host-script contract only; what real After Effects does is in
 * docs/verification.md.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AfterEffects,
  EntityNotFoundError,
  HostNotOwnedError,
  REDO_COMMAND_ID,
  UNDO_COMMAND_ID,
} from "../src/index.js";
import {
  FakeAfterEffectsTransport,
  FakeShapeLayer,
  FakeTextLayer,
  type FakeApplication,
} from "../src/testing/index.js";

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-menu-"));
  transport = new FakeAfterEffectsTransport();
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

/**
 * Stands in for an AEGP plugin's command: one square shape layer per
 * selected text layer of the active comp, recording what it saw in
 * `seen`. Reads its output setting from the process environment, as a
 * native plugin does with getenv.
 */
function registerTraceCommand(app: FakeApplication, seen: string[]): number {
  return app.registerMenuCommand("Fake Plugin: Trace", (host) => {
    seen.push(host.environment.get("FAKE_PLUGIN_OUT") ?? "<unset>");
    const comp = host.project.activeItem;
    if (comp === null) return;
    // Collected first: each new layer goes on top and renumbers the stack.
    const selected: FakeTextLayer[] = [];
    for (let i = 1; i <= comp.numLayers; i++) {
      const layer = comp.layer(i);
      if (layer instanceof FakeTextLayer && layer.selected) selected.push(layer);
    }
    for (const layer of selected) {
      const shape = comp.layers.addShape();
      shape.name = `${layer.name} #1`;
      shape.addPath(
        {
          vertices: [[0, 0], [10, 0], [10, 10], [0, 10]],
          inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
          outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
          closed: true,
        },
        "Restro root",
      );
    }
  });
}

async function sceneWithText(ae: AfterEffects) {
  const project = await ae.project();
  const comp = await project.createComp({ name: "E2E", width: 400, height: 300, duration: 2, frameRate: 30 });
  const { layer, info } = await comp.addTextLayer({
    text: "H",
    font: "ArialMT",
    fontSize: 200,
    fillColor: [1, 1, 1],
    position: [120, 250],
  });
  return { project, comp, layer, info };
}

describe("hostEnvironment", () => {
  it("sets variables in the owned AE process before the session is handed out", async () => {
    const ae = await AfterEffects.launch({
      sessionRoot,
      transport,
      hostEnvironment: { FAKE_PLUGIN_OUT: "/tmp/out" },
    });
    expect(transport.app.environment.get("FAKE_PLUGIN_OUT")).toBe("/tmp/out");
    expect(ae.traceEvents.map((event) => event.op)).toContain("session.hostEnvironment");
  });

  it("refuses a host this session does not own, and leaves its environment alone", async () => {
    transport.ownershipKind = "attached";
    await expect(
      AfterEffects.launch({ sessionRoot, transport, hostEnvironment: { FAKE_PLUGIN_OUT: "/tmp/out" } }),
    ).rejects.toBeInstanceOf(HostNotOwnedError);
    expect(transport.app.environment.size).toBe(0);
  });

  it("rejects names and values that are not portable environment strings", async () => {
    for (const hostEnvironment of [{ "BAD-NAME": "x" }, { "1X": "x" }, { OK: 1 as unknown as string }]) {
      await expect(AfterEffects.launch({ sessionRoot, transport, hostEnvironment })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });
});

describe("building a scene", () => {
  it("creates a comp, a text layer, and makes the comp active", async () => {
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const { project, comp, layer, info } = await sceneWithText(ae);

    expect(info).toMatchObject({ name: "H", index: 1, type: "text", enabled: true, font: "ArialMT", fontSize: 200 });
    expect(await layer.transform()).toMatchObject({ position: [120, 250, 0], scale: [100, 100, 100] });
    expect((await project.comps()).map((c) => c.name)).toEqual(["Main", "E2E"]);

    await comp.openInViewer();
    expect(transport.app.project.activeItem?.name).toBe("E2E");
  });

  it("refuses a comp name another item already has", async () => {
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const project = await ae.project();
    await expect(
      project.createComp({ name: "Main", width: 10, height: 10, duration: 1, frameRate: 24 }),
    ).rejects.toThrow(/already exists/);
    await expect(
      project.createComp({ name: "X", width: 0, height: 10, duration: 1, frameRate: 24 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("selects exactly the named layers and toggles a layer's video", async () => {
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const { comp, layer } = await sceneWithText(ae);
    await comp.addTextLayer({ text: "I" });

    expect(await comp.selectLayers(["H"])).toEqual(["H"]);
    expect((await comp.layers()).map((l) => [l.name, l.selected])).toEqual([
      ["I", false],
      ["H", true],
    ]);
    expect(await comp.selectLayers([])).toEqual([]);

    expect((await layer.setEnabled(false)).enabled).toBe(false);
    expect((await layer.info()).enabled).toBe(false);
  });
});

describe("menu commands", () => {
  it("rejects an unknown name as EntityNotFoundError and a bad id as TypeError", async () => {
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    await expect(ae.menuCommand("No Such Command")).rejects.toMatchObject({
      name: "EntityNotFoundError",
      kind: "menu-command",
    });
    await expect(ae.menuCommand("No Such Command")).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(ae.menuCommand(0)).rejects.toBeInstanceOf(TypeError);
    await expect(ae.menuCommand(1.5)).rejects.toBeInstanceOf(TypeError);
  });

  it("runs a plugin command on the selection and reports the layers it added", async () => {
    const seen: string[] = [];
    const id = registerTraceCommand(transport.app, seen);
    const ae = await AfterEffects.launch({
      sessionRoot,
      transport,
      hostEnvironment: { FAKE_PLUGIN_OUT: "/tmp/out" },
    });
    const { comp } = await sceneWithText(ae);
    await comp.openInViewer();
    await comp.selectLayers(["H"]);

    const command = await ae.menuCommand("Fake Plugin: Trace");
    expect(command.id).toBe(id);
    const run = await command.execute();

    expect(seen).toEqual(["/tmp/out"]);
    expect(run).toMatchObject({ id, name: "Fake Plugin: Trace", before: { comp: "E2E" }, after: { comp: "E2E" } });
    expect(run.before.layers.map((l) => l.name)).toEqual(["H"]);
    expect(run.added.map((l) => [l.name, l.type])).toEqual([["H #1", "shape"]]);
    expect(run.removed).toEqual([]);

    const shape = await comp.layer("H #1");
    expect(await shape.shapePaths()).toEqual([
      {
        groups: ["Restro root"],
        name: "Path 1",
        closed: true,
        vertices: [[0, 0], [10, 0], [10, 10], [0, 10]],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
      },
    ]);
    await expect((await comp.layer("H")).shapePaths()).rejects.toThrow(/not a shape layer/);
  });

  it("undoes and redoes a command, reporting each change", async () => {
    registerTraceCommand(transport.app, []);
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const { comp } = await sceneWithText(ae);
    await comp.openInViewer();
    await comp.selectLayers(["H"]);
    const run = await (await ae.menuCommand("Fake Plugin: Trace")).execute();
    const created = run.added.map((l) => l.id);

    const undone = await ae.undo();
    expect(undone).toMatchObject({ id: UNDO_COMMAND_ID, name: "Undo" });
    expect(undone.removed.map((l) => l.id)).toEqual(created);
    expect((await comp.layers()).map((l) => l.name)).toEqual(["H"]);

    const redone = await ae.redo();
    expect(redone.id).toBe(REDO_COMMAND_ID);
    expect(redone.added.map((l) => l.id)).toEqual(created);
    expect(transport.app.executedCommands).toEqual([run.id, UNDO_COMMAND_ID, REDO_COMMAND_ID]);
  });

  it("records the scene change in the trace file", async () => {
    registerTraceCommand(transport.app, []);
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const { comp } = await sceneWithText(ae);
    await comp.openInViewer();
    await comp.selectLayers(["H"]);
    const run = await (await ae.menuCommand("Fake Plugin: Trace")).execute();

    const events = readFileSync(ae.tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; args?: unknown; result?: Record<string, unknown> });
    const scene = events.find((event) => event.op === "menu.execute.scene");
    expect(scene?.args).toEqual({ id: run.id, name: "Fake Plugin: Trace" });
    expect(scene?.result).toMatchObject({
      comp: "E2E",
      added: run.added.map((l) => l.id),
      removed: [],
      layersAfter: run.after.layers.map((l) => `${l.id} ${l.name}`),
    });
  });

  it("refuses to run any command on a host this session does not own", async () => {
    registerTraceCommand(transport.app, []);
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const command = await ae.menuCommand("Fake Plugin: Trace");
    transport.ownershipKind = "attached";

    await expect(command.execute()).rejects.toBeInstanceOf(HostNotOwnedError);
    await expect(ae.undo()).rejects.toBeInstanceOf(HostNotOwnedError);
    expect(transport.app.executedCommands).toEqual([]);
  });

  it("reports no active comp when none is open", async () => {
    const id = transport.app.registerMenuCommand("Fake Plugin: Nothing", () => {});
    const ae = await AfterEffects.launch({ sessionRoot, transport });
    const run = await (await ae.menuCommand(id)).execute();
    expect(run.before).toEqual({ itemCount: 1, comp: null, layers: [] });
    expect(run.added).toEqual([]);
    expect(run.name).toBeUndefined();
  });

  it("models shape layers outside commands too", () => {
    const shape = new FakeShapeLayer("S", [0, 0]);
    shape.addPath({ vertices: [[1, 2]], inTangents: [[0, 0]], outTangents: [[0, 0]], closed: false });
    expect(shape.property("ADBE Root Vectors Group")).toBeDefined();
  });
});
