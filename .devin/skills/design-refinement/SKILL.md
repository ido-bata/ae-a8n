---
name: design-refinement
description: 非自明なfeature・architecture・product designを実装計画へ渡す前に、repository evidenceからfactと未決定事項を整理し、本当に必要なuser decisionだけを質問する時に使用する。
---

# Design Refinement

非自明なtaskでは、質問を作る前にprojectを読む。
目的はuserを大量の質問でinterviewすることではなく、**read relentlessly, ask minimally** を実行し、implementationが暗黙のassumptionに依存しない状態へすることである。

## 1. Read before asking

最低限、taskに関係するものを必要な範囲で確認する。

- current user request / Issue / acceptance criteria
- project-wide policy / canonical architecture / invariants
- design / specification
- relevant ADR
- relevant project-local Skills / operational docs
- relevant existing implementationを複数箇所
- tests / fixtures / schemas / contracts
- Git history / PR discussion when current codeだけではdecision intentが分からない場合
- framework/runtime/API/toolのcurrent official documentation when version-sensitive
- domain vocabulary / glossary when存在する場合

最初に見つけたfile、会話上の印象、一般的なbest practiceだけでproject intentを補完しない。

## 2. Factとdecisionを分離する

発見したunknownを少なくとも次へ分類する。

### Fact

repository、official source、実行可能なprobe、既存system stateから調査できるもの。

例:

- 現在のAPI behavior
- existing naming/layout convention
- framework/runtime capability
- schema shape
- test coverage
- current release/branch state

Factは原則としてagentが調査して解決する。userへ質問しない。

### Determined decision

`engineering-decisions` のprecedenceとproject evidenceから実質一意に決まるもの。

reversibleで局所的、acceptance criteriaやpublic contract等を変えない場合はagentが決めて進む。

### Unresolved consequential decision

evidenceを読んでも複数のmeaningful optionが残り、選択によってproduct semantics、architecture、public contract、risk、cost、release scope等が変わるもの。

user escalation候補はこのcategoryに限定する。

## 3. Assumptionをhidden stateにしない

implementationを成立させるために必要だがevidenceで確定していない前提を検出する。

特に確認する:

- user-visible behavior
- domain semantics
- ownership / responsibility boundary
- source of truth
- persistence / lifecycle
- failure behavior
- compatibility / migration
- security / privacy / permission
- performance / cost budget
- release / rollout behavior

「おそらくこうだろう」でimplementationへ進まず、factなら調査し、decisionならdecision graphへ入れる。

## 4. Decision dependency graph

unresolved decisionに依存関係がある場合、平坦な質問listにしない。

例:

```text
A: canonical source of truth
├─ B: conflict resolution behavior
└─ C: offline/cache policy
   └─ D: stale-data UX
```

B/C/Dの回答がAに依存するなら、Aが未確定な状態で下流質問をuserへ投げない。

各decision nodeは必要に応じて:

- question / decision statement
- known evidence
- alternatives
- consequences
- dependency
- recommended option
- escalation reason

を持つ。

## 5. Ask only the decision frontier

現在回答可能で、未解決の上流decisionを持たないnodeだけをdecision frontierとする。

userへ質問するのは、そのfrontierのうち `engineering-decisions` のescalation criteriaに該当するものだけに限定する。

質問時は単なる「A/Bどちらですか」ではなく、可能な範囲で:

- 既に確認したevidence
- 残った選択肢
- 各選択肢のmeaningful consequence
- agentの推奨案と理由

を簡潔に示す。

複数decisionが独立しており一度に答えられる場合はまとめてよい。依存しているdecisionを先読みして大量質問しない。

## 6. Stop condition

次を満たしたらrefinementを終了し、planning / ticketization / implementationへ進む。

- task scopeとacceptance criteriaが実装可能な粒度で明確
- relevant factが調査済み、または明示的なexternal blockerとして特定済み
- consequential unresolved decisionが残っていない
- implementationを左右するhidden assumptionが残っていない
- decision resultが必要なcanonical locationへ反映されている

すべてを完全仕様化することは目的ではない。implementationを安全に開始するために必要なuncertaintyだけを解消する。

## 7. Persist selectively

long-lived valueを持つdecisionやdomain knowledgeだけをrepository-controlled stateへ永続化する。

候補:

- design / specification
- ADR
- project-local Skill
- architecture / development docs
- domain glossary / domain context
- schema / contract / test

次は通常永続化しない。

- formatter等が決める自明なchoice
- 一時的な調査結果
- reversibleな局所implementation detail
- conversationでのみ意味を持つ説明
- private chain-of-thought

domain vocabularyが複雑で複数contributor/agentの共通理解に価値がある場合は、projectに適したglossary/domain contextを作成・更新する。固定の `CONTEXT.md` file名や独立documentを全projectへ強制しない。

## 8. Relationship with engineering-decisions

このSkillは `engineering-decisions` を置き換えない。

- `design-refinement`: implementation前にunknown / assumption / decision dependencyを発見し、質問対象を絞る
- `engineering-decisions`: 発見されたdecisionをproject evidenceのprecedenceで自律決定するかuser escalationするか判定する

原則:

```text
inspect evidence
  -> classify facts / decisions
  -> investigate facts
  -> resolve determined decisions
  -> build unresolved decision graph
  -> ask only consequential frontier
  -> persist significant results
  -> plan / implement
```
