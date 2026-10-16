/**
 * A budget per operation, and getting the open project back after a timeout (#22).
 *
 * On a real AE (26.5x89) `project.open` took 330–510 ms inside AE, so with a
 * 400 ms session budget the open timed out although it finished, and the
 * caller had no `Project` except by opening the file again. The timed-out
 * script keeps running; that must stay true, and nothing here may run an
 * operation twice or edit anything the caller did not ask for.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TimeoutError } from "../src/driver/driver.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { AfterEffects, AfterEffectsError } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

/**
 * Behaves like `DoScriptFile` on a real AE: a script runs to completion even
 * after the caller stops waiting for it, and a later script starts only once
 * the earlier one has finished.
 */
class SlowScriptsTransport implements HostTransport {
  readonly kind = "slow-scripts";
  readonly inner = new FakeAfterEffectsTransport();
  /** Methods whose scripts take this long inside "AE". */
  readonly delays = new Map<string, number>();
  /** Methods in the order their scripts actually ran. */
  readonly ran: string[] = [];
  #tail: Promise<void> = Promise.resolve();

  available(): Promise<boolean> {
    return this.inner.available();
  }
  ownership(): HostOwnership {
    return this.inner.ownership();
  }
  launch(): Promise<void> {
    return this.inner.launch();
  }
  close(): Promise<void> {
    return this.inner.close();
  }

  invoke(entry: string, options: InvokeOptions = {}): Promise<void> {
    const method = methodOf(entry);
    const run = this.#tail.then(async () => {
      await sleep(this.delays.get(method) ?? 0);
      await this.inner.invoke(entry);
      this.ran.push(method);
    });
    this.#tail = run.catch(() => undefined);
    return new Promise<void>((resolve, reject) => {
      run.then(resolve, reject);
      // Aborting ends the caller's wait only; `run` carries on.
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }

  /** Resolves once every script handed over so far has finished. */
  settled(): Promise<void> {
    return this.#tail;
  }
}

function methodOf(entry: string): string {
  // <root>/staging/<id>.entry.jsx → <root>/inbox/<id>.request.json
  const id = basename(entry).replace(/\.entry\.jsx$/, "");
  const request = join(entry, "..", "..", "inbox", `${id}.request.json`);
  return existsSync(request) ? (JSON.parse(readFileSync(request, "utf-8")) as { method: string }).method : "?";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let root: string;
let transport: SlowScriptsTransport;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-optimeout-"));
  transport = new SlowScriptsTransport();
  path = join(root, "fixture.aep");
  writeFileSync(path, "fake");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function launch(timeoutMs = 5_000): Promise<AfterEffects> {
  return AfterEffects.launch({ sessionRoot: join(root, "session"), transport, timeoutMs });
}

/** Request envelopes the driver sent for a method. */
function sent(method: string): number {
  const inbox = join(root, "session", "inbox");
  return readdirSync(inbox).filter((name) => methodOf(join(root, "session", "staging", name.replace(".request.json", ".entry.jsx"))) === method).length;
}

async function timesOut(promise: Promise<unknown>): Promise<AfterEffectsError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AfterEffectsError);
  expect((error as AfterEffectsError).cause).toBeInstanceOf(TimeoutError);
  return error as AfterEffectsError;
}

describe("ae.project()", () => {
  it("returns the project a timed-out openProject went on to open, without opening it again", async () => {
    const ae = await launch();
    transport.delays.set("project.open", 300);

    await timesOut(ae.openProject(path, { timeoutMs: 50 }));

    const project = await ae.project();
    expect((await project.info()).file).toBe(path);
    expect(transport.inner.app.openedPaths).toEqual([path]);
    expect(sent("project.open")).toBe(1);
    expect(transport.ran.filter((m) => m === "project.open")).toHaveLength(1);

    // The handle works, and nothing was edited on the way.
    expect(transport.inner.app.project.dirty).toBe(false);
    expect((await project.comps()).map((c) => c.name)).toEqual(["Main"]);
    await ae.close();
  });

  it("changes nothing: no open, no close, unsaved changes stay unsaved", async () => {
    const ae = await launch();
    const opened = await ae.openProject(path);
    const layer = await (await opened.comp("Main")).layer("Solid 1");
    await (await layer.effects.apply("ADBE Fake Gaussian Blur")).parameter("Amount").set(30);
    expect(transport.inner.app.project.dirty).toBe(true);

    const again = await ae.project();
    expect(transport.inner.app.openedPaths).toEqual([path]);
    expect(transport.inner.app.project.dirty).toBe(true);
    const effects = await (await (await again.comp("Main")).layer("Solid 1")).effects.all();
    expect(effects.map((e) => e.matchName)).toEqual(["ADBE Fake Gaussian Blur"]);
    await ae.close({ unsavedChanges: "discard" });
  });
});

describe("a budget per operation", () => {
  it("applies to that call only; the session budget still holds for the next", async () => {
    const ae = await launch(5_000);
    transport.delays.set("project.open", 300);
    transport.delays.set("project.info", 200);

    const error = await timesOut(ae.openProject(path, { timeoutMs: 50 }));
    expect(error.message).toContain("50ms");
    // 200 ms (plus waiting for the open) is over the 50 ms above but well
    // inside the 5 s session budget.
    await expect(ae.project()).resolves.toBeDefined();

    const trace = ae.traceEvents.filter((e) => e.op === "project.open" || e.op === "project.info");
    expect(trace.map((e) => `${e.op}:${e.status}`)).toEqual(["project.open:timeout", "project.info:ok"]);
    await ae.close();
  });

  it("can be longer than the session budget", async () => {
    const ae = await launch(100);
    transport.delays.set("project.open", 300);
    await expect(ae.openProject(path, { timeoutMs: 3_000 })).resolves.toBeDefined();
    expect(sent("project.open")).toBe(1);
    await ae.close();
  });

  it("lets a timed-out render finish once, and does not render again by itself", async () => {
    const ae = await launch();
    const project = await ae.openProject(path);
    const comp = await project.comp("Main");
    transport.delays.set("comp.renderFrame", 300);

    await timesOut(comp.renderFrame(2, { timeoutMs: 50 }));
    await transport.settled();

    const renders = transport.inner.app.project.item(1)?.renders ?? [];
    expect(renders.map((r) => r.frame)).toEqual([2]);
    expect(existsSync(renders[0]!.path)).toBe(true);
    expect(sent("comp.renderFrame")).toBe(1);
    await ae.close({ unsavedChanges: "discard" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects timeoutMs %s before sending anything", async (bad) => {
    const ae = await launch();
    await expect(ae.openProject(path, { timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(ae.project({ timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
    expect(sent("project.open")).toBe(0);
    expect(sent("project.info")).toBe(0);
    await ae.close();
  });
});
