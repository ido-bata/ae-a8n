# Releasing to npm

`@ido-bata/ae-a8n` is published under the `next` dist-tag. The first version
(`0.1.0-alpha.0`) is published by a person with 2FA. From `0.1.0-alpha.1` on,
the `publish` workflow publishes with npm Trusted Publishing (OIDC), and no
npm token exists anywhere.

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
| The tarball `publish` uploads has the shasum the gate checked | fail |

So a release takes two separate, deliberate acts — setting the variable to the
exact version and pushing the tag — and neither alone publishes anything.

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

## 0.1.0-alpha.1 and later: Trusted Publishing

1. A pull request to `main` that bumps `package.json` `version`, the
   `A8N_VERSION` constant in `src/index.ts` (a test keeps them equal), and
   `CHANGELOG.md`. That merge commit is the release commit.
2. On npmjs.com → the package → Settings → Trusted publishing → GitHub
   Actions: organisation `ido-bata`, repository `ae-a8n`, workflow
   `publish.yml`, **environment empty**. A configuration that is not used
   within 2 days expires ([npm][npm-tp]), so do this when the release is
   ready, not ahead of time. `repository.url` in `package.json` must match
   the repository.
3. Repository → Settings → Secrets and variables → Actions → Variables:
   `NPM_PUBLISH_VERSION` = `0.1.0-alpha.1`.
4. Tag the release commit on `main` and push the tag:
   `git tag -a v0.1.0-alpha.1 <sha> -m "0.1.0-alpha.1" && git push origin v0.1.0-alpha.1`.
5. The workflow verifies, the gate approves, `publish` publishes with OIDC.
   Check with `npm view @ido-bata/ae-a8n@next version`.
6. Delete `NPM_PUBLISH_VERSION` (or leave it: the gate will not publish that
   version again, and fails loudly if its tag is pushed while it is still
   set).
7. After the first trusted publish succeeds: package Settings → Publishing
   access → **Require two-factor authentication and disallow tokens**.

If the publish job fails after the gate approved, nothing was published
unless `npm view` says so. Fix the cause, then re-run the failed jobs of that
same run; do not move the tag to another commit — that is a new version.

## Not here yet

- Provenance: npm does not generate it for private repositories
  ([GitHub changelog][gh-prov]). It goes with making the repository public.
- `repository` and `homepage` point to the private repository, so the links
  on npmjs.com will be 404 for everyone outside the organisation.

[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gh-manage]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[gh-prov]: https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
