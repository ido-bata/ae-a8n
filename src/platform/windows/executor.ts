/**
 * The one place the Windows agent starts a process.
 *
 * The payload is strict JSON and is validated before anything is spawned. The
 * program is executed directly (`shell: false`): an argument can never become
 * a command line. Output is capped, artifacts are written, and a timeout is
 * reported as `unknown` — never as success or failure, because the child may
 * still be running.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { JobExecutor, JobExecution } from "./agent.js";
import {
  decodePayload,
  type DecodeOutcome,
  type Job,
  type JobPayload,
} from "./job.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 180_000;

/** The smallest surface of a child process the executor needs. */
export interface ExecutorChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid: number | undefined;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnCallOptions = {
  readonly shell: false;
  readonly windowsHide: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
};

export type SpawnFunction = (
  program: string,
  args: readonly string[],
  options: SpawnCallOptions,
) => ExecutorChild;

export type KillFunction = (child: ExecutorChild) => void | Promise<void>;

/** Reads a process's creation time; null when it does not exist or cannot be read. */
export type ProcessStartReader = (pid: number) => Promise<string | null>;

const START_TIME_TIMEOUT_MS = 5_000;

/**
 * The process creation time, as the OS reports it. A bare pid is not an
 * identity: between the timeout and `taskkill`, the child can exit and its pid
 * be reused by an unrelated process.
 */
export function readWindowsProcessStart(pid: number): Promise<string | null> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(null);
  }
  const script = `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString('o')`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf-8", timeout: START_TIME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        resolve(text === "" ? null : text);
      },
    );
  });
}

export type SpawnJobExecutorOptions = {
  /** Injected so tests can observe the spawn call and drive its events. */
  readonly spawn: SpawnFunction;
  /** Where `stdout.log` and `stderr.log` are written. */
  readonly runDirectory: string;
  /** Per-stream cap. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number;
  /** Defaults to 180 s. */
  readonly timeoutMs?: number;
  /** Injected so tests can observe the tree kill; defaults to `taskkill /T /F`. */
  readonly kill?: KillFunction;
  /**
   * Injected so tests can model pid reuse. A timeout kills only when the
   * process's identity (its creation time) is the same before and at kill
   * time; otherwise nothing is killed and the outcome stays unknown.
   */
  readonly readProcessStart?: ProcessStartReader;
};

/** NUL and the C0 control range, plus DEL. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The real spawn function; the type is narrowed to what the executor needs. */
export const spawnProcess: SpawnFunction = (program, args, options) =>
  spawn(program, [...args], options) as unknown as ExecutorChild;

/**
 * Kill the child and everything it started. `taskkill` is invoked directly,
 * never through a shell, and its failure does not change the outcome.
 */
export function killProcessTree(child: ExecutorChild): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000 },
      () => {
        resolve();
      },
    );
  });
}

function isAbsolutePath(value: string): boolean {
  return value !== "" && isAbsolute(value);
}

/** Strict JSON of the one shape an executor accepts. */
export function decodeJobPayload(bytes: Uint8Array): DecodeOutcome<JobPayload> {
  return decodePayload(bytes, {
    isAbsolutePath,
    hasControlCharacter,
  });
}

export function encodeJobPayload(payload: JobPayload): Uint8Array {
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function truncationNote(
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  maxOutputBytes: number,
): string {
  const notes: string[] = [];
  if (stdoutTruncated) {
    notes.push(`stdout truncated to ${maxOutputBytes} bytes`);
  }
  if (stderrTruncated) {
    notes.push(`stderr truncated to ${maxOutputBytes} bytes`);
  }
  return notes.length === 0 ? "" : `; ${notes.join("; ")}`;
}

export class SpawnJobExecutor implements JobExecutor {
  readonly #spawn: SpawnFunction;
  readonly #runDirectory: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;
  readonly #kill: KillFunction;
  readonly #readProcessStart: ProcessStartReader;

  constructor(options: SpawnJobExecutorOptions) {
    this.#spawn = options.spawn;
    this.#runDirectory = options.runDirectory;
    this.#maxOutputBytes =
      options.maxOutputBytes !== undefined && options.maxOutputBytes > 0
        ? options.maxOutputBytes
        : DEFAULT_MAX_OUTPUT_BYTES;
    this.#timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_EXECUTOR_TIMEOUT_MS;
    this.#kill = options.kill ?? killProcessTree;
    this.#readProcessStart = options.readProcessStart ?? readWindowsProcessStart;
  }

  async execute(input: {
    readonly job: Job;
    readonly payload: Uint8Array;
  }): Promise<JobExecution> {
    // Validate before anything is spawned or written.
    const decoded = decodeJobPayload(input.payload);
    if (!decoded.ok) {
      return {
        status: "failed",
        code: "A8N-JOB-001",
        message: `the job payload was refused: ${decoded.detail}`,
      };
    }
    const { argv, env, cwd } = decoded.value;
    const program = argv[0];
    if (program === undefined) {
      return { status: "failed", code: "A8N-JOB-001", message: "argv is empty" };
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const spawnOptions: SpawnCallOptions = {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      ...(cwd === undefined ? {} : { cwd }),
    };

    let child: ExecutorChild;
    try {
      child = this.#spawn(program, argv.slice(1), spawnOptions);
    } catch (error) {
      return {
        status: "failed",
        message: `the process could not be started: ${describe(error)}`,
      };
    }

    // Capture the process identity now, before any timeout can fire. A pid
    // alone cannot be re-checked later: it may name a different process.
    const startedIdentity: Promise<string | null> =
      child.pid === undefined
        ? Promise.resolve(null)
        : this.#readProcessStart(child.pid).catch(() => null);

    const collect = (
      stream: NodeJS.ReadableStream | null,
      chunks: Buffer[],
      kind: "stdout" | "stderr",
    ): void => {
      stream?.on("data", (chunk: unknown) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const used = kind === "stdout" ? stdoutBytes : stderrBytes;
        if (used >= this.#maxOutputBytes) {
          if (kind === "stdout") {
            stdoutTruncated = true;
          } else {
            stderrTruncated = true;
          }
          return;
        }
        const remaining = this.#maxOutputBytes - used;
        const kept = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
        chunks.push(kept);
        if (kind === "stdout") {
          stdoutBytes += kept.length;
          stdoutTruncated = stdoutTruncated || kept.length < bytes.length;
        } else {
          stderrBytes += kept.length;
          stderrTruncated = stderrTruncated || kept.length < bytes.length;
        }
      });
    };
    collect(child.stdout, stdoutChunks, "stdout");
    collect(child.stderr, stderrChunks, "stderr");

    return new Promise<JobExecution>((resolve) => {
      let settled = false;
      let timedOut = false;

      const writeArtifacts = async (
        status: JobExecution["status"],
        message: string,
        options: { readonly exitCode?: number | null; readonly code?: string } = {},
      ): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);
        let artifactNote = "";
        let artifacts: Readonly<Record<string, Uint8Array>> | undefined;
        try {
          await mkdir(this.#runDirectory, { recursive: true });
          await writeFile(join(this.#runDirectory, "stdout.log"), stdout);
          await writeFile(join(this.#runDirectory, "stderr.log"), stderr);
          artifacts = { "stdout.log": stdout, "stderr.log": stderr };
        } catch (error) {
          // The child's outcome is still what was observed; only its output is
          // missing. Never hide that, and never leave the promise unresolved.
          artifactNote = `; the output could not be written to ${this.#runDirectory}: ${describe(error)}`;
        }
        resolve({
          status,
          ...(options.code === undefined ? {} : { code: options.code }),
          exitCode: options.exitCode ?? null,
          message: `${message}${artifactNote}`,
          ...(artifacts === undefined ? {} : { artifacts }),
        });
      };

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        void (async () => {
          // Kill only the process this run started. If either identity read
          // fails, or the creation time changed, the pid now names something
          // else and nothing is killed: the outcome is already unknown, and
          // killing an unrelated process is worse than leaving this one.
          const before = await startedIdentity;
          const current =
            child.pid === undefined
              ? null
              : await this.#readProcessStart(child.pid).catch(() => null);
          const sameProcess = before !== null && current !== null && before === current;
          if (sameProcess) {
            try {
              await this.#kill(child);
            } catch {
              // The kill failing does not make the outcome less unknown.
            }
          }
          const outcome = sameProcess
            ? `timed out after ${this.#timeoutMs}ms; the child was killed and the outcome is unknown`
            : `timed out after ${this.#timeoutMs}ms; the child's identity could not be re-checked, ` +
              "so nothing was killed and it may still be running";
          await writeArtifacts("unknown", outcome + truncationNote(stdoutTruncated, stderrTruncated, this.#maxOutputBytes), {
            exitCode: null,
            code: "A8N-AE-004",
          });
        })();
      }, this.#timeoutMs);

      child.on("error", (error) => {
        if (timedOut) {
          return;
        }
        void writeArtifacts(
          "failed",
          `the process could not be started: ${describe(error)}` +
            truncationNote(stdoutTruncated, stderrTruncated, this.#maxOutputBytes),
        );
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          return;
        }
        const note = truncationNote(stdoutTruncated, stderrTruncated, this.#maxOutputBytes);
        if (code === 0) {
          void writeArtifacts("ok", `exited with code 0${note}`, { exitCode: 0 });
        } else if (code !== null) {
          void writeArtifacts("failed", `exited with code ${code}${note}`, { exitCode: code });
        } else {
          void writeArtifacts(
            "failed",
            `terminated by signal ${signal ?? "unknown"}${note}`,
            { exitCode: null },
          );
        }
      });
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
