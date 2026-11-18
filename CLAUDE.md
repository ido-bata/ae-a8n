# ae-a8n — agent contract

Programmatic automation runtime and API for Adobe After Effects.

Scope authority: `README.md` and `docs/vision.md`.
Delivery policy: [`rebuildup/project-init`](https://github.com/rebuildup/project-init) Constitution + current release-driven profile.

## Canonical sources

- 最上位 contract: [`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md)
- 現在の Operating Model: [`organization/profiles/release-driven-solo.md`](organization/profiles/release-driven-solo.md)
- 開発・検証・worktree の入口: [`docs/development.md`](docs/development.md)
- GitHub settings / rulesets の正本: [`docs/github-settings.md`](docs/github-settings.md)（適用は `scripts/github-rulesets.js`）
- release 手順: [`docs/releasing.md`](docs/releasing.md) / ADR: [`docs/adr/`](docs/adr/)
- Agent Skills（進捗的開示）: `.agents/skills/`（`skills-lock.json` が導入元と hash を記録）

このファイルは dispatcher であり、詳細は各正本と Skill への pointer に置く。毎回全 skill を読まない。

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

- `main` = released state. `release-0-1-0` は #92、`release-0-2-0` は #133 で `main` に merge 済み。現在の release train は `release-0-3-0`（#210 で開設）で、ticket PR の base はそれ。release PR が `main` に merge されたら、次の ticket 作業を始める前に次期 `release-*` branch を `main` HEAD から開設してこの記述を更新する。
- 1 top-level Issue = 1 number-only branch = 1 ticket PR.
- Independent ticket PR targets the release branch when one is active, otherwise `main`; same-release hard dependencies use stacked PRs.
- Publish the branch and open a **Draft PR** immediately after the first meaningful commit.
- PR landing is **merge commit only** (squash/rebase disabled at the repository level).
- **Landing authority follows the delivery boundary.** A ticket PR (`base` が current `release-*`、`main` 以外) は readiness/quality gate 通過後に追加の人間承認なしで自律 landing する。`release-* -> main` の release PR だけが explicit human authorization を必要とし、readiness は承認ではない。詳細は `github-delivery` Skill と `organization/profiles/release-driven-solo.md`。

## Toolchain

`mise` is the project-local toolchain frontend. `mise install` to bootstrap;
`mise run check` (typecheck / lint / test) is the local quality gate.
`mise` is not an isolation boundary — do not treat it as one.

Package manager は **npm**（`package-lock.json`、CI は `npm ci`）。組織共通ルールの Bun 既定からの deviation であり、移行する場合は lockfile・CI・docs をまとめて変更する別 ticket とする。

Worktree を使う場合、作成・削除は必ず `mise run worktree:setup` / `mise run worktree:teardown` を通す（`.config/wt.toml` が Worktrunk hook として配線済み。plain `git worktree` でも同じ入口を手で呼ぶ）。詳細は `worktree-workflow` Skill と `docs/development.md`。

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

## Agent Skills — 能力ごとの担当

Skill の実体は `.agents/skills/<name>/SKILL.md`（agent 別 directory へ同一 copy）。`disable-model-invocation` のものは自動起動しないので、該当場面では下の path を直接読む。

| 能力 | 担当 Skill | 使う場面 |
| --- | --- | --- |
| delivery | `github-delivery` | Issue / branch / PR / release の進め方 |
| recovery | `agent-recovery` | 中断・crash からの復旧、checkpoint、外部 side effect |
| orchestration | `parallel-orchestration` | worker への分解・委譲・immutable snapshot/result |
| execution-isolation | `sandbox-runtime` | worker ごとの独立 runtime が必要な並行作業 |
| workspace-lifecycle | `worktree-workflow` | worktree の作成・切替・削除と cache |
| supervisor-runtime | `herdr-runtime` | Herdr を Supervisor runtime として使う時だけ |
| quality-gate | `quality-gate` | verification level・gate・CI の設計と実行 |
| design-before-build | `design-refinement` | 非自明な feature / architecture / product design の実装前整理 |
| engineering-decisions | `engineering-decisions` | 実装判断の優先順位と user escalation の境界 |
| debugging | `diagnosing-bugs` | 再現できる失敗・性能退行の診断 loop |
| tdd（手動） | `tdd` — `.agents/skills/tdd/SKILL.md` | user が明示した時、または安い局所 test target がある bug fix のみ |
| code-review | `code-review` | fixed point からの diff を Standards / Spec の2軸でレビュー |
| correctness | `correctness-assurance` | bridge protocol 等の重要な不変条件の保証設計 |
| code-naming | `code-naming` | 命名・リネーム・命名レビュー |
| security-advisory | `security-maintenance` | dependency / framework の脆弱性情報の取り込み |
| estimation | `agent-delivery-estimation` | 中長期の release / roadmap 見積もり |
| onboarding | `onboarding` | 会話履歴なしで始められる docs の整備 |
| prose-artifact | `writing-discipline` | README / ADR / Issue / PR / commit 等、残る文章を書く前 |
| interaction-style | `interaction-discipline` | user とのやりとり、質問の絞り方、blocker の見せ方 |
| policy-evaluation | `policy-evaluation` | Skill / policy 自体を変更・評価する時 |
| skill-selection | `skill-selection` | Skill の追加・更新・採否を決める時 |
| ideation | `idea-discovery` | 既存の延長ではない発想を求められた時だけ |

`skills/after-effects-automation/` は npm package 同梱の利用者向け Skill であり、この表の管理対象外です。

## House rules

- source code（identifier・comment・developer 向け log を含む）と commit message は英語。internal documentation・Issue・PR・review discussion は日本語。localization resource は例外。
- commit message の形式: `<work-prefix>: <ごく短いtitle>`（既存例: `fix(macos): ...`）。
- text search は `rg` / `rg --files`。
- 新しい script を `.py` で追加しない。project の言語（TypeScript）か shell を使う。
- 新しい container definition は `Containerfile`。
- project 固有の rule を global 設定・home directory・agent の私的 memory にだけ置かない。repository に残す。

## Judgment and recovery pointers

- user へ判断を返す条件・決定の優先順位: `engineering-decisions` Skill。
- 残る文章を書く前: `writing-discipline` Skill。
- 中断からの復旧: 会話履歴ではなく Issue / PR / branch / `docs/` から再開する。`agent-recovery` Skill。
