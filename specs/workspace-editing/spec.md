# Workspace layout and AE-specific editing operations — vertical slices (B-WORKSPACE)

- Parent program: [#337](https://github.com/ido-bata/ae-a8n/issues/337) (US-B3, Plan B)
- Ticket: [#345](https://github.com/ido-bata/ae-a8n/issues/345) — T001 spec (this document); T002/T003 implementation slices listed in §12
- Related: [#343](https://github.com/ido-bata/ae-a8n/issues/343) (B-PANEL — supplies `PanelTarget` identity, operation classes `observe`/`mutate-gui`/`mutate-session`, mutation lease + audit, `CaptureArtifact`; Draft PR #349, **not merged** — contract concepts only, no code dependency), [#344](https://github.com/ido-bata/ae-a8n/issues/344) (B-IME — supplies the session-stream input and focus-proof contract this spec reuses for editing ops; Draft PR #354, same non-merged status), [#338](https://github.com/ido-bata/ae-a8n/issues/338) (A-SAFETY mutation gates), [#342](https://github.com/ido-bata/ae-a8n/issues/342) (A-RUNTIME shared OS boundary), [#346](https://github.com/ido-bata/ae-a8n/issues/346) (B-EVIDENCE consumes captures), consumers: B-CONSUMER (ido-bata/ae-devtools#426), B-TEST (ido-bata/ae-test#145)
- Builds on: [panel-interaction spec](../panel-interaction/spec.md), [ime-input spec](../ime-input/spec.md), [gui-supervision spec](../gui-supervision/spec.md), [isolated-ae spec](../isolated-ae/spec.md), [ADR-0004](../../docs/adr/0004-native-mutation-authorization.md), [docs/gui-supervision-safety-gates.md](../../docs/gui-supervision-safety-gates.md)
- Status: **draft for review**. Nothing named below is implied to exist yet. Verification level of every claim is stated explicitly.

## 1. Problem

A plugin author's real workflow is not "call an API" — it is: arrange AE into a known workspace, open a comp, scrub the timeline, select layers and keyframes, drive effect controls, queue a render, save and reopen. Only some of those steps have a scripting equivalent, and for GUI verification the issue explicitly forbids substituting a Scripting mutation for the real operation path ("GUI検証を Scripting 直接変更で代替しない"). Today ae-a8n can observe windows and press buttons, and the B-PANEL/B-IME contracts define panel identity, input delivery, and gates — but nothing addresses:

- **workspace lifecycle**: switching, panel arrangement (dock/float/resize/tab-group), window move/minimize/maximize/focus, save-new/restore/reset;
- **AE editing surfaces**: timeline scrub/zoom/scroll, comp-view pan/zoom, layer/property/keyframe selection, effect controls, menus and context menus, Render Queue, Open/Save/Import dialogs, file/element drag-and-drop.

This spec fixes the operation taxonomy, the scripting-vs-GUI boundary, the vertical slices this ticket delivers, and what remains honestly unverified.

## 2. The scripting-vs-GUI boundary (load-bearing rule)

Issue FR: "AE APIで目的を満たす場合は優先、GUI検証では実操作経路". Applied per operation:

| Purpose of the test step | Allowed path |
| --- | --- |
| Arrange preconditions the scenario does not assert (make a comp, add a layer, set a value) | Scripting (`host/` DOM methods: `project.createComp`, `comp.selectLayers`, `effect.setParameter`, …) — preferred, deterministic |
| The asserted interaction itself, when the scenario's claim is "the real user operation path works" (workspace restore, panel dock, timeline scrub, context menu, file dialog, drag-drop) | **GUI path only** — OS-level or AE-menu-level real input per the B-IME contract; scripting mutation is prohibited as evidence |
| Observation/readback of resulting state | Any honest channel: in-AE DOM readback (`layer.selected`, `comp.*`), AX/census geometry, `CaptureArtifact`, workspace XML read-only inspection — the channel is recorded, never blended silently |

Two subtleties this spec fixes:

1. **`app.executeCommand` / `menu.execute` is scripting, not GUI.** The host already exposes `menu.find`/`menu.execute` (`host/a8n-host.js` L913–L954). It satisfies "AE API で目的を満たす場合" for menu *commands* (e.g., adding a comp to the render queue when queue membership is not what is being asserted), but it is **not** evidence that the GUI menu path works — menu labels, checkmarks, and command availability are exactly what a workspace/editing test may need to prove. When a slice's AC is about the GUI path, the act goes through OS input (click/key/drag per B-IME §6) or an AX-press on the menu item; `menu.execute` is labelled `scripting-direct` in evidence and never counted as a GUI pass.
2. **Readback ≠ mutation.** Reading `comp.time`, `layer.selected`, or the workspace XML file is observation and is allowed regardless of which path performed the act. A hybrid "GUI act + DOM readback" oracle is the *preferred* pattern where the DOM exposes the fact (see §5).

## 3. First vertical slices

Per T001 the full FR list is decomposed into independently reviewable slices; three are chosen as the first deliveries because they exercise disjoint capability families and together cover the issue's T002 plus the two highest-value editing surfaces.

### Slice W1 — Workspace arrange → measure → save/restore (issue T002)

**Scenario**: reproduce a representative workspace ("Standard" or a saved custom workspace), rearrange one panel (dock↔float or tab regroup via drag), verify the arrangement through OS geometry and in-GUI state, save-as or switch away and back, verify restoration.

- **Act (GUI)**: Window > Workspace menu item click; panel drag to float/dock; window move via title-bar drag or AX `set position`.
- **Observe**: current-workspace identity via the Window > Workspace submenu checkmark (new AX menu-bar surface — §7); panel frames via census+AX (`PanelTarget` `docked-region`/`window` modes from the panel spec); arrangement persistence via read-only inspection of the workspace XML (§8).
- **Scriptable equivalents — deliberately not used as the asserted path**: `app.executeCommand(app.findMenuCommandId("<workspace>"))` switches workspaces in scripting (verified behavior reported by community sources, **not yet verified on our host** — see §9); workspace XML is written by AE on workspace change/quit, so file mtime/content is corroborating evidence, never the mutation channel.
- **AC**: workspace switch verified by menu checkmark + panel frame delta; arrangement verified by frame readback within tolerance; save/restore verified by post-restore frame equality (tolerance) AND XML persistence record; every mutation gated `mutate-gui` with lease+audit; `indeterminate` on timeout, never blind-resend (a resent drag drops twice).

### Slice W2 — Timeline scrub + layer/property/keyframe selection (comp editing)

**Scenario**: open a comp with known layers/keyframes; scrub the timeline by dragging the current-time indicator; click a layer row and a property to change selection; navigate to a keyframe.

- **Act (GUI)**: mouse drag on the timeline ruler / current-time indicator; click on layer/property rows in the Timeline panel; keyframe navigator arrows.
- **Observe (hybrid oracle)**: `comp.time` readback (candidate new host readback — currently `comp.info` does not expose `time`, §4), `layer.selected` (already exposed via `comp.selectLayers`/`layerInfo.selected`, `host/a8n-host.js` L702), selected-property/keyframe state (DOM `Property.selected`/`isTimeVarying` — candidate additions), Timeline panel scroll position via panel-region geometry.
- **Scriptable equivalents**: `comp.time =`, `layer.selected =`, property value/keyframe writes are all DOM-available — used for **setup** (create keyframes deterministically) and never as the asserted act.
- **AC**: scrub lands within one frame of the dragged position (readback `comp.time` vs requested, tolerance recorded); layer/property selection readback matches the clicked row; keyframe navigation lands on the expected key; ambiguous row hit → `ambiguous-target`, never nearest-match.

### Slice W3 — Menu-driven render queue + file dialog (menu/dialog surface family)

**Scenario**: Composition > Add to Render Queue (or the RQ panel's add control) → Render Queue shows one item; File > Import opens the native picker → choose a fixture file → footage imports.

- **Act (GUI)**: real menu click through the AX menu bar; file dialog interaction through the existing dialog-recovery observation/press machinery (`gui-recovery.ts` — `classifyDialog`, `chooseRecoveryWindow` already classify AE dialogs) plus file-name entry via the B-IME text path.
- **Observe**: Render Queue item presence — **no DOM readback exists** (`app.project` exposes no render queue in the classic ExtendScript DOM; unverified whether newer DOM or `app.executeCommand` state helps — recorded as GUI/AX-only); AX tree of the RQ panel region (needs the deeper `docked-region` walk the panel spec defers); import success via `project.info`/`project.comps` DOM readback after dialog dismissal.
- **Scriptable equivalents**: `layer.applyEffect` exists but render-queue membership has no DOM mutation; `project.importFile` exists for import — again setup-only when the dialog path is the assertion.
- **AC**: RQ item count/presence verified by AX-observed panel content + capture artifact; import verified by DOM `itemCount` delta and `project.info`; the file picker itself is verified as a *dialog class* with bounded wait, never auto-confirmed blind.

**Deferred to follow-up tickets** (T003, same taxonomy, ordered by consumer demand): window minimize/maximize/focus cycle; comp-view pan/zoom; effect-controls fold/parameter edit via GUI; context menus (layer/item right-click); Open/Save dialog round-trip; file/element drag-drop (highest risk — §9); multi-monitor workspace restore.

## 4. What's GUI-only vs scriptable — survey result

| Surface | GUI mutation possible? | DOM/script equivalent | Verdict for this spec |
| --- | --- | --- | --- |
| Workspace switch | Window > Workspace menu (AX menu click) | `app.executeCommand(findMenuCommandId(name))` — works, locale/version-dependent ID, **no DOM readback of current workspace** | GUI act + menu-checkmark readback; `menu.execute` allowed for setup only |
| Panel dock/float/tab/resize | drag on panel title/tab bar; `PanelTarget` resize (B-PANEL) | none | GUI-only |
| Window move/min/max/focus | AX `set position`/`set size`/`set miniaturized`; `AXMain`/`AXFocused` | none | GUI/AX-only; focus proof per B-IME §5.3 |
| Workspace save/restore | Window > Workspace > New Workspace / Reset / saved-item click | none (AE writes XML itself) | GUI act; XML = read-only evidence |
| Timeline scrub | drag current-time indicator | `comp.time =` exists (mutation) — setup only | GUI act + `comp.time` readback (new host readback, `implemented` candidate) |
| Timeline zoom/scroll | zoom controls / scrollbar drag | none | GUI act; scroll offset via panel geometry |
| Comp-view pan/zoom | viewer drag / zoom dropdown / shortcuts | partial `app.executeCommand` for fit/100% — unreliable | GUI act; result verified by capture diff + panel geometry |
| Layer selection | timeline row click | `layer.selected` read+write | GUI act + DOM readback (existing `layerInfo.selected`) |
| Property/keyframe selection | click property row / keyframe nav | `Property.selected`, keyframe APIs | GUI act + DOM readback (candidate host additions) |
| Effect controls | Effect Controls panel interaction | `layer.applyEffect`, `effect.setParameter` — full DOM | GUI act for the asserted path; DOM for setup |
| Render Queue membership/items | RQ panel + Composition menu | **none in classic DOM** | GUI/AX-only observation — weakest oracle in this spec |
| Open/Save/Import | native file dialogs | `app.open`, `project.save`, `project.importFile` | GUI dialog path for the assertion; DOM verify after |
| File/element drag-drop | OS drag (CGEvent/SendInput mouse sequences) | none | GUI-only; drop-target resolution is the hard part (§9) |
| Context menus | right-click on panel items | none | GUI-only; needs context-menu AX surface (§7) |

**Rule of thumb encoded**: if the DOM can express the *state*, it is a readback channel; if it can express the *act*, it is setup-only unless the test's claim is not about the GUI path. `menu.execute`/`app.executeCommand` is classified `scripting-direct` — a legitimate fast path for preconditions, never a GUI-pass substitute.

## 5. Operation taxonomy (reuses B-PANEL/B-IME classes)

| Operation group | Class | Gate | Notes |
| --- | --- | --- | --- |
| Enumerate windows/panels, resolve `PanelTarget`/`WorkspaceTarget`, measure frames, read menu checkmarks, capture original | `observe` | existing read-only path | includes new menu-bar AX listing and `docked-region` deep walk — both read-only |
| Panel resize/move/dock, window move/min/max/focus, workspace switch via menu click, timeline/comp-view scrub/zoom/scroll, layer/property/keyframe selection clicks, effect-control interaction, RQ panel ops, menu/context-menu invocation, dialog confirm/cancel | `mutate-gui` target-scoped | GUI lease + audit + `assertProvenIdentity` + `attribution==="owned"` + re-resolution before AND after act | mouse ops delivered to the proven target frame (B-IME §6 `mouse` row); session-stream keys/modifiers carry `requiresGlobalInputAuthorization` (B-IME §5.4) |
| File dialog filename entry, clipboard-assisted drag | `mutate-gui` shared-state | above + save/restore prior state (B-IME §5.5) | file pickers are native dialogs — target is the dialog window, not the main window |
| File/element drag-drop payloads | `mutate-gui` target-scoped | same + drag-sequence integrity | drop onto a foreign app/window refuses; source must be our fixture file |
| Anything touching windows outside the target pid, other AE instances, workspace changes beyond the proven instance | `mutate-session` | out of slice | A-SAFETY sign-off required |

New descriptor needed beyond `PanelTarget`:

```
WorkspaceTarget {
  workspace: { name: string | null,            // null = default/unnamed current layout
               persisted: boolean,             // appears in ModifiedWorkspaces XML
               xmlRef?: { path, sha256 } }     // read-only evidence handle, not identity
}
```

Identity of "which workspace is active" is *not* durable state: it is re-read from the menu checkmark (or, failing that, `indeterminate`) before and after every workspace-affecting op. There is no handle to cache — a workspace is a layout predicate verified per observation, matching the `PanelTarget` "locator, not handle" rule.

## 6. Locator re-resolution strategy

Per Issue FR ("locator再解決、曖昧拒否"): every op re-resolves immediately before acting; nothing is durable across calls.

- **Surface locators** reuse the panel spec vocabulary: `PanelTarget.locator` `{ title?, role?, subrole?, censusFrame?, axPath? }` for windows; for `docked-region` the locator adds a *pane path* inside the main window's AX tree (e.g., role+position-index path to the Timeline/Comp/RQ pane). Docked panes have no stable AX identifier today — first implementation records `axPath` empirically per AE version and treats path drift as `stale-locator` → re-walk, never guess.
- **Menu locators**: menu items are addressed by (menu-bar path, item title). Titles are **localized** — a Japanese AE shows Japanese labels, and `findMenuCommandId` is documented unreliable across language packages. Menu driving therefore resolves by *AX-observed title at runtime* within a declared locale, records the observed title in evidence, and refuses `unsupported-locale` when the expected menu path is absent rather than falling back to coordinate clicks. `app.findMenuCommandId` may assist *discovery* of command existence but is never the GUI locator.
- **Row locators** (timeline layer/property/keyframe): addressed by visible row identity — layer name text + row ordinal within the pane's AX/geometry listing; selection state readback via DOM disambiguates. Two rows matching → `ambiguous-target`.
- **Coordinate fallback**: relative coordinates inside a re-verified element frame only (B-IME §6 mouse row); absolute remembered positions are prohibited evidence.
- Re-resolution cadence: pre-act (inside lease), between drag segments (bounded), post-act readback — same three-step shape as B-IME §5.3 focus proof.

## 7. New observation surfaces required (gap list)

| Surface | Needed for | Exists today? | Candidate channel |
| --- | --- | --- | --- |
| macOS menu bar tree (AXMenuBar → menu bar items → menus → items, incl. checkmark `AXMenuItemMarkChar`/state) | workspace identity, all menu/context-menu ops | **No** — `LIST_WINDOWS_SCRIPT` walks windows/UI-elements only | extend `scripts/isolated-session/ax-windows.swift` or new `ax-menu.swift` via `AXUIElementCopyAttributeValue`; System Events `menu bar` classes as fallback — **unverified on AE** |
 Docked-pane deep walk | `docked-region` targets, RQ panel content, timeline rows | **Partial** — AXLayoutArea children deliberately not walked (perf, `gui-recovery.ts` L614) | targeted walk scoped to one pane subtree, depth/time-bounded; census frame bounds the region first |
| Context menus | right-click ops | No | appear as new AX window/menu surface post-click; classify like dialogs |
| Render Queue content | W3 oracle | No DOM, no dedicated AX walk | pane-region AX texts/buttons + capture; weakest oracle — mark `limited` |
| `comp.time`, `Property.selected`, keyframe enumeration readbacks | W2 oracle | `comp.time`/`Property.selected` not in host; `layer.selected` exists | host additions (small, safe — read-only ExtendScript) |
| Workspace XML files | W1 persistence evidence | n/a (OS files) | read-only file read of `ModifiedWorkspaces`/`OriginalUserWorkspaces` (§8); never written by us |

## 8. Workspace persistence research (documented facts + unverified)

Documented (Adobe helpx + community sources — `unverified` against our installs until probed):

- Workspaces persist as **XML files** in the preferences folder: macOS `~/Library/Preferences/Adobe/After Effects/<version>/ModifiedWorkspaces` (customized/saved) and `OriginalUserWorkspaces` (factory); Windows `%APPDATA%\Adobe\After Effects\<version>\` same subfolders.
- AE writes workspace state on workspace change and on quit; monitor configurations are stored in the workspace (multi-monitor layouts are part of the file).
- A project saved with a custom workspace looks for that workspace by name on open — cross-machine caveats around monitor size/layout.

Consequences for this spec:

- **Save/restore verification has a file-level oracle**: hash + mtime of the relevant XML before/after, plus DOM-independent GUI checkmark readback. File inspection is `observe`-class (read-only) and stays outside the AE process — it cannot disturb the target.
- **We never write these files.** A "restore workspace by copying XML" path would be a file mutation outside the GUI contract, prohibited as GUI evidence; it may exist later only as an explicit non-GUI fixture-setup helper, labelled accordingly.
- Whether AE reloads/ignores externally-modified workspace XML while running is **unverified** — irrelevant to this spec since we don't do it.

## 9. Per-OS capability matrix

Verification levels: `implemented` / `automated test` / `fake/mock only` / `verified on real host` / `unverified` / `unsupported` / `needs-human`.

| Capability | macOS candidate | Windows candidate | Status today |
| --- | --- | --- | --- |
| Window move/min/max/zoom/focus | Direct `AXUIElementSetAttributeValue` on enumerated `AXWindows`/`AXChildren` entries (window-ops helper vehicle, #357-proven on AE 2027); AX `AXMain`/`AXFocused`/`AXMinimized`; **System Events `set position/size` disproved on AE** (AppleEvent -1712 timeout, enumeration sees almost nothing — #357) | `SetWindowPos`/`ShowWindow(SW_*)`/`SetForegroundWindow` (new mutation script sibling to `gui-act-script.ts`) | move/resize/restore **verified on real host** (#357, `docs/evidence/realhost-2026-11-27/panel-ax-vehicle-poc.json`; requires app frontmost at least once for AX window vend); minimize/maximize/focus variants untested; Windows unimplemented |
| Menu enumeration + invoke | AX menu-bar walk (new helper); fallback System Events `menu bar`/`click menu item` | UIA `MenuBar`/`MenuItem` patterns in existing PS observer family; `SendMessage`/`PostMessage` MN_GETHMENU as fallback — **unverified** | unverified both OSes; localized titles are the known hazard |
| Context menu invoke | right-click via `CGEvent`/System Events `right click`? — System Events click is left-only; `CGEvent` right-button post needed | `SendInput` right-button + UIA `ExpandCollapse`/context pattern | unverified; macOS right-click posting is a new helper |
| Timeline/comp-view scrub/zoom/scroll/drag | `CGEvent` mouse drag sequences via new swift helper in session; coordinates from re-verified pane frame | `SendInput` mouse (`MOUSEEVENTF_*`) drag/wheel | implementable; drag fidelity on AE's custom-drawn timeline unverified — **prime real-host question** |
| Layer/property/keyframe row click | same mouse path + AX row locator | same | implementable; row geometry stability unverified |
| Render Queue observe | docked-pane AX walk + capture | UIA tree of RQ pane | unverified; DOM has no RQ — GUI/AX is the only channel |
| File dialog (Open/Save/Import) | existing dialog classification + B-IME text entry + `screencapture`/AX filename field | existing Win32 dialog census + UIA edit control + SendInput | partially exists (recovery observes dialogs); filename entry depends on B-IME gates — `needs-human`/gated |
| File/element drag-drop | `CGEvent` press-drag-release with drag-payload semantics; source = our fixture file | `SendInput` mouse + `DoDragDrop`-compatible sequence | **highest-risk cell**: OS drag sessions have timing/autoscroll semantics, drop-target hit-testing is not observable pre-drop. **PoC 結果 (#369, verified on real host): `unsupported`** — synthetic `NSDraggingSession`(.fileURL)+CGEvent file drop は owned AE 2027 へ 39 attempt 全て AE 側拒否（`operation:"none"`、drop 地点到達・z-order 所有証明済み）。証跡 `docs/evidence/realhost-2026-11-27/drag-drop-poc.md`。再 PoC hypotheses は同 README 参照 |
| Workspace XML read | direct file read (observe) | same | `implemented`-safe (read-only); path layout `unverified` per-version |
| Multi-monitor / DPI | census+AX frames are points; `backingScale` per capture (B-PANEL §6.3); workspace XML stores monitor config | census is physical px; `GetDpiForWindow`/awareness context required | partial — inherits B-PANEL DPI contract; per-monitor workspace restore unverified |

## 10. Wait vs resend (Issue FR)

- **Wait** (bounded, declared): after an act, poll the *postcondition* — frame equality within tolerance, `comp.time` within one frame, menu checkmark flipped, dialog class gone, XML mtime advanced. Deadline expiry → `indeterminate` with observed state reported.
- **Resend** is prohibited for every `mutate-gui` op in this spec: a resent workspace-menu click toggles nothing but a resent drag drops twice; a resent scrub moves time twice. UNKNOWN/timeout outcomes follow the recovery-policy non-resend rule (ADR execution-model); the only retry is a *fresh op* after re-resolution, initiated by the caller, never automatic.
- Drag sequences are atomic per lease: multi-segment drags (press → intermediate moves → release) re-check focus/attribution between segments and abort — never "finish the drag" — on focus change (B-IME §5.3 shape).
- Dialog waits reuse `chooseRecoveryWindow`/blocking taxonomy: a file picker appearing mid-op is evidence, handled as its own bounded wait, not a reason to resend the invoking click.

## 11. Verification plan

**Provable now (contract level, no AE launch):**

- Taxonomy/class/gate mapping, `WorkspaceTarget` descriptor, locator re-resolution rules, wait-vs-resend semantics — unit-tested against fakes (`src/testing/fake-adapter.ts` family) and scripted fake AX/menu listings.
- Host readback additions (`comp.time`, `Property.selected`, keyframe enumeration, RQ-adjacent `project` facts where DOM exposes them) — `implemented` + `automated test` via the in-repo fake AE host; **fake/mock only** until real host.
- Workspace-XML path discovery/parsing helpers (read-only) — `implemented` against fixture XML; real AE path layout `unverified`.
- Menu-locator locale rules, `ambiguous-target`/`stale-locator` refusal paths — automated test.

**Requires real host (owned AE launch; same blocker class as #339):**

- Whether AE's AX tree exposes menu bar / docked panes / context menus with enough fidelity to drive W1–W3 (the §7 surfaces are all `unverified`).
- Whether `CGEvent`/`SendInput` drag sequences produce real AE timeline scrubs and panel docks (custom-drawn controls are the risk).
- `comp.time` readback actually tracking GUI scrub (the W2 oracle's core assumption).
- Workspace switch via GUI menu → XML file delta; restore fidelity incl. panel frames.
- Render Queue AX observability; file-dialog filename entry under the input gates.
- Drag-drop end-to-end; multi-monitor workspace restore; DPI edge cases.

**Honest non-claims**: nothing in this spec asserts any of the above works; every §9 cell carries its level. "Windows coverage" is design-only until a Windows lane runs.

## 12. Slice → ticket decomposition (T001 output)

| Slice | Scope | Depends on | Suggested ticket |
| --- | --- | --- | --- |
| W1 | workspace switch + arrange + save/restore | B-PANEL `PanelTarget`/`docked-region`, menu-bar AX surface, workspace XML reader | #345-T002 (this issue's first impl ticket) |
| W2 | timeline scrub + layer/property/keyframe selection | B-IME mouse/key ops, host readback additions | follow-up ticket |
| W3 | menu-driven RQ + file dialog | menu AX surface, dialog machinery, B-IME text entry | follow-up ticket |
| W4+ | window ops cycle, comp-view pan/zoom, effect controls, context menus, Open/Save round-trip, drag-drop (#369 PoC: `unsupported`), multi-monitor | per-slice | ordered by consumer demand (B-CONSUMER/B-TEST) |

Each lands as its own PR against the then-current release train; shared contract changes to §5/§6 amend this spec first.

## 13. Non-goals

- No general GUI engine, locator DSL, workspace-structure parser, or OCR/image-based decision path (inherited prohibitions).
- No scripting-mutation-as-GUI-evidence anywhere; `menu.execute`/`app.executeCommand` is `scripting-direct`.
- No writing of AE preference/workspace files; no restore-by-file-copy as GUI evidence.
- No mutation enablement in this stage: all `mutate-gui` ops stay behind the lease+audit+gate chain pending A-SAFETY clearance (same posture as panel spec §9.1/IME spec §9).
- No foreign-AE/foreign-window interaction; drag-drop sources are fixture files only.
- No ae-test/ae-devtools consumer implementation here.
- No Windows real-host verification claims.

## 14. Traceability

| Issue element | Where addressed |
| --- | --- |
| FR workspace切替/配置/並び替え/保存復元 | §3 W1, §5, §8 |
| FR window移動/最大最小化/focus | §4, §5, §9 |
| FR timeline scrub/zoom/scroll, comp view pan/zoom | §3 W2 + deferred list, §9 |
| FR layer/property/keyframe選択, effect controls | §3 W2, §4, §9 |
| FR menu/context menu, Render Queue, Open/Save/Import | §3 W3, §4, §7, §9 |
| FR file/element drag-drop | §4, §5, §9 (explicitly highest-risk) |
| FR 共通platform mouse/keyboard/modifier | §5 reuses B-IME §6 taxonomy |
| FR "AE APIで目的を満たす場合は優先、GUI検証では実操作経路" | §2 boundary rule |
| FR locator再解決・曖昧拒否・state waitと再送の区別 | §6, §10 |
| FR DPI/複数画面 | §9 rows, inherits B-PANEL §6.3 |
| FR 対象・権限・結果確認 | §5 gates, §10 postcondition readback |
| FR 汎用Locator/完全workspace構造解析は非目的 | §13 |
| T001 実利用シナリオ分解→子Issue | §12 table (issues to be filed by delivery flow) |
| T002 最初のslice実装/検証 | §3 W1 |
| AC 代表workspace再現・復元 + GUI/AE状態検証 + 能力ごとのlevel記録 | §3 ACs, §9 matrix, §11 |
| Dependencies B-PANEL/B-IME/安全ゲート | header links, §5 class reuse, §13 gate posture |

## 15. Verification levels reached by this document

| Claim | Level |
| --- | --- |
| Helper inventory / host method surface (`menu.find`/`menu.execute`, `comp.selectLayers`, `layerInfo.selected`, no render-queue DOM) | `implemented` — cited from `host/a8n-host.js` source |
| Workspace XML storage locations & AE write timing | `unverified` — Adobe/community documentation only; probe required on real host |
| `app.executeCommand` workspace switching | `unverified` on our host (community-reported) |
| Menu bar / docked-pane / context-menu AX fidelity on AE | `unverified` — new surfaces, §7 |
| All mutation feasibility (drag, menu click, dialog entry) | `unverified` — gated, real-host PoC required |
| File/element drag-drop feasibility | `unsupported` on macOS AE 2027 — #369 real-host PoC (CGEvent/NSDraggingSession refused, 39 attempts); see `docs/evidence/realhost-2026-11-27/drag-drop-poc.md` |
| Contract, taxonomy, boundary rule, slice decomposition | this document; `automated test` arrives with implementation tickets |
