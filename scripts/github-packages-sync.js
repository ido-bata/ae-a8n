/**
 * Mirrors versions that are already published on npmjs.com to GitHub
 * Packages (npm.pkg.github.com), so the repository's Packages tab shows the
 * same releases. npmjs.com stays the canonical registry; this script only
 * ever publishes bytes that came *from* npmjs — never a local build, never a
 * version npmjs does not have, never a version GitHub Packages already has.
 *
 *   node scripts/github-packages-sync.js [--version <v>] [--dry-run]
 *
 * The workflow (.github/workflows/github-packages.yml) runs this on manual
 * dispatch with GITHUB_TOKEN (packages: write). Auth for npm.pkg.github.com
 * comes from the runner's .npmrc; nothing here stores a credential.
 *
 * What it refuses rather than guesses:
 *   - a requested version that npmjs does not publish;
 *   - a tarball whose sha1 does not match the registry's dist.shasum;
 *   - republishing a version GitHub Packages already has (idempotent skip);
 *   - running without a way to ask the registries (a failed `npm view`
 *     aborts the run instead of publishing blind).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { get } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { npmCommand } from "./npm-cli.js";

export const NPMJS_REGISTRY = "https://registry.npmjs.org";
export const GITHUB_PACKAGES_REGISTRY = "https://npm.pkg.github.com";

/**
 * The versions this run may publish: every npmjs version GitHub Packages
 * lacks, or exactly `requested` when one is named. A requested version that
 * npmjs does not have is an error — this mirror never invents a release.
 *
 * @param {string[]} sourceVersions versions published on npmjs.com
 * @param {string[]} targetVersions versions already on GitHub Packages
 * @param {string | undefined} requested a single version, or undefined for all
 * @returns {{ action: "publish", versions: string[] } | { action: "fail", reason: string } | { action: "skip", reason: string }}
 */
export function selectSyncVersions(sourceVersions, targetVersions, requested) {
  const target = new Set(targetVersions);
  if (requested !== undefined) {
    if (!sourceVersions.includes(requested)) {
      return {
        action: "fail",
        reason: `${requested} is not published on npmjs.com; the GitHub Packages mirror only carries released versions`,
      };
    }
    if (target.has(requested)) {
      return { action: "skip", reason: `${requested} is already on GitHub Packages` };
    }
    return { action: "publish", versions: [requested] };
  }
  const missing = sourceVersions.filter((version) => !target.has(version));
  if (missing.length === 0) {
    return { action: "skip", reason: "every npmjs.com version is already on GitHub Packages" };
  }
  return { action: "publish", versions: missing };
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function npm(args, options = {}) {
  const { command, args: npmArgs } = npmCommand();
  return execFileSync(command, [...npmArgs, ...args], {
    encoding: "utf-8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

/** `npm view` as JSON; throws when the registry cannot answer. */
function npmView(args, registry) {
  const registryArgs = registry === undefined ? [] : ["--registry", registry];
  const out = npm(["view", ...args, "--json", ...registryArgs]);
  return JSON.parse(out);
}

function versionsOn(registry, name) {
  try {
    const versions = npmView([name, "versions"], registry);
    return Array.isArray(versions) ? versions.map(String) : [];
  } catch (error) {
    // A registry that has never seen the package answers 404, which for the
    // mirror means "empty", not "cannot ask". Any other failure still aborts
    // the run: a mirror that cannot check is not allowed to guess.
    const text = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    if (registry === GITHUB_PACKAGES_REGISTRY && /E404|404 Not Found/.test(text)) {
      return [];
    }
    throw error;
  }
}

function distInfo(name, version) {
  const dist = npmView([`${name}@${version}`, "dist"], NPMJS_REGISTRY);
  const tarball = dist?.tarball;
  const shasum = dist?.shasum;
  if (typeof tarball !== "string" || typeof shasum !== "string") {
    throw new Error(`npmjs has no dist.tarball/dist.shasum for ${name}@${version}`);
  }
  return { tarball, shasum };
}

function download(url, destination) {
  return new Promise((resolvePromise, reject) => {
    get(url, (response) => {
      if (response.statusCode !== 200 || response.statusCode === undefined) {
        response.resume();
        reject(new Error(`${url} answered HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        writeFileSync(destination, Buffer.concat(chunks));
        resolvePromise();
      });
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let requested;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--version") {
      requested = args[i + 1];
      i += 1;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else {
      fail(`unknown argument ${args[i]}; usage: node scripts/github-packages-sync.js [--version <v>] [--dry-run]`);
    }
  }
  if (requested !== undefined && requested.length === 0) {
    fail("--version needs a value");
  }

  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
  const name = manifest.name;
  if (typeof name !== "string" || !name.startsWith("@")) {
    fail("package.json has no scoped name to mirror");
  }

  let sourceVersions;
  let targetVersions;
  try {
    sourceVersions = versionsOn(undefined, name);
    targetVersions = versionsOn(GITHUB_PACKAGES_REGISTRY, name);
  } catch (error) {
    fail(
      `cannot ask the registries (${error instanceof Error ? error.message : String(error)}); ` +
        "nothing was published — a mirror that cannot check is not allowed to guess",
    );
  }

  const decision = selectSyncVersions(sourceVersions, targetVersions, requested);
  if (decision.action === "fail") {
    fail(decision.reason);
  }
  if (decision.action === "skip") {
    console.log(`github-packages: ${decision.reason}`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "ae-a8n-gpr-"));
  try {
    for (const version of decision.versions) {
      const { tarball, shasum } = distInfo(name, version);
      const file = join(work, `${name.replace("/", "-")}-${version}.tgz`);
      await download(tarball, file);
      const actual = createHash("sha1").update(readFileSync(file)).digest("hex");
      if (actual !== shasum) {
        fail(`${name}@${version}: downloaded tarball sha1 ${actual} does not match npmjs dist.shasum ${shasum}`);
      }
      if (dryRun) {
        console.log(`would publish ${name}@${version} to ${GITHUB_PACKAGES_REGISTRY} (sha1 ${shasum})`);
        continue;
      }
      // npm refuses a prerelease without an explicit tag; mirror it under the
      // same dist-tag convention npmjs uses (publishConfig.tag, "next"). A
      // stable version keeps npm's default (latest).
      const publishArgs = ["publish", file, "--registry", GITHUB_PACKAGES_REGISTRY];
      if (version.includes("-")) {
        const tag = manifest.publishConfig?.tag ?? "next";
        publishArgs.push("--tag", String(tag));
      }
      npm(publishArgs, { stdio: "inherit" });
      console.log(`published ${name}@${version} to ${GITHUB_PACKAGES_REGISTRY} (sha1 ${shasum})`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
