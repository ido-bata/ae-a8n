/**
 * Merge-time revalidation for a release PR (`release-* -> main`).
 *
 *   node scripts/release-merge-preflight.js <pr-number> [--repo owner/name]
 *
 * The `release-gate` workflow proves the integration path when its check
 * runs, but a check result is a snapshot: RELEASE_TRAIN can change, the
 * train tip can move, or the check can go stale before the merge executor
 * acts. `pull_request_target` does not re-run on repository-variable
 * changes, so the workflow alone cannot close that window. This script is
 * the merge executor's second look: run it immediately before
 * `gh pr merge`, and merge only when it exits 0.
 *
 * It re-fetches every fact the gate relies on — PR base/head, the
 * RELEASE_TRAIN variable, the train branch tip, ahead_by, and the latest
 * check runs — and refuses on any mismatch. It performs no writes.
 */
import { execFileSync } from "node:child_process";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}
function ghJson(path) {
  return JSON.parse(gh(["api", path]));
}

const args = process.argv.slice(2);
const prIndex = args.findIndex((a) => /^\d+$/.test(a));
const repoIndex = args.indexOf("--repo");
if (prIndex < 0) {
  console.error("usage: node scripts/release-merge-preflight.js <pr-number> [--repo owner/name]");
  process.exit(2);
}
const prNumber = args[prIndex];
const repo =
  repoIndex >= 0
    ? args[repoIndex + 1]
    : gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);

function fail(msg) {
  console.error(`::error::preflight: ${msg}`);
  process.exit(1);
}

const pr = ghJson(`repos/${repo}/pulls/${prNumber}`);
if (pr.base?.ref !== "main") fail(`PR #${prNumber} base is ${pr.base?.ref}, not main`);
if (pr.base?.repo?.full_name !== pr.head?.repo?.full_name)
  fail("release PRs must come from a branch in this repository, not a fork");
if (pr.state !== "open") fail(`PR #${prNumber} is ${pr.state}`);

const train = gh(["variable", "get", "RELEASE_TRAIN", "--repo", repo]);
if (!/^[A-Za-z0-9._/-]+$/.test(train)) fail(`RELEASE_TRAIN is unset or invalid ('${train}')`);
if (pr.head?.ref !== train)
  fail(`PR head '${pr.head?.ref}' is not the current release train '${train}'`);

const tip = ghJson(`repos/${repo}/branches/${train}`).commit?.sha;
if (pr.head?.sha !== tip)
  fail(`PR head ${pr.head?.sha?.slice(0, 7)} is not the tip of ${train} (${tip?.slice(0, 7)}); synchronize the branch`);

const ahead = ghJson(`repos/${repo}/compare/main...${train}`).ahead_by;
if (ahead === 0) fail(`${train} is fully merged into main (ahead_by=0); RELEASE_TRAIN is stale`);

// Required checks must be green *on the current head SHA* — a pass on an
// older commit does not count.
const contexts = ["check", "release-tooling-windows", "windows"];
const runs = ghJson(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`).check_runs ?? [];
const latest = new Map();
for (const run of runs) {
  if (!contexts.includes(run.name)) continue;
  const prev = latest.get(run.name);
  if (!prev || new Date(run.started_at) > new Date(prev.started_at)) latest.set(run.name, run);
}
for (const ctx of contexts) {
  const run = latest.get(ctx);
  if (!run) fail(`required check '${ctx}' has no run on ${pr.head.sha.slice(0, 7)}`);
  if (run.status !== "completed" || run.conclusion !== "success")
    fail(`required check '${ctx}' is ${run.status}/${run.conclusion}, not success`);
}

console.log(
  `preflight ok: PR #${prNumber} (${train} @ ${pr.head.sha.slice(0, 7)}, ahead_by=${ahead}) — ` +
    `base=main, RELEASE_TRAIN matches, tip matches, required checks green on head SHA`,
);
