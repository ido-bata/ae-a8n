/**
 * Contract tests for dispatcher activation provenance (#294).
 *
 * The in-AE dispatcher cannot name its own pid, so the only honest pid
 * evidence is what an *owned* `activateDispatcher()` delivery proved:
 * the session that owned the After Effects process knew the pid, the
 * process start identity, and — bound to the heartbeat's
 * instance/activatedAt/nonce — exactly which activation it was. This
 * file pins the record's shape and, more importantly, every fail-closed
 * edge of `DispatcherTransport.attestation()`: a reused pid, a
 * re-activated dispatcher, a foreign or unreadable record, or an
 * unreadable census must all attest nothing.
 */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import {
  dispatcherProvenancePath,
  readDispatcherProvenance,
  recordDispatcherProvenance,
} from "../src/driver/dispatcher-provenance.js";
import { DispatcherTransport } from "../src/driver/dispatcher-transport.js";
import {
  ScriptInvocationTransport,
  type HostProcess,
} from "../src/driver/script-invocation.js";
import type { MacAppInstance } from "../src/driver/mac-session.js";
import { runHostScript } from "../src/testing/fake-ae/es3-runtime.js";
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
} from "../src/testing/fake-ae/object-model.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-dispatcher-prov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-15T00:00:00Z");
const NONCE = "a".repeat(32);
const INSTANCE = "inst-owned-1";
const WINDOWS_EXECUTABLE = "C:\\Adobe\\After Effects 2026\\Support Files\\AfterFX.exe";
const IDENTITY = "2026-10-15T00:00:01.0000000Z";

const ownedHost = {
  pid: 42,
  startedAt: T0 + 1_000,
  identity: IDENTITY,
  executable: WINDOWS_EXECUTABLE,
};

/** A census entry that `sameProcess` accepts for `ownedHost` on any OS. */
const censusMatch: HostProcess = {
  pid: 42,
  startedAt: T0 + 1_000,
  executable: WINDOWS_EXECUTABLE,
  identity: IDENTITY,
};

async function preparedChannel(dir: string): Promise<string> {
  const transport = new DispatcherTransport({ channelDir: dir });
  await transport.prepare();
  const meta = JSON.parse(readFileSync(join(dir, "channel.json"), "utf-8")) as {
    token: string;
  };
  return meta.token;
}

function writeHeartbeat(
  dir: string,
  token: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(dir, "state.json"),
    `${JSON.stringify({
      v: 1,
      token,
      instance: INSTANCE,
      aeVersion: "26.5.0",
      activatedAt: T0,
      lastTick: Date.now(),
      pollMs: 2_000,
      activationNonce: NONCE,
      extensionMethods: [],
      ...overrides,
    })}\n`,
    "utf-8",
  );
}

function recordProvenance(
  dir: string,
  overrides: Partial<Parameters<typeof recordDispatcherProvenance>[1]> = {},
): void {
  recordDispatcherProvenance(dir, {
    host: ownedHost,
    instance: INSTANCE,
    activatedAt: T0,
    activationNonce: NONCE,
    session: null,
    ...overrides,
  });
}

function attestingTransport(
  dir: string,
  processes: () => HostProcess[],
  appInstances?: () => MacAppInstance[],
): DispatcherTransport {
  return new DispatcherTransport({
    channelDir: dir,
    processes,
    ...(appInstances === undefined ? {} : { appInstances }),
  });
}

/** The window-server entry a recorded session must still match. */
const appInSession = (overrides: Partial<MacAppInstance> = {}): MacAppInstance => ({
  name: "After Effects",
  pid: 42,
  uid: 501,
  asid: 99,
  ...overrides,
});

describe("dispatcher provenance record", () => {
  it("round-trips what an owned activation recorded", () => {
    const dir = join(root, "channel");
    recordProvenance(dir, {
      session: { uid: 501, asid: 99, user: "tester" },
    });
    const provenance = readDispatcherProvenance(dir);
    expect(provenance).not.toBeNull();
    expect(provenance?.schema).toBe("a8n.dispatcher-provenance/v1");
    expect(provenance?.host).toMatchObject({
      pid: 42,
      startedAt: T0 + 1_000,
      identity: IDENTITY,
      executable: WINDOWS_EXECUTABLE,
      platform: process.platform,
    });
    expect(provenance?.instance).toBe(INSTANCE);
    expect(provenance?.activatedAt).toBe(T0);
    expect(provenance?.activationNonce).toBe(NONCE);
    expect(provenance?.session).toEqual({ uid: 501, asid: 99, user: "tester" });
  });

  it("is null when nothing was recorded", () => {
    expect(readDispatcherProvenance(join(root, "empty"))).toBeNull();
  });

  it("throws on malformed or foreign content rather than reading it as absent", () => {
    const dir = join(root, "channel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dispatcherProvenancePath(dir), "{broken", "utf-8");
    expect(() => readDispatcherProvenance(dir)).toThrow(/not readable JSON/);
    writeFileSync(
      dispatcherProvenancePath(dir),
      JSON.stringify({ schema: "something-else/v9" }),
      "utf-8",
    );
    expect(() => readDispatcherProvenance(dir)).toThrow(/does not match/);
  });
});

describe("DispatcherTransport.attestation with recorded provenance (#294)", () => {
  it("attests the recorded pid and session while heartbeat and census agree", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir, {
      session: { uid: 501, asid: 99, user: "tester" },
    });

    const transport = attestingTransport(dir, () => [censusMatch], () => [
      appInSession(),
    ]);
    const attestation = transport.attestation();
    expect(attestation.pid).toBe(42);
    expect(attestation.sessionUid).toBe(501);
    expect(attestation.sessionAsid).toBe(99);
    expect(attestation.sessionUser).toBe("tester");
    expect(attestation.ownedProcess).toBeNull();
    expect(transport.hostPid()).toBe(42);
  });

  it("attests nothing without a provenance record — human activation stays blind", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);

    const transport = attestingTransport(dir, () => [censusMatch]);
    expect(transport.attestation().pid).toBeNull();
    expect(transport.hostPid()).toBeNull();
  });

  it("attests nothing when the heartbeat names a different activation", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    // A re-activation (new instance) or a second AE taking the channel
    // over changes the heartbeat identity the record is bound to.
    writeHeartbeat(dir, token, { instance: "inst-other" });
    recordProvenance(dir);

    const transport = attestingTransport(dir, () => [censusMatch]);
    expect(transport.attestation().pid).toBeNull();

    writeHeartbeat(dir, token, { activatedAt: T0 + 5_000 });
    expect(transport.attestation().pid).toBeNull();

    writeHeartbeat(dir, token, { activationNonce: "b".repeat(32) });
    expect(transport.attestation().pid).toBeNull();
  });

  it("attests nothing when the pid was reused — start identity must match", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir);

    // Same pid, different start time: a different process owns it now.
    const reused: HostProcess = { ...censusMatch, startedAt: T0 + 90_000 };
    expect(attestingTransport(dir, () => [reused]).attestation().pid).toBeNull();

    // Same pid and start time, different Windows creation identity:
    // judged only on win32 — POSIX `ps` resolution is the start time.
    const wrongIdentity: HostProcess = {
      ...censusMatch,
      identity: "2026-10-15T00:00:09.0000000Z",
    };
    const withWrongIdentity = attestingTransport(dir, () => [wrongIdentity]);
    if (process.platform === "win32") {
      expect(withWrongIdentity.attestation().pid).toBeNull();
    } else {
      expect(withWrongIdentity.attestation().pid).toBe(42);
    }
  });

  it("attests nothing when the recorded session moved or cannot be re-proven", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir, {
      session: { uid: 501, asid: 99, user: "tester" },
    });

    // The pid is unchanged but the process now lives in another login
    // session — fast user switching must not leave a stale attestation.
    const moved = attestingTransport(dir, () => [censusMatch], () => [
      appInSession({ asid: 100 }),
    ]);
    expect(moved.attestation().pid).toBeNull();

    // The window-server census cannot place the pid in the session at
    // all: another user's AE, a different pid, or no answer — all null.
    for (const apps of [
      [appInSession({ uid: 502 })],
      [appInSession({ pid: 43 })],
      [],
    ]) {
      expect(
        attestingTransport(dir, () => [censusMatch], () => apps).attestation().pid,
      ).toBeNull();
    }
    expect(
      attestingTransport(dir, () => [censusMatch], () => {
        throw new Error("lsappinfo unavailable");
      }).attestation().pid,
    ).toBeNull();

    // A record whose session was never identified cannot be verified
    // either — fail closed rather than attest half the evidence.
    const dir2 = join(root, "channel2");
    const token2 = await preparedChannel(dir2);
    writeHeartbeat(dir2, token2);
    recordProvenance(dir2, {
      session: { uid: 501, asid: null, user: "tester" },
    });
    expect(
      attestingTransport(dir2, () => [censusMatch], () => [appInSession()]).attestation()
        .pid,
    ).toBeNull();
  });

  it("attests nothing when the recorded pid is gone from the census", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir);

    expect(attestingTransport(dir, () => []).attestation().pid).toBeNull();
    expect(
      attestingTransport(dir, () => [{ ...censusMatch, pid: 77 }]).attestation().pid,
    ).toBeNull();
  });

  it("fails closed when the census or the provenance cannot be read", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir);

    expect(
      attestingTransport(dir, () => {
        throw new Error("census unavailable");
      }).attestation().pid,
    ).toBeNull();

    writeFileSync(dispatcherProvenancePath(dir), "{broken", "utf-8");
    expect(attestingTransport(dir, () => [censusMatch]).attestation().pid).toBeNull();
    expect(attestingTransport(dir, () => [censusMatch]).hostPid()).toBeNull();
  });

  it("ignores a provenance record written on another platform", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir);
    // Rewrite the record as if it came from the other OS: the pid it
    // names cannot exist in this machine's census semantics.
    const path = dispatcherProvenancePath(dir);
    const doc = JSON.parse(readFileSync(path, "utf-8")) as {
      host: { platform: string };
    };
    doc.host.platform = process.platform === "win32" ? "darwin" : "win32";
    writeFileSync(path, `${JSON.stringify(doc)}\n`, "utf-8");

    expect(attestingTransport(dir, () => [censusMatch]).attestation().pid).toBeNull();
  });

  it("loads the channel token lazily, like status() does", async () => {
    const dir = join(root, "channel");
    const token = await preparedChannel(dir);
    writeHeartbeat(dir, token);
    recordProvenance(dir);

    // A fresh transport that never ran prepare() still attests: the
    // token comes from channel.json, exactly as status() reads it.
    const transport = attestingTransport(dir, () => [censusMatch]);
    expect(transport.attestation().pid).toBe(42);
  });
});

/* ------------------------------------------------------- e2e activation */

/**
 * A script-invocation transport whose "AfterFX.exe" is the in-repo fake
 * AE: `launch()` takes the real adopt path (owned pid 42), `invoke()`
 * runs the staged entry script against the fake host exactly like
 * `FakeAfterEffectsTransport`, and `deliverActivationScript()` runs the
 * delivered activation file so the real dispatcher code writes the real
 * heartbeat — including this call's nonce — into the channel.
 */
class ScriptedAeTransport extends ScriptInvocationTransport {
  readonly app = new FakeApplication();
  readonly #engineGlobal: Record<string, unknown> = {};

  constructor() {
    super({
      platform: "win32",
      install: {
        executable: WINDOWS_EXECUTABLE,
        versionName: "Adobe After Effects 2026",
        renderExecutable: null,
      },
      now: () => T0,
      processes: () => [censusMatch],
      selfPid: 500,
      adopt: { ...ownedHost },
    });
    this.app.version = "26.0.0";
  }

  override async launch(): Promise<void> {
    await super.launch();
    if (this.app.project.numItems === 0) {
      this.app.project.load(createDefaultComp(), null);
    }
  }

  override awaitScriptable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  override invoke(entryScriptPath: string): Promise<void> {
    const outcome = runHostScript(entryScriptPath, createFakeGlobals(this.app), {
      environment: this.app.environment,
      engineGlobal: this.#engineGlobal,
    });
    if (!outcome.success) {
      return Promise.reject(new Error(`fake host threw: ${outcome.error.message}`));
    }
    return Promise.resolve();
  }

  override deliverActivationScript(scriptPath: string): Promise<string> {
    // Same contract as the real delivery: a private copy AE reads once,
    // beside the staged file in the same directory.
    const copy = join(
      dirname(scriptPath),
      `.a8n-deliver-${randomBytes(8).toString("hex")}.jsx`,
    );
    copyFileSync(scriptPath, copy);
    const outcome = runHostScript(copy, createFakeGlobals(this.app), {
      environment: this.app.environment,
      engineGlobal: this.#engineGlobal,
    });
    if (!outcome.success) {
      rmSync(copy, { force: true });
      return Promise.reject(
        new Error(`activation script failed in the fake host: ${outcome.error.message}`),
      );
    }
    return Promise.resolve(copy);
  }

  override close(): Promise<void> {
    // The fake "process" never exits on its own; the driver's app.quit
    // already ran through invoke().
    return Promise.resolve();
  }
}

describe("AfterEffects.activateDispatcher records provenance (#294)", () => {
  it("writes provenance an attaching session can attest from", async () => {
    const channelDir = join(root, "channel");
    const transport = new ScriptedAeTransport();
    const ae = await AfterEffects.launch({ sessionRoot: join(root, "session"), transport });

    const activation = await ae.activateDispatcher({ channelDir });
    expect(activation.instance).toBeTruthy();

    // The record names the owned process the nonce proved, bound to the
    // heartbeat identity the delivery observed.
    const provenance = readDispatcherProvenance(channelDir);
    expect(provenance).not.toBeNull();
    expect(provenance?.host.pid).toBe(42);
    expect(provenance?.host.startedAt).toBe(T0 + 1_000);
    expect(provenance?.host.identity).toBe(IDENTITY);
    expect(provenance?.instance).toBe(activation.instance);
    expect(provenance?.session).toBeNull(); // win32 seam: no login-session identity

    const nonce = new DispatcherTransport({ channelDir }).status().heartbeat?.activationNonce;
    expect(provenance?.activationNonce).toBe(nonce);
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);

    // A later attach session attests the pid while census and heartbeat agree.
    const attaching = attestingTransport(channelDir, () => [censusMatch]);
    expect(attaching.attestation().pid).toBe(42);
    expect(attaching.hostPid()).toBe(42);

    // …and attests nothing once the pid names a different process.
    const reused: HostProcess = { ...censusMatch, startedAt: T0 + 90_000 };
    expect(attestingTransport(channelDir, () => [reused]).attestation().pid).toBeNull();

    await ae.close();
  });
});
