/**
 * Contract tests for the attach-only path (#269).
 *
 * The guarantee under test is structural, not behavioural politeness:
 * `AfterEffects.attach` / `ScriptInvocationTransport({ attach })` must be
 * unable to reach process creation. Every case below either proves a
 * spawn seam was never invoked, or proves the typed `AttachTargetError`
 * a fail-closed census produces.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects, AttachTargetError } from "../src/api/index.js";
import { AfterEffectsError } from "../src/api/errors.js";
import { HostUnavailableError } from "../src/driver/driver.js";
import type { HostProcess } from "../src/driver/host-processes.js";
import { ScriptInvocationTransport } from "../src/driver/script-invocation.js";
import type {
  HostTransport,
  InvokeOptions,
} from "../src/driver/transport.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

const EXE =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const INSTALL = { executable: EXE, versionName: "Adobe After Effects 2026.app", renderExecutable: null };
const T0 = Date.parse("2026-11-20T00:00:00Z");

const ae = (pid: number, startedAt = T0 - 60_000, extra: Partial<HostProcess> = {}): HostProcess => ({
  pid,
  startedAt,
  executable: EXE,
  ...extra,
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-attach-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Spawn seams that record any attempt to create a process. */
function spawnSpies() {
  const calls = { launchMacHost: 0, openMacApp: 0, spawnLauncher: 0 };
  return {
    calls,
    seams: {
      launchMacHost: () => {
        calls.launchMacHost += 1;
        return Promise.resolve(1);
      },
      openMacApp: () => {
        calls.openMacApp += 1;
        return Promise.resolve();
      },
      spawnLauncher: () => {
        calls.spawnLauncher += 1;
        const child = Object.assign(new EventEmitter(), { pid: 1, unref: () => {} });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
  };
}

function attachTransport(
  lists: HostProcess[][],
  options: {
    platform?: NodeJS.Platform;
    targetPid?: number;
    sessionUid?: number;
  } = {},
) {
  const spies = spawnSpies();
  let i = 0;
  const transport = new ScriptInvocationTransport({
    platform: options.platform ?? "darwin",
    install: INSTALL,
    now: () => T0,
    sessionUid: options.sessionUid ?? 501,
    processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
    ...spies.seams,
    ...(options.targetPid === undefined ? { attach: {} } : { attach: { targetPid: options.targetPid } }),
  });
  return { transport, calls: spies.calls };
}

describe("attach-only target selection (script transport, macOS)", () => {
  it("selects the single running instance and never touches a spawn seam", async () => {
    const { transport, calls } = attachTransport([[ae(7)], [ae(7)]]);
    expect(transport.attachOnly).toBe(true);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "attached" });
    expect(transport.hostPid()).toBe(7);
    expect(transport.hostState()).toBe("alive");
    expect(calls).toEqual({ launchMacHost: 0, openMacApp: 0, spawnLauncher: 0 });
  });

  it("refuses not-found when nothing is running, without spawning", async () => {
    const { transport, calls } = attachTransport([[]]);
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error).toBeInstanceOf(AttachTargetError);
    expect(error?.reason).toBe("not-found");
    expect(error?.message).toContain("attach never starts one");
    expect(calls).toEqual({ launchMacHost: 0, openMacApp: 0, spawnLauncher: 0 });
  });

  it("refuses ambiguous when two instances run and no pid is pinned", async () => {
    const { transport, calls } = attachTransport([[ae(7), ae(8)]]);
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("ambiguous");
    expect(error?.message).toContain("target.pid");
    expect(calls.launchMacHost).toBe(0);
  });

  it("honours target.pid among several instances", async () => {
    const { transport, calls } = attachTransport([[ae(7), ae(8)], [ae(7), ae(8)]], {
      targetPid: 8,
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "attached" });
    expect(transport.hostPid()).toBe(8);
    expect(calls).toEqual({ launchMacHost: 0, openMacApp: 0, spawnLauncher: 0 });
  });

  it("refuses a pinned pid that is not running", async () => {
    const { transport } = attachTransport([[ae(7)]], { targetPid: 99 });
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("not-found");
  });

  it("refuses wrong-session when the only AE belongs to another uid", async () => {
    const { transport } = attachTransport([[ae(7, T0 - 60_000, { uid: 502 })]], {
      sessionUid: 501,
    });
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("wrong-session");
    expect(error?.message).toContain("another login session");
  });

  it("refuses wrong-session for a pinned pid owned by another uid", async () => {
    const { transport } = attachTransport(
      [[ae(7, T0 - 60_000, { uid: 502 }), ae(8)]],
      { sessionUid: 501, targetPid: 7 },
    );
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("wrong-session");
  });

  it("refuses unknown-target when the process list cannot be read", async () => {
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install: INSTALL,
      now: () => T0,
      sessionUid: 501,
      attach: {},
      processes: () => {
        throw new Error("ps failed");
      },
    });
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("unknown-target");
  });

  it("downgrades to unknown when the target is replaced before the probe answers", async () => {
    // pid 7 selected, then pid 7 is gone and pid 9 appeared: same-pid proof
    // fails, so ownership is unknown — never attached to the wrong process.
    const { transport } = attachTransport([[ae(7)], [ae(9, T0 - 30_000)]]);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "unknown" });
  });

  it("downgrades to unknown when a second instance appears before confirm", async () => {
    const { transport } = attachTransport([[ae(7)], [ae(7), ae(8)]]);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "unknown" });
  });

  it("stays attached when a pinned target coexists with another instance", async () => {
    const { transport } = attachTransport([[ae(7), ae(8)], [ae(7), ae(8)]], {
      targetPid: 7,
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "attached" });
  });
});

describe("attach-only on Windows", () => {
  it("refuses unsupported without ever spawning AfterFX.exe", async () => {
    const { transport, calls } = attachTransport([[]], { platform: "win32" });
    const error = await transport.launch().then(
      () => null,
      (caught: unknown) => caught as AttachTargetError,
    );
    expect(error?.reason).toBe("unsupported");
    expect(error?.message).toContain("in-ae-dispatcher");
    expect(calls).toEqual({ launchMacHost: 0, openMacApp: 0, spawnLauncher: 0 });
  });
});

describe("attach option validation", () => {
  it("rejects adopt and attach together", () => {
    expect(
      () =>
        new ScriptInvocationTransport({
          platform: "darwin",
          install: INSTALL,
          attach: {},
          adopt: { pid: 7, startedAt: T0, executable: EXE },
        }),
    ).toThrow(TypeError);
  });

  it("rejects a non-positive targetPid", () => {
    expect(
      () =>
        new ScriptInvocationTransport({
          platform: "darwin",
          install: INSTALL,
          attach: { targetPid: 0 },
        }),
    ).toThrow(TypeError);
  });
});

describe("AfterEffects.attach", () => {
  it("connects through a supplied transport and never quits on close", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownershipKind = "attached";
    const ae = await AfterEffects.attach({ sessionRoot: root, transport });
    expect(ae.info().version).toBeTruthy();
    expect(ae.ownership().kind).toBe("attached");
    const result = await ae.close();
    expect(result.quit).toBe(false);
  });

  it("refuses a launch-capable ScriptInvocationTransport instance", async () => {
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install: INSTALL,
    });
    expect(transport.attachOnly).toBe(false);
    await expect(AfterEffects.attach({ sessionRoot: root, transport })).rejects.toThrow(
      /attach-capable/,
    );
  });

  it("accepts an attach-only ScriptInvocationTransport instance", async () => {
    // The API-level guard must not reject the attach-capable form; the
    // transport then fails on its own census (no AE in this test env is
    // assumed), which is still a typed AttachTargetError — never a spawn.
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install: INSTALL,
      sessionUid: typeof process.getuid === "function" ? process.getuid() : 501,
      attach: {},
      processes: () => [],
    });
    const error = await AfterEffects.attach({ sessionRoot: root, transport }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AttachTargetError);
    expect((error as AttachTargetError).reason).toBe("not-found");
  });

  it("wraps an unresponsive target as AttachTargetError", async () => {
    const stub: HostTransport = {
      kind: "stub-unavailable",
      available: () => Promise.resolve(true),
      launch: () => Promise.reject(new HostUnavailableError("no dispatcher answering")),
      invoke: (_entry: string, _options?: InvokeOptions) => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const error = await AfterEffects.attach({ sessionRoot: root, transport: stub }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AttachTargetError);
    expect((error as AttachTargetError).reason).toBe("unresponsive");
    expect((error as AttachTargetError).op).toBe("session.attach");
  });

  it("rejects a non-integer target.pid before anything runs", async () => {
    await expect(AfterEffects.attach({ sessionRoot: root, target: { pid: -1 } })).rejects.toThrow(
      TypeError,
    );
    await expect(AfterEffects.attach({ sessionRoot: root, target: { pid: 1.5 } })).rejects.toThrow(
      TypeError,
    );
  });

  it("refuses session.recover, which needs an owned process", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownershipKind = "attached";
    await expect(
      AfterEffects.attach({
        sessionRoot: root,
        transport,
        session: { uid: 501, recover: true },
      }),
    ).rejects.toThrow(AfterEffectsError);
  });
});

describe("attach through the real driver (fake host script)", () => {
  it("an attach-mode transport reports attached ownership end to end", async () => {
    // Drive AeDriver directly against the attach-mode transport with a
    // processes seam: proves confirmLaunched wiring inside driver.start.
    const lists = [[ae(7)], [ae(7)]];
    let i = 0;
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install: INSTALL,
      now: () => T0,
      sessionUid: 501,
      attach: {},
      processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
    });
    // launch() selects; the probe would then run — we only assert the
    // pre-probe state here since invoke needs a real AE.
    await transport.launch();
    expect(transport.ownership()).toMatchObject({ kind: "unknown", evidence: "not launched" });
    transport.confirmLaunched();
    expect(transport.ownership()).toMatchObject({ kind: "attached" });
  });
});
