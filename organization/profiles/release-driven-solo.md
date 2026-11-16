# Release-driven solo development profile

- Status: Current default
- Constitutional authority: none; this profile must refine the Constitution
- Related: ADR-0004, ADR-0008, ADR-0012, ADR-0013, ADR-0016, ADR-0018, ADR-0022, ADR-0023, ADR-0024, ADR-0025, ADR-0026, ADR-0031, ADR-0032

## Purpose

現在のsolo / small-project release-driven developmentで使用する標準Operating Modelを定義します。

このprofileはproject-initの唯一の正しいorganization topologyではありません。別profileまたはproject-specific modelがConstitutionを満たす場合は置換できます。

## Current topology

### Source and implementation state

- Git: source stateのcanonical authority
- GitHub Issues: durable implementation scope / acceptance criteria / dependency state
- GitHub Pull Requests: review / candidate integration / validation evidence
- `main`: released/integrated source state
- `release-x-y-z`: current release integration line

### Release planning

- Linear Projects / Initiatives: release goal / target date / health / portfolio view
- GitHub IssueをLinear Issueへ全面mirrorしない
- implementation/dependency factsはGitHub側のownershipを維持する

### Delivery defaults

- normal planning / review cadence: 1 week (publication cadenceは可変)
- 1 release train = 1 version = 1 integration branch。複数planning windowへの継続・同じ週の早期releaseを許容する
- versionは公開する変更のcontract / release intentで決める（major / minor / patch）。週次経過だけでbumpを強制しない
- release candidate review: change scope/risk、value/urgency、unpublished wait、release-only CI/deploy実測で hold / candidate / blocked を記録し、project-local thresholdは根拠を示す
- release candidate freeze: scope/current SHAを固定し、候補外ticketのlandingを短期間保留。ticket実装/レビューは継続し、候補外は次releaseへretargetする
- freeze中のSHA変更はaffected validationを失効させて再実行する。candidate readyだけではmainへのrelease mergeを承認しない
- top-level durable work: GitHub Issue
- ticket branch: Issue number only
- independent ticket PR: target release branch
- hard dependency stack: immediate predecessor branchをbaseにできる
- first meaningful durable commit後はcanonical remote publication + PR作成を行う。active/incomplete implementationではDraft、readiness条件を満たしていればReady for reviewとする
- Draftは未完了作業の一時状態に限定し、ticket/release PRがreadiness条件を満たしたら速やかにReady for reviewへ遷移する。PR作成時点ですでに条件を満たす場合は最初からReadyで作成する
- release branchにmeaningful differenceが入ったらDraft release PRを維持し、release readiness条件を満たした時点でReady for reviewへ遷移する
- readiness/quality gateを満たしたticket PRは追加のuser merge authorizationを待たず、dependency順にtarget release trunkへ自律landingする
- ticketがtarget release trunkへlandしたらlinked Issueを明示closeし、安全ならticket branchを削除する
- recovery/completion時にPRなしticket branch、Ready未landing PR、land済みopen Issue、merged後残存branchをreconcileする
- `main`へのnormal integrationはcurrent release branchからのrelease PRだけ。release PRはbulk/autonomous ticket landingから常に除外する
- `release-* -> main` のmergeだけはcurrent interactionのexplicit user authorizationを必須とし、generic merge/cleanup指示からrelease authorizationを推定しない
- PR landing method: merge commit only
- repository merge settings: `allow_merge_commit=true` / `allow_squash_merge=false` / `allow_rebase_merge=false`
- squash merge / rebase mergeは使用しない。branch-local `git rebase` はstack maintenance等のbranch mechanicsとして別扱い
- stacked/native landingはmerge commit semanticsを保持できる場合だけ使用する
- ticket landingはADR-0027に従い自律実行する（candidate freeze中の一時停止を除く）。release-class `release-* -> main` landingだけADR-0012/ADR-0027のexplicit authorization boundaryを維持する

### Workspace/runtime defaults

- project-local toolchain/bootstrap frontend: mise
- runtime / development CLI prerequisitesは原則repository-controlledな `mise.toml` からmaterializeする
- fresh clone / CI / agentのbootstrapは `mise install`、committed mise lockfileをreproducibility mechanismとして使う場合は `mise install --locked`、command executionは `mise exec -- ...` / `mise run <task>` を標準入口とする
- required toolはexact pin、bounded version request + committed mise lockfile、または既存ecosystem-native canonical version sourceのいずれかでreproducibleにする
- `rust-toolchain.toml` 等のnative canonical version sourceがある場合、mise側へ独立した競合pinを作らない
- external/untrusted PR checkoutでrepository-controlledなmise config/taskをagentが実行する前に、documented trust reviewまたはbounded sandboxを必須とし、mise自体をisolation boundaryとして扱わない
- miseはOS/system package、container/sandbox、secret management、worker isolationの代替にしない
- mise unavailable/incompatible時は同等のversion/reproducibility guaranteeを持つ明示的fallbackを使用する
- WSL/Linux worktree frontend: Worktrunk
- Worktrunk unavailable/incompatible時: native Git worktree fallback
- worktreeのsetup / teardown / port決定はrepository-controlledな入口に置き、Worktrunk・Orca・plain gitのどのfrontendからも同じ入口を呼ぶ
- Orcaは任意のUI / agent terminal frontendとして併用できる。Orcaのworkspace・orchestration stateはSoTにせず、Orcaなしでも同じ状態を作れることを保つ（`orca-frontend`）
- Rust/Cargo projectではconcurrent worktree間で`target-dir` / `build.build-dir`を共有せず、Cargo registry/git cacheと必要に応じたbounded `sccache`を共有候補とする
- short-lived agent worktreeのincremental compilationはreuse期間とdisk footprintを見て`CARGO_INCREMENTAL=0`を選べる。long-lived interactive checkoutへ機械的に伝播させない
- Rust `target/`はdirect sharingしない。Worktrunk ignored-file copyは`--require-include` + repository-controlled `.worktreeinclude` allowlistを必須とし、承認済みnon-secret cache pathだけを対象にする。reflink対応filesystemでのみCoW seedを許容し、full-copy hostでは除外する。cleanupはselective `cargo clean`とworktree lifecycleを優先する
- worktree自体をruntime isolation proofとして扱わない
- cross-boundary / judgment-heavy workで独立したtop-level workが複数ある場合、Herdrをoptional adaptive Supervisor runtimeとして使用できる
- Mac / Windows native / WSL間で作業を配置する場合は [execution placement](../execution-placement.md) を適用する。OS固有機能の一致、物理ホスト共有資源（Windows + そのWSLは同じ資源群）、実行権限/lease、証拠SHAを判定し、別端末での実行を負荷分散と無条件に同一視しない。Herdr/SSHは実行場所への接続手段であり、Supervisor権限・mutable ownership・GUI実機証拠を生成しない
- fan-outはsmallest useful fan-outから開始し、Ready work / uncertainty / WIP / resource / human-review / CI bottleneckを見て増減する。agent数自体をoptimization targetにしない
- 単独で済む軽量taskに不要な委譲を増やさない。ただし project-local で dedicated non-authoring Supervisor profile を選択した場合、軽量taskは単独Worker/限定executorへ送る。Supervisor自身が実装する例外にはせず、委譲不能ならblockedとする（`supervisor-boundary` / ADR-0035）。このprofileは明示導入であり、通常のcombined actorを無条件に禁止しない。external delegationが必要なroleについてはproject-localでresolved routeを先に固定し、Herdrと統一`agent` launcherが利用可能な場合はその経路を使う。provider/budgetの分離が必要な委譲をnative subagentで代替しない
- native subagentはroute制約のない短命な観測・探索作業に限り選択可能。既存のproject-local delegation policyがexternal Workerを指定するroleではnative subagentをdefaultにしない
- 現在のroute選択・起動preflight・fail-closedの参照実装は`templates/agent-routing/`。モデル・credentialの定義は引き続きdotfilesの統一`agent` launcherをSoTとし、project-initに複製しない
- implementation workerのmutable runtimeは適切に分離する
- parent/child handoffはimmutable identityへpinする

### Cloudflare CLI defaults

Cloudflareを利用するprojectでは、Cloudflare control plane / resource API / supported Worker lifecycleのprimary CLIを `cf` とする。

- Cloudflare documentationやexampleがWranglerで記述されていても、それだけをWrangler採用の根拠にしない。まず `cf cli search` 等でcurrent `cf` surfaceに同等操作があるか確認する
- `cf` で同等のworkflowを実行できる場合は `cf` を使用し、新規automationやagent instructionをWrangler前提で増やさない
- `cf` が未対応、互換性不足、または対象workflowでWranglerへ委譲する場合は、Wranglerをexplicit compatibility fallbackとして残してよい
- Wrangler fallbackは必要なworkflowへboundedにし、silent fallbackにしない。tool upgrade / project reconciliation時に `cf` capabilityを再確認し、不要になったfallbackを縮小・削除する
- `cf` がWranglerへ内部委譲するprojectでは、表面commandを `cf` に統一できてもWrangler dependencyを誤って削除しない
- Cloudflareを利用しないprojectへ `cf` / Wranglerをpolicy complianceだけのために導入しない
- `cf` / WranglerはPracticeでありConstitutionではない。provider/tool capabilityの変化に応じて同等以上のguaranteeを持つmechanismへ置換できる

### Interactive AI harness/provider configuration

- Project runtime contractは、必要なagent能力・recovery evidence・budget/authorizationを定義する。個人のAPI契約、モデル名、token残量、ログイン状態をproject-levelの正しさとして固定しない。
- current user environmentでは、machine-global CLIの導入は`pc-setup` / mise、任意のAPI接続先への切替は`dotfiles`の**統一`agent` launcher（宣言TOML `config/agents.toml` + process-scoped Infisical ENV injection）**で行う。別の専用ルーターや長寿命proxyを要求しない。
- CLIの通常コマンドはnative loginのまま保持し、特別なprovider/accountは明示的な`agent <ハーネス> <provider>` routeで選択する。model・endpoint・credential名はTOMLの宣言のみで変更し、未知の組み合わせは起動前に失敗させる。quota枯渇による無断の従量課金failoverはしない。
- 個別ハーネスのplugins/hooks/sessions/config、秘密情報のSoT、project-localな役割を混同しない。task再開は既存task（Issue）・PR・commitのdurable handoffを優先し、validationで状態を補完する。

### Secret / environment defaults

- application / serviceのsecret valueはInfisicalをcurrent default SoTとする
- current default control planeはself-hosted `https://secrets.rebuildup.dev` とし、APIは `https://secrets.rebuildup.dev/api`
- current defaultで使用するprovider endpoint / project ID / environment/path mapping等のnon-secret pointerをrepositoryからdiscoverableにする
- wrapper / CI / runtimeはprovider endpointを明示し、managed Infisical Cloudへ暗黙fallbackしない
- required key / type / validation / non-secret metadataはrepository-controlled schemaとして保持する
- normal local workflowはCLI-firstとし、runtime injectionを優先する
- plaintext `.env` をcanonical storeにしない
- human / agent / CIはidentityを分離し、project / environment / path / actionをleast privilegeにする
- GitHub Actionsは利用可能ならOIDC + scoped Machine Identityを使用し、long-lived master credentialをdefaultにしない
- generic CIへproduction secretを渡さない
- NixOS / dotfiles / bootstrap等 encrypted secret-in-Git がexplicit requirementならSOPS等へdeviateできる
- provider-specific procedureは `secrets-management` Skillへprogressive disclosureする

### Quality / evidence

- project-specific adaptive quality profileをcompileする
- validation evidenceをcurrent artifact/SHAへbindする
- worker / integration / release gateの責務を分ける
- fixed universal required status check名は前提にしない

## Constitutional mapping

### Identity Integrity

- resolved immutable SHAへsnapshot/result/validationをpin
- predecessor change後にaffected validationを再実行
- execution generation/fencingでstale continuationを区別

### Authority Integrity

- ticket-class integrationとrelease-class landingを分離する
- ticket PRはreadiness/quality gate通過後のautonomous landingを標準権限とする
- `release-* -> main` だけexplicit user authorizationを要求し、ticket権限をreleaseへ伝播させない
- merge method固定やrepository settingの整合からrelease authorizationを導出しない
- release/product/irreversible decisionは定義済みauthority boundaryへ従う

### Evidence Integrity

- current SHAのvalidation evidenceを使用
- false greenを禁止
- PR/release readinessはapplicable evidenceへ基づく

### Mutable Ownership Safety

- worktree-only isolationを認めない
- concurrent implementation workerはmutable runtimeを安全に分離
- DB/Redis/queue/port等のshared mutable stateを別途調停

### Organizational Continuity

- Issue / PR / Git ref / committed docs / immutable resultをdurable recovery sourceにする
- native conversation resumeをcanonical recovery stateにしない

### Canonical Consistency

- source / implementation / review / release-planning responsibilityをfield ownershipで分離
- 同一factの二重canonical化を避ける

### Progress

- 自明なimplementation decisionを不要にoperatorへ返さない
- review/validation完了後のticket workは不要なpermission待ちで停止せず、landing -> Issue close -> safe branch cleanupまで進める。release mergeだけはexplicit authorizationを実blockerとして扱う
- safety mechanismがdelivery deadlockを作る場合はOperating Modelをre-evaluateする

## Deviation

このprofileの具体的なtool/cadence/topologyから外れる場合でも、該当するConstitutional guaranteeを維持できれば許容します。

explicit user/project decisionとして固定されたrelease scope/version/public contract等は、単なるdefaultとは区別します。

## Re-evaluate / remove

次の場合はprofile全体または一部を見直します。

- agent/runtimeが同等以上のisolation/recovery/review semanticsをより単純に提供する
- GitHub/Linear/Worktrunk/miseの役割を別systemが置換する
- release branch modelがcontinuous delivery等に対して逆効果になる
- weekly cadenceがproject objectiveへ合わない
- eval/実績から特定procedureの追加価値が消えた
