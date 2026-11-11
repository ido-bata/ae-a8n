/**
 * Release preconditions, checked before anything can be published.
 *
 *   node scripts/check-release.js [<tag>]
 *
 * - A pre-release version (x.y.z-anything) must publish under a non-default
 *   dist-tag ("next"), so `npm install @ido-bata/ae-a8n` never picks it up.
 * - Provenance stays off while the source repository is private: npm refuses
 *   provenance from a private repository. Turning it on is part of making the
 *   repository public, not of this check.
 * - A tag, when given, must be exactly `v<version>`.
 * - The exported A8N_VERSION constant must equal the package version.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const problems = [];

const version = manifest.version;
const prerelease = /^\d+\.\d+\.\d+-.+$/.test(version);
const tag = manifest.publishConfig?.tag;
if (prerelease && (tag === undefined || tag === "latest")) {
  problems.push(`pre-release ${version} must publish under a non-default dist-tag (publishConfig.tag), not ${tag ?? "latest"}`);
}
if (manifest.publishConfig?.provenance !== false) {
  problems.push("publishConfig.provenance must be false while the repository is private");
}
if (manifest.publishConfig?.access !== "public") {
  problems.push("publishConfig.access must be public for a scoped package");
}
// The constant is declared in src/version.ts and re-exported from src/index.ts
// (#70), so the gate looks where it is declared rather than assuming the file
// that happens to hold it today. A tree older than that move has no
// src/version.ts, and the lookup keeps working there.
const DECLARATION = /export const A8N_VERSION = "([^"]+)"/;
const constant = ["src/version.ts", "src/index.ts"]
  .filter((file) => existsSync(join(root, file)))
  .map((file) => DECLARATION.exec(readFileSync(join(root, file), "utf-8"))?.[1])
  .find((value) => value !== undefined);
if (constant !== version) {
  problems.push(`A8N_VERSION is ${constant}, package.json says ${version}`);
}
const gitTag = process.argv[2];
if (gitTag !== undefined && gitTag !== "" && gitTag !== `v${version}`) {
  problems.push(`tag ${gitTag} does not match v${version}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`${manifest.name}@${version} → dist-tag "${tag ?? "latest"}"${gitTag ? `, tag ${gitTag}` : ""}: ok`);
