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

import { AfterEffects, HostNotOwnedError, UnsavedChangesError } from "../src/index.js";
import { runExtensionCommand } from "../src/cli/extension.js";
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

    // The capability surface states the same invariant the behavior just
    // proved (#129): the attach-vs-owned distinction is visible, and the
    // quit policy is owned-only — an attached instance is never quit.
    const response = await ae.capabilities();
    expect(response.target.ownershipKind).toBe(kind);
    expect(response.target.quitPolicy).toBe("owned-only");
    expect(response.target.nonInterference).toBe("unproven");
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

describe.each(["attached", "unknown"] as const)(
  "the authorization grant on a host the session does not own (%s)",
  (kind) => {
    async function buildExtension(): Promise<string> {
      const ext = join(root, "ext.mjs");
      writeFileSync(
        ext,
        'export default { name: "aulymo", version: "1.0.0", methods: [' +
          '{ name: "aulymo.echo", source: "function (params) { return params.value; }" },' +
          '{ name: "aulymo.boom", source: "function () { throw new Error(\\"boom\\"); }" }' +
          "] };\n",
        "utf-8",
      );
      const out = join(root, "host.generated.js");
      const result = await runExtensionCommand(
        ["build", "--extension", ext, "--out", out],
        { writeOut: () => undefined, writeErr: () => undefined },
      );
      expect(result.exitCode).toBe(0);
      return out;
    }

    it("refuses privileged operations without a grant, and never quits", async () => {
      transport.ownershipKind = kind;
      const hostScript = await buildExtension();
      const ae = await AfterEffects.launch({
        sessionRoot: join(root, "s"),
        transport,
        hostScript,
      });

      await expect(ae.call("aulymo.echo", { value: "x" })).rejects.toBeInstanceOf(HostNotOwnedError);
      const command = transport.app.registerMenuCommand("Fake Plugin: Trace", () => {});
      await expect((await ae.menuCommand(command)).execute()).rejects.toBeInstanceOf(HostNotOwnedError);

      const response = await ae.capabilities();
      expect(response.target.grantedOperations).toEqual([]);
      expect(response.target.dispatcherInstance).toBeNull();

      // The grant changes nothing about quitting: still owned-only.
      const result = await ae.close({ unsavedChanges: "discard" });
      expect(result.quit).toBe(false);
      expect(transport.app.quitCount).toBe(0);
    });

    it("runs exactly the operations the grant names", async () => {
      transport.ownershipKind = kind;
      const hostScript = await buildExtension();
      const ae = await AfterEffects.launch({
        sessionRoot: join(root, "s"),
        transport,
        hostScript,
        hostEnvironment: { FAKE_PLUGIN_OUT: "/tmp/out" },
        authorization: {
          extensionMethods: ["aulymo.echo"],
          menuCommands: true,
          hostEnvironment: true,
        },
      });

      // hostEnvironment was applied at launch under the grant.
      expect(ae.traceEvents.map((event) => event.op)).toContain("session.hostEnvironment");

      // The listed method runs; the unlisted one is refused before dispatch.
      await expect(ae.call("aulymo.echo", { value: "hi" })).resolves.toBe("hi");
      await expect(ae.call("aulymo.boom")).rejects.toBeInstanceOf(HostNotOwnedError);

      const command = transport.app.registerMenuCommand("Fake Plugin: Trace", () => {});
      await expect((await ae.menuCommand(command)).execute()).resolves.toMatchObject({ id: command });

      const response = await ae.capabilities();
      expect([...response.target.grantedOperations].sort()).toEqual([
        "extensionMethods",
        "hostEnvironment",
        "menuCommands",
      ]);

      // Grant or not, this session still cannot quit the host.
      await expect(ae.close()).resolves.toMatchObject({ quit: false });
      expect(transport.app.quitCount).toBe(0);
    });

    it("rejects a grant that names an unknown scope or a malformed value", async () => {
      transport.ownershipKind = kind;
      for (const authorization of [
        { bogus: true },
        { extensionMethods: "all" },
        { menuCommands: "yes" },
        "yes",
      ]) {
        await expect(
          AfterEffects.launch({
            sessionRoot: join(root, `s${Math.random()}`),
            transport,
            authorization: authorization as never,
          }),
        ).rejects.toThrow(TypeError);
      }
    });
  },
);

describe("recoveryTarget", () => {
  it("is null for a transport that cannot attest a pid, even when owned", async () => {
    // The fake transport owns its host but cannot name a real pid or GUI
    // session — recovery authorization must see "no attested target",
    // never a substitute pid.
    const ae = await launch();
    expect(transport.ownershipKind).toBe("owned");
    expect(ae.recoveryTarget()).toBeNull();
  });

  it("is null once the session is closed", async () => {
    const ae = await launch();
    await ae.close();
    expect(ae.recoveryTarget()).toBeNull();
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
