# Threat model — isolated AE backend (#59, T034)

対象読者: この backend の保守者と、isolated session を設計する consumer。
ここに書くのは **実装済みの防御と、その残るリスク** であり、実機受入の
証拠ではない。各行の証拠レベルは末尾の表にまとめる。

## 1. 資産と信頼境界

| 資産 | 境界 |
| --- | --- |
| controller の uid / 資格情報 | controller ホスト上のプロセス |
| target の uid / ASID（GUI session） | 別 OS ユーザーの Aqua session |
| console owner（`/dev/console` の owner） | 「今誰が物理画面を持っているか」 |
| 共有 staging / job / result ディレクトリ | controller と target が両方書ける唯一の場所 |
| channel key / job file / result file | 上記ディレクトリ内の正規ファイル |
| AE プロセス（所有・非所有） | target session 内で動く実行主体 |

## 2. 脅威と現行の防御

### 2.1 target session のすり替え（uid 再利用・ASID 切替・console flip）

- **脅威**: job 発行後に target ユーザーが logout/login し直す、uid が
  再利用される、console ownership が入れ替わると、「隔離された session で
  動いた」という記録が嘘になる。
- **防御**: `scripts/isolated-session/session-rules.mjs` が各段階で再証明
  する — `assertTargetSession`（対象 session が存在し target uid のもので
  console でない）、`assertOutcomeSession` / `assertResultSession`
  （結果が要求した session で作られたこと）、`assertReportIsolation`
  （console owner が読めない報告は隔離の証拠にしない）、
  `sessionIsolation`（console owner 不明は `unknown` であって isolated
  ではない）。`src/driver/mac-session.ts` は Apple Event / AX を送る前に
  同じ証明を行い、証明が変われば拒否する。
- **残存リスク**: 証明は「確認した時点」のもの。証明と送信の間の
  TOCTOU は原理上残るが、送信直前の再確認で窓を最小化している。
  fake/単体テストで網羅、実機での console flip 再現は未実施。

### 2.2 共有ディレクトリ経由のなりすまし・symlink 走査

- **脅威**: 共有 dir に第三者が symlink や hardlink、部分書き込み、
  `0777` のファイルを置き、controller がそれを job/result として読む。
- **防御**: `ensureSharedDir`（owner・mode・sticky bit の検査）、
  `sharedDirIsUsable`（sticky 無しの world-writable は拒否）、
  `jobFileIsTrusted`（正規ファイル・controller uid 所有・mode 検査）、
  `parseTerminalResult`（半分書かれた結果を結果と見なさない）、
  `shellQuote` / `shellCommandLine`（引数注入を構造的に排除）。
  `test/isolated-session.check.mjs` が symlink・部分書き込み・
  permissive mode の adversarial case を自動検査する。
- **残存リスク**: sticky bit の効かない filesystem（別ボリューム等）では
  前提が崩れる。対象 dir は controller が作成する前提で、既存 dir の
  安全性は検査で担保するが、filesystem 自体の性質は環境依存。

### 2.3 stale state・中断した job

- **脅威**: timeout/cancel 後の job が後の agent pass で再実行される、
  中断した setup が半端な状態を「成功」として残す。
- **防御**: `assertJobRunnable`（deadline・cancelled を検査）、
  `run-in-isolated-session.mjs` / `session-agent.mjs` の状態遷移、
  UNKNOWN 結果の非再送保証（`ae-a8n` 全体の契約）。
- **残存リスク**: 外部 kill（SIGKILL）で中間状態が残る場合の recovery
  UI は T038 の範囲であり、stale job の手動 `recover` 経路が網羅的かは
  実機確認待ち。

### 2.4 GUI recovery の誤爆

- **脅威**: recovery が console 側・license/sign-in ダイアログ・無関係な
  modal を操作し、物理デスクトップへ fallback したり、timeout した
  script を二度送ったりする。
- **防御**: `src/driver/gui-recovery.ts` は「非 console session の
  positive に識別された modal」のみを対象とし、license/sign-in は
  denylist、physical desktop への fallback は存在しない。timeout した
  script は再送しない（UNKNOWN 非再送）。
- **残存リスク**: modal の「positive identification」の判定は AX 情報に
  依存し、AX が取れない環境では操作自体を拒否する設計。実機の modal
  種別ごとの挙動は受入待ち。

### 2.5 ローカルの他ユーザー

- **脅威**: 同一ホストの別ローカルユーザーが共有 dir や結果を読む・
  書き換える。
- **防御**: 共有 dir は sticky bit + owner 限定を要求し、channel key と
  job/result ファイルは owner/mode を検査する。権限の無いユーザーは
  job file を「trusted」と見なせない（`jobFileIsTrusted`）。
- **残存リスク**: controller と target が同一 uid で動く構成ではこの
  境界は成立しない — isolated backend は「別 uid の target」を前提と
  する設計であり、同一 uid への適用は対象外。

## 3. やらないこと（設計上の非目標）

- unowned AE の force-kill、ユーザーデータの無断削除。
- TCC.db / SIP の直接改変、任意の TCC grant reset（`contracts/permissions.md` §3）。
- Apple credential の保存・入力の自動化。
- timeout した script の自動再送（UNKNOWN は成功でも失敗でもない）。

## 4. 検証レベル

| 層 | 状態 |
| --- | --- |
| adversarial 単体/契約テスト（`test/isolated-session.check.mjs`, `test/macos-session.test.ts`, `test/recovery.test.ts`） | automated test（fake/fixture） |
| 実機 macOS での session flip / modal / permission denial の再現 | 未実施 — T039 の real-host 受入 |
| Windows | 本 backend の対象外。Windows 側の同等脅威は `docs/windows-verification.md` |
