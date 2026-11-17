# Adaptive release batching — release candidate review

このreferenceは `github-delivery` の週次planningとrelease candidate selectionの実行手順。閾値とbudgetはプロジェクト固有であり、一般化した固定値を埋め込まない。ADR-0032に従う。

## 1. Reviewの入口

週次planning checkpoint、変更量/影響範囲のproject-local limit到達、公開価値の成立、緊急修正、最古の未公開変更の待機上限到達、release-only costの変化で候補を**再評価**する。期限到達を自動publication triggerにしない。緊急修正も通常のrelease branch / user authorization / release gateを経る。

判定に必要な最小情報:

- integrated ticket IDs / dependency graph / scope admission state（未確定要求をcritical pathへ入れない）
- user-facing value・priority・security impact・urgency・external deadlines
- earliest integrated-but-unpublished change、elapsed waiting time、未公開変更の件数とリスク面
- changed areas / interfaces / persistence / deployment / reversibility、必要なrelease-wide verification
- PR CIとrelease-onlyの別々の実測: trigger頻度、runner minutes、revalidation、artifact、deploy実行・料金、rollback負担（利用可能な値のみ）
- release候補へ含めないopen ticket / stacked PR / carry-over owner
- project-local thresholdsと根拠のrevision。測定不足なら `unknown` と記録し、架空のcostや推奨頻度を作らない

PR数・変更ファイル数は変更量の一部であり、それだけでrelease eligibility、安全性、費用を決定しない。quality gateを削って費用を最適化しない。`quality-gate` がCI resource evidenceを、`agent-delivery-estimation` が日程/待ち時間の根拠を提供する。

## 2. Outcomeは3種類

| Outcome | 意味 |
| --- | --- |
| `hold` | 候補化せず次checkpointに再評価。期限/責任者を記録 |
| `candidate` | admitted scopeを選択し、候補freeze/terminal gateへ進む |
| `blocked` | データ不足・未確定scope・検証不能・依存不整合などのblockerを解消する。期限だけで繰り上げない |

`candidate` はpublic releaseの許可ではない。候補作成、候補Ready、green CI、閾値到達は `release-* -> main` をauthorizeしない。

Decision record（既存のGitHub release PR / Linear release Projectを利用し、別SoTは作らない）:

```text
checkpoint / evaluated_at:
release_version / branch / current_sha:
integrated_scope / admitted_scope / excluded_scope:
change_surface / dependency / risk:
value / urgency / oldest_wait:
PR_CI_usage / release_only_usage / deploy_cost (measured/unknown):
local_thresholds / evidence / tradeoff:
outcome: hold | candidate | blocked
next_checkpoint_or_blocker_owner:
approval_state: not_requested | requested | authorized
```

## 3. Freeze・terminal verification・handoff

1. `candidate` を選んだらCoordinatorがscope、freeze owner、current release trunk SHAを記録し、同じtrunkへの**新規ticket landingだけ**一時保留。非対象ticketの実装/PR reviewは継続できる。
2. release candidate scopeに含めないin-flight ticketはcarry-overとしてowner・依存関係・保留理由を記録し、旧candidateへのlandingを保留する。次release branchが存在する前にretargetしない。freeze解除で旧候補に滑り込ませない。
3. frozen SHAに対してrelease-applicable integration / E2E / smoke / packaging / publication前のsemantic gateを実行。failure時は問題を修正するため明示的にunfreeze/re-scope、変更SHAでrequired gateを再実行する。
4. release PRのreview/qualityが完成しても明示的user release authorizationがない場合はReadyで停止する。承認があればauthorization対象SHAを再取得して検証し、release PRをmerge commitでmainへ入れる。
5. project-local publication artifactをpublish /再取得/ identity verificationする。次release trainはpublish後のmainから開始する。次branch作成後にcarry-over ticketをretarget/rebaseし、stack dependency、remote head、PR metadataを整合して変更後のSHAでfresh validationを実行する。freezeが長期化・複数releaseが競合する場合はrelease coordinatorが明示的に整合し、平行publicationを暗黙許可しない。

## 4. Calibration / recovery

- release後、実測のrelease-only CI/deploy usage、変更量、公開待機、revalidation数、post-release defect/rollback、freeze durationを比較し、project-local thresholdを更新する。
- freeze中にownerが中断した場合も、決定記録・候補SHA・PR/Issue dependencyから復旧。候補を自動解除して変更をlandしない。
- budget不足なら不要な重複CIから改善し、required gateを消さない。費用不明なら推奨閾値はunknownのまま報告。
