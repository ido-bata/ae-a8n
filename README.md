# ae-a8n

After Effects を外部プログラムから再現可能に操作するための automation runtime / API。

## Scope

ae-a8n は、After Effects の起動、プロジェクト操作、コンポジション／レイヤー／エフェクト操作、レンダー、状態取得などをプログラムから扱うための共通基盤を提供する。

テストランナーやリモート実機サービスそのものはこのリポジトリの責務に含めない。

## Ecosystem

- **ae-a8n** — After Effects automation runtime / API
- **ae-test** — ae-a8n を利用する Playwright-like testing framework
- **ae-farm** — ae-test を Mac / Windows 実機上で実行する remote execution service

`ae-devtools` は別軸の開発支援プロジェクトであり、この自動化系列との共通依存を前提にしない。

## Status

初期設計・検証段階。最初の目標は、外部プロセスから After Effects を起動し、実在するプラグインを適用して 1 フレームをレンダーできる最小 vertical slice を成立させること。
