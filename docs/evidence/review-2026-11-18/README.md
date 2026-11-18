# Pre-RC review of post-0.2.0 convergence — 2026-11-18

範囲: `b2c6321`（release-0-2.0 RC freeze）.. `57f6ea8`（#195/#196/#197 merge 後の main）。61 commits、55 files、+6,603/-1,387。開発収束ラウンド（#57 setup/permissions、#59 isolated-session safety、#62 docs、#75 release tooling）の独立レビュー。

## How it ran

| | |
| --- | --- |
| Method | repo `code-review` Skill の2軸並列レビュー（Standards / Spec） |
| Fixed point | `b2c6321c96fa01f333cc9bc5b696f00fdeb31f3f` |
| Standards sources | `AGENTS.md`、`constitution/CONSTITUTION.md`、`docs/development.md` + Fowler smell baseline |
| Spec sources | Issue #57 / #59、`specs/isolated-ae/contracts/{cli,permissions}.md`、`docs/security.md`、`docs/isolated-testing.md` |

## Findings and dispositions

### Spec 軸

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | prompt routing が dialog 出現より後に出力される（permissions.md §3 違反） | **fixed** — PR #198。`grantCheck` に `onRouting` seam を追加し、session routing を最初の probe 前、各 permission の dialog 説明を request 直前に出力。既 granted は announce しない。test で順序を固定 |
| 2 | AE script access 行に DoScriptFile probe がない（permissions.md §1） | **記録する制限** — DoScriptFile は AE 起動を要し軽量 probe にできない。script-trust（-1708）の実測は最初の `ae-a8n test` の fail-closed 診断に委ねる。approval 粒度は #125 で未計測のまま。Issue #57 に記録 |

### Standards 軸

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | packaged `tcc.ts` と in-session `permission-probe.mjs` の TCC probe script 重複（drift リスク） | **fixed** — 両 script の同一性を pin する test を `test/doctor.test.ts` に追加（PR #198） |
| 2 | session facts parse 5箇所・flag parser 5箇所・`parseAeProcesses` 2箇所の重複、adapter.ts の Divergent Change | **記録する既知負債** — `session-rules.mjs` への集約は別リファクタ ticket 相当。今回は見送り |
| 3 | `scripts/isolated-session/*.mjs` が AGENTS.md「新規 script は TypeScript か shell」からの deviation、tsconfig 対象外で typecheck 非対象 | **記録する deviation** — eslint.config.js で carve-out 済みの ESM repo harness。typecheck 非対象は認識済み |

## Explicitly not claimed

- T026 実機 consent 受入（prompt trace・denial/retry の実機証拠）— 未実施
- Windows real-host 受入 — 環境になし
- fake host と実 AE の `File`/`Folder` 等の挙動差 — `docs/verification.md` 記載の approximation のまま
