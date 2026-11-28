# Dialog-perception OCR spike — RC-S17 real captures (#462)

Date: 2026-11-28. Host: macOS arm64, tesseract 5.x (`/opt/homebrew/bin/tesseract`,
stock `eng`+`osd` traineddata only), `jpn` traineddata fetched separately for the
spike (`tessdata_fast`, not shipped). Fixtures: real `screencapture -l` window
captures from `docs/evidence/release-0-7-0-rc-s17/` (BirthPrefs / crash-repair
modal sessions, dark Japanese UI).

## Results per fixture

| Capture | Size | Engine / settings | Result |
| --- | --- | --- | --- |
| `s17-a-subject-18577/window-9279.png` | 1050×754 | tesseract `jpn`, `--psm 6`, original | **Coherent Japanese dialog text** — クラッシュ修復オプション heading, full body paragraph, all three choice labels (プラグインを管理 / 環境設定をリセット / セーフモードで開始). ~18 s wall. |
| `s17-c-subject-37622/window-9716.png` | same modal, other pid | same | Same coherent text. |
| `window-9280.png`, `window-9736.png` | 1000×1000 | same | Empty output — blank/fully transparent parked-window captures. Correctly `unreadable`-grade. |
| `window-9281..9284.png`, `window-9724..9727.png` | 3420×76 strips etc. | same | Noisy partial menu-bar/title-bar text (AfterEffects ファイル 編集 …). `partial` at best; these are non-dialog surfaces. |
| any fixture | — | tesseract `eng` only (stock traineddata) | Garbage Latin lookalikes of Japanese glyphs — unusable. |
| any fixture | — | tesseract `jpn` `tessdata_best` | Timed out >60 s — too slow; `tessdata_fast` is the viable variant. |
| `window-9279.png` etc. | — | macOS Vision (`VNRecognizeTextRequest`, Swift and ObjC front-ends, fast+accurate, en/ja) | **Rejected.** `.fast` crashes inside Vision result bridging (`Swift/SwiftNativeNSArray.swift:78 Fatal error: Array index out of range`) whenever observations exist; `.accurate` produces no output within 40 s. Reproduced on a plain wallpaper capture with text → environment-level defect, not image-specific. |
| `window-9279.png` | — | invert + 2× upscale preprocessing (CoreImage) then tesseract `eng` | Same garbage as non-inverted — preprocessing does not substitute for language data. |

## Conclusions baked into the substrate

- OCR **works** on the motivating fixture with: tesseract + `jpn` (fast)
  traineddata + `--psm 6`, no preprocessing, ~18 s for a modal-sized capture.
- It is far too slow for the ~2 s supervision tick → bounded subprocess,
  pull-based invocation only (spec §3).
- Language coverage is the dominant honesty variable: stock `eng`-only
  installs read Japanese dialogs as garbage; the runner records the languages
  actually used in `evidence.ocr` and never pretends coverage it lacks.
- Blank parked-window captures return empty text → `unreadable` with reason,
  which is the correct honest answer for a surface with no visible content.
