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
| `main-branch-protection` | `refs/heads/main` | pull request required, merge commit only, 0 approvals for now, review threads resolved; checks `check` (Linux) and `release-tooling-windows` (Windows) from GitHub Actions; no force push; no deletion; no linear-history rule; no bypass |
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
