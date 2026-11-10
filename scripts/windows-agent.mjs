#!/usr/bin/env node
/**
 * The in-session Windows agent, started in the dedicated user's signed-in
 * session. Everything testable lives in `dist/platform/windows/agent-main.js`;
 * this file only loads it and translates signals into an abort.
 *
 * Build first, then on the Windows target:
 *
 *   node scripts/windows-agent.mjs \
 *     --channel \\\\controller\\share\\a8n \
 *     --agent-id ae-a8n-agent \
 *     --host WIN-AE-01 \
 *     --user a8n \
 *     --session-id 1 \
 *     --version 0.1.0-alpha.1
 *
 * The channel is a directory both sides can see. The agent never reads or
 * writes a credential.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function load(relativePath) {
  const url = pathToFileURL(resolve(PACKAGE_ROOT, relativePath)).href;
  try {
    return await import(url);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") {
      console.error(`${relativePath} is missing; run "npm run build" first.`);
      process.exit(1);
    }
    throw error;
  }
}

const { main } = await load("dist/platform/windows/agent-main.js");

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => controller.abort());
}

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
