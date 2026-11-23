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

import {
  ScriptInvocationTransport,
  parseWindowsProcessList,
  windowsProcesses,
  windowsSameInstall,
  type HostProcess,
  type SpawnLauncher,
} from "../src/driver/script-invocation.js";

const EXE = "C:\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
const install = { executable: EXE, versionName: "x", renderExecutable: null };
const T0 = Date.parse("2026-10-16T10:00:00Z");

/** `identity` is Windows' full creation time (100 ns); by default it follows `startedAt`. */
/** This test process, as the parent of the launchers it spawns. */
const SELF = 4242;
const ae = (
  pid: number,
  startedAt = T0 + 1_000,
  executable = EXE,
  identity = `t${startedAt}`,
  parentPid = 1,
): HostProcess => ({ pid, startedAt, executable, identity, parentPid });

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

/** Hands out `pids` in turn to successive launches (the first is the AE itself, later ones are `-r` launchers). */
function launcherSequence(pids: number[]): SpawnLauncher {
  let i = 0;
  return () => {
    const child = new EventEmitter() as EventEmitter & { unref(): void; pid?: number };
    child.unref = () => undefined;
    const pid = pids[Math.min(i++, pids.length - 1)];
    if (pid !== undefined) child.pid = pid;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

/** Sees `lists[0]` at launch, `lists[1]` at confirmation, and so on; the last repeats. */
function transportSeeing(
  spawnedPid: number | undefined,
  ...lists: HostProcess[][]
): ScriptInvocationTransport {
  return transportSeeingInstall(install, spawnedPid, ...lists);
}

/** `transportSeeing` against a caller-named install. */
function transportSeeingInstall(
  install: { executable: string; versionName: string; renderExecutable: string | null },
  spawnedPid: number | undefined,
  ...lists: HostProcess[][]
): ScriptInvocationTransport {
  let i = 0;
  return new ScriptInvocationTransport({
    platform: "win32",
    install,
    now: () => T0,
    spawnLauncher: launcherWith(spawnedPid),
    processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
    exitTimeoutMs: 300,
    selfPid: SELF,
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

  it("is owned even while a different install's AE runs: -r is never handed to it (#323)", async () => {
    // AE 2025 running beside the AE 2026 this session starts is a different
    // product, not a sibling instance: the foreign process is out of scope,
    // so the spawned host is provably ours and close() may quit it — while
    // the foreign AE is never named as this install's host.
    const other = ae(7, T0 - 60_000, "C:\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe");
    const t = await started(transportSeeing(42, [other], [other, ae(42)], [other, ae(42)]));
    expect(t.ownership().kind).toBe("owned");
    expect(t.recoveryTargetPid()).toBe(42);
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

describe("a second AfterFX.exe of another version is out of scope (#323)", () => {
  // The real-host shape: AE 2026 pinned by installDir on D:, AE 2027 already
  // running from Program Files. Only the image path tells them apart.
  const EXE_2026 = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
  const EXE_2027 = "C:\\Program Files\\Adobe\\Adobe After Effects 2027\\Support Files\\AfterFX.exe";
  const install2026 = { executable: EXE_2026, versionName: "Adobe After Effects 2026", renderExecutable: null };
  const ae2027 = (pid: number): HostProcess =>
    ae(pid, T0 - 3_600_000, EXE_2027, `t${T0 - 3_600_000}`, 1);

  it("owns the spawned AE 2026 and reports it as the recovery target while AE 2027 runs", async () => {
    const foreign = ae2027(46800);
    const ours = ae(42, T0 + 1_000, EXE_2026);
    const t = await started(
      transportSeeingInstall(install2026, 42, [foreign], [foreign, ours], [foreign, ours]),
    );
    expect(t.ownership().kind).toBe("owned");
    // The supervision gate: the pid must be provable on every re-read, not
    // just once — a foreign AfterFX.exe in the census must not count.
    expect(t.recoveryTargetPid()).toBe(42);
    expect(t.ownership().evidence).not.toContain("46800");
  });

  it("stays attached to a same-install AE that was already running, foreign version aside", async () => {
    const foreign = ae2027(46800);
    const running = ae(7, T0 - 60_000, EXE_2026);
    const t = await started(
      transportSeeingInstall(install2026, 99, [foreign, running], [foreign, running], [foreign, running]),
    );
    expect(t.ownership().kind).toBe("attached");
    // Attached is never a recovery target: the pid is not this session's.
    expect(t.recoveryTargetPid()).toBeNull();
  });

  it("is still ambiguous when a second instance of the SAME install runs", async () => {
    const foreign = ae2027(46800);
    const sibling = ae(43, T0 + 2_000, EXE_2026);
    const t = await started(
      transportSeeingInstall(install2026, 42, [foreign], [foreign, ae(42, T0 + 1_000, EXE_2026), sibling], [foreign, ae(42, T0 + 1_000, EXE_2026), sibling]),
    );
    expect(t.ownership().kind).toBe("unknown");
    expect(t.recoveryTargetPid()).toBeNull();
  });

  it("still counts an AfterFX.exe whose image path Windows would not reveal", async () => {
    // "" cannot be proven foreign — it may be this install's elevated AE —
    // so it keeps the census ambiguous rather than being guessed away.
    const foreign = ae2027(46800);
    const unreadable = ae(77, T0 + 5_000, "", "unreadable", 1);
    const ours = ae(42, T0 + 1_000, EXE_2026);
    const t = await started(
      transportSeeingInstall(install2026, 42, [foreign], [foreign, ours, unreadable], [foreign, ours, unreadable]),
    );
    expect(t.ownership().kind).toBe("unknown");
    expect(t.recoveryTargetPid()).toBeNull();
  });

  it("does not let another version's -r launcher count as a sibling", async () => {
    // A foreign -r shows as a second AfterFX.exe under the foreign install;
    // out of scope before the launcher-pid exclusion is even consulted.
    const foreign = ae2027(46800);
    const foreignLauncher = ae(46801, T0 + 5_000, EXE_2027, "foreign-launcher", SELF);
    const ours = ae(42, T0 + 1_000, EXE_2026);
    const t = await started(
      transportSeeingInstall(install2026, 42, [foreign], [foreign, ours], [foreign, foreignLauncher, ours]),
    );
    expect(t.ownership().kind).toBe("owned");
    expect(t.recoveryTargetPid()).toBe(42);
  });
});

describe("windowsSameInstall", () => {
  const installExe = "D:\\4_apps\\adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";

  it("accepts an image under the install directory, case and slash tolerant", () => {
    expect(
      windowsSameInstall("d:/4_apps/adobe/adobe after effects 2026/support files/afterfx.exe", installExe),
    ).toBe(true);
  });

  it("rejects another version's AfterFX.exe", () => {
    expect(
      windowsSameInstall("C:\\Program Files\\Adobe\\Adobe After Effects 2027\\Support Files\\AfterFX.exe", installExe),
    ).toBe(false);
    // A prefix sibling is not the install: the directory boundary matters.
    expect(
      windowsSameInstall("D:\\4_apps\\adobe\\Adobe After Effects 2026 Beta\\Support Files\\AfterFX.exe", installExe),
    ).toBe(false);
  });

  it("answers null — undecidable, fail closed — for an unreadable image or unplaceable install", () => {
    expect(windowsSameInstall("", installExe)).toBeNull();
    expect(windowsSameInstall("   ", installExe)).toBeNull();
    expect(windowsSameInstall("D:\\x\\AfterFX.exe", "D:\\x\\AfterFX.exe")).toBeNull();
  });
});

describe("a -r launcher is not a second AfterFX.exe", () => {
  /** Owned AE 42, then a `-r` (pid 77) is spawned; the list then shows the AE plus whatever `later` says. */
  async function afterARun(...later: HostProcess[][]): Promise<ScriptInvocationTransport> {
    let i = 0;
    const lists: HostProcess[][] = [[], [ae(42)], ...later];
    const t = new ScriptInvocationTransport({
      platform: "win32",
      install,
      now: () => T0,
      spawnLauncher: launcherSequence([42, 77]),
      processes: () => lists[Math.min(i++, lists.length - 1)] as HostProcess[],
      selfPid: SELF,
    });
    await t.launch();
    t.confirmLaunched();
    await t.invoke("C:\\x\\entry.jsx"); // spawns the `-r` launcher, pid 77
    return t;
  }

  it("is left out when it is a launcher this process spawned, so close() can still quit", async () => {
    const launcher = ae(77, T0 + 5_000, EXE, "launcher", SELF);
    const t = await afterARun([ae(42), launcher]);
    expect(t.ownership().kind).toBe("owned");
  });

  it("is counted when the same pid belongs to something this process did not spawn", async () => {
    const stranger = ae(77, T0 + 5_000, EXE, "stranger", 999);
    const t = await afterARun([ae(42), stranger]);
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is counted when its parent is this process but this process never spawned that pid", async () => {
    const unknownChild = ae(88, T0 + 5_000, EXE, "child", SELF);
    const t = await afterARun([ae(42), unknownChild]);
    expect(t.ownership().kind).toBe("unknown");
  });

  it("never hides the AE this transport itself started", async () => {
    // Its parent is also this process; it must still be what is judged.
    const self = ae(42, T0 + 1_000, EXE, "t" + (T0 + 1_000), SELF);
    const t = await started(transportSeeing(42, [], [self], [self]));
    expect(t.ownership().kind).toBe("owned");
    const t2 = await started(transportSeeing(42, [], [self], []));
    expect(t2.ownership().kind).toBe("unknown");
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

  it("treats a pid that now belongs to a different process as the original having exited", async () => {
    const reused = ae(42, T0 + 1_000, EXE, "reused-process");
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42)], [reused]));
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("does not take an unreadable process list for 'it exited'", async () => {
    let calls = 0;
    const t = new ScriptInvocationTransport({
      platform: "win32",
      install,
      now: () => T0,
      spawnLauncher: launcherWith(42),
      exitTimeoutMs: 300,
      processes: () => {
        calls += 1;
        if (calls <= 2) return calls === 1 ? [] : [ae(42)];
        throw new Error("powershell failed");
      },
    });
    await started(t);
    await expect(t.close()).rejects.toThrow(/powershell failed/);
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

describe("Windows ownership fails closed", () => {
  it("is unknown when the launcher reported no pid, even for a single AfterFX.exe", async () => {
    const t = await started(transportSeeing(undefined, [], [ae(42)], [ae(42)]));
    expect(t.ownership().kind).toBe("unknown");
    expect(t.ownership().evidence).toMatch(/no pid/);
  });

  it("does not accept a creation time that is merely close (pid reused within a second)", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42, T0 + 1_000 + 500)]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("does not accept a creation time that differs only below a millisecond (pid reused)", async () => {
    // Same pid, the same millisecond, 100 ns apart: only the full identifier tells them apart.
    const first = ae(42, T0 + 1_000, EXE, "2026-10-16T10:00:01.0000000Z");
    const reused = ae(42, T0 + 1_000, EXE, "2026-10-16T10:00:01.0000001Z");
    const t = await started(transportSeeing(42, [], [first], [reused]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("is unknown when the process list gives no full creation identifier", async () => {
    const bare = { pid: 42, startedAt: T0 + 1_000, executable: EXE } as HostProcess;
    const t = await started(transportSeeing(42, [], [bare], [bare]));
    expect(t.ownership().kind).toBe("unknown");
  });

  it("accepts the same creation time", async () => {
    const t = await started(transportSeeing(42, [], [ae(42)], [ae(42, T0 + 1_000)]));
    expect(t.ownership().kind).toBe("owned");
  });
});

describe("the Windows process list", () => {
  const doc = (processes: unknown[], v: unknown = 1) => JSON.stringify({ v, processes });
  const one = { pid: 42, started: "2026-10-16T10:00:01.0000000Z", path: EXE, ppid: 1 };

  it("reads an empty list as 'none running', which is an answer", () => {
    expect(parseWindowsProcessList(doc([]))).toEqual([]);
  });

  it("reads a good entry, and tolerates a byte order mark", () => {
    expect(parseWindowsProcessList("\uFEFF" + doc([one]))).toEqual([
      {
        pid: 42,
        startedAt: Date.parse("2026-10-16T10:00:01Z"),
        executable: EXE,
        identity: "2026-10-16T10:00:01.0000000Z",
        parentPid: 1,
      },
    ]);
  });

  it("keeps an unreadable path as an empty string, not a guess", () => {
    expect(parseWindowsProcessList(doc([{ ...one, path: "" }]))[0]?.executable).toBe("");
  });

  it.each([
    ["not JSON", "42|2026-10-16T10:00:01Z|C:\\x"],
    ["empty output", ""],
    ["wrong version", doc([one], 2)],
    ["no processes member", JSON.stringify({ v: 1 })],
    ["a non-object entry", doc(["42"])],
    ["a string pid", doc([{ ...one, pid: "42" }])],
    ["a zero pid", doc([{ ...one, pid: 0 }])],
    ["a fractional pid", doc([{ ...one, pid: 4.5 }])],
    ["a missing creation time", doc([{ pid: 42, path: EXE }])],
    ["an invalid creation time", doc([{ ...one, started: "yesterday" }])],
    ["a creation time with less than 100 ns precision", doc([{ ...one, started: "2026-10-16T10:00:01Z" }])],
    ["a missing path field", doc([{ pid: 42, started: one.started }])],
    ["a missing parent pid", doc([{ pid: 42, started: one.started, path: EXE }])],
    ["a negative parent pid", doc([{ ...one, ppid: -1 }])],
    ["a repeated pid", doc([one, { ...one, path: "" }])],
    ["a good entry beside a bad one", doc([one, { pid: "x", started: one.started, path: EXE }])],
  ])("throws on %s", (_label, text) => {
    expect(() => parseWindowsProcessList(text)).toThrow();
  });

  // The call gives PowerShell 30 s (a cold CIM/WMI start on a loaded CI runner
  // takes several); the test's 5 s default is shorter than the code's own
  // budget, so a slow runner failed the test while the call was still working.
  it.runIf(process.platform === "win32")("is readable from this machine's real PowerShell", () => {
    const list = windowsProcesses();
    expect(Array.isArray(list)).toBe(true);
    for (const p of list) {
      expect(Number.isInteger(p.pid)).toBe(true);
      expect(Number.isNaN(p.startedAt)).toBe(false);
    }
  }, 35_000);
});
