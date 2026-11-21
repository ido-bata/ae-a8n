/**
 * Contract tests for owned-session dispatcher activation (issue #276).
 *
 * `AfterFX.exe -r` cannot name a pid: the hand-off target is whichever
 * After Effects instance AE decides to give the script to. The only thing
 * that makes delivery safe is proving, immediately before the spawn, that
 * this session owns the single in-scope instance — and that the file
 * being delivered is the activation script this package generated, never
 * arbitrary JSX. These tests pin those gates: a foreign, ambiguous, or
 * unverifiable target must see zero spawn attempts.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import { ACTIVATION_MARKER } from "../src/driver/dispatcher-activation.js";
import {
  ScriptInvocationTransport,
  type HostProcess,
} from "../src/driver/script-invocation.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-dispatcher-activate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-15T00:00:00Z");
const WINDOWS_EXECUTABLE = "C:\\Adobe\\After Effects 2026\\Support Files\\AfterFX.exe";
const windowsInstall = {
  executable: WINDOWS_EXECUTABLE,
  versionName: "Adobe After Effects 2026",
  renderExecutable: null,
};
const IDENTITY = "2026-10-15T00:00:01.0000000Z";
const winProcess = (pid: number): HostProcess => ({
  pid,
  startedAt: T0 + 1_000,
  executable: WINDOWS_EXECUTABLE,
  identity: IDENTITY,
});

/** A generated-looking activate.jsx: the marker line plus inert body. */
function activationScript(name = "activate.jsx"): string {
  const path = join(root, name);
  writeFileSync(path, `${ACTIVATION_MARKER}\nvar __a8n = {};\n`, "utf-8");
  return path;
}

function foreignScript(name = "not-ours.jsx"): string {
  const path = join(root, name);
  writeFileSync(path, "// a caller-supplied script\napp.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\n", "utf-8");
  return path;
}

/** Records every launcher spawn: executable and argv. */
function spawnRecorder() {
  const spawns: { executable: string; args: readonly string[] }[] = [];
  return {
    spawns,
    spawnLauncher: (executable: string, args: readonly string[]) => {
      spawns.push({ executable, args });
      const child = Object.assign(new EventEmitter(), { pid: 9000 + spawns.length, unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    },
  };
}

/**
 * A Windows script transport that has adopted pid 42 as its owned AE —
 * the same seam session-adopt.test.ts uses — with `processes` answering
 * from `lists` in order (the last list repeats).
 */
function ownedWindowsTransport(
  lists: HostProcess[][],
  recorder = spawnRecorder(),
): { transport: ScriptInvocationTransport; recorder: typeof recorder } {
  let i = 0;
  const transport = new ScriptInvocationTransport({
    platform: "win32",
    install: windowsInstall,
    now: () => T0,
    processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
    selfPid: 500,
    spawnLauncher: recorder.spawnLauncher,
    adopt: {
      pid: 42,
      startedAt: T0 + 1_000,
      identity: IDENTITY,
      executable: WINDOWS_EXECUTABLE,
    },
  });
  return { transport, recorder };
}

describe("ScriptInvocationTransport.deliverActivationScript", () => {
  it("spawns AfterFX.exe -r with the activation script for an owned host", async () => {
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");

    const script = activationScript();
    await transport.deliverActivationScript(script);

    expect(recorder.spawns).toHaveLength(1);
    expect(recorder.spawns[0]?.executable).toBe(WINDOWS_EXECUTABLE);
    expect(recorder.spawns[0]?.args[0]).toBe("-r");
    expect(recorder.spawns[0]?.args[1]).toBe(script);
  });

  it("refuses on a non-Windows platform even when owned", async () => {
    // darwin has no -r; the same ownership proof exists but the delivery
    // mechanism does not, so nothing may be spawned.
    const recorder = spawnRecorder();
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install: {
        executable: "/Applications/AE.app/Contents/MacOS/After Effects",
        versionName: "AE.app",
        renderExecutable: null,
      },
      now: () => T0,
      sessionUid: 501,
      processes: () => [
        { pid: 42, startedAt: T0 + 1_000, executable: "/Applications/AE.app/Contents/MacOS/After Effects" },
      ],
      spawnLauncher: recorder.spawnLauncher,
      adopt: {
        pid: 42,
        startedAt: T0 + 1_000,
        executable: "/Applications/AE.app/Contents/MacOS/After Effects",
      },
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");

    await expect(transport.deliverActivationScript(activationScript())).rejects.toThrow(
      /only implemented for Windows/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });

  it("refuses when the session does not own the host — nothing is spawned", async () => {
    // A launch-capable transport whose census already held an AfterFX.exe
    // before launch: ownership is "attached", and -r cannot be allowed to
    // reach whatever instance AE would hand the script to. The only spawn
    // permitted is launch()'s own bare AfterFX.exe — never a -r.
    const recorder = spawnRecorder();
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: windowsInstall,
      now: () => T0,
      processes: () => [winProcess(7)],
      selfPid: 500,
      spawnLauncher: recorder.spawnLauncher,
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("attached");
    const spawnsBefore = recorder.spawns.length;

    await expect(transport.deliverActivationScript(activationScript())).rejects.toThrow(
      /does not own/,
    );
    expect(recorder.spawns).toHaveLength(spawnsBefore);
  });

  it("refuses when a second in-scope instance makes ownership unprovable", async () => {
    // Owned at confirm time, but the live re-check inside deliverActivationScript
    // sees two instances: -r could reach either, so nothing may be spawned.
    const recorder = spawnRecorder();
    let extra: HostProcess[] = [];
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: windowsInstall,
      now: () => T0,
      processes: () => [winProcess(42), ...extra],
      selfPid: 500,
      spawnLauncher: recorder.spawnLauncher,
      adopt: {
        pid: 42,
        startedAt: T0 + 1_000,
        identity: IDENTITY,
        executable: WINDOWS_EXECUTABLE,
      },
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");

    extra = [{ ...winProcess(43), identity: "2026-10-15T00:00:02.0000000Z" }];
    const spawnsBefore = recorder.spawns.length;
    await expect(transport.deliverActivationScript(activationScript())).rejects.toThrow(
      /does not own/,
    );
    expect(recorder.spawns).toHaveLength(spawnsBefore);
  });

  it("refuses a file that is not a generated activation script", async () => {
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    await expect(transport.deliverActivationScript(foreignScript())).rejects.toThrow(
      /not a dispatcher activation script/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });

  it("refuses a marker quoted inline rather than on its own line", async () => {
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    const path = join(root, "quoted.jsx");
    writeFileSync(path, `var s = "${ACTIVATION_MARKER}";\n`, "utf-8");
    await expect(transport.deliverActivationScript(path)).rejects.toThrow(
      /not a dispatcher activation script/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });
});

describe("AfterEffects.activateDispatcher", () => {
  it("refuses a session whose ownership is not owned", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownershipKind = "attached";
    const ae = await AfterEffects.launch({ sessionRoot: root, transport });
    await expect(ae.activateDispatcher()).rejects.toMatchObject({ name: "HostNotOwnedError" });
    await ae.close();
  });

  it("refuses a transport that cannot deliver activation scripts", async () => {
    // The fake is owned, but it is not the script transport: there is no
    // -r path, and no substitute delivery may be invented.
    const ae = await AfterEffects.launch({ sessionRoot: root, transport: new FakeAfterEffectsTransport() });
    await expect(ae.activateDispatcher()).rejects.toThrow(/built-in script transport/);
    await ae.close();
  });
});
