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
 * check runs — and refuses on any mismatch or API failure. It performs no
 * writes. On success it prints the exact merge command, including
 * `--match-head-commit`, so the SHA it validated is the SHA that merges.
 *
 * `evaluatePreflight` is pure and unit-tested; the CLI half only fetches
 * the inputs and fails closed on any error.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_MAIN_CHECKS = ["check", "release-tooling-windows", "windows"];

/**
 * Decide whether a release PR may merge, from already-fetched facts.
 * Returns { ok: true, headSha } or { ok: false, reason }.
 *
 * @param {object} facts
 * @param {{ base?: { ref?: string, repo?: { full_name?: string } }, head?: { ref?: string, sha?: string, repo?: { full_name?: string } }, state?: string }} facts.pr
 * @param {string} facts.train           RELEASE_TRAIN variable value
 * @param {string} facts.tip             current tip SHA of the train branch
 * @param {number} facts.aheadBy         compare main...train ahead_by
 * @param {Array<{ name?: string, status?: string, conclusion?: string|null, started_at?: string, app?: { slug?: string }|null }>} facts.runs check runs on the head SHA
 */
export function evaluatePreflight({ pr, train, tip, aheadBy, runs }) {
  if (pr.base?.ref !== "main") return { ok: false, reason: `base is ${pr.base?.ref}, not main` };
  if (pr.base?.repo?.full_name !== pr.head?.repo?.full_name)
    return { ok: false, reason: "head is a fork, not a branch in this repository" };
  if (pr.state !== "open") return { ok: false, reason: `PR is ${pr.state}` };
  if (!/^[A-Za-z0-9._/-]+$/.test(train ?? ""))
    return { ok: false, reason: `RELEASE_TRAIN is unset or invalid ('${train}')` };
  if (pr.head?.ref !== train)
    return { ok: false, reason: `head '${pr.head?.ref}' is not the current release train '${train}'` };
  if (pr.head?.sha !== tip)
    return { ok: false, reason: `head ${pr.head?.sha?.slice(0, 7)} is not the tip of ${train} (${tip?.slice(0, 7)})` };
  if (aheadBy === 0) return { ok: false, reason: `${train} is fully merged into main (ahead_by=0); RELEASE_TRAIN is stale` };

  const latest = new Map();
  for (const run of runs ?? []) {
    if (!REQUIRED_MAIN_CHECKS.includes(run.name)) continue;
    if (run.app?.slug !== "github-actions") continue;
    const prev = latest.get(run.name);
    if (!prev || new Date(run.started_at) > new Date(prev.started_at)) latest.set(run.name, run);
  }
  for (const ctx of REQUIRED_MAIN_CHECKS) {
    const run = latest.get(ctx);
    if (!run) return { ok: false, reason: `required check '${ctx}' has no GitHub Actions run on the head SHA` };
    if (run.status !== "completed" || run.conclusion !== "success")
      return { ok: false, reason: `required check '${ctx}' is ${run.status}/${run.conclusion}, not success` };
  }
  return { ok: true, headSha: pr.head.sha };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}
function ghJson(path) {
  return JSON.parse(gh(["api", path]));
}

async function main() {
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

  try {
    const pr = ghJson(`repos/${repo}/pulls/${prNumber}`);
    const train = gh(["variable", "get", "RELEASE_TRAIN", "--repo", repo]);
    const verdict = evaluatePreflight({
      pr,
      train,
      tip: ghJson(`repos/${repo}/branches/${pr.head?.ref ?? ""}`).commit?.sha,
      aheadBy: ghJson(`repos/${repo}/compare/main...${pr.head?.ref ?? ""}`).ahead_by,
      runs: ghJson(`repos/${repo}/commits/${pr.head?.sha}/check-runs?per_page=100`).check_runs ?? [],
    });
    if (!verdict.ok) {
      console.error(`::error::preflight: ${verdict.reason}`);
      process.exit(1);
    }
    console.log(
      `preflight ok: PR #${prNumber} (${pr.head.ref} @ ${verdict.headSha}) — merge preconditions verified`,
    );
    console.log(`merge with: gh pr merge ${prNumber} --merge --match-head-commit ${verdict.headSha}`);
  } catch (error) {
    // Any API/parse failure is fail-closed: no merge on unverifiable state.
    console.error(
      `::error::preflight: could not verify merge preconditions: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
