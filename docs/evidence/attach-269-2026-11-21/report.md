# attach-only 実機検証 evidence（#269 / PR #270）

検証対象: `AfterEffects.attach()` — 既存 AE プロセスへの接続だけを行い、
新規 AE プロセスを生成しないことが構造的に保証される API。

## 結果サマリ

| Platform | 経路 | 結果 | evidence level |
| --- | --- | --- | --- |
| macOS | script invocation（Apple Events） | **成功 attach** + 安全な close + 型付き失敗 | verified on real host |
| Windows | script invocation | `AttachTargetError(reason="unsupported")`、プロセス生成ゼロ | verified on real host |
| Windows | in-ae-dispatcher | `AttachTargetError(reason="unresponsive")`、プロセス生成ゼロ | verified on real host（接続失敗経路のみ） |
| Windows | in-ae-dispatcher 成功 attach | **UNVERIFIED** — dispatcher がユーザー AE 内で activate されていないため。ユーザー起動中の AE を操作して activate することは本検証の範囲外 | — |

## macOS（AE 2026、pid 34792 が既に起動中）

`macos-attach.log`:

- `attach()` 成功: `ownership.kind = "attached"`、version `26.5.3x9` build `9`。
- `close()` → `{ quit: false }` — attached host を終了しない既存 safe-close 意味論を維持。
- プロセス census 前後で pid 集合が不変（新規 spawn / 終了なし）。
- AE 2027 install 不在時: `AttachTargetError reason="not-found"`。
- 存在しない pid `999999` 指定: `AttachTargetError reason="not-found"`。
- pid `34792` 明示 pin: attach 成功、attached ownership。

`macos-attach-failures.log` に上記失敗系の生ログ。

## Windows（device-windows、AE 2026 pid 22944 + AE 2027 pid 16708 がユーザー起動済み）

`windows-attach.log`:

- `attach()` 既定経路 → `AttachTargetError reason="unsupported"`。
  Windows の script invocation は配送に `AfterFX.exe -r` の spawn が必須なため、
  attach-only では構造的に到達不能。エラーメッセージは in-ae-dispatcher か
  独自 HostTransport を案内する。
- `attach({ transport: "in-ae-dispatcher" })` → dispatcher 未 activate のため
  `AttachTargetError reason="unresponsive"`（busy/modal/不一致を fail-closed で報告）。
- 両ケースで `Get-CimInstance Win32_Process AfterFX.exe` の census が完全一致 —
  **新規 AE プロセスは 1 つも生成されていない**ことを実機で確認。
- ユーザー起動中の AE 2 プロセスには一切触れていない。

## 既知の UNVERIFIED 項目

- Windows での dispatcher 経由の**成功 attach** は未検証。
  ユーザーの AE 内で dispatcher を activate する操作が必要であり、
  本検証ではユーザーセッションの AE を操作しない方針のため実施していない。
- Windows の busy/modal 実機再現は未検証（型付き `unresponsive` 失敗経路のみ実機確認済み）。
- macOS の ambiguous（複数 AE 同一 install）実機ケースは未検証
  （ユニットテスト `test/attach.test.ts` でカバー）。
