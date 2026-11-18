# Releasing to npm

`@ido-bata/ae-a8n` is published under the `next` dist-tag. The first version
(`0.1.0-alpha.0`) is published by a person with 2FA. From `0.1.0-alpha.2` on,
the `publish` workflow *stages* each version with npm Trusted Publishing
(OIDC) and a person approves it with 2FA; no npm token exists anywhere.

`0.1.0-alpha.1` is a spent number: its tag `v0.1.0-alpha.1` points at an older
commit and the version was never published. Versions are immutable, so the
first staged release is `0.1.0-alpha.2` and `alpha.1` is not reused.

**Next vs latest.** Everything this document stages goes to the `next`
dist-tag — that is a publish, not a promotion. Moving `latest` is a separate
act that requires the cross-platform real-host evidence gate (#75, T093):
both platforms' evidence files tied to the exact candidate commit and
tarball. A `0.x` version is an early-development release: its unverified
scope is stated in README, CHANGELOG, the package description and the
evidence record rather than encoded in a prerelease suffix
(`docs/consumer-acceptance.md` §4). `scripts/check-release.js` enforces the
`next`-only publish config (`tag`, `provenance`, `access`) and the tag =
`v<version>` precondition. `scripts/evidence-gate.js` (below) enforces the
cross-platform evidence contract mechanically; whether the evidence behind
a record is sufficient remains the human release judgement.

## What stops an accidental or double publish

The repository is private and the organisation is on GitHub Free. On that
plan environments cannot be configured for private repositories at all
([managing environments][gh-manage]); required reviewers and wait timers need
a public repository on every plan below Enterprise ([environments][gh-env]);
and branch protection and rulesets answer this repository's API with 403
"Upgrade to GitHub Pro or make this repository public". A workflow that names
an environment that does not exist creates it, "with no protection rules"
([managing environments][gh-manage]), so an `environment: npm` line would
look like a gate without being one. The workflow therefore names no
environment, and the conditions live in
[`scripts/publish-gate.js`](../scripts/publish-gate.js), tested in
`test/publish-gate.test.ts`:

| Condition | Otherwise |
| --- | --- |
| The run is a pushed tag `v<package.json version>` | skip (pull requests, dispatch, branches); fail on a mismatched tag |
| Repository variable `NPM_PUBLISH_VERSION` equals that version exactly | skip — `"true"`, an older version or nothing all mean "not now" |
| The version is not on npm yet | never published again; if the tagged commit packs to a different tarball than the one on npm, fail |
| The version is not `0.1.0-alpha.0` | fail — that one is published by hand |
| The tagged commit is an ancestor of `main` | fail |
| npm could be asked | fail (when approved) |
| The tarball `stage` uploads has the shasum the gate checked | fail |

So a release takes three separate, deliberate acts — setting the variable to
the exact version, pushing the tag, and approving the staged version with
2FA on npm — and no one of them publishes anything alone.

**What this does not protect against.** The gate runs inside the workflow.
Someone with write access can edit the workflow on a branch, tag that, and
the npm trusted publisher (which checks the repository and the workflow file
name, not the ref) would accept it. GitHub Free has no server-side control
for this in a private repository. Today the organisation has one member. The
server-side options, all decisions for the owner rather than for this
workflow:

- GitHub Team: an `npm` environment limited to `v*` tags, a tag ruleset
  saying who may create `v*` tags, and the npm trusted publisher bound to
  environment `npm`.
- GitHub Enterprise Cloud: the above plus required reviewers.
- Making the repository public: all of the above on any plan, and provenance.

## The tarball is reproducible

`npm pack` of the same commit gives the same bytes on macOS and on the
GitHub runner (`0.1.0-alpha.0` from 78ed671: shasum
`459a618f74a3e7937fe794f2343497d729c0ed90`, both places). The gate relies on
this to check that a tag points at what was published, and the manual
publish below relies on it to publish exactly what CI verified.

## 0.1.0-alpha.0: published by hand

Prerequisites: the `ido-bata` organisation on npmjs.com, your npm account a
member with publish rights and 2FA on. Everything up to step 4 is merged.

1. Merge the release stack into `main` (merge commits; squash and rebase are
   disabled on this repository). The commit to publish is the resulting
   `main` head.
2. Run the `publish` workflow by hand on `main` (Actions → publish → Run
   workflow). It never publishes from a dispatch; it verifies and packs. Note
   the `shasum` in its **Pack** step.
3. Build the same commit locally and compare:

   ```bash
   git switch --detach <main sha> && git status --short   # must be clean
   npm ci && npm run build
   npm pack                                                 # prints shasum
   ```

   The shasum must equal step 2's. If not, stop: something differs between
   the two builds.
4. Publish that tarball:

   ```bash
   npm publish ./ido-bata-ae-a8n-0.1.0-alpha.0.tgz --tag next --access public --provenance=false
   ```

   npm asks for the 2FA code.
5. Check: `npm view @ido-bata/ae-a8n@next version` → `0.1.0-alpha.0`, and
   `npm view @ido-bata/ae-a8n@0.1.0-alpha.0 dist.shasum` → the shasum above.
6. Tag the published commit and push the tag:

   ```bash
   git tag -a v0.1.0-alpha.0 <main sha> -m "0.1.0-alpha.0"
   git push origin v0.1.0-alpha.0
   ```

   The workflow runs, finds the version on npm, checks the commit packs to
   the published shasum, and does not publish. `NPM_PUBLISH_VERSION` stays
   unset. (Were it set to `0.1.0-alpha.0`, the gate fails rather than
   publishes.)

The tag comes **after** the publish, so the tag always means "this is what is
on npm".

## 0.1.0-alpha.2 and later: staged, then approved with 2FA

From `0.1.0-alpha.2` the workflow never publishes. It **stages** the verified
tarball with `npm stage publish` through Trusted Publishing, and a maintainer
publishes it by approving the staged version with 2FA
([staged publishing][npm-staged], [`npm stage`][npm-stage]). An OIDC token
cannot approve. The trusted publisher is configured **stage-only**, so the
registry refuses a plain `npm publish` from this workflow too.

Pinned and checked by `scripts/stage-publish.js` (tested against a recording
registry with the real npm CLI in `test/stage-publish.test.ts`):

- npm CLI `NPM_CLI_VERSION` in `publish.yml` (11.19.1), installed in both
  jobs and compared exactly. `npm stage` needs 11.15.0 or later.
- Dist-tag `next`, passed explicitly. A staged package's tag cannot be
  changed later. Without the flag, npm 11.19.1 still sends `next` (from
  `publishConfig.tag`), but its log line says "latest".
- The uploaded tarball is the one `verify` built and the gate checked (sha1
  before sending, and again from npm's report).
- A version already on npm is not staged (the gate), and the registry
  refuses a version that is already staged or published ("Staged packages
  share the same semver version unique index as published packages"). npm's
  own client-side "cannot publish over" check ignores prerelease versions
  (npm 11.19.1 `lib/commands/publish.js`), so for alphas it is the gate and
  the registry that stop a duplicate, not the CLI.

Steps:

1. A pull request to `main` that bumps `package.json` `version`, the
   `A8N_VERSION` constant in `src/index.ts` (a test keeps them equal), and
   `CHANGELOG.md`. That merge commit is the release commit.
2. Trusted publisher, stage-only, with 2FA (npm ≥ 11.15.0):

   ```bash
   npm trust github @ido-bata/ae-a8n --file publish.yml \
     --repository ido-bata/ae-a8n --allow-stage-publish
   ```

   (or npmjs.com → package → Settings → Trusted publishing, with only
   "stage publish" allowed). No environment: see above. A configuration
   not used within 2 days expires ([npm][npm-tp]), so do this when the
   release is ready. `repository.url` in `package.json` must match the
   repository.
3. Repository variable `NPM_PUBLISH_VERSION` = `0.1.0-alpha.2`.
4. Tag the release commit on `main` and push the tag:
   `git tag -a v0.1.0-alpha.2 <sha> -m "0.1.0-alpha.2" && git push origin v0.1.0-alpha.2`.
5. The workflow verifies, the gate approves, `stage` stages. The run summary
   gives the stage id and shasum.
6. Review and approve, with 2FA:

   ```bash
   npm stage view <stage-id>         # version 0.1.0-alpha.2, tag next
   npm stage download <stage-id>     # prints the shasum: must equal the run's
   npm stage approve <stage-id>      # 2FA; publishes to next
   ```

   If anything is off: `npm stage reject <stage-id>` (2FA). The version
   number stays taken while staged; after a rejection, check `npm stage
   list` before reusing it.
7. Check: `npm view @ido-bata/ae-a8n@next version` and
   `npm view @ido-bata/ae-a8n@0.1.0-alpha.2 dist.shasum`.
8. Delete `NPM_PUBLISH_VERSION`.
9. Once staging has worked: package Settings → Publishing access →
   **Require two-factor authentication and disallow tokens**.

If `stage` fails after the gate approved, check `npm stage list
@ido-bata/ae-a8n` before anything else: a version that did get staged
cannot be staged again. Re-run the failed job of that same run; do not move
the tag to another commit — that is a new version.

Not verified before the first real use: staging through OIDC against the
real registry, what `npm stage view` shows, and how long a staged version
waits (npm's documentation does not say).

## Promoting `latest`: the cross-platform evidence gate (#75)

Staging under `next` is a publish; moving the `latest` dist-tag is a
promotion and needs real-host evidence on **both** supported platforms.
`scripts/evidence-gate.js` is that gate. It is a manual release step — it
runs on the maintainer's machine against the exact candidate, not inside
the publish workflow — and it fails closed: a missing, malformed, stale or
failed record denies with a named reason.

One record per platform lives at `docs/evidence/platforms/<platform>.json`
(`macos`, `windows`):

```json
{
  "schemaVersion": 1,
  "platform": "macos",
  "commit": "<full sha of the candidate commit>",
  "tarballSha256": "<sha256 hex of the packed tarball>",
  "recordedAt": "2026-11-18",
  "verdict": "pass",
  "evidence": "docs/evidence/<run directory or file>"
}
```

`commit` and `tarballSha256` bind the record to the candidate; a record
naming any other commit or hash is stale and denies. `verdict` is `pass`,
`unverified` or `fail`. The record is written by the human release step
from the acceptance run (`docs/evidence/` directories hold the underlying
evidence); the gate only enforces that the record exists, parses, is
current and says what it claims.

Run it against the packed candidate tarball:

```bash
npm pack
node scripts/evidence-gate.js --dist-tag next \
  --commit "$(git rev-parse HEAD)" --tarball ./ido-bata-ae-a8n-<version>.tgz
# and again with --dist-tag latest before any latest promotion
```

Rules (`scripts/evidence-gate.js`, tested in `test/release-gate.test.ts`):

- `latest`: every platform record must be present, well-formed, bound to
  the candidate commit and tarball, and `verdict: "pass"`. Anything less
  denies.
- The declarations are read from the checkout, so the CLI refuses when
  `git rev-parse HEAD` there differs from `--commit`: the README and
  package description that excuse an `unverified` Windows record must be
  the candidate's own words, not a later checkout's.
- `next`: the same currency and integrity requirements hold, but Windows
  may be `verdict: "unverified"` — and only while the package description
  **and** README still declare that Windows real-host evidence is
  missing. The gate checks the declaration itself; removing it while the
  record stays `unverified` denies. `unverified` is not accepted for
  macOS, and `fail` is never accepted.
- The published tarball's SHA-256 is the one the records were written
  against: the gate hashes the `.tgz` it is given, and `stage-publish.js`
  separately refuses a tarball whose sha1 differs from the one the gate
  and registry saw.

### The managed promotion command

`latest` is moved only through `scripts/promote-dist-tag.js`, which runs
the gate itself — a promotion attempted through the documented procedure
cannot skip it:

```bash
node scripts/promote-dist-tag.js --version <version> --commit <full sha> --dry-run
node scripts/promote-dist-tag.js --version <version> --commit <full sha>
```

Before the gate runs, the script re-proves the candidate three ways:
`v<version>` resolves to `--commit`, the version's npm manifest carries
`gitHead` equal to `--commit`, and the hashed tarball is the one
`npm pack <pkg>@<version>` downloads from the registry — not a locally
rebuilt file. Only on `allow` does it run
`npm dist-tag add <pkg>@<version> latest` (your npm credentials, your
2FA — the authorization boundary is unchanged). `test/promote-dist-tag.test.ts`
pins that a deny never reaches the dist-tag call.

What this does **not** protect against is the same residual the publish
gate documents: anyone holding npm publish credentials can still run
`npm dist-tag` by hand. The script removes the *accidental* bypass, not
the determined one; the server-side fix is the same owner decision listed
under "What stops an accidental or double publish".

## GitHub Packages mirror (#117)

Every version published on npmjs.com can also be mirrored to GitHub Packages
(`npm.pkg.github.com`) so the repository's Packages tab lists the releases.
npmjs.com stays the canonical registry — the mirror only carries bytes that
came from it.

After a version is actually published on npmjs (staged approval included),
run the `github-packages` workflow by hand (Actions → github-packages → Run
workflow). It is dispatch-only on purpose: it never fires on a tag push, and
`scripts/github-packages-sync.js` refuses to publish anything npmjs does not
already serve. The script:

- lists npmjs versions and GitHub Packages versions and publishes only the
  difference (or just `--version <v>` when one is named);
- downloads each version's `dist.tarball` straight from the npmjs registry
  and refuses it unless its sha1 equals the registry's `dist.shasum`, so the
  mirrored bytes are provably the published bytes;
- skips versions GitHub Packages already has, so re-running is safe;
- aborts when either registry cannot be asked — a mirror that cannot check
  never guesses.

Auth is the workflow's `GITHUB_TOKEN` (`packages: write`); no long-lived
token is stored. The package links to this repository through the
`repository` field in `package.json`, which is what puts it under the
Packages tab. Verification of the live mirror (registry answers + Packages
tab entry) is recorded on #117 separately from this implementation.

## Not here yet

- Provenance: npm does not generate it for private repositories
  ([GitHub changelog][gh-prov]). It goes with making the repository public.
- `repository` and `homepage` point to the private repository, so the links
  on npmjs.com will be 404 for everyone outside the organisation.
- Real `docs/evidence/platforms/` records: they are produced per candidate
  by the acceptance runs; until they exist the gate denies, which is the
  intended fail-closed state.

[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gh-manage]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[npm-staged]: https://docs.npmjs.com/staged-publishing
[npm-stage]: https://docs.npmjs.com/cli/v11/commands/npm-stage
[gh-prov]: https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
