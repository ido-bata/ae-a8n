# attach-only hardening 実機検証 evidence（#272）

対象: release PR #271 の CodeRabbit review で見つかった attach-only の
欠陥修正。実機確認は macOS のみ（Windows はユーザー AE が稼働中で
failure-path のみ前回 #269 evidence で確認済み、今回の変更は
platform 非依存の lifecycle 修正）。

## macOS（AE 2026, pid 68426 がユーザー起動済み・非干渉）

`macos-attach-hardened.log`（`dist/` ビルド済み package を直接実行）:

- `AfterEffects.attach()` → `ownership: attached`（pid 68426）。
- `ae.info()` が実際に Apple Event を通り `26.5.3x9` build `9` を返した
  — 新設の invoke 直前 liveness guard が生存 target を正しく通すことを
  実機確認。
- `target: { pid: 68426 }` の pinned attach → 同様に成功。
- `target: { pid: 999999 }` → `AttachTargetError reason="not-found"`。
- `close()` ×2 → ともに `quit: false`、AE プロセスは前後で不変
  （spawn / 終了なし）。

## UNVERIFIED（正直な境界）

- **attached プロセス終了後の invoke が spawn しないことの実機確認は
  未実施**: この Mac では AE が 1 インスタンスしか起動できず、稼働中の
  ものはユーザーのプロセスのため終了させられない。contract test
  （`test/attach.test.ts` "invoke refuses to deliver once the attached
  process is gone"）とコード上の guard（`invoke()` が osascript 送信
  直前に `#attached` を再証明）で担保。残留 race（check と send の
  間の数 ms）は pid 宛 Apple Event が存在しないため原理的に残る —
  コードコメントに明記済み。
- **Windows**: 今回の修正は platform 非依存（`#launched` reset、pin
  enforcement、invoke guard は darwin 分岐）。Windows attach は従来通り
  `unsupported` で refuse されることを CI の windows job が担保。
- **pin と sibling instance の macOS 実機再現は未実施**（同一 install
  の複数 instance を実機で作れない）— contract test で担保。
