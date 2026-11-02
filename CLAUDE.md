# ae-a8n — agent contract

Programmatic automation runtime and API for Adobe After Effects.

This file is a **dispatcher**: it is read on every session, so it stays short. The detail it
points to is in `docs/` and in the project-local Agent Skills under `.claude/skills/`.

Scope authority: [`README.md`](README.md) (Scope) and [`docs/vision.md`](docs/vision.md).
Delivery policy: [`rebuildup/project-init`](https://github.com/rebuildup/project-init)
Constitution + the release-driven-solo profile.

## What this repo owns

- After Effects process lifecycle (launch / close)
- project / comp / layer / effect / parameter operations
- render, and retrieval of results and errors
- the programmatic API that higher-level tools consume
- the bridge protocol and transport contract, when one is needed

Not owned: test DSL → `ido-bata/ae-test`; remote worker / queue / GitHub integration →
`ido-bata/ae-farm`; dev-tooling UX → `ido-bata/ae-devtools`. The series is
`ae-a8n → ae-test → ae-farm`; do not invert or merge it.

`docs/architecture.md` has the layers, the bridge protocol, the fake host, and the bridge rules.

## Where the truth lives

| Fact | Where |
| --- | --- |
| Released state | `main` |
| Current integration line | `main` — no `release-x-y-z` branch is open. When one opens, independent ticket PRs target it and only a `release-* → main` PR needs human authorization |
| Durable work, scope, acceptance criteria | GitHub Issues |
| Review and validation evidence | GitHub pull requests |
| Decisions and their reasons | `docs/adr/` |
| Secrets | there are none; publishing uses npm Trusted Publishing (OIDC) and no long-lived token |

## Commands

`mise` is the project-local toolchain frontend (`mise install` to bootstrap). It delegates to the
npm scripts so every command is defined exactly once.

| Task | Command |
| --- | --- |
| Quality gate (typecheck + lint + test) | `mise run check` |
| Release gate (gate + build + shipping checks) | `mise run validate:release` |
| Typecheck only | `mise run typecheck` |
| Lint only | `mise run lint` |
| Unit tests | `mise run test` |
| One test file | `npx vitest run test/api.test.ts` |
| One test by name | `npx vitest run -t "renders a frame"` |
| Tests in watch mode | `mise run test.watch` |
| Build (`tsc` → `dist/`) | `mise run build` |
| Install deps | `npm ci` (package-lock.json is the lockfile — **npm, not pnpm**) |

`docs/development.md` is the long form. The unit suite never needs After Effects: it runs the
**real** host script against the in-repo fake host.

## Working agreement

1. One top-level Issue → one number-only branch → one ticket PR. Branch name is the Issue number
   and nothing else.
2. After the first meaningful commit, publish the branch and open the PR immediately. Draft while
   the work is incomplete; Ready for review once readiness is met. Do not push "later".
3. A ticket PR lands on its own once the readiness and quality gates pass. A `release-* → main`
   PR needs explicit human authorization — never infer it from a general "merge the ready PR".
   Merging is a human-authorized side effect; an agent never merges.
4. Publishing is separate from merging: `scripts/publish-gate.js` + `scripts/stage-publish.js`
   stage a tarball through npm Trusted Publishing, and a maintainer approves it with 2FA.
   `docs/releasing.md` has the procedure.

Details: the `github-delivery` skill.

## Judgment boundaries

- What to decide alone, and what to bring back to the user, is the `engineering-decisions` skill.
  Read it before escalating anything; most implementation decisions are not the user's.
- Before writing anything that stays — README, ADR, Issue, PR, commit message, review comment,
  release note — use `writing-discipline` (and `natural-japanese` for Japanese prose).
- When work is interrupted, resume from the Issue, the PR, the branch, and the recorded commit —
  not from a conversation. `docs/recovery.md` has the procedure.

## Verification taxonomy and evidence levels

| Level | Meaning |
| --- | --- |
| `implemented` | code exists and compiles |
| `automated test` | covered by a green test in CI |
| `fake/mock only` | verified against the in-repo fake AE host, not a real After Effects |
| `verified on real host` | observed running against an installed After Effects |

**Report the level reached. Never present `fake/mock only` as "working".**
Anything below `verified on real host` is unproven against real AE; say so explicitly.

Unit tests must not require After Effects. Integration tests that do are opt-in and skipped when
no AE installation is discoverable. `quality/profile.json` holds the machine-readable form of
this policy.

## Bridge rules

- Callers never see the bridge protocol, the ExtendScript host script, or raw script strings.
  That separation is a requirement, not an implementation detail.
- ExtendScript host code is **ES3**. Do not put it in `src/` TypeScript; it is shipped
  verbatim as `host/`. Anything TypeScript will not compile must not be the host's only copy.
- The host script must run unmodified against both a real AE and the in-repo fake host.
  Only the peer differs.

## Capabilities and the Skill in charge

Project-local Skills live in `.claude/skills/`. They are copies owned elsewhere, pinned by
`skills-lock.json` and checked by `test/vendored-skills.test.ts`. **Do not edit a vendored
copy** — change it at the source and re-vendor.

| Capability | Skill | Use it when |
| --- | --- | --- |
| Routing | this file | Picking the skill for the job. No router skill is installed on purpose |
| Delivery | `github-delivery` | Issue → branch → PR → landing, stacked PRs, release PRs |
| Recovery | `agent-recovery` | A session, sandbox, or context was interrupted and work must resume |
| Orchestration | `parallel-orchestration` | Splitting work across subagents, or integrating their results |
| Quality gate | `quality-gate` | Deciding what to verify, at what level, and how the gate is compiled |
| Design before build | `design-refinement` | A non-trivial feature, architecture, or API shape is about to be built |
| Engineering decisions | `engineering-decisions` | Deciding what to do, and what to escalate |
| Debugging | `diagnosing-bugs` | A failure needs a reproducible loop before a cause |
| TDD | `.claude/skills/tdd/SKILL.md` (manual) | The user asked for TDD, or a bug has an obvious cheap local test target |
| Code review | `code-review` | Reviewing a diff against the repository's conventions and the specification |
| Correctness | `correctness-assurance` | Something has invariants worth stating and proving |
| Code naming | `code-naming` | Naming, renaming, or reviewing names — including public API names |
| Security advisories | `security-maintenance` | A dependency or runtime advisory has to be triaged |
| Estimation | `agent-delivery-estimation` | A release or roadmap horizon needs a forecast from observed throughput |
| Onboarding | `onboarding` | Documentation for someone starting without any context |
| Prose (persistent) | `writing-discipline` | Writing or editing anything a reader will keep |
| Prose (Japanese) | `natural-japanese` | Writing Japanese prose a reader has to read |
| Interaction | `interaction-discipline` | Talking to the user: what to report, what to ask, how blockers are shown |
| Policy evaluation | `policy-evaluation` | A Skill or a policy is being changed and needs to be evaluated |
| Skill authoring | `skill-authoring` | Writing a Skill for this repository |
| Skill selection | `skill-selection` | Deciding which Skills this repository adopts |
| Ideation | `idea-discovery` | A genuinely new idea is asked for, not a variation on the existing one |
| Driving a real AE | `skills/after-effects-automation/SKILL.md` (shipped) | A task needs After Effects itself, or a plugin's real behaviour |

## House rules

- Source code (identifiers, comments, developer-facing logs) and commit messages: **English**.
  Internal discussion and records — Issues, PRs, review discussion, ADRs: **Japanese**. The
  published documentation set (`README.md`, `docs/`) stays **English**, because it is read by
  npm consumers, not by the team. Localization resources excepted.
- Commit message format: `<work-prefix>: <very short title>` (e.g. `feat(api): run menu commands`).
- The package manager is **npm**, not Bun, and not pnpm: `package-lock.json` is the lockfile and
  CI installs with `npm ci`. This is a deliberate deviation from the project-init house rule.
- Text search: `rg` / `rg --files`.
- Do not add new `.py` scripts; use the project's language or shell. TypeScript in this project.
- New container definitions are named `Containerfile`.
- Keep project-specific rules in this repository, not in global settings or private agent memory.
- Install Agent Skills project-locally and individually, never as a whole pack, and never a
  router skill. Pin the revision and commit both the files and `skills-lock.json`.
