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

/**
 * The dist-tag operations that make GitHub Packages point where npmjs
 * points. `sourceTags`/`targetTags` map tag → version; `presentVersions`
 * are the versions known to exist on GitHub Packages after this run.
 * A tag npmjs assigns to a version the mirror does not have is ignored —
 * the mirror never tags what it does not carry. A tag that exists only on
 * GitHub Packages is removed so `npm install <pkg>` resolves the same
 * default on both registries.
 *
 * @param {Record<string, string>} sourceTags npmjs dist-tags
 * @param {Record<string, string>} targetTags GitHub Packages dist-tags
 * @param {ReadonlySet<string>} presentVersions versions on GitHub Packages
 * @returns {{ add: { tag: string, version: string }[], remove: string[] }}
 */
export function planDistTagSync(sourceTags, targetTags, presentVersions) {
  const desired = new Map();
  for (const [tag, version] of Object.entries(sourceTags)) {
    if (presentVersions.has(version)) {
      desired.set(tag, version);
    }
  }
  const add = [];
  for (const [tag, version] of desired) {
    if (targetTags[tag] !== version) {
      add.push({ tag, version });
    }
  }
  const remove = Object.keys(targetTags).filter((tag) => !desired.has(tag));
  return { add, remove };
}

/** The --tag a publish should carry so the interim pointer is closest to npmjs. */
export function publishTagFor(version, sourceTags) {
  const tags = Object.entries(sourceTags)
    .filter(([, v]) => v === version)
    .map(([tag]) => tag)
    .sort();
  if (tags.includes("latest")) return "latest";
  return tags[0] ?? "next";
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
  // An empty answer means the registry has no dist-tags view for the
  // package (npm.pkg.github.com does not serve it for every package).
  // Callers decide whether empty is "none" or "cannot ask".
  return out.trim() === "" ? null : JSON.parse(out);
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

/** dist-tags as { tag: version }; an unseen package has none. */
function distTagsOn(registry, name) {
  try {
    const tags = npmView([name, "dist-tags"], registry);
    if (tags === null) {
      // npmjs must always answer dist-tags; an empty reply there means the
      // mirror cannot know where tags should point, so it must not guess.
      if (registry === undefined) {
        throw new Error(`npm view ${name} dist-tags answered empty on ${NPMJS_REGISTRY}`);
      }
      return {};
    }
    if (typeof tags !== "object" || Array.isArray(tags)) {
      return {};
    }
    return Object.fromEntries(Object.entries(tags).map(([tag, v]) => [tag, String(v)]));
  } catch (error) {
    const text = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    if (registry === GITHUB_PACKAGES_REGISTRY && /E404|404 Not Found/.test(text)) {
      return {};
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
  let sourceTags;
  let targetTags;
  try {
    sourceVersions = versionsOn(undefined, name);
    targetVersions = versionsOn(GITHUB_PACKAGES_REGISTRY, name);
    sourceTags = distTagsOn(undefined, name);
    targetTags = distTagsOn(GITHUB_PACKAGES_REGISTRY, name);
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
  if (decision.action === "skip" && dryRun) {
    console.log(`github-packages: ${decision.reason}`);
    return;
  }

  const toPublish = decision.action === "publish" ? decision.versions : [];
  const presentVersions = new Set([...targetVersions, ...toPublish]);
  const tagPlan = planDistTagSync(sourceTags, targetTags, presentVersions);

  if (dryRun) {
    if (decision.action === "skip") {
      console.log(`github-packages: ${decision.reason}`);
    }
    for (const version of toPublish) {
      console.log(`would publish ${name}@${version} to ${GITHUB_PACKAGES_REGISTRY}`);
    }
    for (const { tag, version } of tagPlan.add) {
      console.log(`would tag ${name}@${version} as ${tag} on ${GITHUB_PACKAGES_REGISTRY}`);
    }
    for (const tag of tagPlan.remove) {
      console.log(`would remove ${tag} from ${GITHUB_PACKAGES_REGISTRY}`);
    }
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "ae-a8n-gpr-"));
  try {
    for (const version of toPublish) {
      const { tarball, shasum } = distInfo(name, version);
      const file = join(work, `${name.replace("/", "-")}-${version}.tgz`);
      await download(tarball, file);
      const actual = createHash("sha1").update(readFileSync(file)).digest("hex");
      if (actual !== shasum) {
        fail(`${name}@${version}: downloaded tarball sha1 ${actual} does not match npmjs dist.shasum ${shasum}`);
      }
      // npm refuses a prerelease without an explicit tag; pick the tag npmjs
      // assigns to this version so the interim pointer is closest to the
      // canonical registry. planDistTagSync reconciles every tag afterwards.
      const publishArgs = [
        "publish",
        file,
        "--registry",
        GITHUB_PACKAGES_REGISTRY,
        "--tag",
        publishTagFor(version, sourceTags),
      ];
      npm(publishArgs, { stdio: "inherit" });
      console.log(`published ${name}@${version} to ${GITHUB_PACKAGES_REGISTRY} (sha1 ${shasum})`);
    }
    // Publishing can move `latest`/`next` to the wrong version; reconcile
    // dist-tags to npmjs's pointers for every version the mirror carries.
    for (const { tag, version } of tagPlan.add) {
      npm(["dist-tag", "add", `${name}@${version}`, tag, "--registry", GITHUB_PACKAGES_REGISTRY]);
      console.log(`tagged ${name}@${version} as ${tag} on ${GITHUB_PACKAGES_REGISTRY}`);
    }
    for (const tag of tagPlan.remove) {
      npm(["dist-tag", "rm", `${name}@${tag}`, "--registry", GITHUB_PACKAGES_REGISTRY]);
      console.log(`removed ${tag} from ${GITHUB_PACKAGES_REGISTRY}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
