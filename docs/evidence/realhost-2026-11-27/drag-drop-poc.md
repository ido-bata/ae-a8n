# File/element drag-drop real-host PoC — macOS, 2026-11-27

Issue #369 Stage 1: CGEvent / NSDraggingSession 経由の file drop が
実機の After Effects に着地するかの最小 PoC。プローブは
`scripts/poc-drag.swift`（CGEvent 投稿 + NSDraggingSession ソース）と
`scripts/poc-drag-drop.mjs`（orchestrator）+ `scripts/poc-drag-extension.mjs`
（in-AE readback 用 ExtendScript host）。shipped feature ではない。

Verification level: **verified on real host**（観測記録のみ。
drop が一度も着地しなかったため「動く」側の証拠は存在しない）。

## 環境

- macOS arm64、screen 1710x1112pt、user `rebui`
- 対象 install: Adobe After Effects 2027（27.0.0、`/Applications` 配下）
- AE 2026（pid 84367）は **foreign instance** として常駐。preflight が
  in-scope instance 0 を確認した上で owned launch し、全 attempt で
  z-ordered WindowServer census（`topmostAt`）により drop 地点の
  最前面 window が **owned pid** であることを毎回証明してから
  イベントを投稿した。foreign window が最前面の地点は drag を
  skip する設計で、実際 scan5 の右側 target 10 点は全て foreign
  AE 2026 window が最前面であり正しく skip された。

## 機構の確認（動いた部分）

`filedrag` モードは機構としては完動する:

- helper process が `--from` に borderless NSWindow を出し、
  post された `leftMouseDown` を受けて `beginDraggingSession` を呼ぶ
  → `session=true` を確認
- `NSDraggingItem` の pasteboard は `.fileURL`（`public.file-url`）
  を vend する（`NSFilenamesPboardType` は `NSPasteboardWriting`
  の UTI 検証で拒否されるため `BoardWriter` adapter 経由。
  実機で "not a valid UTI" を観測）
- drag 中の `leftMouseDragged` / `leftMouseUp` は CGEvent で投稿され、
  session は drop 地点で終了。`endedAt` は bottom-left 原点の NS座標で、
  top-left 原点の target と screen 高さ分の反転で一致することを確認
  （例: target (100,400) → endedAt (100,712) = 1112-400）

## 結果 — 全 attempt で `operation:"none"`

| run | attempts | dragged | 結果 |
| --- | --- | --- | --- |
| scan1 | 20 | 20 | helper 側の UTI 失敗で全 timeout（修正前） |
| scan2 | 20 | 20 | `operation:"none"` ×20（`BoardWriter` 修正後） |
| scan3 | 10 | 10 | `none` ×9 + 1 timeout |
| scan4 | 10 | 10 | `none` ×10 |
| scan5 | 10 | 0 | 全て foreign AE 2026 window が最前面 → 正しく skip |

fixture PNG は project item として一度も import されず
（`projectItemCount` 4 → 4、`fixturePresent:false`）、
comp layer 順の変化も無し。`drag-before.png` / `drag-after.png` と
window 別 capture（`window-<id>.png`）が視覚記録。

### 座標の同定（OCR + census）

`window-1849.png`（main window 1710x1074）の OCR で Project panel の
実位置を同定: tab「プロジェクト」≈ global (12,116)、列 header
「名前/種類/サイズ」≈ y276、item row「PoC Comp」「平面」≈ y293-320、
panel 内容域はおおよそ x7-390, y140-640。

重要な発見: 同 install の **ty-plus CEP panel 群（640x504 window が
11 枚、x19-1127, y161-1100 をタイル状に覆う）** が main window の上に
浮いている。しかし z-order census が示す通り、Project panel 領域の
少なくとも 7 地点（scan4 の (60,380),(100,300),(100,400),(150,500),
(200,300),(200,420),(250,540) 等）では **main window 自体が最前面**
であり、drop は AE 本体の UI（Project panel 領域）に直接着地して
いた。それでも `operation:"none"` で import されなかった。

### aux window を退かせる試行（失敗の記録）

Project panel を完全に露出させるため aux window の除去を試みたが、
全経路で不可だった（`drag-drop-scan3/4.json` の `close-aux-windows` step）:

- **AX**: `count=0` — #406 と同じく ty-plus window も AX 非公開
- **close button click**: 640x504 window の左上に標準 traffic-light
  が存在しない（pixel scan で赤黄緑を検出せず、独自 chrome）
- **title-strip drag で移動**: `drag` モードで title 帯を下方向へ
  drag しても bounds が変化しない（非移動パネルの可能性）
- **Cmd+M minimize**: 非 activating panel の可能性があり key window
  が main window のままになる危険があるため不採用

## 結論（Stage 1 PoC verdict）

**unsupported / unverified**:

合成 `NSDraggingSession`（`.fileURL` vend）+ CGEvent mouse による
file drop は、AE 2027 の実 window（Project panel 領域を含む main
window 上面と確認済み）に対して **39 attempt 全てで拒否**
（`operation:"none"`、import 無し）された。drag session 自体は
正常に生成・終端しており、座標と z-order の証明も取れているため、
「synthetic drag session を AE が受理しない」または
「必要な pasteboard 表現（例: legacy `NSFilenamesPboardType` flavor、
file promise、あるいは real app を source とする session）が不足」
のどちらかである。

Stage 2 で切り分けるべき仮説:

1. **legacy flavor**: `NSFilenamesPboardType` を `writableTypes` に
   含めると UTI 検証で拒否されるが、宣言レベルでの追加や
   `NSPasteboardItem` 経由の別実装で vend できるか
2. **real-source 対照実験**: Finder 等の実 app を source とした drag
   （本 PoC の安全規約上 foreign app 操作が必要なため範囲外。
   人間の手動 drag での陽性対照が最も安い）
3. **hover/dwell**: drop 地点での drag 停止時間を延ばす
   （現行は到達即 mouseUp）
4. **element drag（file 以外）**: Project panel 内 item の並べ替えや
   comp への layer drag 等、file 以外の drag が受理されるか —
   `mode drag`（session 無し plain CGEvent）も試す価値あり

なお foreign AE 2026 が同一画面を大きく覆っており、右側領域
（x>~1200）は owned AE の drop surface として使えない環境だった
ことも記録しておく（gate が正しく機能した証拠でもある）。

## 再現方法

```
npm run build
node scripts/poc-drag-drop.mjs \
  --install "/Applications/Adobe After Effects 2027" \
  --mode file --from 850,500 \
  --attempts "60,380;100,300;100,400;150,500;200,420;250,540" \
  --session-root /tmp/ae-a8n-369-poc --out docs/evidence/realhost-2026-11-27/drag-drop-scan4.json
```

`--probe` で drag 無しの launch/settle/census/screenshot/quit のみ。
各 attempt 前に owned AE を再 activate し、`topmostAt` で
z-order 最前面が owned pid であることを確認する。
