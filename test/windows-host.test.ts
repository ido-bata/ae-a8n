/**
 * The parts of the real transport that a Windows machine disagreed with.
 *
 * Found on Windows 11 with After Effects 26.5 installed under `D:\...`:
 *
 *   - `C:\Program Files\Adobe\Adobe After Effects 2026` was a 17-file leftover
 *     with no `AfterFX.exe`; discovery looked only at the newest directory and
 *     reported "not installed" while a complete install existed elsewhere;
 *   - the installer records where it installed, but nothing consulted it;
 *   - `launch()` awaited the exit of `AfterFX.exe`, which *is* After Effects,
 *     so a cold start could not reach the readiness probe.
 *
 * These run on every platform: the launcher is a seam and no process is
 * started. Nothing here says anything about a real After Effects; see
 * docs/verification.md for what has been observed on one.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import { resolveInstall } from "../src/driver/install-path.js";
import {
  ScriptInvocationTransport,
  type LauncherChild,
  type SpawnLauncher,
} from "../src/driver/script-invocation.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-win-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Lays out `<adobeRoot>/Adobe After Effects <year>/Support Files`. */
function windowsInstall(adobeRoot: string, year: string, options: { executable?: boolean } = {}): string {
  const dir = join(adobeRoot, `Adobe After Effects ${year}`);
  const supportFiles = join(dir, "Support Files");
  mkdirSync(supportFiles, { recursive: true });
  writeFileSync(join(supportFiles, "boost_regex.dll"), "");
  if (options.executable !== false) {
    writeFileSync(join(supportFiles, "AfterFX.exe"), "");
    writeFileSync(join(supportFiles, "aerender.exe"), "");
  }
  return dir;
}

describe("Windows install discovery", () => {
  it("skips a newer leftover directory with no executable and uses the older complete install", () => {
    windowsInstall(root, "2026", { executable: false });
    const complete = windowsInstall(root, "2025");
    expect(resolveInstall("win32", { root, registryLocations: () => [] })).toEqual({
      executable: join(complete, "Support Files", "AfterFX.exe"),
      versionName: "Adobe After Effects 2025",
      renderExecutable: join(complete, "Support Files", "aerender.exe"),
    });
  });

  it("takes the newest complete install when several exist", () => {
    windowsInstall(root, "2024");
    const newest = windowsInstall(root, "2026");
    windowsInstall(root, "2025");
    expect(resolveInstall("win32", { root, registryLocations: () => [] }).executable).toBe(
      join(newest, "Support Files", "AfterFX.exe"),
    );
  });

  it("reports nothing installed when no directory holds an executable", () => {
    windowsInstall(root, "2026", { executable: false });
    expect(() => resolveInstall("win32", { root, registryLocations: () => [] })).toThrow(
      /no After Effects installation found/,
    );
  });

  it("accepts an explicit installDir outside any Adobe root, with spaces and Japanese in the path", () => {
    const dir = windowsInstall(join(root, "アプリ ケーション", "my adobe"), "2026");
    const found = resolveInstall("win32", { installDir: dir, registryLocations: () => ["must-not-be-read"] });
    expect(found.executable).toBe(join(dir, "Support Files", "AfterFX.exe"));
    expect(found.versionName).toBe("Adobe After Effects 2026");
  });

  it("rejects an installDir whose executable is missing", () => {
    const dir = windowsInstall(root, "2026", { executable: false });
    expect(() => resolveInstall("win32", { installDir: dir })).toThrow(/no After Effects installation found/);
  });

  describe("when the default root holds nothing usable", () => {
    it("uses the location the installer recorded", () => {
      const defaultRoot = join(root, "Program Files", "Adobe");
      windowsInstall(defaultRoot, "2026", { executable: false });
      const recorded = join(root, "D drive", "apps");
      const real = windowsInstall(recorded, "2026");
      expect(resolveInstall("win32", { root: defaultRoot, registryLocations: () => [recorded] }).executable).toBe(
        join(real, "Support Files", "AfterFX.exe"),
      );
    });

    it("accepts a recorded location that is the install itself", () => {
      const real = windowsInstall(join(root, "elsewhere"), "2026");
      expect(
        resolveInstall("win32", { root: join(root, "none"), registryLocations: () => [real] }).executable,
      ).toBe(join(real, "Support Files", "AfterFX.exe"));
    });

    it("prefers versioned installs under a recorded root over a stray Support Files at that root", () => {
      // Seen on a real machine: `<adobe root>\Support Files\AfterFX.exe` was a
      // 25.6.4 leftover next to `Adobe After Effects 2026` (26.5).
      const adobeRoot = join(root, "apps", "adobe");
      const real = windowsInstall(adobeRoot, "2026");
      mkdirSync(join(adobeRoot, "Support Files"), { recursive: true });
      writeFileSync(join(adobeRoot, "Support Files", "AfterFX.exe"), "");
      expect(
        resolveInstall("win32", { root: join(root, "none"), registryLocations: () => [adobeRoot] }).executable,
      ).toBe(join(real, "Support Files", "AfterFX.exe"));
    });

    it("picks the newest across several recorded locations and ignores duplicates and dead entries", () => {
      const a = join(root, "a");
      const b = join(root, "b");
      windowsInstall(a, "2025");
      const newest = windowsInstall(b, "2026");
      expect(
        resolveInstall("win32", {
          root: join(root, "none"),
          registryLocations: () => [a, b, b + "\\", join(root, "gone")],
        }).executable,
      ).toBe(join(newest, "Support Files", "AfterFX.exe"));
    });

    it("is not consulted when the default root has a usable install", () => {
      const defaultRoot = join(root, "Program Files", "Adobe");
      const here = windowsInstall(defaultRoot, "2025");
      expect(
        resolveInstall("win32", {
          root: defaultRoot,
          registryLocations: () => {
            throw new Error("must not be consulted");
          },
        }).executable,
      ).toBe(join(here, "Support Files", "AfterFX.exe"));
    });

    it("still fails with the scanned root named when the registry has nothing either", () => {
      expect(() => resolveInstall("win32", { root: join(root, "none"), registryLocations: () => [] })).toThrow(
        /looked in: .*none/,
      );
    });
  });

  it("does not widen a root the caller named: no fallback to whatever the registry knows", () => {
    // No registryLocations seam here, so a fallback would reach the real
    // registry of whichever machine runs this; an AE installed there must not
    // satisfy a root that holds nothing.
    expect(() => resolveInstall("win32", { root: join(root, "named-but-empty") })).toThrow(
      /no After Effects installation found/,
    );
  });

  it("does not consult the registry on macOS", () => {
    expect(() =>
      resolveInstall("darwin", {
        root,
        registryLocations: () => {
          throw new Error("must not be consulted");
        },
      }),
    ).toThrow(/no After Effects installation found/);
  });
});

type FakeChild = EventEmitter & LauncherChild & { unref(): void; unrefCalled: boolean };

/** A launcher whose child behaves like AfterFX.exe: it appears, and does not exit. */
function launcher(behaviour: (child: FakeChild) => void = (child) => child.emit("spawn")): {
  spawnLauncher: SpawnLauncher;
  calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[];
  children: FakeChild[];
} {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const spawnLauncher: SpawnLauncher = (command, args, options) => {
    const child = new EventEmitter() as FakeChild;
    child.unrefCalled = false;
    child.unref = () => {
      child.unrefCalled = true;
    };
    calls.push({ command, args, options: { ...options } });
    children.push(child);
    queueMicrotask(() => behaviour(child));
    return child;
  };
  return { spawnLauncher, calls, children };
}

const EXE = "C:\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";

function winTransport(spawnLauncher: SpawnLauncher): ScriptInvocationTransport {
  return new ScriptInvocationTransport({
    platform: "win32",
    install: { executable: EXE, versionName: "x", renderExecutable: null },
    spawnLauncher,
    // AE's window is up; the real check asks Windows.
    mainWindowVisible: () => true,
  });
}

describe("Windows launch", () => {
  it("returns once the process exists, without waiting for it to exit", async () => {
    const { spawnLauncher, calls, children } = launcher();
    await winTransport(spawnLauncher).launch();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(EXE);
    expect(calls[0]?.args).toEqual([]);
    // Detached and unreferenced: AE outlives, and does not hold, this process.
    expect(calls[0]?.options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(children[0]?.unrefCalled).toBe(true);
  });

  it("does not hide the application window", async () => {
    const { spawnLauncher, calls } = launcher();
    await winTransport(spawnLauncher).launch();
    expect(calls[0]?.options.windowsHide).toBe(false);
  });

  it("launches once however many drivers share the transport", async () => {
    const { spawnLauncher, calls } = launcher();
    const transport = winTransport(spawnLauncher);
    await transport.launch();
    await transport.launch();
    expect(calls).toHaveLength(1);
  });

  it("fails, naming the executable, when the process cannot be started", async () => {
    const { spawnLauncher } = launcher((child) => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    const error = await winTransport(spawnLauncher).launch().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("cannot start");
    expect(error?.message).toContain("AfterFX.exe");
    expect(error?.message).toContain("ENOENT");
    expect((error?.cause as { code?: string }).code).toBe("ENOENT");
  });

  it("is not an error when the launcher exits right away: that is a hand-off to a running AE", async () => {
    const { spawnLauncher } = launcher((child) => {
      child.emit("spawn");
      child.emit("exit", 1, null);
    });
    await expect(winTransport(spawnLauncher).launch()).resolves.toBeUndefined();
  });

  it("survives an error after the process has started", async () => {
    const { spawnLauncher, children } = launcher();
    await winTransport(spawnLauncher).launch();
    expect(() => children[0]?.emit("error", new Error("late"))).not.toThrow();
  });

  it("has no way to kill what it started", async () => {
    const { spawnLauncher, children } = launcher();
    await winTransport(spawnLauncher).launch();
    expect(Object.keys(children[0] ?? {}).filter((key) => /kill|terminate/i.test(key))).toEqual([]);
    expect(Object.getOwnPropertyNames(ScriptInvocationTransport.prototype).filter((key) => /kill|terminate/i.test(key))).toEqual([]);
  });
});

describe("Windows invoke", () => {
  it("runs `AfterFX.exe -r <entry>` and does not wait for the process or its exit status", async () => {
    const { spawnLauncher, calls } = launcher();
    await winTransport(spawnLauncher).invoke("C:\\sessions\\x\\entry.jsx");
    expect(calls[0]?.args).toEqual(["-r", "C:\\sessions\\x\\entry.jsx"]);
  });

  it("passes the entry path as one argument, Japanese intact (whitespace is handled below)", async () => {
    const { spawnLauncher, calls } = launcher();
    const entry = "C:\\Users\\山田太郎\\a8n-sessions\\entry.jsx";
    await winTransport(spawnLauncher).invoke(entry);
    expect(calls[0]?.args).toEqual(["-r", entry]);
  });

  it("does not wait on a launcher that is itself the running AE", async () => {
    const { spawnLauncher } = launcher();
    const abort = new AbortController();
    const done = winTransport(spawnLauncher).invoke("entry.jsx", { signal: abort.signal });
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects when the executable cannot be started", async () => {
    const { spawnLauncher } = launcher((child) => child.emit("error", new Error("spawn EACCES")));
    await expect(winTransport(spawnLauncher).invoke("entry.jsx")).rejects.toThrow(/cannot start .*EACCES/);
  });
});

/**
 * `AfterFX.exe -r "<path with a space>"` exits 0 and runs nothing, with no
 * dialog (observed on AE 26.5x89, Windows 11; the same file runs from
 * File > Scripts > Run Script File, and a space-free or Japanese path runs).
 */
describe("Windows script paths with whitespace", () => {
  const SPACED = "C:\\Users\\山田 太郎\\AppData\\Local\\Temp\\ae-a8n-x\\inbox\\entry.jsx";

  function withShortPath(shortPath: (directory: string) => string | null) {
    const { spawnLauncher, calls } = launcher();
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: { executable: EXE, versionName: "x", renderExecutable: null },
      spawnLauncher,
      shortPath,
    });
    return { transport, calls };
  }

  it("leaves a path without whitespace alone, Japanese included, and never asks for a short name", async () => {
    const { transport, calls } = withShortPath(() => {
      throw new Error("must not be consulted");
    });
    await transport.invoke("C:\\Users\\山田\\Temp\\ae-a8n\\entry.jsx");
    expect(calls[0]?.args).toEqual(["-r", "C:\\Users\\山田\\Temp\\ae-a8n\\entry.jsx"]);
  });

  it("gives -r the short name of a directory that has a space, keeping the file name", async () => {
    const asked: string[] = [];
    const { transport, calls } = withShortPath((directory) => {
      asked.push(directory);
      return "C:\\Users\\4E71~1\\AppData\\Local\\Temp\\AE-A8N~1\\inbox";
    });
    await transport.invoke(SPACED);
    expect(asked).toEqual(["C:\\Users\\山田 太郎\\AppData\\Local\\Temp\\ae-a8n-x\\inbox"]);
    expect(calls[0]?.args).toEqual(["-r", "C:\\Users\\4E71~1\\AppData\\Local\\Temp\\AE-A8N~1\\inbox\\entry.jsx"]);
  });

  it("asks for a directory's short name once", async () => {
    let asked = 0;
    const { transport, calls } = withShortPath(() => {
      asked += 1;
      return "C:\\SHORT~1\\inbox";
    });
    await transport.invoke(SPACED);
    await transport.invoke(SPACED.replace("entry.jsx", "second.jsx"));
    expect(asked).toBe(1);
    expect(calls.map((call) => call.args[1])).toEqual(["C:\\SHORT~1\\inbox\\entry.jsx", "C:\\SHORT~1\\inbox\\second.jsx"]);
  });

  // Asks Windows for real. A kana short name was once garbled by reading
  // PowerShell's CP932 output as UTF-8, which produced a path that did not exist.
  it.runIf(process.platform === "win32")(
    "gets a short name that exists for a directory with Japanese and a space",
    async () => {
      const directory = join(root, "セッション with space");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "entry.jsx"), "");
      const { spawnLauncher, calls } = launcher();
      const transport = new ScriptInvocationTransport({
        platform: "win32",
        install: { executable: EXE, versionName: "x", renderExecutable: null },
        spawnLauncher,
      });
      await transport.invoke(join(directory, "entry.jsx"));
      const given = calls[0]?.args[1] ?? "";
      expect(given).not.toMatch(/\s/);
      expect(existsSync(given)).toBe(true);
    },
  );

  it("refuses before launching, saying why, when the directory has no short name", async () => {
    const { transport, calls } = withShortPath(() => null);
    const error = await transport.invoke(SPACED).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.name).toBe("UnsupportedScriptPathError");
    expect(error?.message).toContain("whitespace");
    expect(error?.message).toContain("sessionRoot");
    expect(calls).toHaveLength(0);
  });

  it("refuses a short name that still has whitespace", async () => {
    const { transport, calls } = withShortPath(() => "C:\\Still Spaced\\inbox");
    await expect(transport.invoke(SPACED)).rejects.toMatchObject({ name: "UnsupportedScriptPathError" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a file name with whitespace, which a directory short name cannot fix", async () => {
    const { transport, calls } = withShortPath(() => "C:\\SHORT~1");
    await expect(transport.invoke("C:\\Temp dir\\my entry.jsx")).rejects.toMatchObject({
      name: "UnsupportedScriptPathError",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("Windows session start", () => {
  it("reaches the readiness probe and times out there when AE never answers, instead of hanging", async () => {
    // The child never exits and nothing ever writes a result: a launcher that
    // is waited on would block here for good.
    const { spawnLauncher } = launcher();
    const driver = new AeDriver({
      transport: winTransport(spawnLauncher),
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
      readinessTimeoutMs: 400,
    });
    const began = Date.now();
    await expect(driver.start()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("sends no script until AE's main window is visible, then probes once", async () => {
    // A `-r` sent while AE is still starting is dropped, or answered with a
    // "Scripting plugin is not installed" dialog that blocks the start.
    const { spawnLauncher, calls } = launcher();
    let polls = 0;
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: { executable: EXE, versionName: "x", renderExecutable: null },
      spawnLauncher,
      shortPath: (dir) => dir,
      readyPollMs: 5,
      mainWindowVisible: () => ++polls > 3,
    });
    const driver = new AeDriver({
      transport,
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
      readinessTimeoutMs: 600,
    });
    await expect(driver.start()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(polls).toBeGreaterThan(3);
    // One launch with no arguments, then exactly one `-r`.
    expect(calls.map((c) => c.args[0])).toEqual([undefined, "-r"]);
  });

  it("sends nothing and says why when the main window never appears", async () => {
    const { spawnLauncher, calls } = launcher();
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: { executable: EXE, versionName: "x", renderExecutable: null },
      spawnLauncher,
      readyPollMs: 5,
      mainWindowVisible: () => false,
    });
    const driver = new AeDriver({
      transport,
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
      readinessTimeoutMs: 100,
    });
    await expect(driver.start()).rejects.toMatchObject({
      name: "HostUnavailableError",
      message: expect.stringContaining("no script was sent"),
    });
    expect(calls.map((c) => c.args[0])).toEqual([undefined]);
  });

  it("does not wait for a window on other platforms", async () => {
    const mac = new ScriptInvocationTransport({
      platform: "darwin",
      install: { executable: "/Applications/Adobe After Effects 2026/x", versionName: "x", renderExecutable: null },
      mainWindowVisible: () => {
        throw new Error("must not be asked");
      },
    });
    await expect(mac.awaitScriptable(10)).resolves.toBe(true);
  });

  it("does not claim ownership of a process it cannot prove it started", async () => {
    const { spawnLauncher } = launcher();
    const transport = winTransport(spawnLauncher);
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("unknown");
  });
});
