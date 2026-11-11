/**
 * Read-only Windows host probe.
 *
 * Prints one JSON document on stdout: the facts the probe read, the exact
 * outputs they came from, the resulting diagnostic checks, and the backend
 * capabilities. It starts nothing, writes nothing and sends nothing to After
 * Effects.
 *
 * Run on the Windows host, after `npm run build`:
 *
 *   node scripts/probe-windows.mjs [remote-host|session] [target-user]
 *
 * Exit: 0 when no check is a blocker, 3 when one is (`contracts/cli.md` §2).
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

const [isolationArgument = "remote-host", targetUser = null] = process.argv.slice(2);
if (isolationArgument !== "remote-host" && isolationArgument !== "session") {
  console.error(`unknown isolation "${isolationArgument}"; use "remote-host" or "session"`);
  process.exit(2);
}

const { probeWindows } = await load("dist/platform/windows/probe.js");
const { SpawnCommandRunner } = await load("dist/platform/windows/spawn-runner.js");

const result = await probeWindows(new SpawnCommandRunner(), {
  isolation: isolationArgument,
  targetUser,
});

const blockers = result.checks.filter((check) => check.severity === "blocker");
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "1.0",
      command: "probe-windows",
      status: blockers.length === 0 ? "ok" : "blocked",
      isolation: isolationArgument,
      targetUser,
      facts: result.facts,
      capabilities: result.capabilities,
      checks: result.checks,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = blockers.length === 0 ? 0 : 3;
