# Vision

## Purpose

ae-a8n は After Effects を外部プログラムから再現可能に操作するための automation runtime / API を提供する。

## Responsibility

ae-a8n が所有するもの:

- After Effects process lifecycle
- project / comp / layer / effect / parameter 操作
- render と状態取得
- 上位ツールから利用する programmatic API
- 必要になった場合の protocol / transport 契約

所有しないもの:

- test DSL / assertion / snapshot runner — ae-test
- remote worker / queue / GitHub integration — ae-farm
- VS Code / AI コーディング向け開発支援体験 — ae-devtools

ae-devtools は別軸のプロジェクトであり、自動化系列との共通依存を前提にしない。

## First vertical slice

最初の統合ゴール:

1. 外部プロセスから After Effects を起動する
2. fixture project を開く
3. 実在するプラグインを適用する
4. parameter を変更する
5. 1 frame をレンダーする
6. 結果と失敗情報を呼び出し元へ返す
7. After Effects を終了し後片付けする

この slice で要求されない抽象化は、必要性が実証されるまで先回りして固定しない。
