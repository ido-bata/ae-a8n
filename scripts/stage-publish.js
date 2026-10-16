/**
 * Stages the verified tarball on npm (npm Staged Publishing). It does not
 * publish: a maintainer approves the staged version with 2FA, and only then
 * is it installable.
 *
 *   node scripts/stage-publish.js <tarball.tgz> --expect-shasum <sha1> [--dry-run] [npm args...]
 *
 * Run from the package root. npm is started as `node <npm-cli.js>`, never
 * through a shell (scripts/npm-cli.js). Before anything is sent it checks:
 * - the npm CLI is the pinned one (NPM_CLI_VERSION, when set) and new enough
 *   for `npm stage` (11.15.0);
 * - the tarball is the one the gate checked (sha1);
 * - the dist-tag is `next`, the same as package.json publishConfig.tag.
 *
 * The tag is passed explicitly: `npm stage publish` takes publishConfig.tag
 * into the request, but its own log line reports only the command-line tag,
 * so without the flag the log says "latest" while the request says "next"
 * (npm 11.19.1). A staged package's tag cannot be changed afterwards.
 *
 * After npm answers it checks the reported name, version and shasum again,
 * and that a stage id came back. Writes `stage-id` to $GITHUB_OUTPUT and the
 * approval steps to $GITHUB_STEP_SUMMARY.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import { npmCommand } from "./npm-cli.js";

export const DIST_TAG = "next";
export const MINIMUM_NPM = "11.15.0";

/** @param {string} a @param {string} b */
export function versionAtLeast(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** @param {string} message */
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const tarball = args.shift();
  const expectIndex = args.indexOf("--expect-shasum");
  if (tarball === undefined || expectIndex === -1 || args[expectIndex + 1] === undefined) {
    console.error("usage: stage-publish.js <tarball.tgz> --expect-shasum <sha1> [--dry-run] [npm args...]");
    process.exit(2);
  }
  const expected = args[expectIndex + 1];
  args.splice(expectIndex, 2);
  const dryRun = args.includes("--dry-run");

  // npm runs as `node <npm-cli.js>`, never through a shell (scripts/npm-cli.js).
  let npm;
  try {
    npm = npmCommand();
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }
  const probe = spawnSync(npm.command, [...npm.args, "--version"], { encoding: "utf-8" });
  if (probe.status !== 0 || typeof probe.stdout !== "string" || probe.stdout.trim() === "") {
    fail(`could not run the npm CLI at ${npm.args[0]}: ${probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`}`);
  }
  const npmVersion = probe.stdout.trim();
  const pinned = process.env.NPM_CLI_VERSION;
  if (pinned !== undefined && pinned !== "" && npmVersion !== pinned) {
    fail(`npm is ${npmVersion}, the workflow pins ${pinned}`);
  }
  if (!versionAtLeast(npmVersion, MINIMUM_NPM)) {
    fail(`npm ${npmVersion} has no \`npm stage\`; ${MINIMUM_NPM} or later is needed`);
  }

  const actual = createHash("sha1").update(readFileSync(tarball)).digest("hex");
  if (actual !== expected) {
    fail(`${tarball} has shasum ${actual}, not the ${expected} that was verified`);
  }

  const manifest = JSON.parse(readFileSync("package.json", "utf-8"));
  if (manifest.publishConfig?.tag !== DIST_TAG) {
    fail(`publishConfig.tag is ${manifest.publishConfig?.tag}, but staging uses ${DIST_TAG}`);
  }

  const result = spawnSync(
    npm.command,
    [...npm.args, "stage", "publish", tarball, "--tag", DIST_TAG, "--access", "public", "--provenance=false", "--json", ...args],
    { encoding: "utf-8" },
  );
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    fail(`npm stage publish exited ${result.status}`);
  }
  if (!new RegExp(`Staging to \\S+ with tag ${DIST_TAG} and public access`).test(result.stderr)) {
    fail(`npm did not report staging with tag ${DIST_TAG}`);
  }

  /** @type {Record<string, { name: string, version: string, shasum: string, stageId?: string }>} */
  const report = JSON.parse(result.stdout);
  const staged = report[manifest.name];
  if (staged === undefined) fail(`npm reported nothing for ${manifest.name}`);
  if (staged.version !== manifest.version) fail(`npm staged ${staged.version}, package.json is ${manifest.version}`);
  if (staged.shasum !== expected) fail(`npm staged shasum ${staged.shasum}, expected ${expected}`);
  if (!dryRun && (staged.stageId === undefined || staged.stageId === "")) fail("npm returned no stage id");

  const id = `${manifest.name}@${manifest.version}`;
  const stageId = staged.stageId ?? "(dry run)";
  console.log(`${dryRun ? "would stage" : "staged"} ${id} with tag ${DIST_TAG}, shasum ${expected}, stage id ${stageId}`);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stage-id=${stageId}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && !dryRun) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## ${id} is staged, not published`,
        "",
        `Stage id \`${stageId}\`, dist-tag \`${DIST_TAG}\`, shasum \`${expected}\`.`,
        "A maintainer approves it with 2FA (docs/releasing.md):",
        "",
        "```bash",
        `npm stage view ${stageId}`,
        `npm stage download ${stageId}   # its shasum must be ${expected}`,
        `npm stage approve ${stageId}`,
        "```",
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1]?.endsWith("stage-publish.js")) {
  main();
}
