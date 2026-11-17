# Canonical requirement continuity at handoff and fan-in

This procedure is conditional for durable, complex, parallel or compaction-prone work. It refines Issue #152, not an alternative source of requirements.

## Before spawn

複数agentへ委譲する前に、継続して守るべきscope・constraints・acceptance criteria・重要な決定をGitHub Issue / Spec / ADR等の適切な正本へ選別して反映する（`writing-discipline`）。派生Issueには元の要求の出典refと必要なrevisionを引き継ぎ、上流の重要な制約を追跡できるようにする。会話全体や長文promptをそのまま永続化しない。

## During spawn and unavailable sources

spawn inputには正本のrefと必要なrevision/snapshotを明示する。子は親の要約だけで仕様を確定せず、正本を直接読む。アクセス不可なら出典・版を識別できるimmutableな原文抜粋を渡し、送信側が委譲scope内の重要な要求・否定条件・受入基準をすべて含むことを照合する。網羅性を確認できない場合、子は推測で補わず、そのscopeの実装を停止して正本へのアクセスまたは正確な引き継ぎを要求する。短命taskで独立Issueを要しない場合も、親が確定した元のtask contractへの追跡性を維持する。

## Fan-in and recovery

fan-inではchildのsummary/完了宣言ではなく、正本の要求とcurrent artifact・validationを照合する。新たなscope/decisionをhandoff中に暗黙に確定させない。

A fresh agent must verify the original scope, negative constraints, acceptance criteria and resulting artifact; it must not treat a private summary/checkpoint or an inaccessible partial excerpt as authoritative. This rule does not force new Issues for small short-lived work.

## Recovery lifecycle

GitHub上のIssue/PR/branch metadataはdurable recovery evidenceであり、active durable ticket branchにpublished remote head + PRがない状態を正常状態として扱わない。PRが存在する場合もactive/incompleteならDraft、readiness条件を満たしていればReady for reviewであることをreconcileする。Ready ticket PRの未landing、land済みopen Issue、merged/landed後のstale ticket branchもdriftとしてrepairする。zero-diff release branchはDraft release PR invariantの例外だが、first meaningful integrated difference後はDraft release PRを必須とし、release PRをautonomous ticket landingへ含めない。
