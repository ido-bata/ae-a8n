/**
 * The real `CommandRunner`: starts one program, waits for it, and returns its
 * output instead of throwing. A missing program or a timeout becomes an exit
 * code, because the probe must report an unreadable fact rather than crash.
 */

import { execFile, type ExecFileException } from "node:child_process";

import type { CommandResult, CommandRunner, ProbeCommand } from "./probe.js";

export type SpawnRunnerOptions = {
  /** Per-command limit. A probe is read-only, so a hung command is just absent. */
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** 124 = the command did not finish; 127 = it could not be started. */
function exitCodeOf(error: ExecFileException | null): number {
  if (error === null) {
    return 0;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  return error.killed === true ? 124 : 127;
}

export class SpawnCommandRunner implements CommandRunner {
  readonly #timeoutMs: number;
  readonly #maxBuffer: number;

  constructor(options: SpawnRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  run(command: ProbeCommand): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command.program,
        [...command.args],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: this.#timeoutMs,
          maxBuffer: this.#maxBuffer,
        },
        (error, stdout, stderr) => {
          resolve({ stdout, stderr, exitCode: exitCodeOf(error) });
        },
      );
    });
  }
}
