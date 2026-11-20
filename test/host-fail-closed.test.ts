/**
 * Exercises the shipped ES3 host without an AE installation. The only fake
 * components are the application object model and ExtendScript I/O.
 * A failed response publication must never be mistaken for a completed call.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  failFileClosesAt,
  failNextFileCloses,
  failNextFileWrites,
  failNextRenames,
  resetFileFaults,
  resetRenameFaults,
  runHostScript,
  type HostGlobals,
} from "../src/testing/fake-ae/es3-runtime.js";
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
} from "../src/testing/fake-ae/object-model.js";

const HOST_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../host/a8n-host.js");

let root: string;
let app: FakeApplication;
let sequence: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-host-contract-"));
  app = new FakeApplication();
  app.project.load(createDefaultComp(), null);
  sequence = 0;
  resetFileFaults();
  resetRenameFaults();
});

afterEach(() => {
  resetFileFaults();
  resetRenameFaults();
  rmSync(root, { recursive: true, force: true });
});

function dispatch(method: string, params: Record<string, unknown> = {}) {
  const id = String(++sequence);
  const requestPath = join(root, `request-${id}.json`);
  const resultPath = join(root, `result-${id}.json`);
  writeFileSync(requestPath, JSON.stringify({
    v: 1,
    id,
    method,
    params,
    timeoutMs: 5000,
  }));
  const globals: HostGlobals = {
    ...createFakeGlobals(app),
    __a8n: { request: requestPath, result: resultPath },
  };
  const execution = runHostScript(HOST_SCRIPT, globals);
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      result?: unknown;
      error?: { name: string; message: string };
    }
    : null;
  return { execution, result, resultPath };
}

describe("ES3 host failure safety (#265)", () => {
  it("publishes a normally completed response", () => {
    const reply = dispatch("app.info");
    expect(reply.execution.success).toBe(true);
    expect(reply.result?.ok).toBe(true);
  });

  it("never publishes a staging file when File.write returns false", () => {
    failNextFileWrites(1);
    const reply = dispatch("app.info");
    expect(reply.execution.success).toBe(false);
    expect(reply.result).toBeNull();
    expect(existsSync(reply.resultPath)).toBe(false);
  });

  it("never publishes a staging file when File.close returns false", () => {
    failNextFileCloses(1);
    const reply = dispatch("app.info");
    expect(reply.execution.success).toBe(false);
    expect(reply.result).toBeNull();
    expect(existsSync(reply.resultPath)).toBe(false);
  });

  it("removes a directly written result when its close fails", () => {
    // Every rename fails, so publishResult falls back to a direct write;
    // that write's close then reports failure. Before the fix the complete
    // ok:true envelope stayed at resultPath and read as a success while the
    // host reported failure — and the staging file was left behind.
    const id = String(++sequence);
    const requestPath = join(root, `request-${id}.json`);
    const resultPath = join(root, `result-${id}.json`);
    writeFileSync(
      requestPath,
      JSON.stringify({ v: 1, id, method: "app.info", params: {}, timeoutMs: 5000 }),
    );
    failNextRenames(3); // PUBLISH_ATTEMPTS in the host script
    failFileClosesAt(resultPath, 1);
    const globals: HostGlobals = {
      ...createFakeGlobals(app),
      __a8n: { request: requestPath, result: resultPath },
    };
    const execution = runHostScript(HOST_SCRIPT, globals);
    expect(execution.success).toBe(false);
    expect(existsSync(resultPath)).toBe(false);
    expect(existsSync(resultPath + ".part")).toBe(false);
  });

  it("does not report project.close success after a cancelled dialog", () => {
    Object.defineProperty(app.project, "close", { value: () => false, configurable: true });
    const reply = dispatch("project.close", { save: true });
    expect(reply.execution.success).toBe(true);
    expect(reply.result).toMatchObject({
      ok: false,
      error: { name: "ProjectCloseCancelled" },
    });
  });

  it.each([
    { fontSize: 0 },
    { fontSize: "big" },
    { fillColor: [1, "bad", 0] },
    { position: [10] },
    { position: [10, Number.NaN] },
  ])("rejects invalid comp.addText arguments before a layer exists (%j)", (invalid) => {
    const comp = app.project.item(1);
    if (comp === undefined) throw new Error("missing test composition");
    const before = comp.numLayers;
    const reply = dispatch("comp.addText", { comp: "Main", text: "Hello", ...invalid });
    expect(reply.execution.success).toBe(true);
    expect(reply.result?.ok).toBe(false);
    expect(comp.numLayers).toBe(before);
  });
});
