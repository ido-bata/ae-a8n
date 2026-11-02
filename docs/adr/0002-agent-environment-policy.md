# ADR 0002 — エージェント開発環境の初期化方針

- Status: accepted
- Date: 2026-11-02
- Affects: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `skills-lock.json`, `quality/profile.json`, `docs/`, `mise.toml`, `package.json`, `.gitignore`

## Context

`ae-a8n` は SDK ではなく、反復的な feature 開発と保守の三省に跨る
リポジトリである。Windows と macOS の両方で release する npm パッケージであり、実際の
After Effects を起動するコードを含むため、テストが通ることだけでは足りない。この開発環境を
human と agent が共に回すために、project-init の Constitution と release-driven-solo profile を
根拠に、agent 向けの root contract / Skill 構成 / quality gate / 運用手順を一度に定める
必要があった。

判断の根拠は次の順で、正本は外部リポジトリにある。

1. `rebuildup/project-init` の Constitution（組織が常に維持する性質）
2. `organization/profiles/release-driven-solo.md`（現在の Operating Model）
3. `skills/*/SKILL.md`（場面ごとの判断基準）
4. 本 ADR（このリポジトリ固有の決定）

## Decision

### root contract は 1 枚だけ

`CLAUDE.md` を root contract とする。必要な情報を全部書くと、毎回読まれるはずの文面に
実装詳細が流れ込むため、詳細は `docs/` へ移す。

- `CLAUDE.md` — dispatcher。境界、source of truth、entry point、作業の約束、判断の境界、
  verification taxonomy、bridge rules、能力ごとの Skill 担当表、house rules。
- `AGENTS.md` — 他の harness 向けの入口。`CLAUDE.md` を読むことを指示するだけに留める。
  内容を二重化しない。
- `docs/architecture.md` — 3 層の分離、bridge protocol、fake host、bridge rules。
- `docs/development.md` — bootstrap、コマンド、構成、release。
- `docs/security.md` / `docs/recovery.md` / `docs/troubleshooting.md` — 追加した文書。

### 能力ごとに担当 Skill を 1 つ決める

project-init の `catalog/capabilities.tsv` の `needed_when` をこのリポジトリの実際の状態から
判定し、導入した Skill を `.claude/skills/` に置いた。導入は `skills` CLI の `--copy` を使い、
revision は tag で固定した。導入した複製は直接編集せず、`skills-lock.json` と
`test/vendored-skills.test.ts` が hash で一致を検査する。

採用した Skill と導入先:

| 能力 | Skill | 配布元 | revision |
| --- | --- | --- | --- |
| delivery | `github-delivery` | rebuildup/project-init | `v0.7.0` |
| recovery | `agent-recovery` | rebuildup/project-init | `v0.7.0` |
| orchestration | `parallel-orchestration` | rebuildup/project-init | `v0.7.0` |
| quality-gate | `quality-gate` | rebuildup/project-init | `v0.7.0` |
| design-before-build | `design-refinement` | rebuildup/project-init | `v0.7.0` |
| engineering-decisions | `engineering-decisions` | rebuildup/project-init | `v0.7.0` |
| correctness | `correctness-assurance` | rebuildup/project-init | `v0.7.0` |
| code-naming | `code-naming` | rebuildup/project-init | `v0.7.0` |
| security-advisory | `security-maintenance` | rebuildup/project-init | `v0.7.0` |
| estimation | `agent-delivery-estimation` | rebuildup/project-init | `v0.7.0` |
| onboarding | `onboarding` | rebuildup/project-init | `v0.7.0` |
| interaction-style | `interaction-discipline` | rebuildup/project-init | `v0.7.0` |
| policy-evaluation | `policy-evaluation` | rebuildup/project-init | `v0.7.0` |
| skill-selection | `skill-selection` | rebuildup/project-init | `v0.7.0` |
| ideation | `idea-discovery` | rebuildup/project-init | `v0.7.0` |
| debugging | `diagnosing-bugs` | mattpocock/skills | `v1.3.2` |
| code-review | `code-review` | mattpocock/skills | `v1.3.2` |
| tdd | `tdd`（manual invocation） | cursor/plugins | tag なし |
| prose-artifact | `writing-discipline` | rebuildup/writing-skills | tag なし |
| prose-japanese | `natural-japanese` | rebuildup/writing-skills | tag なし |
| skill-authoring | `skill-authoring` | rebuildup/writing-skills | tag なし |

`routing` 能力の担当は root contract 自体であり、router 性质的 Skill は意図的に導入しない。

### 見送った候補

| Skill | 見送った理由 |
| --- | --- |
| `security-audit` | 「未知の脆弱性を能動的に探すことを選んだ」場合の能力であり、このリポジトリでは既定ではない。脆弱性情報の取り込みは `security-maintenance` が担当する |
| `secrets-management` | application / service の secret を使わない。publish は npm Trusted Publishing (OIDC) のみで、長寿命 token は存在しない |
| `linear-release-control` | Linear を使わない。release planning は GitHub Issue 側で行う（profile からの deviation） |
| `worktree-workflow` | worktree 運用をしていない。`worktree:*` の task も `.config/wt.toml` も作らない |
| `herdr-runtime` / `orca-frontend` | Herdr も Orca も使っていない |
| `sandbox-runtime` | 並行な implementation worker を動かさない。検証用の一時領域は各テストが `mkdtempSync` で個別に持つ |
| router 群（`using-superpowers`, `ask-matt`, `poteto-mode` ほか） | 入口を握る Skill は root contract のみが持つ。外部 pack は丸ごと入れない |
| プラットフォーム / framework / デザイン系 | Cloudflare、Vercel、React、office 文書、UI・motion の利用がない |

採用判断のうち、このリポジトリ固有でないものは project-init の `catalog/candidates.tsv` へ
PR で返す。

### quality gate を機械可読にする

`quality/profile.json` に verification taxonomy、change ごとの必要検証、gate、CI の構成、
false green の禁止事項、platform matrix を置いた。stable な entry point は次の 3 つです。

- `mise run check` — worker gate（typecheck / lint / test）
- `mise run validate:release` — release gate（gate + build + ES3 parse + doc snippet +
  packed package + public API）
- 実機 integration — 手動・opt-in。`docs/verification.md` に記録する。自動 runner は無い

## profile からの deviation と理由

| profile の default | 実際 | 理由 |
| --- | --- | --- |
| JavaScript / TypeScript の package manager は Bun | **npm** | `package-lock.json` が lockfile で、CI も `npm ci` を使う。切り替えれば publish 済みの再現性機構が変わる。lint のために Bun を入れる価値もない |
| release planning の control plane は Linear | **GitHub Issue** | この規模で Linear は control plane にならない。実装・依存関係の SoT は GitHub のまま。profile は project-specific model への置換を許している |
| release branch `release-x-y-z` が integration line | **現在 `main`** | open な release branch が存在しないため。branch が開いたら ticket PR の target をそこに向ける |
| mise lockfile を commit | **未 commit** | CI が固定する mise version と lockfile 形式が食い違う危険があり、format drift のリスクに見合わない。再現性は `node = "24"` の major pin + `engines.node` + npm の lockfile で担保する |
| eval は `bun evals/...` | **vitest** | このリポジトリの test framework は vitest。eval を Bun に移すと test runner が二重になる |
| agent-routing template / worktree entry point | **なし** | top-level 委譲と worktree 運用をしていない |

## Consequences

- `CLAUDE.md` は短いままで保たれ、詳細の正本は `docs/` へ移った。
- 導入した Skill は 21 個。いずれも `single` 能力の担当は 1 つで、外部 pack の router は入っていない。
- `test/vendored-skills.test.ts` が、`skills-lock.json` と `.claude/skills/` の実体が食い違えば
  落とす。復製の改変は CI で検出される。
- `mise.toml` から未使用の `pnpm` の pin を外した。lockfile は npm のまま。
- 文言言語の規定を、会話・記録（日本語）と publish 対象ドキュメント（英語）に分けた。
  既存の `docs/adr/0001-bridge-transport.md` は英語のまま残っている。これは legacy であり、
  将来的に揃える。

## 未確認 / 残る制約

- Windows 版 After Effects は `docs/windows-verification.md` に実機検証が記録済み。ただし ARM64 と
  英語以外の Windows UI は未実行で、Windows の主張はその範囲に限られる。
- `release-* → main` の merge には human の明示的な authorization が必要で、agent は merge しない。
