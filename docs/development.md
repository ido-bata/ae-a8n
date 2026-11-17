# 開発ガイド

このドキュメントは、会話履歴なしで repository を bootstrap し、日常の検証と worktree 運用を行うための入口です。仕様の正本は [`README.md`](../README.md) と [`vision.md`](vision.md)、delivery の設定正本は [`github-settings.md`](github-settings.md) と [`releasing.md`](releasing.md) を参照してください。

## Bootstrap

前提: macOS または Windows 上で [mise](https://mise.jdx.dev/) が使えること。toolchain（Node.js）の version は `mise.toml` が正本です。

```bash
mise install          # toolchain の導入
npm ci                # 依存の導入（package-lock.json が正本）
mise run check        # typecheck + lint + test の local quality gate
```

shell で mise を activate していなくても `mise exec -- <command>` / `mise run <task>` がそのまま使えます。

## 日常のコマンド

| 目的 | コマンド |
| --- | --- |
| 型検査（emit なし） | `mise run typecheck` |
| lint | `mise run lint` |
| 単体 test（AE 不要） | `mise run test` |
| 全体の品質 gate | `mise run check` |
| build | `mise run build` |
| watch で test | `mise run test.watch` |

## 検証レベル

unit test は After Effects を必要としません。実機 AE に対する検証は opt-in で、AE が見つからない環境では skip されます。何がどのレベルで確認済みかは [`verification.md`](verification.md) と README の Status 表が正本です。`fake/mock only` の結果を実機 verified として報告しないでください。

## Worktree

作業単位は Issue 番号だけの branch とし、worktree は `wt`（Worktrunk）等の frontend で作成します。作成・削除時の処理は frontend に依存せず、必ず repository の入口を通します。

- 作成時: `mise run worktree:setup`（`.config/wt.toml` の `pre-start` hook、または手動で同じコマンド）
- 削除時: `mise run worktree:teardown`（`.config/wt.toml` の `pre-remove` hook）

`scripts/worktree/setup.sh` は toolchain の導入、依存の `npm ci`、worktree 固有の `.worktree.env`（branch 由来の key）を冪等に行います。`teardown.sh` は worktree の外にある resource の解放を担当します。mutable state（port、DB、生成物）を worker 間で共有しないでください。

## Agent Skills

この repository が agent 向けに導入している Skill は `.agents/skills/`（および agent 別 directory への copy）にあり、`skills-lock.json` が導入元と hash を記録します。`skills/after-effects-automation/` は npm package に同梱される利用者向け Skill で、agent 基盤の Skill とは別物です。

- 更新: `bunx skills update`（diff を確認してから commit）
- 復元: `bunx skills experimental_install`（lockfile からの復元）
- 導入・選定の規約: `skill-selection` Skill と `AGENTS.md` の担当表を参照

## 中断からの復旧

会話履歴ではなく、Issue / PR / branch / commit / `docs/` を durable state として復旧します。手順は `agent-recovery` Skill を参照してください。

## Delivery

- `main` は released state。release branch（`release-x-y-z`）がある期間は ticket PR をそこへ向け、`main` への統合は release PR のみです。
- Issue / branch / PR の規約、rulesets、merge method の正本は `github-delivery` Skill と `docs/github-settings.md` です。
- release 手順は `docs/releasing.md`、ADR は `docs/adr/` を参照してください。
