/**
 * Verify the published package, from a consumer's position.
 *
 * `npm pack` succeeding is not evidence the package is usable, and neither is
 * this repository's own test suite: every test here imports through relative
 * paths, so a broken `exports` map is invisible locally. The bug this was
 * written for is exactly that — `./testing` named `dist/testing.js` while
 * `tsc` emitted `dist/testing/index.js`, the suite stayed green, and every
 * consumer got `ERR_MODULE_NOT_FOUND`.
 *
 * So: pack, install into a clean project, and resolve the package the way a
 * consumer does — through the published exports map, with no source tree in
 * sight.
 *
 * This checks the *package surface* only. It deliberately does not drive the
 * automation API: that arrives in a later branch, and requiring it here would
 * make this script belong to a branch it does not describe. The API's own
 * end-to-end check is `scripts/check-public-api.js`.
 *
 * Run: node scripts/check-packed-package.js
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Symbols each entry point must export. Kept to what every branch in this
 * series provides, so the check is meaningful on the bridge-only branch as
 * well as on the one that adds the public API.
 */
const EXPECTED = {
  "@ido-bata/ae-a8n": ["A8N_VERSION"],
  "@ido-bata/ae-a8n/testing": ["FakeAfterEffectsTransport"],
};

/** Paths that must survive packing. `host/` is not produced by tsc. */
const REQUIRED_FILES = ["dist", "host", "package.json"];

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf-8", ...options });
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

console.log(`packing ${manifest.name}@${manifest.version}…`);
const tarballName = run("npm", ["pack", "--silent"], { cwd: PACKAGE_ROOT })
  .trim()
  .split("\n")
  .at(-1);
const tarball = join(PACKAGE_ROOT, tarballName);

const workdir = mkdtempSync(join(tmpdir(), "a8n-packed-check-"));
try {
  writeFileSync(
    join(workdir, "package.json"),
    `${JSON.stringify({ name: "packed-check", private: true, type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  run("npm", ["install", "--silent", tarball], { cwd: workdir });

  const installed = join(workdir, "node_modules", manifest.name);

  // 1. The tarball contains what the runtime needs.
  const probeSource = `
    const expected = ${JSON.stringify(EXPECTED)};
    const problems = [];
    for (const [specifier, symbols] of Object.entries(expected)) {
      let mod;
      try {
        mod = await import(specifier);
      } catch (error) {
        // The failure this check exists for: a specifier that the exports map
        // names but the build never produced.
        problems.push(specifier + " did not resolve: " + error.message);
        continue;
      }
      for (const symbol of symbols) {
        if (!(symbol in mod)) {
          problems.push(specifier + " does not export " + symbol);
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(problems.join("\\n"));
    }
    console.log("resolved " + Object.keys(expected).join(" and "));
  `;
  const probePath = join(workdir, "resolve.mjs");
  writeFileSync(probePath, probeSource, "utf-8");

  // 2. The installed tree has the directories the runtime reads at runtime.
  for (const required of REQUIRED_FILES) {
    if (!existsSync(join(installed, required))) {
      fail(`${required} is missing from the installed package — check "files" in package.json`);
    }
  }
  console.log(`installed package contains ${REQUIRED_FILES.join(", ")}`);

  // 3. Both entry points resolve through the published exports map, with no
  //    source tree in sight. This is the assertion that would have caught the
  //    `./testing` regression.
  //
  // The probe reports its failures as a thrown Error so the child process exits
  // non-zero; they are unwrapped here so CI shows the actual problem rather
  // than a stack trace pointing into a temporary directory.
  let output;
  try {
    output = run(process.execPath, [pathToFileURL(probePath).pathname], {
      cwd: workdir,
      // The child's stack trace points into a temporary directory that is about
      // to disappear. The useful line is re-emitted by `fail` below.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const match = /Error: ([\s\S]*?)\n\s*at /.exec(stderr);
    fail(match ? match[1] : stderr.trim() || String(error.message));
  }
  console.log(`  ${String(output).trim()}`);

  // 4. The installed copy is the build, not a stale one.
  const installedManifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf-8"),
  );
  if (installedManifest.version !== manifest.version) {
    fail(
      `installed version ${installedManifest.version} does not match ${manifest.version}`,
    );
  }

  console.log("\npacked package resolves as published.");
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
