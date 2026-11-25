# Portfolio assets — provenance

## ae-a8n-main.png (main image, 1920x1080 PNG)

Composed evidence board rendered from a real run of the **published**
`@ido-bata/ae-a8n@0.6.0` npm package (repo `main` @ `8cb1b71`, the
`release-0-6-0` merge — the released state).

- Code shown: excerpt of the capture driver `capture.mjs` (lines 61-133),
  which calls only the public API (`AfterEffects.launch`, `project()`,
  `createComp`, `addTextLayer`, `layer.effects.apply`,
  `effect.parameters`, `parameter.get/set`, `comp.info`, `comp.layers`,
  `comp.renderFrame`, `close`). The driver itself is capture tooling,
  not shipped product code; every API it calls is the published surface.
- Run: 2026-11-25, macOS arm64, owned After Effects session pinned to the
  AE 2026 install (`/Applications/Adobe After Effects 2026`,
  `26.5.3x9`). The run refuses to start if an AE 2026 process already
  exists; the user's running AE 2027 was never touched. All 18 evidence
  steps `ok`; `close` returned `quit: true`, `ownership: owned`, and no
  AE process remained.
- Scene: comp `A8N-Portfolio` 640x360 @30fps; text layer `Title`
  ("ae-a8n", ArialMT 110); `ADBE Gaussian Blur 2` applied (display name
  `ブラー (ガウス)` on the ja host); parameter `ブラー` (Blurriness)
  read 25 -> set 37 -> read-back 37; `renderFrame(0)` wrote
  `A8N-Portfolio.00000.png` 640x360.
- Verification level: **verified on real host** (real After Effects
  26.5.3, owned session, npm published package).
- alt: `ae-a8n のポートフォリオ主画像。公開APIで After Effects 実機にコンポジションとテキストレイヤーを作成し、Gaussian Blur エフェクトのブラー値を 25 から 37 に変更して読み戻し、renderFrame で PNG を書き出した一連の実行証跡をコードと共に示す図。`
- caption: `@ido-bata/ae-a8n@0.6.0 — createComp / addTextLayer / effects.apply / parameter.set / renderFrame を1回の owned セッションで実行し、AE 26.5 実機で効果を確認。`
- Rights: project-owned composite; rendered frame and run JSON are
  self-produced demo data. No third-party or private content.

## ae-a8n-frame0.png (supplement, 640x360 PNG)

Byte-identical copy of the real `comp.renderFrame(0)` output written by
the same run (`session/artifacts/A8N-Portfolio.00000.png`): comp
`A8N-Portfolio`, text layer "ae-a8n" with Gaussian Blur 37 applied.
RGBA PNG rendered by After Effects 26.5.3.

## Reproduction

```
npm init -y && npm install @ido-bata/ae-a8n@0.6.0
# capture.mjs: AfterEffects.launch({ installDir: <AE 2026>, ... }) then
# the public API sequence above; evidence.json records every step.
node capture.mjs
```

The capture sandbox (`capture.mjs`, `evidence.json`, `out/frame0.png`)
is retained under the worker workspace
`/Users/rebui/work/p1225-assets/ae-a8n/sandbox/` for supervisor review;
it is not part of this repository's shipped code.
