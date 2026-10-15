/**
 * Decides whether the publish workflow may publish this commit to npm.
 *
 *   node scripts/publish-gate.js <packed-tarball.tgz>   (from the package root)
 *
 * Inputs come from the workflow environment: GITHUB_EVENT_NAME,
 * GITHUB_REF_TYPE, GITHUB_REF_NAME, NPM_PUBLISH_VERSION (a repository
 * variable). Writes `publish=true|false`, `shasum=<sha1>` and
 * `registry=absent|present|unknown` to $GITHUB_OUTPUT, and fails the job
 * when something is inconsistent rather than merely "not this time".
 *
 * Why a script and not an environment with required reviewers: the
 * repository is private on GitHub Free, where required reviewers, wait timers
 * and deployment tag policies are not available. So the conditions live here,
 * and they are written so that publishing needs two separate deliberate acts —
 * setting NPM_PUBLISH_VERSION to the exact version, and pushing the tag — and
 * so that no version can be published twice:
 *
 * 1. Only a pushed tag `v<package version>` can publish.
 * 2. NPM_PUBLISH_VERSION must equal that version. "true", a stale previous
 *    version, or nothing at all mean "not now".
 * 3. A version already on the registry is never published again. If its tag
 *    is pushed (after the manual first publish, say), the commit must pack to
 *    the published tarball byte for byte, or the tag is pointing at something
 *    else and the job fails.
 * 4. The first version is published by a person with 2FA, never by CI.
 * 5. The tagged commit must be on main: what is published went through review.
 * 6. If the registry cannot be asked, nothing is published.
 *
 * These checks run inside the workflow, so they protect against mistakes, not
 * against someone with write access who edits this workflow on a branch and
 * tags it. On this plan nothing server-side can; see docs/releasing.md.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Published by hand with 2FA; CI never publishes it. */
export const MANUAL_FIRST_PUBLISH = "0.1.0-alpha.0";

/**
 * @typedef {{ state: "absent" } | { state: "present", shasum: string } | { state: "unknown", error: string }} RegistryState
 * @typedef {{
 *   event: string,
 *   refType: string,
 *   ref: string,
 *   version: string,
 *   approvedVersion: string,
 *   onMain: boolean,
 *   registry: RegistryState,
 *   packedShasum: string,
 * }} Facts
 * @typedef {{ action: "publish" | "skip" | "fail", reason: string }} Decision
 */

/**
 * @param {Facts} facts
 * @returns {Decision}
 */
export function decide(facts) {
  const { version, approvedVersion, registry } = facts;
  if (facts.event !== "push" || facts.refType !== "tag") {
    return { action: "skip", reason: `${facts.event} on ${facts.refType || "?"} ${facts.ref}: only a pushed version tag publishes` };
  }
  if (facts.ref !== `v${version}`) {
    return { action: "fail", reason: `tag ${facts.ref} does not match package version v${version}` };
  }
  const approved = approvedVersion === version;

  if (registry.state === "present") {
    if (registry.shasum !== facts.packedShasum) {
      return {
        action: "fail",
        reason: `${version} is already on npm with shasum ${registry.shasum}, but ${facts.ref} packs to ${facts.packedShasum}: the tag does not point at what was published`,
      };
    }
    if (approved) {
      return {
        action: "fail",
        reason: `${version} is already on npm (same tarball). Nothing to publish; NPM_PUBLISH_VERSION still says ${version} — clear it or set it to the next version`,
      };
    }
    return { action: "skip", reason: `${version} is already on npm and ${facts.ref} packs to the same tarball (shasum ${registry.shasum})` };
  }

  if (!approved) {
    const why = approvedVersion === "" ? "NPM_PUBLISH_VERSION is not set" : `NPM_PUBLISH_VERSION is ${JSON.stringify(approvedVersion)}, not ${JSON.stringify(version)}`;
    const registryNote = registry.state === "unknown" ? ` (registry state unknown: ${registry.error})` : "";
    return { action: "skip", reason: `${why}: not publishing ${version}${registryNote}` };
  }
  if (registry.state === "unknown") {
    return { action: "fail", reason: `cannot tell whether ${version} is on npm: ${registry.error}` };
  }
  if (version === MANUAL_FIRST_PUBLISH) {
    return { action: "fail", reason: `${version} is the first version and is published by hand with 2FA (docs/releasing.md), not by CI` };
  }
  if (!facts.onMain) {
    return { action: "fail", reason: `${facts.ref} is not on main: only reviewed, merged commits are published` };
  }
  return { action: "publish", reason: `${version} is approved, on main, and not yet on npm` };
}

/** The registry the gate asks: npm's `registry` setting when npm passes it on, else the public one. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/**
 * Asks the registry for one version's manifest over HTTP, as `npm view
 * <name>@<version> dist.shasum` does, without starting a child process: a
 * spawned `npm` is `npm.cmd` on Windows, which Node will not start without a
 * shell, so the gate could never see the registry there.
 *
 * @param {string} name
 * @param {string} version
 * @param {string} [registry]
 * @returns {Promise<RegistryState>}
 */
export async function registryState(name, version, registry = process.env.npm_config_registry || DEFAULT_REGISTRY) {
  // Scoped names keep the `@` and escape the `/`: /@scope%2fname/<version>.
  const url = new URL(`${name.replace("/", "%2f")}/${encodeURIComponent(version)}`, registry.endsWith("/") ? registry : `${registry}/`);
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const cause = /** @type {{ cause?: { code?: string }, name?: string, message?: string }} */ (error);
    return { state: "unknown", error: `GET ${url} failed: ${cause.cause?.code ?? cause.name ?? cause.message}` };
  }
  // The registry answers 404 both for an unknown package and an unknown
  // version. (It also does for a private package it may not show; npm
  // publish itself is the last word there.)
  if (response.status === 404) return { state: "absent" };
  if (!response.ok) return { state: "unknown", error: `GET ${url} answered ${response.status}` };
  /** @type {unknown} */
  let body;
  try {
    body = await response.json();
  } catch {
    return { state: "unknown", error: `GET ${url} answered ${response.status} with a body that is not JSON` };
  }
  const shasum = /** @type {{ dist?: { shasum?: unknown } } | null} */ (body)?.dist?.shasum;
  return typeof shasum === "string" && shasum !== ""
    ? { state: "present", shasum }
    : { state: "unknown", error: `GET ${url} answered without dist.shasum` };
}

async function main() {
  const tarball = process.argv[2];
  if (tarball === undefined) {
    console.error("usage: publish-gate.js <packed-tarball.tgz>");
    process.exit(2);
  }
  // The checkout being released, as the workflow runs it: the package root.
  const manifest = JSON.parse(readFileSync("package.json", "utf-8"));
  const packedShasum = createHash("sha1").update(readFileSync(tarball)).digest("hex");

  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const refType = process.env.GITHUB_REF_TYPE ?? "";
  const isTagPush = event === "push" && refType === "tag";
  let onMain = false;
  if (isTagPush) {
    // Needs a checkout with history and origin/main (fetch-depth: 0).
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdio: "ignore" });
      onMain = true;
    } catch {
      onMain = false;
    }
  }

  /** @type {Facts} */
  const facts = {
    event,
    refType,
    ref: process.env.GITHUB_REF_NAME ?? "",
    version: manifest.version,
    approvedVersion: (process.env.NPM_PUBLISH_VERSION ?? "").trim(),
    onMain,
    registry: await registryState(manifest.name, manifest.version),
    packedShasum,
  };
  const decision = decide(facts);
  console.log(JSON.stringify({ ...facts, decision }, null, 2));

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `publish=${decision.action === "publish"}\nshasum=${packedShasum}\nregistry=${facts.registry.state}\n`);
  }
  if (decision.action === "fail") {
    console.error(`::error::${decision.reason}`);
    process.exit(1);
  }
  console.log(`::notice::${decision.action}: ${decision.reason}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
