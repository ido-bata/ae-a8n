/**
 * Who owns the After Effects process on Windows (#39).
 *
 * `owned` is the only state in which `close()` quits AE, so it is granted only
 * on proof: nothing was running before launch, exactly one AfterFX.exe exists
 * after, it is the install's executable, it started after launch began, and it is
 * the very process this transport spawned. Everything else is `attached` or
 * `unknown`, and neither is ever quit. These run against a fake process list;
 * the real-host runs are in docs/windows-verification.md.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { ScriptInvocationTransport, type HostProcess, type SpawnLauncher } from "../src/driver/script-invocation.js";

const EXE = "C:\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
const install = { executable: EXE, versionName: "x", renderExecutable: null };
const T0 = Date.parse("2026-10-16T10:00:00Z");

const ae = (pid: number, startedAt = T0 + 1_000, executable = EXE): HostProcess => ({ pid, startedAt, executable });

/** A launcher whose child has `pid` (or none). */
function launcherWith(pid: number | undefined): SpawnLauncher {
  return () => {
    const child = new EventEmitter() as EventEmitter & { unref(): void; pid?: number };
    child.unref = () => undefined;
    if (pid !== undefined) child.pid = pid;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

/** Sees `lists[0]` at launch, `lists[1]` at confirmation, and so on; the last repeats. */
function transportSeeing(spawnedPid: number | undefined, ...lists: HostProcess[][]): ScriptInvocationTransport {
  let i = 0;
  return new ScriptInvocationTransport({
    platform: "win32",
    install,
    now: () => T0,
    spawnLauncher: launcherWith(spawnedPid),
    processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
    exitTimeoutMs: 300,
  });
}

async function started(t: ScriptInvocationTransport): Promise<ScriptInvocationTransport> {
  await t.launch();
  t.confirmLaunched();
  return t;
}

describe("Windows ownership", () => {
  it("owns the AE it started: none before, one after, the one it spawned", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42)]));
    expect(t.ownership()).toMatchObject({ kind: "owned" });
  });

  it("compares the executable without regard to case or slash direction", async () => {
    const shouting = ae(42, T0 + 1_000, EXE.toUpperCase().replace(/\\/g, "/"));
    const t = await started(transportSeeing(42, [], [shouting], [shouting]));
    expect(t.ownership().kind).toBe("owned");
  });

  it("is attached to an AE that was already running, and stays so", async () => {
    const running = ae(7, T0 - 60_000);
    const t = await started(transportSeeing(99, [running], [running], [running]));
    expect(t.ownership()).toMatchObject({ kind: "attached" });
  });

  it("is attached even if the pre-existing AE is a different install's", async () => {
    // Another instance may be what `-r` is handed to; never claim the machine.
    const other = ae(7, T0 - 60_000, "C:\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe");
    const t = await started(transportSeeing(42, [other], [other, ae(42)], [other, ae(42)]));
    expect(t.ownership().kind).toBe("attached");
  });

  it("is unknown when two AEs appear at start", async () => {
    const t = await started(transportSeeing(42, [], [ae(42), ae(43)], [ae(42), ae(43)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the only AE is not the process this transport spawned", async () => {
    // Someone else's AE won the race; ours handed over and exited.
    const t = await started(transportSeeing(42, [], [ae(43)], [ae(43)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the AE started before launch began", async () => {
    const t = await started(transportSeeing(42, [], [ae(42, T0 - 30_000)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the AE is not this install's executable", async () => {
    const elsewhere = ae(42, T0 + 1_000, "D:\\Other\\AfterFX.exe");
    const t = await started(transportSeeing(42, [], [elsewhere], [elsewhere]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the executable path cannot be read", async () => {
    const unreadable = ae(42, T0 + 1_000, "");
    const t = await started(transportSeeing(42, [], [unreadable], [unreadable]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when AE died between the probe and the check", async () => {
    const t = await started(transportSeeing(42, [], []));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the process list cannot be read", async () => {
    let calls = 0;
    const t = new ScriptInvocationTransport({
      platform: "win32",
      install,
      now: () => T0,
      spawnLauncher: launcherWith(42),
      processes: () => {
        if (calls++ > 0) throw new Error("powershell failed");
        return [];
      },
    });
    await t.launch();
    t.confirmLaunched();
    expect(t.ownership().kind).toBe("unknown");
  });

  it("stops owning when the pid now belongs to a different start (pid reuse)", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42, T0 + 90_000)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("stops owning once a second instance appears", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42), ae(50)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("stops owning when the process it started is gone", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], []));
    expect(t.ownership().kind).toBe("unknown");
  });
});

describe("Windows close", () => {
  it("waits for the AE it owns to exit", async () => {
    // launch, confirm, ownership() inside close's own checks aside: then gone.
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42)], [ae(42)], []));
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("says so, and kills nothing, if the AE it owns does not exit", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42)]));
    await expect(t.close()).rejects.toThrow(/did not exit within 300 ms/);
  });

  it("does not wait for, or consult, an AE it does not own", async () => {
    let consulted = false;
    const t = new ScriptInvocationTransport({
      platform: "win32",
      install,
      now: () => T0,
      spawnLauncher: launcherWith(99),
      processes: () => {
        consulted = true;
        return [ae(7, T0 - 60_000)];
      },
    });
    await started(t);
    consulted = false;
    await t.close();
    expect(t.ownership().kind).toBe("attached");
    expect(consulted).toBe(false);
  });
});
