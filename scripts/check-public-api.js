/**
 * Drive the public API from an installed package.
 *
 * `scripts/check-packed-package.js` covers the *package surface*: that the
 * tarball installs and both entry points resolve. This covers what happens once
 * a consumer imports them — that the built driver finds the shipped host
 * script from inside someone else's `node_modules`, and that a session actually
 * opens and answers.
 *
 * They are separate on purpose. The packing check has to stay identical on
 * every branch, including ones that do not have the API yet; a single script
 * that grew a dependency on `AfterEffects` would stop being runnable on the
 * branch that owns the packaging.
 *
 * Run: node scripts/check-public-api.js
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf-8", ...options });
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

console.log(`packing ${manifest.name}@${manifest.version}…`);
const tarballName = run("npm", ["pack", "--silent"], { cwd: PACKAGE_ROOT })
  .trim()
  .split("\n")
  .at(-1);
const tarball = join(PACKAGE_ROOT, tarballName);

const workdir = mkdtempSync(join(tmpdir(), "a8n-api-check-"));
try {
  writeFileSync(
    join(workdir, "package.json"),
    `${JSON.stringify({ name: "api-check", private: true, type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  run("npm", ["install", "--silent", tarball], { cwd: workdir });

  const probePath = join(workdir, "api.mjs");
  writeFileSync(
    probePath,
    `
import { AfterEffects } from "${manifest.name}";
import { FakeAfterEffectsTransport } from "${manifest.name}/testing";

if (typeof AfterEffects !== "function") {
  throw new Error("AfterEffects is not exported as a function");
}
if (typeof AfterEffects.launch !== "function") {
  throw new Error("AfterEffects.launch is missing");
}

// The fake host exercises the same host script a real After Effects would run,
// so reaching a rendered PNG here means the whole chain — exports map, built
// driver, shipped host script, bridge protocol — is wired correctly.
const ae = await AfterEffects.launch({ transport: new FakeAfterEffectsTransport() });
const version = ae.info().version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("no host version reported");
}

const comps = await ae.comps();
await ae.close();
console.log("drove the public API; host version " + version + ", " + comps.length + " comp(s)");
`,
    "utf-8",
  );

  let output;
  try {
    output = run(process.execPath, [pathToFileURL(probePath).pathname], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error("::error::the public API did not work from an installed package");
    const stderr = String(error.stderr ?? "");
    const match = /Error: ([\s\S]*?)\n\s*at /.exec(stderr);
    console.error(match ? match[1] : stderr.trim() || String(error.message));
    process.exit(1);
  }
  console.log(`  ${String(output).trim()}`);
  console.log("\npublic API is usable as published.");
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
