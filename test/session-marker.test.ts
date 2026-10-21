/**
 * The session marker (#43): proof of *where* a script was delivered.
 *
 * On Windows `AfterFX.exe -r` cannot be aimed at a pid, so ownership of a process
 * does not say which instance a quit reaches. The probe makes the instance that
 * answered it remember this session's random id; `app.quit` then runs only where
 * that id is remembered. A quit delivered to any other instance refuses, quits
 * nothing, and says so. Only transports that cannot aim a delivery opt in
 * (`verifiesDestination`); macOS is untouched.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";
import { TraceRecorder } from "../src/trace/trace.js";

/** Two After Effects instances behind one way of delivering scripts. */
class TwoInstances implements HostTransport {
  readonly kind = "two-instances";
  readonly a = new FakeAfterEffectsTransport();
  readonly b = new FakeAfterEffectsTransport();
  /** Which instance the next delivery goes to; the test flips it. */
  target: "a" | "b" = "a";
  readonly verifiesDestination: boolean | undefined;
  constructor(verifies: boolean | undefined) {
    this.verifiesDestination = verifies;
  }
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async launch(): Promise<void> {
    await this.a.launch();
    await this.b.launch();
  }
  invoke(entry: string, _options?: InvokeOptions): Promise<void> {
    return (this.target === "a" ? this.a : this.b).invoke(entry);
  }
  ownership(): HostOwnership {
    return { kind: "owned", evidence: "test" };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-marker-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function driverOn(transport: HostTransport, name = "session"): AeDriver {
  return new AeDriver({ transport, sessionRoot: join(root, name), trace: new TraceRecorder() });
}

function requestsIn(name = "session"): Array<{ method: string; session?: { id: string; adopt?: boolean; require?: boolean } }> {
  const dir = join(root, name, "inbox");
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as { method: string; session?: { id: string; adopt?: boolean; require?: boolean } });
}

describe("the session marker", () => {
  it("lets a quit through on the instance that answered the probe", async () => {
    const t = new TwoInstances(true);
    const driver = driverOn(t);
    await driver.start();
    const result = await driver.stop({ unsavedChanges: "discard" });
    expect(result.quit).toBe(true);
    expect(t.a.app.quitCount).toBe(1);
  });

  it("refuses a quit delivered to another instance, quits nothing, and says why", async () => {
    const t = new TwoInstances(true);
    const driver = driverOn(t);
    await driver.start(); // answered by A
    t.target = "b"; // the quit is mis-delivered
    const result = await driver.stop({ unsavedChanges: "discard" });
    expect(result.quit).toBe(false);
    expect(result.reason).toMatch(/different After Effects instance/);
    expect(t.b.app.quitCount).toBe(0);
    expect(t.a.app.quitCount).toBe(0);
  });

  it("refuses when the instance that answered has been replaced (no marker there)", async () => {
    const t = new TwoInstances(true);
    const driver = driverOn(t);
    await driver.start();
    // A restart: a fresh engine that never saw the probe.
    t.a.resetEngine();
    const result = await driver.stop({ unsavedChanges: "discard" });
    expect(result.quit).toBe(false);
    expect(t.a.app.quitCount).toBe(0);
  });

  it("gives every session its own random id, and two sessions can share an instance", async () => {
    const t = new TwoInstances(true);
    const one = driverOn(t, "one");
    const two = driverOn(t, "two");
    await one.start();
    await two.start();
    const idOne = requestsIn("one").find((r) => r.session?.adopt)?.session?.id;
    const idTwo = requestsIn("two").find((r) => r.session?.adopt)?.session?.id;
    expect(idOne).toMatch(/^[0-9a-f-]{36}$/);
    expect(idTwo).toMatch(/^[0-9a-f-]{36}$/);
    expect(idOne).not.toBe(idTwo);
    // The second probe did not erase the first session's marker.
    expect((await one.stop({ unsavedChanges: "discard" })).quit).toBe(true);
  });

  it("asks only the probe to adopt and only the quit to require", async () => {
    const t = new TwoInstances(true);
    const driver = driverOn(t);
    await driver.start();
    await driver.call("app.info");
    await driver.stop({ unsavedChanges: "discard" });
    const sent = requestsIn();
    expect(sent.filter((r) => r.session?.adopt).map((r) => r.method)).toEqual(["app.info"]);
    expect(sent.filter((r) => r.session?.require).map((r) => r.method)).toEqual(["app.quit"]);
    expect(sent.filter((r) => r.method === "app.info" && r.session === undefined)).toHaveLength(1);
  });

  it("keeps only strings and booleans in the engine, never an After Effects object", async () => {
    const t = new TwoInstances(true);
    await driverOn(t).start();
    const store = t.a.engineGlobal["__a8nSessions"] as Record<string, unknown>;
    expect(Object.keys(store)).toHaveLength(1);
    expect(Object.values(store).every((v) => v === true)).toBe(true);
    expect(Object.keys(t.a.engineGlobal)).toEqual(["__a8nSessions"]);
  });

  it("is not used, and changes nothing, on a transport that can aim its deliveries (macOS)", async () => {
    const t = new TwoInstances(undefined);
    const driver = driverOn(t);
    await driver.start();
    t.target = "b"; // would be refused if a marker were required
    const result = await driver.stop({ unsavedChanges: "discard" });
    expect(requestsIn().every((r) => r.session === undefined)).toBe(true);
    expect(result.quit).toBe(true);
    expect(t.b.app.quitCount).toBe(1);
  });
});
