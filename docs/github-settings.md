# GitHub settings

What this repository's GitHub settings are meant to be, and which of them
are applied by a script. Read back through the API on 2026-10-17.

## Repository settings (applied by hand, through the API)

| Setting | Value |
| --- | --- |
| Merge methods | merge commit only (squash and rebase off) |
| Delete head branches after merge | on |
| Auto-merge | off |
| `GITHUB_TOKEN` default permissions | read (`default_workflow_permissions: read`) |
| Actions may approve pull requests | no (`can_approve_pull_request_reviews: false`) |
| Fork pull request workflows | approval needed for first-time contributors |

Check them:

```bash
gh api repos/OWNER/REPO -q '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge}'
gh api repos/OWNER/REPO/actions/permissions/workflow
```

Workflows ask for what they need per job: `contents: read` everywhere, and
`id-token: write` only on the publish workflow's `stage` job (npm Trusted
Publishing). The read-only default does not take that away: a job's own
`permissions:` wins over the default.

## Rulesets (applied by `scripts/github-rulesets.js`)

| Ruleset | Refs | Rules |
| --- | --- | --- |
| `main-branch-protection` | `refs/heads/main` | pull request required, merge commit only, 0 approvals for now, review threads resolved; checks `check` (Linux), `release-tooling-windows` and `windows` (Windows) from GitHub Actions; no force push; no deletion; no linear-history rule; no bypass |
| `release-tag-protection` | `refs/tags/v*` | no update (a tag is never moved), no force push, no deletion; creating a tag is allowed; no bypass |

```bash
node scripts/github-rulesets.js                 # dry run: prints what would change
node scripts/github-rulesets.js --apply         # create or update, then read back
```

It needs `gh` logged in as a repository admin. It refuses to apply while
the repository is private (GitHub Free does not enforce rulesets there). It
also refuses if a required check did not run, from GitHub Actions, on the
latest pull request. It matches rulesets by name and target, so a second run
changes nothing. Other rulesets are left alone.

## Release-only integration gate

`main` accepts only the current release train's PR. The canonical train is
the repository variable `RELEASE_TRAIN` (currently `release-0-3-0`), not a
branch-name pattern — a spoofed `release-*` head fails the gate.

`.github/workflows/release-gate.yml` runs on `pull_request_target`, so the
workflow definition always comes from `main` and a PR cannot weaken it by
editing workflow files in its head. It never checks out head code; it only
compares PR metadata and repository state passed through environment
variables: same-repo head, `head.ref == RELEASE_TRAIN` (read via the
`vars` context — no extra token permission needed), `head.sha ==` the
train branch tip, and `main...train` `ahead_by > 0` so a fully merged
(stale) train stops authorizing integrations. An unset, empty or
non-branch-name `RELEASE_TRAIN` fails closed.

### Merge-time preflight

The gate proves the path when its check runs; it cannot re-run when
`RELEASE_TRAIN` changes or when a stale check result outlives a branch
update. The merge executor therefore revalidates immediately before
merging:

```bash
node scripts/release-merge-preflight.js <release-pr-number>
gh pr merge <release-pr-number> --merge --match-head-commit <sha>
```

The script re-fetches the PR base/head, the `RELEASE_TRAIN` variable,
the train tip, `ahead_by`, and the latest required-check runs **on the
current head SHA** — counting only check runs reported by the
`github-actions` app — and exits non-zero on any mismatch or API
failure. On success it prints the exact merge command with
`--match-head-commit`, so the SHA it validated is the SHA that merges;
any head update after preflight invalidates the merge. The decision
logic is `evaluatePreflight`, unit-tested against counterexamples in
`test/release-merge-preflight.test.ts`. Merge only on exit 0, and only
with explicit human authorization — the script checks the integration
path, not approval.

The gate does not decide release *approval* — that remains the explicit
human authorization at merge time. It only proves the integration path.

Train lifecycle: after a release PR merges, `RELEASE_TRAIN` still names
the merged train until it is re-pointed. The `ahead_by = 0` check makes
the stale value harmless — it rejects rather than silently accepting —
but the correct sequence when opening the next train is: create
`release-x-y-z` from `main` HEAD → `gh variable set RELEASE_TRAIN
--body release-x-y-z` → update the train references in `AGENTS.md` /
`CLAUDE.md` → open the Draft release PR.

Bootstrap note: `pull_request_target` only runs workflows that exist on
`main`, so `release-gate` is not a required check until the first release
PR carrying it merges. The post-merge activation sequence is:

1. Merge the release PR (explicit human authorization).
2. In a ticket PR, add `"release-gate"` to `REQUIRED_CHECKS` in
   `scripts/github-rulesets.js`, merge it into the *next* train, and run
   `node scripts/github-rulesets.js --apply` — the ruleset update only
   takes effect for PRs opened after it applies, so verify on a fresh PR
   that the `release-gate` check run is attached to the PR's head commit
   (`gh pr checks <n>`), not merely that the workflow file exists.
3. Counterexample verification on throwaway PRs to `main`: arbitrary
   branch, spoofed `release-*` name, stale `RELEASE_TRAIN`, and a PR
   whose head edits `release-gate.yml` — each must fail `release-gate`.
4. If activation fails (check never reported, wrong commit, ruleset
   rejected), the recovery is: fix the workflow or ruleset on `main` via
   a release PR, re-run `--apply`, and re-verify — never bypass the
   required check and never merge `main` directly to "unstick" it.

The required checks name the CI jobs, not the workflow. If a job in
`.github/workflows/ci.yml` is renamed, change `REQUIRED_CHECKS` in the same
pull request, then re-run the script after merging. Until then, main waits
for a check that no longer runs. The checks are tied to GitHub Actions'
app id (15368), so no other installed app can satisfy them by reporting a
status with the same name.

Nobody can bypass these rulesets, including admins. Every change to main
goes through a pull request, and a release tag that points at the wrong
commit is fixed with a new version, never by moving the tag. To change a
rule, edit the script, merge, and re-run it.
