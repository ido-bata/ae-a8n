/**
 * A session never quits an After Effects it does not own, and never throws
 * away unsaved changes it was not told it may.
 *
 * Before this, `close()` always ran `app.quit`, after closing the open project
 * without saving — so attaching to someone's running AE and closing the
 * session quit their AE and discarded their work.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects, UnsavedChangesError } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

let root: string;
let transport: FakeAfterEffectsTransport;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-session-"));
  transport = new FakeAfterEffectsTransport();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const launch = () => AfterEffects.launch({ sessionRoot: join(root, "s"), transport });

async function edit(ae: AfterEffects): Promise<void> {
  const fixture = join(root, "fixture.aep");
  writeFileSync(fixture, "fake");
  const project = await ae.openProject(fixture);
  const layer = await (await project.comp("Main")).layer("Solid 1");
  await layer.effects.apply("ADBE Fake Gaussian Blur");
}

describe.each(["attached", "unknown"] as const)("a host the session does not own (%s)", (kind) => {
  it("is left running, with its unsaved changes, and the result says why", async () => {
    transport.ownershipKind = kind;
    const ae = await launch();
    await edit(ae);

    const result = await ae.close({ unsavedChanges: "discard" });

    expect(result).toMatchObject({ quit: false, ownership: { kind } });
    expect(result.reason).toMatch(/does not own/);
    expect(transport.app.quitCount).toBe(0);
    expect(transport.app.project.dirty).toBe(true);
    expect(transport.closed).toBe(false);
  });
});

describe("a host the session owns", () => {
  it("is quit when there is nothing unsaved", async () => {
    const ae = await launch();
    await expect(ae.close()).resolves.toMatchObject({ quit: true, ownership: { kind: "owned" } });
    expect(transport.app.quitCount).toBeGreaterThan(0);
  });

  it("refuses to discard unsaved changes, and stays usable", async () => {
    const ae = await launch();
    await edit(ae);

    await expect(ae.close()).rejects.toBeInstanceOf(UnsavedChangesError);
    expect(transport.app.quitCount).toBe(0);
    expect(transport.app.project.dirty).toBe(true);
    // Still a live session: the caller decides what happens next.
    await expect(ae.version()).resolves.toBe("26.0.0");

    await expect(ae.close({ unsavedChanges: "discard" })).resolves.toMatchObject({ quit: true });
  });
});

describe("closing a project through the driver", () => {
  it("refuses to drop unsaved changes unless told to", async () => {
    const ae = await launch();
    await edit(ae);
    const { AeDriver } = await import("../src/driver/driver.js");
    const { TraceRecorder } = await import("../src/trace/trace.js");
    const d = new AeDriver({ transport, sessionRoot: join(root, "d"), trace: new TraceRecorder({ file: join(root, "d.jsonl") }) });
    await d.start();
    await expect(d.call("project.close", {})).rejects.toMatchObject({ name: "UnsavedChangesError" });
    expect(transport.app.project.dirty).toBe(true);
    await d.call("project.close", { discardUnsavedChanges: true });
    expect(transport.app.project.file).toBeNull();
  });
});

describe("opening a project over unsaved changes", () => {
  it("refuses unless told to discard them", async () => {
    const ae = await launch();
    await edit(ae);
    const other = join(root, "other.aep");
    writeFileSync(other, "fake");

    await expect(ae.openProject(other)).rejects.toBeInstanceOf(UnsavedChangesError);
    expect(transport.app.openedPaths).toHaveLength(1);

    await ae.openProject(other, { unsavedChanges: "discard" });
    expect(transport.app.openedPaths).toHaveLength(2);
    await ae.close();
  });
});
