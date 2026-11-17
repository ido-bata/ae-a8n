/**
 * The consumer acceptance smoke: install the packed candidate into a clean
 * project and drive the `AfterEffects` API the way ae-test and Aulymo will.
 *
 * `scripts/check-packed-package.js` proves the tarball resolves and
 * `scripts/check-public-api.js` proves the API works against the in-repo fake
 * host. Neither touches a real After Effects, and neither is what a consumer
 * does first: a consumer installs the tarball, imports the package, finds out
 * whether After Effects is even there, and only then launches. This script is
 * that sequence, in one command:
 *
 *   1. `npm pack` the candidate and `npm install` the tarball into a fresh
 *      temporary project — never this repository's node_modules.
 *   2. Import the package through its published exports map and check the
 *      surface a consumer codes against (`AfterEffects.launch`,
 *      `resolveInstall`, `A8N_VERSION`, …). This part needs no After Effects
 *      and is what CI exercises on every platform.
 *   3. When an After Effects installation is discoverable, run the real-host
 *      smoke: launch → version → capability handshake → project →
 *      diagnostics → close. When none is, the script reports the skip and
 *      exits 0 — a green run here is `automated test` evidence for the
 *      package surface only, never `verified on real host`.
 *
 * The real-host part is read-only by default: it reports the open project and
 * its comps and quits nothing it did not start (`close` refuses to quit an
 * attached or unknown-ownership instance). Pass `--project <absolute .aep>`
 * to open a specific project instead of reading the current one; opening
 * still refuses to discard unsaved changes.
 *
 * `A8N_SMOKE_SKIP_REAL_HOST=1` skips the launch step even when an install is
 * discoverable. It can only skip — it never manufactures a pass — and exists
 * so the packaging half of this check can run on a host that has After
 * Effects but must not be driven (CI runners, a verification of the skip
 * path itself).
 *
 * Run: node scripts/check-consumer-smoke.js [--project <path>]
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { npmCommand } from "./npm-cli.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
let projectPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--project") {
    projectPath = args[i + 1];
    i += 1;
  } else {
    console.error(`::error::unknown argument ${args[i]}; usage: node scripts/check-consumer-smoke.js [--project <path>]`);
    process.exit(1);
  }
}
if (projectPath !== null && !isAbsolute(projectPath)) {
  console.error("::error::--project must be an absolute path");
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  return execFileSync(command, cmdArgs, { encoding: "utf-8", ...options });
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

console.log(`packing ${manifest.name}@${manifest.version}…`);
// npm runs as `node <npm-cli.js>`, never through a shell (scripts/npm-cli.js):
// on Windows `npm` is `npm.cmd`, which execFileSync cannot start — this script
// failed there with `spawn npm ENOENT` — and a shell would re-parse the args.
const npm = npmCommand();
const tarballName = run(npm.command, [...npm.args, "pack", "--silent"], { cwd: PACKAGE_ROOT })
  .trim()
  .split("\n")
  .at(-1);
const tarball = join(PACKAGE_ROOT, tarballName);

const workdir = mkdtempSync(join(tmpdir(), "a8n-consumer-smoke-"));
try {
  writeFileSync(
    join(workdir, "package.json"),
    `${JSON.stringify({ name: "consumer-smoke", private: true, type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  run(npm.command, [...npm.args, "install", "--silent", tarball], { cwd: workdir });

  const probePath = join(workdir, "smoke.mjs");
  writeFileSync(
    probePath,
    `
import {
  A8N_VERSION,
  AfterEffects,
  AfterEffectsNotInstalledError,
  resolveInstall,
} from "${manifest.name}";

// --- Package surface: what a consumer codes against. Runs everywhere. ---

if (A8N_VERSION !== ${JSON.stringify(manifest.version)}) {
  throw new Error("A8N_VERSION " + A8N_VERSION + " does not match package.json " + ${JSON.stringify(manifest.version)});
}
for (const [name, value] of [
  ["AfterEffects.launch", AfterEffects.launch],
  ["AfterEffects.resume", AfterEffects.resume],
  ["resolveInstall", resolveInstall],
]) {
  if (typeof value !== "function") {
    throw new Error(name + " is missing or not a function");
  }
}
console.log("package surface ok: " + A8N_VERSION);

// --- After Effects discovery. Absent is a skip, not a failure. ---

if (process.env.A8N_SMOKE_SKIP_REAL_HOST === "1") {
  console.log("RESULT: skipped — real-host steps disabled by A8N_SMOKE_SKIP_REAL_HOST");
  process.exit(0);
}

let install;
try {
  install = resolveInstall();
} catch (error) {
  if (error instanceof AfterEffectsNotInstalledError) {
    console.log("RESULT: skipped — no After Effects installation is discoverable on this host");
    process.exit(0);
  }
  throw error;
}
console.log("After Effects install found: " + install.executable);

// --- Real-host smoke: launch → version → handshake → project → diagnostics → close. ---
// Read-only unless --project was given: nothing here creates, edits, renders,
// or quits an instance this run does not own.

const PROJECT = ${JSON.stringify(projectPath)};
const ae = await AfterEffects.launch({ timeoutMs: 120000 });
try {
  const info = ae.info();
  const version = await ae.version();
  const handshake = await ae.capabilities();
  const ownership = ae.ownership();

  let project;
  if (PROJECT !== null) {
    project = await ae.openProject(PROJECT);
  } else {
    project = await ae.project();
  }
  const projectInfo = await project.info();
  const comps = await ae.comps();
  const diagnostics = ae.diagnostics();

  console.log("host: version=" + version + " build=" + (info.build ?? "unknown"));
  console.log(
    "handshake: contract=" + handshake.contractVersion.major + "." + handshake.contractVersion.minor +
    " catalog=" + handshake.catalogRevision +
    " hostId=" + handshake.hostId +
    " capabilities=" + handshake.availableCapabilities.length +
    " diagnostics=" + handshake.diagnostics.length +
    " ownership=" + handshake.target.ownership,
  );
  console.log(
    "project: " + (projectInfo.file ?? projectInfo.name ?? "(unsaved)") +
    " items=" + projectInfo.itemCount + " comps=" + comps.length,
  );
  console.log(
    "diagnostics: bundle=" + diagnostics.bundleDir +
    " events=" + (diagnostics.trace === null ? "none" : diagnostics.trace.events),
  );
  console.log("RESULT: real-host pass (read-only smoke)");
} finally {
  const closed = await ae.close();
  console.log(
    "closed: quit=" + closed.quit +
    " ownership=" + closed.ownership.kind +
    (closed.reason === undefined ? "" : " reason=" + closed.reason),
  );
}
`,
    "utf-8",
  );

  let output;
  try {
    output = run(process.execPath, [probePath], {
      cwd: workdir,
      // The child's stack trace points into a temporary directory that is
      // about to disappear. The useful line is re-emitted by `fail` below.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const match = /Error: ([\s\S]*?)\n\s*at /.exec(stderr);
    fail(match ? match[1] : stderr.trim() || String(error.message));
  }
  console.log(String(output).trim());

  if (String(output).includes("RESULT: real-host pass")) {
    console.log("\nconsumer smoke passed against a real After Effects.");
  } else {
    console.log(
      "\nconsumer smoke: package surface verified from a clean install; " +
        "real-host steps skipped (verification level: automated test, not real host).",
    );
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
