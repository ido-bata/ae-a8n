/**
 * The real transport: run a host script by invoking After Effects itself.
 *
 * Windows and macOS reach the same result by different routes, and the
 * difference is not cosmetic — see ADR 0001.
 *
 *   Windows  `AfterFX.exe -r <entry.jsx>`
 *            Single-instance: if AE is already running the new process hands
 *            the script to it and exits without a usable status. The process is
 *            therefore not waited on; the driver's result-file poll is what
 *            reports success or timeout.
 *
 *   macOS    `osascript` → `tell application "Adobe After Effects" to DoScript`
 *            Synchronous, and the script's result comes back on stdout.
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstall, type AfterEffectsInstall } from "./install-path.js";
import type { HostTransport } from "./transport.js";

export type ScriptInvocationOptions = {
  /** Explicit install directory; skips discovery. */
  readonly installDir?: string;
  /** Adobe root to scan. Mainly a test seam. */
  readonly installRoot?: string;
  /** Pre-resolved install, when the caller already discovered one. */
  readonly install?: AfterEffectsInstall;
  readonly platform?: NodeJS.Platform;
};

/** A cold After Effects start can take a minute on a spinning disk. */
export const READINESS_TIMEOUT_MS = 180_000;

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class ScriptInvocationTransport implements HostTransport {
  readonly kind = "script-invocation";
  readonly #install: AfterEffectsInstall;
  readonly #platform: NodeJS.Platform;
  #scriptCount = 0;

  constructor(options: ScriptInvocationOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.#platform = platform;
    this.#install =
      options.install ??
      resolveInstall(platform, {
        ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
        ...(options.installRoot === undefined ? {} : { root: options.installRoot }),
      });
  }

  get install(): AfterEffectsInstall {
    return this.#install;
  }

  available(): Promise<boolean> {
    return Promise.resolve(existsSync(this.#install.executable));
  }

  /**
   * Starts After Effects only if it is not already running.
   *
   * Launching is deliberately not awaited to completion: AE takes tens of
   * seconds to become scriptable on a cold start, and the readiness probe in
   * `AeDriver.start` is the thing that actually gates on usability. Blocking
   * here on process exit would report success before AE could answer.
   */
  async launch(): Promise<void> {
    if (this.#platform !== "win32") {
      // On macOS `DoScript` launches AE on demand, so there is nothing to do.
      return;
    }
    await this.#run(join(this.#install.executable, ".."), this.#install.executable, []);
  }

  async invoke(entryScriptPath: string): Promise<void> {
    if (this.#platform === "win32") {
      await this.#run(join(this.#install.executable, ".."), this.#install.executable, [
        "-r",
        entryScriptPath,
      ]);
      return;
    }
    if (this.#platform === "darwin") {
      const scriptPath = this.#writeAppleScript(entryScriptPath);
      try {
        // `DoScript` takes a string of JavaScript; `$.evalFile` is how a file
        // on disk becomes one, and avoids guessing whether AE would accept the
        // bare path.
        await this.#runAppleScript(scriptPath);
      } finally {
        try {
          unlinkSync(scriptPath);
        } catch {
          // Best effort; the file is in the OS temp directory.
        }
      }
      return;
    }
    throw new Error(
      `no After Effects automation transport for platform "${this.#platform}"; ` +
        "use the fake host from @ido-bata/ae-a8n/testing instead",
    );
  }

  async close(): Promise<void> {
    // The driver issues `app.quit` through the host script, which closes the
    // project first. Killing the process here would discard unsaved state.
  }

  #writeAppleScript(entryScriptPath: string): string {
    // Unique per invocation: two concurrent sessions must not share a scratch
    // file.
    this.#scriptCount += 1;
    const path = join(tmpdir(), `a8n-${process.pid}-${this.#scriptCount}.scpt`);
    const body = [
      'tell application "Adobe After Effects"',
      `  DoScript "$.evalFile(new File(\\"${escapeAppleScriptString(entryScriptPath)}\\"))"`,
      "end tell",
    ].join("\n");
    writeFileSync(path, body, "utf-8");
    return path;
  }

  #runAppleScript(scriptPath: string): Promise<void> {
    return this.#run("/", "osascript", [scriptPath]);
  }

  /**
   * Runs a process and resolves when it exits. Errors are surfaced, except
   * where noted in `invoke` for Windows.
   */
  #run(cwd: string, command: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // Windows reports a non-zero exit from `AfterFX.exe -r` even when the
        // script ran correctly, because the process hands off to an existing
        // instance. The result file is the authority there, not the exit code.
        if (this.#platform === "win32" && code !== 0 && args.length > 0) {
          resolve();
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`),
        );
      });
    });
  }
}
