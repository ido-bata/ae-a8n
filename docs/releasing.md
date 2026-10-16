# Releasing to npm

`@ido-bata/ae-a8n` is published under the `next` dist-tag. The first version
(`0.1.0-alpha.0`) is published by a person with 2FA. From `0.1.0-alpha.1` on,
the `publish` workflow *stages* each version with npm Trusted Publishing
(OIDC) and a person approves it with 2FA; no npm token exists anywhere.

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

## 0.1.0-alpha.1 and later: staged, then approved with 2FA

From `0.1.0-alpha.1` the workflow never publishes. It **stages** the verified
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
3. Repository variable `NPM_PUBLISH_VERSION` = `0.1.0-alpha.1`.
4. Tag the release commit on `main` and push the tag:
   `git tag -a v0.1.0-alpha.1 <sha> -m "0.1.0-alpha.1" && git push origin v0.1.0-alpha.1`.
5. The workflow verifies, the gate approves, `stage` stages. The run summary
   gives the stage id and shasum.
6. Review and approve, with 2FA:

   ```bash
   npm stage view <stage-id>         # version 0.1.0-alpha.1, tag next
   npm stage download <stage-id>     # prints the shasum: must equal the run's
   npm stage approve <stage-id>      # 2FA; publishes to next
   ```

   If anything is off: `npm stage reject <stage-id>` (2FA). The version
   number stays taken while staged; after a rejection, check `npm stage
   list` before reusing it.
7. Check: `npm view @ido-bata/ae-a8n@next version` and
   `npm view @ido-bata/ae-a8n@0.1.0-alpha.1 dist.shasum`.
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

## Not here yet

- Provenance: npm does not generate it for private repositories
  ([GitHub changelog][gh-prov]). It goes with making the repository public.
- `repository` and `homepage` point to the private repository, so the links
  on npmjs.com will be 404 for everyone outside the organisation.

[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gh-manage]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[npm-staged]: https://docs.npmjs.com/staged-publishing
[npm-stage]: https://docs.npmjs.com/cli/v11/commands/npm-stage
[gh-prov]: https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
