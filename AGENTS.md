# ae-a8n — agent contract

Programmatic automation runtime and API for Adobe After Effects.

Scope authority: `README.md` (Scope) and `docs/vision.md`.
Delivery policy: [`rebuildup/project-init`](https://github.com/rebuildup/project-init) Constitution + current release-driven profile.

## What this repo owns

- After Effects process lifecycle (launch / close)
- project / comp / layer / effect / parameter operations
- render, and retrieval of results and errors
- the programmatic API that higher-level tools consume
- the bridge protocol and transport contract, when one is needed

## What this repo does not own

- test DSL / assertion / snapshot runner → `ido-bata/ae-test`
- remote worker / queue / GitHub integration → `ido-bata/ae-farm`
- dev-tooling UX → `ido-bata/ae-devtools` (a separate axis; **no shared-core dependency in either direction**)

The series is `ae-a8n → ae-test → ae-farm`. Do not introduce a dependency that inverts or merges these.

## Delivery

- `main` = released state. Current integration line: `release-0-1-0`.
- 1 top-level Issue = 1 number-only branch = 1 ticket PR.
- Independent ticket PR targets the release branch; same-release hard dependencies use stacked PRs.
- Publish the branch and open a **Draft PR** immediately after the first meaningful commit.
- PR landing is **merge commit only** (squash/rebase disabled at the repository level).
- **Merging is an explicit human-authorized side effect.** An agent never merges. Readiness is not authorization.

## Toolchain

`mise` is the project-local toolchain frontend. `mise install` to bootstrap;
`mise run check` (typecheck / lint / test) is the local quality gate.
`mise` is not an isolation boundary — do not treat it as one.

## Verification taxonomy and evidence levels

| Level | Meaning |
| --- | --- |
| `implemented` | code exists and compiles |
| `automated test` | covered by a green test in CI |
| `fake/mock only` | verified against the in-repo fake AE host, not a real After Effects |
| `verified on real host` | observed running against an installed After Effects |

**Report the level reached. Never present `fake/mock only` as "working".**
Anything below `verified on real host` is unproven against real AE; say so explicitly.

Unit tests must not require After Effects. Integration tests that do are opt-in and
skipped when no AE installation is discoverable.

## Bridge rules

- Callers never see the bridge protocol, the ExtendScript host script, or raw script strings.
  That separation is a requirement, not an implementation detail.
- ExtendScript host code is **ES3**. Do not put it in `src/` TypeScript; it is shipped
  verbatim as `host/`. Anything TypeScript will not compile must not be the host's only copy.
- The host script must run unmodified against both a real AE and the in-repo fake host.
  Only the peer differs.
