/**
 * The process entry for the installed `ae-a8n` bin.
 *
 * The exit code is set on `process` rather than thrown, so the JSON envelope
 * stays the only thing on stdout and a caller sees the contract's number.
 */

import { runCli } from "./run.js";

export async function main(argv: readonly string[]): Promise<void> {
  process.exitCode = await runCli(argv);
}
