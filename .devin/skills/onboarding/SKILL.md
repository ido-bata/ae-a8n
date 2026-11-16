---
name: onboarding
description: 新規参入者が会話履歴や個人環境に依存せずprojectを理解・起動・検証・開発開始・作業復旧できるdocumentationを初期化・更新する時に使用する。
---

# Onboarding

onboarding documentationは「READMEがある」ことではなく、fresh contributor / fresh agentがproject truthへ自力で到達できることを目的とする。

## 1. Onboarding completion target

新規参入者が会話履歴・個人memory・既存memberの口頭説明なしで最低限次を行える状態にする。

1. projectの目的とscopeを理解
2. architecture / major boundariesを把握
3. local environmentをbootstrap
4. application / serviceを起動
5. test / validationを実行
6. weekly sprint / target release / Issue dependencyを確認
7. Issueを選びticket branchを作成
8. first meaningful commitをremoteへpublishし、remote head SHA一致を確認した直後にPRを作成し、作業状態に応じてDraft/Readyを設定したうえでassignee / reviewer / labels / Issue linkage / target release / stack contextを設定
9. independent ticketかstacked dependent ticketかを判断
10. decision / design / ADR / Skillの参照先を発見
11. common failureを切り分け
12. 中断されたticketをIssue / PR / Git / checkpointから復旧

## 2. Document structure

project規模に合わせて最小限に構成する。

候補:

- `README.md`: project overview / first entry point
- `CONTRIBUTING.md`: development workflow / GitHub workflow
- `docs/architecture.md`: system boundaries / dependency direction / data flow
- `docs/development.md`: bootstrap / run / test / validation
- `docs/troubleshooting.md`: recurring failure / diagnosis
- `docs/release.md`: planning / release batching / deployment
- `docs/security.md`: security maintenance / reporting when appropriate
- `docs/recovery.md`: checkpoint / recovery / external side-effect workflow when complexity justifies it
- ADR directory
- design/specification directory
- project-local Agent Skills

巨大な1 documentへ全て詰め込まない。入口から必要なdetailへprogressive disclosureできるようにする。

documentationは作業contextの保存先ではなくreader-facing artifactとして扱う。新規作成・更新時は `writing-discipline` に従い、Select -> Compose -> Rereadで独立した文章へ整える。

## 3. README minimum

READMEにはprojectに応じて最低限:

- 何を作るprojectか
- support/target platform
- architecture overviewへのlink
- prerequisites
- canonical bootstrap command
- canonical run command
- canonical validation entry point
- internal docs index
- contribution entry point
- recovery entry point / `agent-recovery` Skillへの導線

を置く。

READMEへ内部実装detailを過剰に置かない。

### Public README badges

public repositoryでは、README冒頭のbadgeが読者の判断を速くする場合は積極的に採用する。

badgeは装飾ではなく、projectの現在状態・配布情報・信頼性・主要actionへの短い導線として扱う。候補:

- CI / build / test status
- release / package version
- license
- package downloadsやGitHub Stars等のadoption signal
- deploy / demo / documentation等のaction badge

選定原則:

- projectに実在し、現在も維持されている情報だけを表示する
- GitHub Actionsやhosting/package provider等が公式badge/buttonを提供する場合はそれを優先する
- 汎用badgeが必要な場合はShields.io等のmaintained serviceを使用してよい
- badgeのlink先はstatus details、release/package page、license、deploy target等、表示内容に対応するcanonical destinationへ向ける
- 同じ情報をREADME本文やGitHub UIと重複表示するだけで判断価値が低いbadgeは省く
- private repositoryや、外部読者向けのsignal/actionが不要なrepositoryでは無理に追加しない
- badge数を増やすことを目的にせず、README title直下の可読性と情報hierarchyを維持する


## 4. Development guide

最低限:

- supported host: macOS / WSL/Linux等
- project-local toolchain bootstrap: mise採用時は `mise.toml` / version authority / lock strategyを記述し、lockfile運用なら `mise install --locked` をcanonical bootstrapにする
- runtime/sandbox bootstrap
- dependency install
- env setup
- DB migration/seed
- app/service startup
- local preview / port access
- worker/integration/release validation commands
- generated code handling
- common cache/reset operations

を実repoのcommandから記述する。

存在しないcommandや古いsetupを推測で書かない。

mise採用projectはshell activationへ依存せず `mise exec -- ...` / `mise run <task>` を使える形にし、native canonical version sourceとの二重pinを避ける。external/untrusted PRではmise command実行前にtrust reviewまたはbounded sandboxを必須とし、mise自体をisolation boundaryにしない。

## 5. Architecture guide

visual/structuralに把握できるよう、必要ならMermaid等で次を示す。

- major components/services
- dependency direction
- data flow
- external systems
- persistence boundaries
- trust/security boundaries
- build/deploy/runtime boundaries
- Supervisor / sandbox / checkpoint boundary when agent infrastructure is non-trivial

詳細なdecision historyはADRへ分離する。

## 6. Development decision discovery

新規参入者が次の優先順位を発見できるようにする。

`project-wide policy > design/spec/task instruction > existing implementation majority`

root agent instruction / CONTRIBUTING / development docsから、canonical policy・design・ADR・Skillsへの導線を明示する。

## 7. GitHub workflow guide

週次planningと可変releaseを区別し、1 release train = 1 version = 1 branch、candidate freeze、明示的release承認を説明する。

independent ticket:

```text
main
└─ release-x-y-z
   └─ <issue-number>
```

stacked hard dependency:

```text
main
└─ release-x-y-z
   └─ 123
      └─ 124
         └─ 125
```

明示する:

- Issue/PRは日本語
- commitは英語
- ticket branchはIssue番号のみ
- Issue dependency graphがcanonical dependency SoT
- independent ticket PR baseはtarget release branch
- stacked dependent ticket PR baseはimmediate predecessor ticket branch
- stack membersは同じtarget release trunkを共有
- branch作成→commit→remote publish/head確認→PR作成・state設定までを一手順にする
- active branchにremote headとPRを必須とし、作業中はDraft、readyならReadyにする
- readyなPRは最初からReadyにする
- subagent/workerにも同じ公開・PR lifecycleを適用
- PRにIssue・assignee・reviewer・labels・release/stackを紐づけ、mappingを永続化
- predecessor変更後はdownstreamのbaseとcurrent-SHA validationを再確認
- ticket PRはquality gate後にdependency順で自律landing（追加のmerge許可は不要）
- stacked ticketはrelease trunk到達後にIssue closeする（predecessor landingだけではDoneにしない）
- landing後はdependent PRを調整し、安全なticket branchを削除する
- release差分が生じたらDraft release PRを作成し、readinessでReadyへ進める
- release PRは`release-* -> main`のみ。bulk ticket landingから除外する
- release mergeはcurrent interactionでのexplicit authorizationを必須とする
- public repositoryの`main`はrulesetで保護し、release PR経由でのみ変更する
- merge commitのみ許容（squash/rebaseは禁止）。repo設定とPR landing methodは`merge`で統一する
- Draft -> Ready -> target release-trunk landing -> Issue close / Project Doneの条件

意味のあるreviewerがいないrepositoryでは、形式的な自己reviewerを設定するのではなく、その事実と代替review pathを文書化する。

## 8. Recovery discovery

fresh agentが以前のchatを読めなくても、次を発見できるようにする。

- current Issue / PR / target release
- immediate stack predecessor / pinned predecessor SHA when applicable
- ticket branch / checkpointの見つけ方
- `agent-recovery` Skill
- current/next validation command
- active child/subagentの確認方法
- external side-effect journalの場所
- recovery時にuserへ確認すべき条件

PR欠落・state driftはdurable Issue/branch/baseから修復。Ready ticketはlanding・Issue close・safe cleanupまで行う。release PRはzero-diff例外以外で保持し、explicit authorizationなしにmergeしない。詳細は`github-delivery`・`agent-recovery`。

native session resumeの手順だけを書いてrecovery guideとしない。sessionが失われても復旧できるdurable pathを記載する。

## 9. Documentation verification

docsもquality gateの対象にする。

可能なら:

- documented commandsをCI/fresh sandboxで実行
- broken links検出
- setup pathをfresh environmentで確認
- GitHub workflow exampleがcurrent delivery policyと一致するか検証
- public repositoryの`main` protection/rulesetが実際に有効か確認
- repositoryのPR merge method設定がmerge commit onlyになっているか確認し、変更権限がなければ差分をblocker/limitationとして明示
- recovery pathをfresh agent/sandboxでdrill
- version-sensitive instructionsをupgrade時にreview
- conversation / task / execution contextなしで文章単体を理解できるかreader視点でreread
- chronology dump、不要なcurrent-state記述、context-dependent referent、重複を編集

「READMEには書いてあるがfresh cloneでは動かない」「recovery guideはあるがcheckpointから復旧できない」「CONTRIBUTINGだけ古いPR lifecycleのまま」を許容しない。

## 10. Update triggers

次の場合はonboarding docsを更新する。

- bootstrap/run/validation command変更
- architecture boundary変更
- framework/runtime migration
- mise / toolchain bootstrap / version authority / lock strategy変更
- environment/host support変更
- sprint cadence / release workflow変更
- stacked PR / dependency workflow変更
- branch / PR state / PR metadata lifecycle変更
- public repositoryのmain protection/ruleset変更
- PR merge method / repository merge settings変更
- Supervisor/sandbox/recovery model変更
- recurring troubleshooting knowledgeが増えた
- security/dependency maintenance workflow変更

実装変更でdocsがstaleになるなら同じticket/PR内で更新する。

## 11. Temporary artifact contract

一時的な検証・調査artifactはrepository root直下の `.tmp/` 以下へ集約する。

対象例:

- test result / report
- 一次log
- screenshot
- trace
- diagnostic file
- generated verification artifact
- temporary fixture
- one-off investigation output

禁止:

- repository rootへ一時fileを直接散らす
- `.tmp/` artifactを通常sourceとして参照する
- 正式なdocumentation/test fixture等へ明示的に昇格していない一時artifactをcommitする

`.tmp/` はGit ignoreする。正式artifactへ昇格する場合はcanonical locationへ移し、temporary originへ依存しない状態にする。

## 12. External reference repository contract

外部repositoryをsource/design/referenceとして調査する必要がある場合、target project root直下の `.reference/` 以下へcloneできる。

`.reference/` はGit ignoreし、reference repositoryをproject本体の一部として扱わない。

禁止:

- project source treeへ直接組み込む
- implicit build dependencyにする
- implicit runtime dependencyにする
- reference repository内の変更をtarget projectの成果物としてcommitする
- `.reference/` の存在をfresh clone / build / test / runの必須条件にする

必要な時だけcloneし、削除してもprojectが正常にbootstrap/build/test/runできる状態を維持する。

source/code/designをcopyする場合は事前にlicense / redistribution / attribution / copied-source restrictionを確認する。

## 13. Environment / `.gitignore` hygiene

actual dotenvのcanonical policy:

- `.env`
- `.env.development`
- `.env.production`

を実値用として扱いGit ignoreする。

committed schema/example:

- `.env.example`
- `.env.development.example`
- `.env.production.example`

を許可する。

example filesはenvironment variable schemaとして維持し、GitHub Actions / GitHub Secretsで使用するvariable名も対応するexampleへ反映する。secretにはvalueを書かず `SECRET_NAME=` のようにnameだけを残す。public configurationだけsafe example valueを置ける。

GitHubのstored secret valueを後から読み戻せることをbootstrap/recovery前提にしない。localとCIで同じ概念のvariable名を不必要に変えない。

`.gitignore` はstackを調査して最低限次を検討する。

- `.tmp/`
- `.reference/`
- actual dotenv files
- dependencies
- build outputs
- generated caches
- test / coverage outputs
- tool caches
- OS/editor temporary files
- local secret artifacts

一方、次を誤ってignoreしない。

- source
- lockfile
- reproducibility configuration
- Agent Skills / project agent config
- CI/CD configuration
- committed env examples

重複・相互矛盾するignore ruleを無秩序に追加しない。

このpolicyのためだけにpre-commit hookを新設しない。必要なvalidationはproject scriptとCIから再現可能にする。

## 14. Fresh-clone audit

初期化完了前に、既存machine stateを一度忘れたfresh cloneの視点で確認する。

最低限:

- agent behaviorを定義するcanonical fileは何か
- Skills / adapters / plugin configはどこか
- required binariesとprovision方法は何か
- undocumented global software/configを暗黙要求していないか
- environment variablesとexample schemaは何か
- secrets/trust/authenticationはどう供給されるか
- supported host/runtimeでbootstrapできるか
- home directory config / implicit persistent memoryに依存していないか
- `.tmp/` / `.reference/` / actual envがignoredか
- env examples / lock/reproducibility configがcommittedか
- mise等のrepository-controlled bootstrap pathとcanonical `mise exec` / `mise run` entry pointをfresh environmentで再現できるか
- mise lockfile運用ならbounded request + `mise install --locked` で不足entryを検出できるか
- external/untrusted PRでmise実行前のtrust review / bounded sandbox gateがあるか
- native canonical version sourceとmiseに競合する二重pinがないか
- `.reference/` がなくてもbuild/test/runできるか
- local validationとCIが同じcanonical semanticsを呼ぶか
- documented bootstrap/run/validation commandをfresh environmentで実行できるか

hidden dependencyが見つかった場合はdocumentationだけで正当化せず、可能ならrepository-controlled reproducibilityへ移す。

## 15. Initialization completion report

初期化終了時は、単に「完了」と報告せず最低限次を簡潔にexternalizeする。

- detected stack / architecture / target platform
- official guidance investigated
- existing agent configuration
- files created/changed
- Skillsとactivation conditions
- plugins/tools considered
- selected toolsとselection reason
- rejected meaningful candidatesとrejection reason
- ADRs created/updated
- canonical bootstrap/run/validation entry points
- test / quality / CI configuration
- environment / secret schema configuration
- remaining trust/authentication/user gates
- existing quality/dependency debt
- known limitations / unreproducible items

report内容がconversationにしか残らないlong-lived decisionを含む場合は、先にrepository-controlled docs/ADRへ永続化する。
