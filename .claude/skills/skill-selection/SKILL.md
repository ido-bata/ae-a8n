---
name: skill-selection
description: projectの初期化や再整備で、どのAgent Skillを導入するかを決める時に使用する。必要な能力を判定し、project-initの能力一覧と候補記録、さらに外部の探索から候補を評価して、能力ごとに担当を決め、project-localに導入してlockと採否を記録する。
---

# Skill Selection

Skillの導入を「良さそうなものを足す」作業にしない。目的は、projectに必要な能力ごとに、衝突しない担当を1つずつ決めることである。

## Skillはガードレールである

Skillは、agentが的外れな方向へ失敗するのを防ぐガードレールとして導入する。「当てはまるかもしれないから使う」ものではない。

- 発火する場面が明確で、その場面に**ちょうど当てはまる**Skillだけを採用する。少しでも関係しそうなら起動する、という広いtriggerのSkillは採らない。
- 手順の量は、防ぐ失敗の大きさに比例させる。短い作業を長い儀式に変えるSkill（小さな修正にも毎回TDDや対話式のbrainstormingを強制するもの等）は採らないか、条件を絞った起動にする。
- 良いSkillは、防ぐ失敗の型と、その場面でだけ効く判断基準を短く持つ。一般的な心得の網羅は、agentが既定でできることの繰り返しになりやすい。

project-initには、選定の材料となる2つの表がある。

- `catalog/capabilities.tsv` — 能力の一覧。`scope` が `single` の能力は担当を1つに絞り、`multi` は併用してよい。`needed_when` はその能力が必要になる条件。
- `catalog/candidates.tsv` — 評価済みの候補記録。許可リストではない。前回までの評価結果をまとめたキャッシュであり、記録にないSkillも探索して評価してよい。

## 1. 必要な能力を判定する

repositoryの実際の状態から、各能力の `needed_when` が成り立つかを判定する。たとえば、Cloudflareの設定があるか、test基盤があるか、日本語の文書があるか、などである。

一覧にない能力が必要なら、その能力を行として追加する候補にする（§6）。

## 2. 候補を集める

能力ごとに、次の順で候補を集める。

1. projectに既にあるSkill（project-localの `skills/` や導入済みのもの）
2. `candidates.tsv` で `default` の候補
3. `candidates.tsv` の `alternative` の候補
4. 外部の探索（`bunx skills find`、skills.sh、公式vendorのrepository、frameworkの公式docs）。候補repositoryの中身は `bunx skills add <source> --list` で確認できる

記録の `reviewed_on` が古い、または `review_depth` が `listed` / `skimmed` にとどまる候補は、その場で中身を読んでから判断する。記録は判断を省略する根拠にならない。

## 3. 評価する

候補は中身を読んで評価する。descriptionだけで採用しない。

- **担当が重ならないか**：同じ `single` 能力に担当がすでにいれば、置き換えるか見送るかを決める。2つを併用しない。重なったSkillは、互いの指示を打ち消しあうか、片方が無視されるためである。
- **routerではないか**：「応答の前に必ずSkillを確認せよ」「このpackのplaybookに従え」のように入口を握るSkillは導入しない。入口はprojectのroot contractだけが持つ。pack内の個別Skillは部品として使える。
- **前提が合うか**：特定のIDE・plugin・pack固有の設定を前提にしていないか。userの承認待ちで自律実行を止めないか。
- **出所と条件**：maintainer、license、更新状況、外部への通信やcommand実行の有無を確認する。licenseが再配布を禁じるSkillは、repositoryへcopyしない。
- **triggerの精度**：descriptionが、起動すべき場面とそうでない場面を区別できるか。他のSkillのdescriptionと同じ場面を奪い合わないか。
- **費用**：常時読まれる量と、起動時に読む量。防ぐ失敗に比べて重すぎないか。

迷う場合は、同じtaskをSkillあり・なしで実行して比べる（`policy-evaluation` の比較評価）。

## 4. 導入する

- project-localに入れる。`--global` は使わない。
- packを丸ごと入れず、`bunx skills add <source> --skill <name>` で個別に入れる。
- `--copy` で導入し、導入されたSkillのfileと `skills-lock.json` を両方commitする。`skills-lock.json` だけでは再現にならないためである。2026-10時点の `skills experimental_install` は、lockの `computedHash` と照合せずに配布元の現在の内容を取得し、導入先も `.agents/skills/` に固定される。
- 更新は `bunx skills update` で行い、Skill fileのdiffをPRで確認してから取り込む。配布元の変更を、確認せずに取り込まないためである。
- 導入した複製は直接編集しない。複製の内容は `computedHash`（各fileの相対pathと中身を、pathの大文字小文字を区別しない順に連結したsha256）と一致し続ける必要がある。project-initの `evals/policy-evaluation/vendored-skills-contract.sh` と同じ検査をprojectのquality gateに入れる。直したい点があれば、正本へPRを出す。
- 配布元がtagを付けているなら、`https://github.com/<owner>/<repo>/tree/<tag>` で導入してlockの `ref` をtagに固定する。commit SHAは `ref` に使えない。
- licenseが再配布を禁じるSkillはcommitしない。`skills-lock.json` にだけ記録し、必要な環境で導入する。
- `disable-model-invocation: true` のSkill（`candidates.tsv` の `invocation` が `manual`）は、agentが自動では起動しない。採用する場合は、root contractの能力表に「この場面ではこのpathを読む」と明記する。

## 5. root contractへ反映する

root contractのSkill一覧は、能力ごとの担当表として書く。採用したSkillの名前、使う場面、手動起動ならそのpathを並べる。外部Skillも自作Skillも同じ表に載せる。

見送った候補や除外したrouterは、root contractに書かない。理由はproject内の決定記録（ADR等）に残す。

## 6. 知見を還元する

project固有でない評価結果は、project-initの `catalog/` へ戻す。

- 新しく評価した候補や、採否を変えた候補は `candidates.tsv` を更新する。`reviewed_rev` と `reviewed_on` は、実際に読んだrevisionと日付にする。
- 新しい能力が必要になったら `capabilities.tsv` に行を足す。
- 変更はproject-initへのPRとして出す。採用中のprojectから直接書き換えない。

## 記録の値

`candidates.tsv` の列の意味は次のとおりである。

- `status`：`default`（その能力の標準の担当）、`alternative`（担当の代替。併用はしない）、`reference`（導入せず考え方だけを参照）、`watch`（評価や改善の途中）、`excluded`（導入しない）
- `review_depth`：`listed`（存在と説明だけを確認）、`skimmed`（主要部分を読んだ）、`read`（全体を読んだ）、`evaluated`（比較評価まで行った）
- `invocation`：`auto`（descriptionで自動起動）、`manual`（明示的に呼ぶかpathで読ませる必要がある）
- skill列の `*` は、package全体や複数Skillをまとめた記録を表す。`default` には使えない。
