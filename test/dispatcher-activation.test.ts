/**
 * Contract tests for owned-session dispatcher activation (issue #276).
 *
 * `AfterFX.exe -r` cannot name a pid: the hand-off target is whichever
 * After Effects instance AE decides to give the script to. The only thing
 * that makes delivery safe is proving, immediately before the spawn, that
 * this session owns the single in-scope instance — and that the file
 * being delivered is byte-identical to the activation script this package
 * generated, never arbitrary JSX. Success is then bound to *this*
 * delivery by a per-call nonce the dispatcher records in its heartbeat:
 * a dispatcher that was already answering the channel cannot satisfy it.
 *
 * These tests pin those gates: a foreign, ambiguous, marker-bearing, or
 * mutated file must see zero spawn attempts, and a fresh heartbeat that
 * does not carry the delivery nonce must never count as success.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import {
  ACTIVATION_MARKER,
  dispatcherActivationScript,
} from "../src/driver/dispatcher-activation.js";
import { DispatcherTransport } from "../src/driver/dispatcher-transport.js";
import {
  ScriptInvocationTransport,
  type HostProcess,
} from "../src/driver/script-invocation.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { runHostScript } from "../src/testing/fake-ae/es3-runtime.js";
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
} from "../src/testing/fake-ae/object-model.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-dispatcher-activate-"));
  // The delivery binding reads the channel's token from channel.json when
  // present; the staged scripts below embed CHANNEL_TOKEN to match.
  writeFileSync(
    join(root, "channel.json"),
    JSON.stringify({ v: 1, token: "f".repeat(64), createdAt: T0, hostScript: null }),
    "utf-8",
  );
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

const CHANNEL_TOKEN = "f".repeat(64);

/** A canonical generated activation script — the only shape `-r` accepts. */
function activationScript(name = "activate.jsx"): string {
  const path = join(root, name);
  writeFileSync(
    path,
    dispatcherActivationScript({ channelDir: root, token: CHANNEL_TOKEN }),
    "utf-8",
  );
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

/* ------------------------------------------- fake AE peer (real host code) */

function fakeAe(version = "26.0.0"): FakeApplication {
  const app = new FakeApplication();
  app.version = version;
  if (app.project.numItems === 0) {
    app.project.load(createDefaultComp(), null);
  }
  return app;
}

/** Runs a staged script against a fake AE the way `-r`/Run Script File would. */
function runActivationScript(
  path: string,
  app: FakeApplication,
  engineGlobal?: Record<string, unknown>,
) {
  return runHostScript(
    path,
    createFakeGlobals(app),
    engineGlobal === undefined ? {} : { engineGlobal },
  );
}

describe("ScriptInvocationTransport.deliverActivationScript", () => {
  it("spawns AfterFX.exe -r with a private copy of the canonical script", async () => {
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");

    const script = activationScript();
    const delivered = await transport.deliverActivationScript(script);

    expect(recorder.spawns).toHaveLength(1);
    expect(recorder.spawns[0]?.executable).toBe(WINDOWS_EXECUTABLE);
    expect(recorder.spawns[0]?.args[0]).toBe("-r");
    // The -r argument is the private copy, not the staged path — and its
    // bytes are exactly what was verified.
    expect(delivered).not.toBe(script);
    expect(recorder.spawns[0]?.args[1]).toBe(delivered);
    expect(readFileSync(delivered, "utf-8")).toBe(readFileSync(script, "utf-8"));
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

  it("refuses arbitrary JSX behind a whole-line marker — marker is not identity", async () => {
    // The review counterexample: prepending the marker line to foreign JSX
    // used to pass the whole-line check. Canonical byte equality must not.
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    const path = join(root, "marker-plus-jsx.jsx");
    writeFileSync(
      path,
      `${ACTIVATION_MARKER}\napp.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\n`,
      "utf-8",
    );
    await expect(transport.deliverActivationScript(path)).rejects.toThrow(
      /not a dispatcher activation script/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });

  it("refuses a generated script mutated after generation", async () => {
    // Even one appended line — or a flipped byte inside the embedded
    // parameters — breaks byte-identity with package output.
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    const appended = join(root, "appended.jsx");
    writeFileSync(
      appended,
      `${dispatcherActivationScript({ channelDir: root, token: CHANNEL_TOKEN })}\n// tampered\n`,
      "utf-8",
    );
    await expect(transport.deliverActivationScript(appended)).rejects.toThrow(
      /not a dispatcher activation script/,
    );

    // A single structural byte — the evalFile target — breaks identity.
    const flipped = join(root, "flipped.jsx");
    const canonical = dispatcherActivationScript({ channelDir: root, token: CHANNEL_TOKEN });
    writeFileSync(flipped, canonical.replace("a8n-host.js", "a8n-hostX.js"), "utf-8");
    await expect(transport.deliverActivationScript(flipped)).rejects.toThrow(
      /not a dispatcher activation script/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });

  it("refuses a canonical script bound to a different channel token", async () => {
    // Byte-identical generator output for *another* token is still refused:
    // the embedded token must match this directory's channel.json.
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    const path = join(root, "other-channel.jsx");
    writeFileSync(
      path,
      dispatcherActivationScript({ channelDir: root, token: "e".repeat(64) }),
      "utf-8",
    );
    await expect(transport.deliverActivationScript(path)).rejects.toThrow(
      /not this channel's/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });

  it("refuses a canonical script whose root is not the script's own directory", async () => {
    // Generator-shaped bytes pointing $.evalFile at a foreign channel
    // directory must not pass: the embedded root is bound to the file's
    // location.
    const { transport, recorder } = ownedWindowsTransport([[winProcess(42)]]);
    await transport.launch();
    transport.confirmLaunched();

    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    const path = join(foreign, "activate.jsx");
    writeFileSync(
      path,
      dispatcherActivationScript({ channelDir: root, token: CHANNEL_TOKEN }),
      "utf-8",
    );
    await expect(transport.deliverActivationScript(path)).rejects.toThrow(
      /not a dispatcher activation script generated for this channel directory/,
    );
    expect(recorder.spawns).toHaveLength(0);
  });
});

describe("activation nonce proof", () => {
  it("a pre-existing fresh heartbeat without the delivery nonce is not success", async () => {
    // The P1a counterexample: a dispatcher is already answering the
    // channel (human-activated, no nonce). A delivery that never runs —
    // or runs elsewhere — must not be reported as this call's success.
    const dir = join(root, "channel");
    const transport = new DispatcherTransport({ channelDir: dir });
    await transport.prepare();

    const app = fakeAe();
    const activated = runActivationScript(join(dir, "activate.jsx"), app);
    expect(activated.success, activated.success ? "" : activated.error.message).toBe(true);

    const beat = transport.status().heartbeat;
    expect(beat?.fresh).toBe(true);
    expect(beat?.activationNonce).toBeNull();

    // A nonce this call could have generated never appears: fail closed.
    await expect(
      transport.waitForActivationNonce("0".repeat(32), 300),
    ).rejects.toThrow(/nonce/);
  });

  it("proves delivery by nonce, and re-proves on an already-active dispatcher", async () => {
    const dir = join(root, "channel");
    const transport = new DispatcherTransport({ channelDir: dir });
    await transport.prepare();

    // Pre-existing dispatcher on the channel — the stale-heartbeat setup.
    const first = fakeAe();
    const firstGlobal: Record<string, unknown> = {};
    const human = runActivationScript(join(dir, "activate.jsx"), first, firstGlobal);
    expect(human.success).toBe(true);

    // Stage this call's delivery file; before AE runs it the nonce proof
    // must still fail — freshness alone is not evidence.
    const activation = await transport.prepareActivationScript();
    await expect(transport.waitForActivationNonce(activation.nonce, 300)).rejects.toThrow(
      /nonce/,
    );

    // The `-r` hand-off reaches a *different* AE instance (the owned one
    // in the real flow): its dispatcher activates and records our nonce.
    const owned = fakeAe();
    const ownedGlobal: Record<string, unknown> = {};
    const delivered = runActivationScript(activation.path, owned, ownedGlobal);
    expect(delivered.success, delivered.success ? "" : delivered.error.message).toBe(true);

    const beat = await transport.waitForActivationNonce(activation.nonce, 2_000);
    expect(beat.activationNonce).toBe(activation.nonce);
    expect(beat.fresh).toBe(true);

    // A second activateDispatcher() call on the same already-active AE
    // re-proves delivery: the new nonce replaces the old one in the
    // heartbeat instead of starting a second dispatcher.
    const second = await transport.prepareActivationScript();
    const redelivery = runActivationScript(second.path, owned, ownedGlobal);
    expect(redelivery.success, redelivery.success ? "" : redelivery.error.message).toBe(true);
    const beat2 = await transport.waitForActivationNonce(second.nonce, 2_000);
    expect(beat2.activationNonce).toBe(second.nonce);
    expect(beat2.instance).toBe(beat.instance);
    expect(ownedGlobal["__a8nDispatcherTask"]).toBeDefined();
  });

  it("re-running the identical delivery file is still refused as a second activation", async () => {
    const dir = join(root, "channel");
    const transport = new DispatcherTransport({ channelDir: dir });
    await transport.prepare();

    const app = fakeAe();
    const engineGlobal: Record<string, unknown> = {};
    const activation = await transport.prepareActivationScript();
    const first = runActivationScript(activation.path, app, engineGlobal);
    expect(first.success).toBe(true);

    // Same file, same nonce: nothing new is proven, so the host refuses —
    // exactly the pre-existing "already active" contract.
    const second = runActivationScript(activation.path, app, engineGlobal);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.message).toMatch(/already active/);
    }
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
