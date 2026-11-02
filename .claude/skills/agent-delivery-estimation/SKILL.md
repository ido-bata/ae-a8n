---
name: agent-delivery-estimation
description: AIエージェント主体の開発で、中長期のrelease/roadmap計画、完了時期、capacity、agent並列度を、主観的な日数感覚ではなくWork Unit・依存関係・実測throughput・human/CI/external wait・usage limitから評価する時に使用する。
---

# Agent Delivery Estimation

AIエージェント自身の「この規模なら数週間」「大型なので数ヶ月」といった主観的calendar estimateを採用しない。
中長期のdelivery forecastは、作業構造と観測可能な実績から構築する。

## Use this Skill when

次の場合に使用する。

- release / roadmap / milestoneの完了時期を見積もる
- 1週間 / 1か月で到達可能なscopeを評価する
- sprint / release scopeがcapacityに収まるか判断する
- agent数、WIP、並列実行数を増減した場合の効果を評価する
- human review / CI / external wait / usage limitを含むbottleneckを特定する
- 予定日に間に合う確率を評価する
- 長期計画のforecastを実績で再校正する

小さな単発taskの即時実装判断に、必ずしもこのSkillを使う必要はない。

## Core rules

### Evidence before numbers

AI自身の感覚だけでcalendar time、throughput、rework rate、parallel speedupを生成しない。

すべての数値にprovenanceを持たせる。

- measured
- derived
- external
- user-specified-scenario
- provisional
- unknown

provisionalは無条件にforecastの根拠へ昇格させない。

### Unknown before invention

データ不足は正当な結果である。

- insufficient data
- unknown
- not identifiable from current evidence

unknownを「安全側に2倍」等の任意倍率で補完しない。

### Structure before duration

時間を考える前に、scope、Work Unit、dependency、parallelism、human gate、external waitを確定する。

### Historical data over intuition

同一project / repository / workflowの実績をAIの一般論より優先する。

### Probability over single date

十分な証拠がある場合は一点日付ではなくP50 / P80 / P95を使用する。

---

# Phase 1: Inspect

実装を開始せず、対象projectを調査する。

確認するもの:

- Issue / milestone / release scope
- related PR
- subsystem / repository
- dependency / blocked-by
- release gate
- CI / E2E / manual verification
- human decision / approval
- external service / store / infrastructure wait
- runtime / environment constraint
- usage limit
- active agent count / WIP
- unresolved specification
- historical comparable work
- previous forecast / observation data

この段階ではcalendar estimateを生成しない。

---

# Phase 2: Extract Work Graph

残作業を独立したWork Unitへ分解する。

最低限のfield:

~~~yaml
id:
description:
type:
weight: # positive number (> 0)
dependencies: []
parallelizable: true
human_required: false
external_wait: false
validation: []
risk:
  ambiguity:
  unfamiliarity:
  integration:
  external_dependency:
  validation_difficulty:
~~~

Work Unitは絶対時間ではなくproject内の相対作業量である。
`weight` / `original_WU` は必ず正の値とし、0以下のWork Unitを作らない。作業量を持たないgateやmilestoneはWork UnitではなくDAG上のgate / eventとして表現する。

## Anchor-based WU calibration

新しいWUを決める前に過去の完了済みWUをanchorとして比較する。

例:

- 0.5 WU: small fix + focused test
- 1.0 WU: single-subsystem feature + tests
- 2.0 WU: frontend/backend contract change + integration validation
- 3.0 WU: cross-repository change + release coordination

上記は説明例であり、projectの既定値ではない。
実際のweightはproject-local anchorから決定する。

十分なanchorがなければWU calibrationをprovisionalまたはunknownとし、絶対日数へ変換しない。

---

# Evidence fallback hierarchy

WU calibration、throughput、risk mapping、rework、waiting time、Monte Carlo samplingでは同じfallback hierarchyを使う。

優先順位:

1. same project + same repository + comparable task characteristics
2. same project + comparable task characteristics
3. same repository + comparable workflow
4. same project, broader historical population
5. explicitly supplied reference dataset
6. provisional / unknown

比較可能性では可能な範囲で以下を揃える。

- task type
- risk level
- validation type
- cross-repo status
- subsystem
- agent/model
- usage-limit condition
- human-gate requirement

fallbackした場合はevidence level / depth / sample sizeを記録する。
異なるpopulationを無言で混合しない。

---

# Sample-size policy

既定の証拠品質:

- n = 0: unknown
- n = 1–2: anecdotal。分布推定に使わない
- n = 3–4: provisional。傾向把握のみ
- n = 5–9: sparse-measured。経験分布利用可、tail estimateは不安定
- n = 10–19: measured。P50 / P80利用可、P95はprovisional
- n >= 20: distribution-capable。P50 / P80 / P95利用可

projectがより厳しい基準を定義している場合はそちらを優先する。
閾値を変更する場合はestimation configへ明示する。

Monte Carloの反復回数を増やしても元データ不足は解消されない。

---

# Phase 3: Risk mapping

riskを収集するだけで終わらせない。

可能ならhistorical evidenceから以下へ接続する。

risk features
→ first-pass success
→ rework
→ validation rounds
→ block probability
→ delay distribution

十分な履歴がなければrisk impactをunknownとする。
任意のrisk multiplierを作らない。

---

# Phase 4: Dependency graph

Work UnitからDAGを作る。

最低限区別する。

- total work
- parallelizable work
- serial-only work
- critical path
- blocked work
- human-gated work
- external-gated work

critical pathとparallelizable workは別軸であり、排他的な内訳とは限らない。

calendar durationを単純な total WU / agent count で計算しない。

---

# Phase 5: Measure capacity

可能なら次を観測する。

- completed WU / day / week
- Issue start → first PR
- first PR → first green
- first green → merge
- review rounds
- rework events
- CI failures / queue delay
- blocked duration
- active agent count
- agent/model
- usage-limit events
- human review throughput
- human decision latency
- external wait

## Throughput accounting

`completed WU / day / week` は既定で **active-work throughput** を意味する。

- 分子: 完了WUの `actual_total_WU` の合計。initial workとreworkを含む
- 分母: そのWU群に実際に費やしたactive work time。internal queue、human wait、CI/build/deploy wait、external wait、usage-limit cooldownは除外する
- 単位: `actual_total_WU / active-work day` または `actual_total_WU / active-work week`

残scopeのactive work demandは、各WUの `original_WU` にsampled reworkを反映して `actual_total_WU` 相当へ変換し、active-work throughputで処理時間へ変換する。

```text
active_duration = sampled_actual_total_WU / sampled_active_work_throughput
calendar_duration = DAG_schedule(active_duration, sampled_waits, gates, queues)
```

human / CI / external / usage-limit waitはDAG scheduleで一度だけ加える。active-work throughputの分母から除外したwaitを、別のwait distributionとして重複計上しない。

active work timeを分離できずwall-clock throughputしか得られない場合、そのthroughputはend-to-end baselineとして扱い、同じ観測区間に含まれるhuman / CI / external waitを別途加算しない。waitを分解したforecastが必要なら、active-work / wait splitを追加観測するまでconditionalまたはunavailableとする。

## Human capacity

AI capacityと人間のcapacityを分離する。

対象例:

- requirement / architecture decision
- design approval
- PR approval
- release approval
- credential / permission
- device verification
- manual QA

AI throughputがhuman throughputを上回る場合、人間queueをbottleneckとして扱う。

## Waiting time

少なくとも次をactive workから分離する。

- internal queue
- human wait
- CI/build/deploy wait
- external wait
- usage-limit cooldown

---

# Effective parallelism

agent数を線形倍率として扱わない。
固定の飽和テーブルも持たない。

## Baseline forecast

現在のagent構成で十分な実測throughputがある場合、その実測値を直接利用する。
baseline forecastだけならparallelism倍率を推定する必要はない。

## Scaling forecast

agent数を変更するwhat-ifでのみscaling effectを評価する。

異なるagent countの期間を比較する場合、可能な限り以下を統制する。

- WU calibration
- task mix / risk
- repository / subsystem
- validation requirements
- model
- usage-limit
- human availability
- blockers

task mix等が違う期間のthroughput差だけから因果的speedupを決めない。

統制不能なら:

- parallelism relationship: observed correlation
- causal scaling effect: unknown

とする。

---

# Rework model

可能なら各WUについて記録する。

- first-pass success
- attempts
- additional WU
- additional validation rounds
- original_WU
- actual_total_WU

rework ratio:

(actual_total_WU - original_WU) / original_WU

`original_WU > 0` をschema invariantとするため、この式は常に定義可能である。既存履歴に0-weight recordがある場合は、そのrecordを比率計算へ含めずdata-quality issueとして記録する。

Forecastでは類似taskの経験分布をbootstrapする。
根拠のない平均rework率を生成しない。

---

# Unknown handling policy

unknownを発見したら、まず4種類へ分類する。

## Structural unknown

scope、dependency、architecture等が未確定でWork Graph自体が安定しない。

結果:

forecast_status: unavailable

P50 / P80 / P95を出さず、何を解決すればforecast可能になるか示す。

## Material distribution unknown

Work Graphは作れるが、critical-path rework、mandatory human approval latency、external wait等、completion distributionへmaterialな入力が欠ける。

結果:

forecast_status: conditional

unknownを0や任意の保守値で埋めない。
必要なら「Xの追加delayがない条件下」等の条件付き結果だけを出す。
conditional resultを通常の確率coverageとして扱わない。

## Scenario-only unknown

baselineには不要だがwhat-ifには必要。

例:

current 4-agent throughputはmeasuredだが8-agent scaling effectはunknown。

結果:

- baseline forecast: available
- 8-agent scenario: unavailable

## Non-material unknown

forecastを実質的に変えないunknown。
記録するがforecastを停止しない。

## Materiality

次のいずれかを変え得る因果経路がある場合materialとみなす。

- Work Graph
- critical path
- bottleneck
- mandatory wait
- rework distribution
- completion distribution
- release eligibility

---

# Phase 6: Forecast

Forecastには必ずstatusを付ける。

## complete

必要なmaterial inputが十分な証拠品質で揃っている。

証拠条件を満たすquantileのみ出す。

## conditional

material unknownが残るが明示条件下の分析は可能。

## unavailable

Work Graphまたは必須capacity evidenceが成立していない。

数字を捏造しない。

---

# Monte Carlo policy

十分な履歴がある場合の既定方式はempirical bootstrap resamplingとする。

対象例:

- throughput
- rework
- human latency
- CI delay
- blocked duration
- external delay

観測サンプルから復元抽出する。

## Bootstrap observation unit

既定の再標本化単位は、1つのcompleted Work Unitまたは同一execution episodeに紐づく **joint observation** とする。可能な場合は次を同じrecordへ保持する。

- active-work throughput / active duration
- original_WU / actual_total_WU / rework
- human gate latency
- CI queue / execution delay
- blocked duration
- external delay
- agent count / model / usage-limit condition
- shared gate / queue identity

同一episode・同一shared gate・同一queue等の共通原因を持つ値は、相関を壊さないようjointに再標本化する。独立再標本化してよいのは、観測上も運用上も別mechanismであり、shared gate / queue / episodeを持たないことを説明できる場合だけとし、そのindependence assumptionをforecast evidenceへ記録する。joint dataが必要なのに存在しない場合は、独立と仮定せずmaterial distribution unknownとして扱う。

## DAG aggregation per bootstrap iteration

各反復で次の順序を固定する。

1. Evidence fallback hierarchyとtask characteristicsに従い、各WU / gate / queueに対応するobservationを復元抽出する。
2. 各WUの `original_WU` にsampled reworkを反映して `sampled_actual_total_WU` を得る。
3. `sampled_actual_total_WU / sampled_active_work_throughput` でactive durationを得る。
4. predecessorが複数あるWUのearliest startは、必要なpredecessor completion / stack-ready snapshot availabilityの最大値とする。serial chainは依存順に累積し、parallel branchは同時進行できる範囲で重ねる。
5. shared human gateはhuman capacityを持つ共通resource queueとして、shared CI queueはCI capacityを持つ共通resource queueとしてscheduleする。同じgate / queue delayを各downstream WUへ重複加算しない。
6. blocked / external waitは、それを生じさせるedgeまたはgateへ一度だけ配置する。
7. release completionはterminal WU群のcompletion最大値に、まだDAGへ含まれていないmandatory release gateをscheduleした時点とする。
8. 反復ごとのrelease completion durationを保存し、その経験分布からP50 / P80 / P95を算出する。

AIが任意のNormal / Uniform等の分布を生成しない。

conditional samplingはEvidence fallback hierarchyに従う。
最も比較可能なpopulationから始め、sample size不足なら一段ずつ広げる。
どこまでfallbackしたか記録する。

Tail quantile policy:

- n < 5: probability forecast不可
- 5 <= n < 10: empirical distribution利用可、tail quantileはdecision-gradeにしない
- 10 <= n < 20: P50 / P80利用可、P95 provisional
- n >= 20: P50 / P80 / P95利用可

---

# When historical data is missing

AIがFast / Expected / Constrained throughputを勝手に作らない。

## Capacity-target scenario

利用者が明示したcapacityをscenarioとして使用してよい。

必ず scenario, not forecast と表示する。

## Calibration period

短期間の実測を優先する。

最低限:

- completed WU
- active agents
- human review
- blocked time
- usage-limit events

を記録する。

初回観測が得られてもn=1で確率forecastを開始しない。

---

# Confidence

Forecast uncertaintyとEvidence confidenceを分離する。

P50/P80/P95の幅は観測されたvarianceから生じる。
Low confidenceだから任意に区間を広げない。

Evidence confidence:

High:
- stable scope
- sufficient WU anchors
- material inputs distribution-capable
- dependencies resolved
- shallow fallback

Medium:
- some sparse-measured inputs
- broader fallback population
- scope mostly stable

Low:
- provisional calibration
- material sample shortage
- deep fallback
- significant unknowns

P80とEvidence confidenceを同じ意味として扱わない。

---

# Persistence

project内に専用storageを置く場合の推奨:

~~~
.estimation/
  config.yaml
  work-units.yaml
  observations.ndjson
  forecasts.ndjson
~~~

既存のplanning / metrics storageがある場合はそちらを優先する。

configの既定sample policy:

~~~yaml
sample_policy:
  empirical_min: 5
  p50_p80_min: 10
  p95_min: 20
~~~

observationsには少なくともtimestamp、work unit、event、agent count、model、rework/blocked情報を追跡可能な形で残す。

forecastsには少なくともtimestamp、scope revision、status、quantiles、confidence、evidence snapshotを残す。

---

# Recalibration triggers

次で再計算する。

- Work Unit完了
- significant blocker発生 / 解消
- scope変更
- dependency変更
- agent数 / model変更
- usage limit変更
- human availability変更
- release gate完了
- material unknown解消
- evidence quality tier変更

---

# Forecast evaluation

予測精度そのものを測る。

最低限:

- forecast error
- forecast bias
- P50 coverage
- P80 coverage
- P95 coverage

coverage calibration目安:

- n < 20: insufficient evidence
- n >= 20: early calibration signal
- n >= 50: meaningful calibration assessment

長期的に、例えばP80 forecastならactual completionが概ね80%包含される状態を目指す。

---

# Output contract

最低限以下を返す。

すべての**数値field**は、単独の裸の数値ではなく次のevidence recordで表現する。

~~~yaml
value:
unit:
provenance: measured | derived | external | user-specified-scenario | provisional | unknown
evidence_ref: []
~~~

- `evidence_ref` はobservation ID、commit / snapshot、external dataset、user instruction、simulation run ID等、根拠を再取得できる参照を持つ
- derived valueは入力evidenceに加えて計算 / simulation runを参照する
- unavailableな値は `value: unavailable`、`provenance: unknown` とし、欠落理由を `evidence_ref` またはUnknownsから追跡可能にする
- provisionalな値は `provenance: provisional` を維持し、通常のdecision-grade measured valueへ見せかけない

~~~markdown
## Scope
Remaining work:
Critical path:
Parallelizable work:
WU calibration:
  value:
  unit: WU
  provenance:
  evidence_ref:

## Capacity evidence
Observation window:
Sample size:
  value:
  unit: observations
  provenance:
  evidence_ref:
Evidence quality:
Active agents:
  value:
  unit: agents
  provenance:
  evidence_ref:
Active-work throughput:
  value:
  unit: actual_total_WU/active-work-day
  provenance:
  evidence_ref:
Human review capacity:
  value:
  unit:
  provenance:
  evidence_ref:
Main bottleneck:

## Forecast
Status:
P50:
  value:
  unit: calendar-duration
  provenance: derived
  evidence_ref:
P80:
  value:
  unit: calendar-duration
  provenance: derived
  evidence_ref:
P95:
  value:
  unit: calendar-duration
  provenance: derived
  evidence_ref:
Evidence confidence:

## Evidence fallbacks
...

## Unknowns
...

## Main uncertainty
...

## Acceleration candidates
...
~~~

P50 / P80 / P95の各`evidence_ref`は、少なくともforecast input snapshotとbootstrap / simulation runを個別に参照する。WU calibration、throughput、agent count、human capacity等、forecastへ入るcapacity数値にも同じrecord形式を適用する。

sample policy上利用できないquantileは、値を捏造せずunavailable / provisionalと表示する。

Acceleration candidateへ数値効果を付ける場合もobserved evidenceまたはsimulationを必要とする。

---

# Integration with other Skills

## github-delivery

release / sprint scope、target date、capacity、carry-over判断を行う時は本Skillを参照する。
IssueのSizeはcalendar durationと同義にしない。

週次sprint cadenceはplanning cadenceであり、「すべてのscopeが1週間で完了する」というestimateではない。

## parallel-orchestration

agent数、WIP、spawn数を増やす前に、現在のbottleneckとparallelism evidenceを確認する。
agent count増加を線形speedupとして扱わない。

orchestrationから得られるactive agents、blocked time、generation/retry、usage limits等はestimation observationへ利用できる。

## quality-gate

validation level、CI delay、E2E/manual requirementはdelivery durationへ影響する入力である。
quality gateをestimate短縮のために弱めない。

## agent-recovery

interruption / reassignment / recoveryによるwall-clock delayやreworkは観測対象とする。
recovery policy自体をestimate達成のために省略しない。

---

# Anti-patterns

禁止:

- 「大型なので3〜6か月」
- 「AIなら5 WU/dayくらい」
- 「4 agentsなら3倍速」
- 「unknownなので安全側に2倍」
- 根拠のないNormal / Uniform distribution
- n=1をmeasured distribution扱い
- task mixが違う期間のthroughput差をagent数の因果効果と断定
- 一般的なhuman team工期をそのままAI開発へ適用
- human bottleneck / waiting timeの無視
- riskを収集してforecastへ接続しない
- uncalibrated WUをcalendar durationへ直結
- 18.4 daysのようなfalse precision

---

# Goal

未来を言い当てることではない。

次を、人間の直感やAI自身の主観的見積もりより再現性高く判断する。

- what can finish
- by when
- with what probability
- under which constraints
- based on which evidence

さらに予測精度そのものを計測し、継続的に再校正する。
