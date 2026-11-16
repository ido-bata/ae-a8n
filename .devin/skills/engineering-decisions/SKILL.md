---
name: engineering-decisions
description: 実装・設計・修正方針を自律的に決定する時に、project内の優先順位を確認し、不要なuser escalationを避けるために使用する。
---

# Engineering Decisions

開発判断は会話上の思いつきや局所的な実装だけで決めない。

## 1. Canonical decision precedence

project内のtechnical/product decisionは原則として次の順で確認する。

1. **Constitution / tool-independent organizational invariant**
2. **applicable public/external contract・persisted-data・protocol/schema compatibility obligation**
3. **explicit product / organizational decision・canonical design/specification・explicit task instruction**
4. **current Operating Model**
5. **applicable Practice contract / project-local quality・security・delivery profile**
6. **coherent existing implementation evidence**
7. framework/runtime/SDKのcurrent official guidance
8. established ecosystem convention
9. local best judgment

同一levelで矛盾する場合は、よりspecificかつ新しいcanonical sourceを優先する。ただしinternal design/specificationは、上位に存在するpublic/external contract、released client、persisted data、protocol/schema等のcompatibility obligationを暗黙にoverrideしない。

userの現在の明示要求が上位system/policyと矛盾しない限りtask scopeとして尊重するが、会話内の曖昧な表現からproject-wide policyを暗黙に上書きしない。

## 1.1 全体最適とrefinement

current defaultへのliteral compliance自体をobjectiveにしない。

Constitutionとexplicit decisionを守ったうえで、project objective・quality・delivery・maintainability・cost・riskを全体として最適化する。

Operating Model / Practiceと異なる手段を選ぶ場合は、該当する上位obligationとalternativeのguaranteeを確認する。同等以上のguaranteeを持つならdeviationは正常なdecision pathであり、単に既定toolを使わなかったことだけをfailureにしない。

## 2. 既存実装は最後のfallbackではなくevidence

existing implementationは重要なevidenceだが、誤ったlegacy patternを機械的に多数決で固定しない。

確認:

- 同じ責務の実装を複数箇所見る
- generated/vendor/example codeを除外する
- migration途中のold/new混在を判別する
- ADR/designが既存実装をrevisionしていないか確認する

「最初に見つけた1 file」をconventionとして扱わない。

## 3. 自明な判断をuserへ返さない

次を満たす場合はagent自身で判断して進める。

- precedenceから答えが一意または実質一意
- reversibleで局所的
- acceptance criteriaを変えない
- public/external contractを新規に確定しない
- security/privacy/cost/release scopeを重大に変えない

例:

- projectの既存命名規則に沿うfile名
- official architectureに沿ったplacement
- 既存formatterが決めるformat
- 既存test structureに沿ったtest location
- 明らかなlint/type error修正

「AとBどちらがいいですか？」を、project evidenceで解けるのにuserへ返してはいけない。

## 4. User escalationが必要な条件

userへ確認するのは、本物のproduct/architecture decisionが残る場合に限定する。

代表例:

- canonical sources同士が矛盾し、どちらを選ぶかでproduct semanticsが変わる
- acceptance criteriaが複数解釈でき、user-visible behaviorが変わる
- irreversible/destructive operation
- `release-* -> main` のrelease-class merge（ADR-0027のexplicit authorization対象）
- external/public API contractを確定する
- security/privacy/compliance riskの受容判断
- meaningful cost increase
- release scope/dateを変更する
- design-first policyでuser合意が明示的に必要

質問する場合も、調査可能な事実を先に調査し、選択肢・影響・推奨案を整理してから聞く。

### Ticket landingとrelease authorizationを分離する

PRのquality/readiness判定とlanding authority classificationを別々に行う。

- ticket-class（release topology内の`base != main`）はquality/readiness gate後に自律landing。追加のmerge許可待ちは不要。
- release-class（current `release-* -> main`）のみexplicit authorization必須。Ready/green/approvalは代替不可。
- genericな作業完遂指示はticket landingまで有効。release mergeへの許可とは扱わない。

## 5. Unknownは調査してから判断する

framework/runtime/API/toolのcurrent behaviorが判断材料ならofficial sourceを確認する。

モデル知識だけでversion-sensitiveなfactを推測しない。

external sourceはevidenceであり、project-local policyを勝手に上書きする権限は持たない。

要求scopeを独断でMVPへ縮めない（縮めるならrelease scope変更としてescalation）。完了はcompile成功ではなくacceptance criteriaと `quality-gate` のverification levelで判定する。

## 6. Decision result

significant decisionは必要に応じて:

- design/spec
- ADR
- project-local Skill
- code/config

へ永続化する。

通常の自明なimplementation choiceをADR化してnoiseを増やさない。

## 7. Naming / responsibility

filename / directory / function / class / component等の名前は、その対象が**所有する責務**を表す。

ancestor path / namespace / ownerも名前の一部として評価し、上位階層ですでに表現されている意味をleafで無意味に繰り返さない。

例えば `Viewer/ViewerWorkspaceGrid/WorkspaceGrid.tsx` のようにrootからleafまで同じ責務語が反復する場合、単なる短縮ではなく責務境界を再検討する。

明確な責務語が存在する場合、次のようなdumping-ground名を安易に使わない。

- `utils`
- `helpers`
- `common`
- `misc`
- `manager`

同一directory階層のparallel entryは**おおむね10以内**をheuristicとする。hard limitではないが大幅に超える場合は複数責務の混在を疑い、domain / feature / responsibility / lifecycle等の実質的境界で分割する。数合わせだけの中間directoryは作らない。

## 8. Design-first lifecycle

design / specificationがcanonical sourceとして存在し、変更がそのsemanticsへ影響する場合は次の順で進める。

1. current designを読む
2. 必要なdesign changeを整理する
3. user approvalがpolicy上必要なら、調査済みfact・影響・推奨案を提示して合意する
4. design/specを**あるべきfinal state**へ更新する
5. implementationを開始する
6. 実装中に仕様変更が必要になれば、implementationを先に既成事実化せずdesignへ戻る

Design documentへchronological memo、implementation diary、temporary TODO、abandoned idea historyを混在させない。decision historyはADRへ分離する。

## 9. ADR lifecycle

ADRが以前のdecisionをsupersede / revise / deprecate / replace / invalidateする場合、decision graphを両方向から追跡できるようにする。

最低限:

- new ADR -> previous ADR reference
- previous ADR -> new ADR reference
- previous ADRのstatus / revised-by / superseded-by等を更新
- current canonical decisionへ直接辿れる状態を維持

architectureだけでなくagent tooling、plugin selection、package manager、dependency strategy、container/runtime、test/quality、CI/CD、infrastructure、release/recovery等のlong-lived decisionにも適用する。

policy sectionを削除・統合するだけでdecisionを消した扱いにしない。semanticsを意図的に変更するならADRまたは同等のcanonical revision recordを残す。

## 10. Early-stage compatibility policy

project evidenceからstable external contract / persisted compatibility obligationが確認できない**実際のearly-stage project**では、将来必要になるかもしれないという理由だけのcompatibility layerを増やさない。

原則:

- obsolete internal APIを維持しない
- deprecated schema / old behaviorを惰性で残さない
- speculative compatibility shimを作らない
- 目的とするcanonical designへ直接移行する

ただし次は例外であり、project evidenceを優先する。

- public/external API contract
- released client compatibility
- persisted user/customer data
- explicit migration requirement
- protocol/schema compatibility obligation
- userがstable contractとして明示したもの

「既存projectだからearly-stage」と推測して破壊的変更を正当化しない。compatibility obligationの有無をrepository/release evidenceから確認する。

## 11. Dependency / tool adoption decision

新規package / plugin / Skill / CLI / reference implementation等を導入する前に最低限確認する。

- 本当に必要なcapabilityか
- platform/runtime/framework native capabilityで足りないか
- existing dependency/toolで足りないか
- smaller maintained alternativeがないか
- direct useされるか
- overlapping responsibilityを持つtool/libraryを増やさないか
- unnecessary transitive dependencyを増やさないか
- actively maintainedか
- source / maintainer / executable behavior / remote communication / permission / secret requirementは妥当か
- license typeとproject license compatibility
- redistribution / attribution / copied-source restriction
- cross-platform targetで利用できるか
- version/pinning/lockによりfresh cloneで再現できるか
- context/schema overheadに見合う利点があるか

Tool selectionをADRへ残す場合は少なくとも:

- 調査日 / status
- 解決したいcapability
- selected tool / Skill / integration
- selection reason
- alternatives considered / rejection reasons
- native/existing capabilityとのoverlap
- maintenance / security / license
- context cost
- version / pinning
- project-local reproduction method
- re-evaluation condition

を記録する。

## 12. Mode / permission / trust boundary

active agent mode、permission、trust、authenticationによってcapabilityが意図的に制限されている場合、その制限を**正規のboundary**として扱う。

禁止:

- bypass手段を探してpolicy制限を回避する
- unrelated tool /別経路で同じ制限を迂回する
- permission不足を理由にvalidationやacceptance criteriaを弱める
- 実行できていない操作を完了済みと報告する

必要なcapabilityが正当に必要なら、許可されたmode変更、authentication、trust decision、credential provisioning等をuser/external gateとして要求する。

制限下で可能な調査・準備・deterministic verificationは先に行い、userへは残った本物のgateだけを返す。

## 13. Agent Skill design contract

Agent Skillsはfull promptの箇条書きを機械的に1 Skillずつ分割して作らない。

Skillのsplit / mergeは最低限次を基準に決める。

- activation condition
- responsibility
- required tools
- context cost

発火条件と責務がほぼ同じruleは統合し、無関係なinstructionが同じtask contextへ常時入るなら分割する。

各Skillは可能な限り:

- 短く具体的なdescription
- 明確なtrigger / activation condition
- 1つの主要責務
- deterministic tool invocation / validation entry point
- 必要な場合だけ読むreference
- 必要な場合だけ実行するscript

を持つ。

root agent fileへ詳細ruleを戻してcontextを肥大化させず、通常taskでは必要なSkillだけを読むprogressive disclosureを維持する。

Skill統合・分割で旧Skillのnormative ruleを移動する場合は `docs/policy-integrity.md` のsemantic-loss guardを適用し、new canonical locationまたはexplicit revisionを追跡可能にする。


## 14. Design refinementとの関係

非自明なfeature / architecture / product designで、そもそも何がfactで何が未決定decisionか、どのdecisionが別decisionに依存するかを発見する段階では `design-refinement` Skillを先に使用する。

責務を分ける:

- `design-refinement`: evidenceを読み、fact / hidden assumption / decision dependencyを発見し、現在のdecision frontierを作る
- `engineering-decisions`: 各decisionをcanonical precedenceで自律決定するか、本物のuser escalationとして残すか判定する

`design-refinement` が質問を増やす理由になってはいけない。project evidenceで解けるものはこのSkillのprecedenceで解決し、userへ返すのは残ったconsequential decisionだけにする。
