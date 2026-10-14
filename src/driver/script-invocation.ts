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
 *   macOS    `osascript` → `tell application <bundle path>` → `DoScriptFile`
 *            Synchronous. The bundle is addressed by path, not by name: the
 *            name differs per release (`Adobe After Effects 2026`) and the
 *            bare `Adobe After Effects` does not resolve to AE at all, which
 *            makes osascript fail to compile the script (-2741).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { macAppBundle, resolveInstall, type AfterEffectsInstall } from "./install-path.js";
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

/**
 * Runs `DoScriptFile` against the application at a path, both taken from argv.
 *
 * Neither path is ever spliced into AppleScript source, so nothing needs
 * escaping. That forces the raw event code: with the target only known at run
 * time the compiler cannot look up the `DoScriptFile` term in AE's dictionary.
 * `miscfile` is the code AE's sdef declares for it.
 */
export const MAC_DO_SCRIPT_FILE = [
  "on run argv",
  "  tell application (item 1 of argv)",
  "    «event miscfile» (item 2 of argv)",
  "  end tell",
  "end run",
];

/** Keeps a failure report bounded however much a process writes. */
export const MAX_DIAGNOSTIC_CHARS = 4_000;

/**
 * Trims process output into something safe to put in an error and a trace:
 * bounded in size, and with the home directory replaced so a shared trace
 * does not carry the user's account name.
 */
export function summariseProcessOutput(output: string, home: string = homedir()): string {
  let text = output.trim();
  if (home.length > 1) {
    text = text.split(home).join("~");
  }
  if (text.length > MAX_DIAGNOSTIC_CHARS) {
    const omitted = text.length - MAX_DIAGNOSTIC_CHARS;
    text = `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}… [${omitted} more characters]`;
  }
  return text;
}

/** A launcher process that failed, with what it said about why. */
export class ScriptInvocationError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(
      `${command} exited with code ${exitCode ?? "null"}` + (stderr.length > 0 ? `: ${stderr}` : ""),
    );
    this.name = "ScriptInvocationError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class ScriptInvocationTransport implements HostTransport {
  readonly kind = "script-invocation";
  readonly #install: AfterEffectsInstall;
  readonly #platform: NodeJS.Platform;

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
      const bundle = macAppBundle(this.#install.executable);
      if (bundle === null) {
        throw new Error(
          `cannot address After Effects by AppleScript: ${this.#install.executable} is not inside an .app bundle`,
        );
      }
      await this.#run("/", "osascript", [
        ...MAC_DO_SCRIPT_FILE.flatMap((line) => ["-e", line]),
        bundle,
        entryScriptPath,
      ]);
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

  /**
   * Runs a process and resolves when it exits. Errors are surfaced, except
   * where noted in `invoke` for Windows.
   */
  #run(cwd: string, command: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      // Only the head is kept: a runaway process must not grow this without
      // bound, and the cause of a launcher failure is in the first lines.
      let stderr = "";
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length <= MAX_DIAGNOSTIC_CHARS) {
          stderr += chunk;
        }
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
        reject(new ScriptInvocationError(command, code, summariseProcessOutput(stderr)));
      });
    });
  }
}
