/**
 * The parts of the real transport that a macOS host disagreed with.
 *
 * Each case here was a failure on AE 26.5x89 / macOS 27.0.1 at 12ac059:
 *
 *   - the executable is `Contents/MacOS/After Effects`, and the bundle sits
 *     inside a version directory, so discovery found nothing;
 *   - `tell application "Adobe After Effects"` does not resolve to AE, so
 *     osascript failed to compile, and its stderr was discarded;
 *   - `app.build` is undefined, so `app.info` reported the string "undefined".
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import { macAppBundle, resolveInstall } from "../src/driver/install-path.js";
import {
  MAX_DIAGNOSTIC_CHARS,
  ScriptInvocationTransport,
  summariseProcessOutput,
} from "../src/driver/script-invocation.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-install-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plist(executable: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "  <key>CFBundleExecutable</key>",
    `  <string>${executable}</string>`,
    "</dict></plist>",
  ].join("\n");
}

/** Lays out an install the way Adobe does on macOS. */
function macInstall(
  name: string,
  options: { executable?: string; plist?: boolean; bundle?: boolean; aerender?: boolean } = {},
): { installDir: string; bundle: string; executable: string } {
  const executableName = options.executable ?? "After Effects";
  const installDir = join(root, name);
  const bundle = join(installDir, `${name}.app`);
  const executable = join(bundle, "Contents", "MacOS", executableName);
  mkdirSync(installDir, { recursive: true });
  if (options.bundle !== false) {
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(executable, "");
    chmodSync(executable, 0o755);
    if (options.plist !== false) {
      writeFileSync(join(bundle, "Contents", "Info.plist"), plist(executableName));
    }
  }
  if (options.aerender !== false) {
    writeFileSync(join(installDir, "aerender"), "");
  }
  return { installDir, bundle, executable };
}

describe("macOS install discovery", () => {
  it("finds the bundle inside its version directory, by its real executable", () => {
    const install = macInstall("Adobe After Effects 2026");
    expect(resolveInstall("darwin", { root })).toEqual({
      executable: install.executable,
      versionName: "Adobe After Effects 2026.app",
      renderExecutable: join(install.installDir, "aerender"),
    });
  });

  it("uses the executable Info.plist declares", () => {
    const install = macInstall("Adobe After Effects 2027", { executable: "Something Else" });
    expect(resolveInstall("darwin", { root }).executable).toBe(install.executable);
  });

  it("falls back to the known executable name when there is no readable plist", () => {
    const install = macInstall("Adobe After Effects 2026", { plist: false });
    expect(resolveInstall("darwin", { root }).executable).toBe(install.executable);
  });

  it("picks the newest of several installs", () => {
    macInstall("Adobe After Effects 2025");
    const newest = macInstall("Adobe After Effects 2026");
    macInstall("Adobe After Effects 2024");
    expect(resolveInstall("darwin", { root }).executable).toBe(newest.executable);
  });

  it("skips a newer version directory that has no bundle left in it", () => {
    macInstall("Adobe After Effects 2026", { bundle: false });
    const usable = macInstall("Adobe After Effects 2025");
    expect(resolveInstall("darwin", { root }).executable).toBe(usable.executable);
  });

  it("reports nothing installed when no directory holds a bundle", () => {
    macInstall("Adobe After Effects 2026", { bundle: false });
    expect(() => resolveInstall("darwin", { root })).toThrow(/no After Effects installation found/);
  });

  it("accepts installDir as the install directory", () => {
    const install = macInstall("Adobe After Effects 2026");
    expect(resolveInstall("darwin", { installDir: install.installDir }).executable).toBe(
      install.executable,
    );
  });

  it("accepts installDir as the .app bundle", () => {
    const install = macInstall("Adobe After Effects 2026");
    const found = resolveInstall("darwin", { installDir: install.bundle });
    expect(found.executable).toBe(install.executable);
    expect(found.renderExecutable).toBe(join(install.installDir, "aerender"));
  });

  it("rejects an installDir with no bundle", () => {
    expect(() => resolveInstall("darwin", { installDir: join(root, "nothing") })).toThrow(
      /no After Effects installation found/,
    );
  });
});

describe("Windows install discovery is unchanged", () => {
  it("finds Support Files/AfterFX.exe in the newest version directory", () => {
    const supportFiles = join(root, "Adobe After Effects 2026", "Support Files");
    mkdirSync(supportFiles, { recursive: true });
    writeFileSync(join(supportFiles, "AfterFX.exe"), "");
    expect(resolveInstall("win32", { root })).toEqual({
      executable: join(supportFiles, "AfterFX.exe"),
      versionName: "Adobe After Effects 2026",
      renderExecutable: null,
    });
  });
});

describe("addressing the application", () => {
  it("derives the bundle from the executable", () => {
    expect(
      macAppBundle(
        "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
      ),
    ).toBe("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app");
  });

  it("distinguishes two installs by path", () => {
    const a = macInstall("Adobe After Effects 2025");
    const b = macInstall("Adobe After Effects 2026");
    expect(macAppBundle(a.executable)).toBe(a.bundle);
    expect(macAppBundle(b.executable)).toBe(b.bundle);
  });

  it("returns null for an executable outside a bundle", () => {
    expect(macAppBundle("/usr/local/bin/AfterFX")).toBeNull();
  });
});

describe("launcher diagnostics", () => {
  it("bounds the output it keeps", () => {
    const text = summariseProcessOutput("x".repeat(MAX_DIAGNOSTIC_CHARS + 50), "/Users/someone");
    expect(text.startsWith("x".repeat(MAX_DIAGNOSTIC_CHARS))).toBe(true);
    expect(text).toContain("[50 more characters]");
  });

  it("does not carry the home directory", () => {
    expect(summariseProcessOutput("cannot open /Users/someone/x.jsx\n", "/Users/someone")).toBe(
      "cannot open ~/x.jsx",
    );
  });

  // Runs the real osascript. The target is a bundle that does not exist, so no
  // After Effects is touched; the path carries quotes and spaces to show it is
  // passed as data, never spliced into AppleScript source.
  it.runIf(process.platform === "darwin")(
    "surfaces osascript's own reason, not just the exit code",
    async () => {
      const install = macInstall('Adobe After Effects "quoted" 2026');
      rmSync(install.bundle, { recursive: true, force: true });
      const transport = new ScriptInvocationTransport({
        platform: "darwin",
        install: { executable: install.executable, versionName: "x", renderExecutable: null },
      });
      const error = await transport.invoke(join(root, "entry.jsx")).then(
        () => null,
        (caught: unknown) => caught as Error & { exitCode?: number; stderr?: string },
      );
      expect(error).not.toBeNull();
      expect(error?.name).toBe("ScriptInvocationError");
      expect(error?.exitCode).toBe(1);
      expect(error?.stderr).toMatch(/-1728/);
      // osascript echoes the application it could not reach in AppleScript's
      // own quoting; the whole path arriving intact is what proves it was
      // passed as data.
      expect(error?.message).toContain('Adobe After Effects \\"quoted\\" 2026.app');
    },
  );
});

describe("app.info", () => {
  async function info(transport: FakeAfterEffectsTransport): Promise<Record<string, unknown>> {
    const driver = new AeDriver({
      transport,
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
    });
    await driver.start();
    const result = await driver.call<Record<string, unknown>>("app.info");
    await driver.stop();
    return result;
  }

  it("reports the build from app.buildNumber", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.app.buildNumber = 89;
    await expect(info(transport)).resolves.toEqual({ version: "26.0.0", build: "89" });
  });

  it("leaves build out rather than reporting the string \"undefined\"", async () => {
    const transport = new FakeAfterEffectsTransport();
    (transport.app as { buildNumber: number | undefined }).buildNumber = undefined;
    const result = await info(transport);
    expect(result).toEqual({ version: "26.0.0" });
    expect(result).not.toHaveProperty("build");
  });
});

describe("closing a session", () => {
  // app.quit returns while AE is still shutting down; a launch in that window
  // failed with -609 on a real host. close must outlast the process.
  const executable = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
  const install = { executable, versionName: "Adobe After Effects 2026.app", renderExecutable: null };

  it("returns only once the AE process has exited", async () => {
    let polls = 0;
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install,
      runningExecutables: () => {
        polls += 1;
        return polls < 3 ? ["/sbin/launchd", executable] : ["/sbin/launchd"];
      },
    });
    await transport.close();
    expect(polls).toBe(3);
  });

  it("does not mistake another install for this one", async () => {
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install,
      runningExecutables: () => [executable.replace(/2026/g, "2025")],
    });
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("says so, without killing anything, when AE does not exit", async () => {
    const transport = new ScriptInvocationTransport({
      platform: "darwin",
      install,
      exitTimeoutMs: 300,
      runningExecutables: () => [executable],
    });
    await expect(transport.close()).rejects.toThrow(/did not exit within 300 ms/);
  });

  it("does not wait on Windows, where the existing behaviour is kept", async () => {
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: { executable: "C:\\AE\\Support Files\\AfterFX.exe", versionName: "x", renderExecutable: null },
      runningExecutables: () => {
        throw new Error("must not be consulted");
      },
    });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
