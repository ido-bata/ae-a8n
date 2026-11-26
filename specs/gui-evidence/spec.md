# GUI recording and screen/render evidence integration (B-EVIDENCE)

- Parent program: [#337](https://github.com/ido-bata/ae-a8n/issues/337) (US-B4, Plan B)
- Ticket: [#346](https://github.com/ido-bata/ae-a8n/issues/346) — T001 PoC scoping (this document); T002/T003 implementation slices listed in §12
- Related: [#343](https://github.com/ido-bata/ae-a8n/issues/343) (B-PANEL — supplies `PanelTarget`, the `CaptureArtifact` original/derived contract, `capture`/`captureRegion`/`captureWindowById`; Draft PR #349, **not merged** — contract concepts only, no code dependency), [#344](https://github.com/ido-bata/ae-a8n/issues/344) (B-IME — supplies the session-stream input ops whose GUI path the recording must evidence; Draft PR #354, same non-merged status), [#345](https://github.com/ido-bata/ae-a8n/issues/345) (B-WORKSPACE — the GUI editing ops this recording captures; Draft PR, same status), [#338](https://github.com/ido-bata/ae-a8n/issues/338) (A-SAFETY gates), [#342](https://github.com/ido-bata/ae-a8n/issues/342) (A-RUNTIME — supplies the `ae-a8n.recovery-evidence/v1` manifest pattern and the artifacts/trace layout this spec extends; Draft PR #353, same non-merged status), consumers: B-CONSUMER (ido-bata/ae-devtools#426), B-TEST (ido-bata/ae-test#145)
- Builds on: [panel-interaction spec](../panel-interaction/spec.md), [ime-input spec](../ime-input/spec.md), [workspace-editing spec](../workspace-editing/spec.md), [gui-supervision spec](../gui-supervision/spec.md), [isolated-ae spec](../isolated-ae/spec.md), [ADR-0004](../../docs/adr/0004-native-mutation-authorization.md), [ADR-0005](../../docs/adr/0005-session-supervision.md)
- Status: **draft for review**. Nothing named below is implied to exist yet. Verification level of every claim is stated explicitly.

## 1. Problem

The user story is "an agent's real operations can be verified by a third party from images, video, and time series" (US-B4). A failed or disputed run today leaves: a `trace.jsonl` of operation rows, ad-hoc recovery screenshots, and whatever render frames the test happened to write — but there is **no recording capability at all**, no schema binding a screen image to the operation that produced it, and no single index that answers "show me everything that evidences this run". Concretely:

- **No video exists.** `screencapture` stills are the only screen evidence; a GUI sequence (drag a panel, scrub the timeline, confirm a dialog) cannot be replayed or audited after the fact.
- **Stills are uncorrelated.** Recovery screenshots carry a request id inside a manifest (#342, unmerged); panel captures (343, unmerged) carry `CaptureArtifact.source.operationId`. There is no run-level index joining captures, recordings, trace rows, and render outputs by one id scheme.
- **Screen evidence and render evidence are different claims.** A screenshot of the comp viewer is not proof the render pipeline produced correct pixels; a `comp.renderFrame` PNG is not proof the GUI path worked. Nothing today prevents a consumer from treating one as the other.
- **Recording has privacy and lifecycle hazards no spec has bounded**: what scope is captured (one window vs whole display vs whole session), what happens to other apps' content, what residue survives a crash mid-recording, and what the overhead is on the measured operation.

This spec fixes the evidence-channel boundary, the artifact/correlation contract, the per-OS recording mechanism decision, and what remains honestly unverified.

## 2. Scope

In scope for this stage (research + contract; implementation tickets follow):

1. **Evidence channel separation** (§3): screen/GUI evidence vs AE render evidence as distinct artifact kinds with distinct claims — never substitutable.
2. **Stills inventory and reuse**: the existing capture paths (`MacGuiRecovery.capture`, `captureRegion`, `captureWindowById` on branch 343, Windows: none) surveyed and bound into the artifact contract.
3. **Recording contract**: bounded start/stop lifecycle, scope declaration, per-OS mechanism candidates with feasibility tiers (§6), interruption/finalize rules (§5.4), privacy/retention/publication boundary (§8).
4. **Correlation scheme**: how captures, recordings, trace rows, audit events, and render outputs join on session/run/request/operation ids and a shared time axis (§5.3).
5. **Run evidence index**: one schema-versioned manifest per session that lists every evidence artifact, its gaps, and its links — the B-side successor to `ae-a8n.recovery-evidence/v1`.
6. **Verification plan**: what is provable without a real host vs what requires an owned AE launch (§10).

Out of scope:

- A general-purpose viewer, timeline UI, or scrubber — explicitly a non-goal (Issue FR; ADR-0006 §5 assigns "large-scale screen recording and a viewer" to program B, and this spec deliberately stops at machine-readable artifacts + index).
- Custom codecs, OCR, or any image-based *decision* path — prohibited by gui-supervision spec; evidence is for humans and deterministic consumers, never a detection input.
- Recording codecs/transcoding pipelines beyond what the OS capture API emits natively; frame extraction for derived artifacts uses OS image tools only.
- ae-test consumer implementation (B-TEST / ae-test#145 consumes the contract later), ae-devtools viewer work (B-CONSUMER).
- Any recording of sessions/hosts this driver does not own, or of foreign apps' windows as a *target* — scope rules in §7 bound what may be recorded, not what may be looked at.

## 3. The two evidence channels — contract boundary

This is the load-bearing distinction of the ticket, parallel to B-IME §4's Tier-1a/1b split:

### 3.1 Channel S — screen evidence (what the GUI displayed)

Artifacts produced by OS capture of the target session's display: stills (`CaptureArtifact` per panel spec §6.3) and recordings (`ScreenRecording` per §5.2). Claims a Channel-S artifact may support:

- "the GUI showed X at time T" — panel geometry, dialog presence, menu state, composition/candidate windows, focus indicators;
- "the GUI operation path ran" — only when correlated with the operation's audit/trace record (§5.3); the video alone does not prove which op ran, the index does.

Channel S **never** proves render output correctness: a comp viewer can display a stale or wrong frame, and a screen pixel is not the render pipeline's product.

### 3.2 Channel R — render evidence (what AE produced)

Artifacts produced by AE's own render paths: `comp.renderFrame` PNGs (`host/a8n-host.js` `methods["comp.renderFrame"]`, ~L609), render-queue outputs where a consumer drives them, and deterministic frame sequences. Claims:

- "AE rendered frame N to these pixels" — the artifact is the render product itself (or a derivative of it);
- render evidence is **never** evidence that a GUI operation worked — a render can be queued and produced while every panel interaction failed.

### 3.3 Coexistence rule

One run may hold both channels for the same operation (e.g., B-WORKSPACE W3: GUI-add-to-render-queue *and* the resulting render). The evidence index (§5.5) records both and links them by time window and request id; a consumer asserting "GUI op → render result" must cite both artifact refs. Blending them into one undifferentiated "screenshot" field is a contract violation.

## 4. Existing helper inventory

Searched `src/`, `scripts/isolated-session/`, `host/` on `release-0-7-0` (plus contract branches 342/343/344/345 via `git show`, no code dependency) for `screencapture`, `CGWindowListCreateImage`, `CGDisplayStream`, `ScreenCaptureKit`, `SCStream`, `PrintWindow`, `Graphics.Capture`, `ffmpeg`, `AVAssetWriter`, `renderFrame`, `saveFrameToPng`, `trace`, `artifacts`.

### 4.1 macOS

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Full-screen still capture | `screencapture -x -o <path>` inside target session via `runInSession` | `src/driver/gui-recovery.ts` `MacGuiRecovery.capture` (~L1168) | verified on real host (recovery evidence) |
| Region still capture | `screencapture -x -o -R<x,y,w,h>` | `captureRegion` on branch 343 (`gui-recovery.ts` ~L1320) | implemented on 343; real-host pending |
| Window still capture | `screencapture -x -o -l<CGWindowID>` | `captureWindowById` on branch 343 (~L1351); census parses `kCGWindowNumber` | implemented on 343; real-host pending |
| Screen/video recording | **nothing** — no `screencapture -V`/`-v` call, no ScreenCaptureKit/`SCStream`, no `CGDisplayStream`, no `AVAssetWriter` anywhere | — | missing |
| Session-scoped exec | `runInSession` (`launchctl asuser`) — the vehicle any recording helper must use | `src/driver/mac-session.ts` | verified on real host |
| GUI lease + audit | `acquireGuiLease`, `auditGuiEvent` — audit rows are the op-side half of evidence correlation | `src/platform/darwin/gui-lease.ts` | verified on real host |
| Standalone swift helpers | `list-windows.swift`, `ax-windows.swift`, `ax-press.swift`, `focus-watch.swift` — the pattern a `screen-record.swift` helper follows (compiled/run via `runInSession`, arguments validated, JSON verdict out) | `scripts/isolated-session/*.swift` | compiled/run in isolated checks |

**Not present on macOS**: any video capture path; any recording-permission handling distinct from the Screen Recording TCC grant that `screencapture` already requires (window *names* redaction observed in panel spec §7 — the same grant gates `SCStream` content); any frame-timestamp or fps accounting.

### 4.2 Windows

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Window census + UIA | `EnumWindows`/`GetWindowRect` + UIA tree | `src/platform/windows/gui-observe-script.ts`, `gui-probe.ts` | implemented |
| Screen capture (any kind) | **none** — `windows-host-recovery.ts` explicitly has no screenshot vehicle | `src/driver/windows-host-recovery.ts` | missing |
| Video capture | **nothing** — no `Windows.Graphics.Capture`, no `PrintWindow` (stills-only anyway), no ffmpeg/gdigrab path | — | missing |
| Render evidence | same host `comp.renderFrame` path (in-AE, OS-independent) | `host/a8n-host.js` | implemented |

**Not present on Windows**: every capture vehicle. `PrintWindow`/`PW_RENDERFULLCONTENT` is the stills candidate (panel spec §8); video candidates are `Windows.Graphics.Capture` (HWND-scoped, Win10 1903+) or an external `ffmpeg` (`gdigrab`/`ddagrab`) — both unbuilt and unverified.

### 4.3 Shared / platform-neutral

- `src/protocol/workspace.ts` `createSessionPaths` — session layout: `<root>/{inbox,outbox,artifacts,staging}` + `trace.jsonl`. Evidence artifacts land under `artifacts/`; the index lives beside them.
- `src/trace/trace.ts` — JSONL operation history: `seq`, `ts` (ISO epoch), `op`, `status`, `durationMs`, redacted `args`/`result`. The time axis recordings correlate against.
- `src/driver/driver.ts` — every `call` gets a `requestId` (`nextRequestId()` UUID) and recovery attempts key manifests off it (#342 pattern: `recovery-<requestId>.evidence.json`, atomic temp+rename, `uncapturable` honesty list).
- `src/runner/artifacts.ts` — run-level `manifest.json`/`report.json`/`trace.jsonl`/`artifacts/` for the CLI runner — a *different* artifact tree than the session's; the evidence index must state which tree it indexes (session `artifacts/` is the primary; runner artifacts reference session paths).
- GUI audit (`gui-lease.ts` `auditGuiEvent`) — per-mutation audit rows inside the lease scope; the GUI-op half of correlation.
- ae-test consumer expectations (`~/work/ae-test-p1225`): `Artifact { name, path, bytes, kind: "render"|"trace"|"attachment"|"diff" }`, `fixture.attach(name, contents)` writes into the test's results dir, `collectRenders(session.artifactsDir, outputDir)` picks up render frames from the session artifacts dir — i.e., **ae-test already treats `session.artifactsDir` as the evidence drop point**; the index must be discoverable there without ae-test knowing internal layout (same design goal as the #342 manifest).

## 5. Contracts

Working names; public API naming is a T002/T003 decision. All schemas carry a `kind`/`schemaVersion` discriminator like `ae-a8n.recovery-evidence/v1`.

### 5.1 Evidence kinds

```
EvidenceKind =
  | "screen-still"        // one OS capture of a scope (display/region/window)
  | "screen-recording"    // one bounded video segment of a scope
  | "render-frame"        // one AE-produced frame (renderFrame PNG, RQ output frame)
  | "render-sequence"     // a numbered frame sequence from one render job
  | "trace"               // the session trace.jsonl (referenced, not copied)
  | "index"               // the run evidence index itself
```

Every artifact record:

```
EvidenceArtifact {
  kind: EvidenceKind
  role: "original" | "derived"               // B-PANEL CaptureArtifact rule, extended to video
  path: string                               // relative to session artifacts dir
  sha256: string | null                      // null only when hashing was impossible — recorded, not omitted
  bytes: number | null
  session: { pid, processStartIdentity, sessionId, sessionKind }   // proven host identity
  scope?: CaptureScope                       // screen-* kinds only (§5.2)
  time: { capturedAt: string,                 // ISO epoch, wall clock
          t0EpochMs: number, t0MonoMs: number,// recording start, both clocks
          durationMs: number | null,          // null = still
          endEpochMs: number | null }
  geometry?: { widthPx, heightPx, fps?, coordinateSpace, backingScale? }
  provenance: { producer: "os-capture" | "ae-render" | "derived-tool",
                tool: string, toolVersion?: string }
  operationIds: string[]                     // requestIds / audit op ids this artifact evidences
  transform?: { kind: "crop"|"scale"|"trim"|"frame-extract"|"re-encode", params }  // derived only
  unavailable?: { reason: string }           // honest absence — a gap is data, not silence
}
```

### 5.2 Capture scope and the recording target

```
CaptureScope =
  | { kind: "window",  window: PanelTarget-ref }     // one proven OS window (B-PANEL identity rules)
  | { kind: "region",  frame: GuiFrame, parent?: PanelTarget-ref }
  | { kind: "display", displayId?: string }          // whole display — maximal leakage, requires explicit scope grant
  | { kind: "session", sessionKind: "isolated"|"attached"|"console" }
```

Rules:

- Scope resolution reuses `PanelTarget` identity (pid + start identity + handle + re-check); `window`/`region` scopes require `attribution==="owned"` before recording starts — recording a `foreign`/`unproven` window is refused exactly like a mutation would be.
- `display`/`session` scope is a **privacy declaration**, not a default: it records `leakage: "full-display"|"full-session"` on every artifact and requires the recording authorization of §7.2. Window/region scope is the preferred default wherever the OS API can honor it (macOS ScreenCaptureKit `SCContentFilter` window capture; Windows WGC HWND capture).
- A scope that cannot be isolated on the OS is recorded honestly: e.g., macOS `screencapture -V` fallback records whole-display even when `window` was requested — the artifact's `scope.kind` stays `"window"` (what was asked) and `actualScope`/`leakage` records what was delivered. Requested ≠ delivered is always explicit.

### 5.3 Operation-id correlation scheme

Three id families already exist; the contract binds them, it does not invent a fourth:

| Id | Owner | Role in evidence |
| --- | --- | --- |
| `requestId` (UUID, `nextRequestId()`) | protocol envelope | one per `ae.*` call; recovery manifests already key off it |
| trace `seq` + `ts` | `src/trace/trace.ts` | ordered operation history; `ts` is the wall-clock axis |
| audit `op` + lease id | `gui-lease.ts` | per-mutation GUI act record inside the lease |

Correlation rules:

1. **Capture/record ops are themselves traced operations.** `record.start`/`record.stop`/`capture.*` emit trace rows with `result.evidenceId` — the artifact's index id — so a consumer can walk trace → artifact without guessing.
2. **Every evidence artifact lists `operationIds`** — the requestIds/audit ops it was *taken for or during*. For recordings, that is every op whose `[start,end]` intersects the segment's `[t0,end]` window **plus** an explicit `coversOperations: boolean` computed at `record.stop` from the trace (the index stores the computed answer; consumers do not re-derive it).
3. **Time axis is dual-clock.** Recordings stamp `t0EpochMs` (wall) and `t0MonoMs` (`process.hrtime`/`CLOCK_MONOTONIC`); trace rows carry epoch `ts` only, so wall clock is the join key and monotonic is the drift check (record `clockSkewMs` estimate in the index when both are available). A trace `ts` inside `[t0EpochMs, endEpochMs]` is "covered" — with `endEpochMs` null (still recording / crashed) coverage is `open`, reported as such.
4. **GUI acts join by audit, not by pixel.** A `mutate-gui` op's audit row gains an `evidenceRef` field (the active recording segment id + still path when one was taken for it). The video shows *that something happened*; the audit row + trace say *what was requested*. Neither alone is the claim.
5. **testId/sessionId**: the session root path and `runId` (runner) / session id (driver) are recorded on the index; a consumer (ae-test) supplies its own test id which the index echoes under `consumerRefs` when the caller passes it — ae-a8n never invents a test identity.

### 5.4 Recording lifecycle and interruption

```
record.start(scope, { maxDurationMs?, fps?, audio: false }) -> RecordingSession { id, t0, scope, actualScope }
record.stop(id)  -> finalize: stop encoder -> verify file (exists, nonzero, container probe) -> index update
```

- **Bounded by contract**: `maxDurationMs` is required-or-defaulted (proposal: default 300 s, hard cap 3600 s); a recording never runs unbounded. The stop deadline is enforced driver-side; the helper process is killed and the segment recorded `incomplete: "deadline-exceeded"` — never retried blind.
- **Finalize in `finally`**: every start pairs with a stop attempt on session teardown, driver `close`, cancellation, and process exit hooks where available. A killed encoder may leave an unplayable `.mov`/`.mp4` — that is recorded (`playable: false`, `unavailable.reason`), not deleted and not claimed.
- **No residue**: the recorder is a child of the session-scoped helper path (`runInSession` on macOS; in-session spawned helper on Windows); teardown enumerates and terminates any surviving recorder pid and records `recorderResidue: "none"|"terminated"|"unknown"` on the index. This is the Issue AC "中断後に録画/入力/プロセス残留を防止" made checkable.
- **Crash honesty**: if the driver dies mid-recording, the helper's own bounded lifetime (`maxDurationMs` enforced inside the helper too, not only by the driver) guarantees the file finalizes or dies with the session; the next session's index marks the segment `orphaned` rather than discovering a growing file.
- **Segmented, not one file**: long evidence is multiple segments (`seg-001`, `seg-002`, …) each with its own t0 — a single multi-hour file is unreviewable and unmergeable; segment boundaries are also natural correlation units.

### 5.5 Run evidence index — `ae-a8n.gui-evidence/v1`

One JSON document per session, written incrementally (atomic temp+rename per update, same pattern as #342) at `<sessionRoot>/artifacts/evidence-index.json`:

```
GuiEvidenceIndex {
  kind: "ae-a8n.gui-evidence/v1"
  session: { sessionRoot, sessionId, pid, processStartIdentity, sessionKind, adapter }
  consumerRefs?: { testId?, runId?, suite? }        // echoed, never invented
  segments: RecordingSession-summary[]             // id, scope, actualScope, t0/end, file, playable, coversOperations
  artifacts: EvidenceArtifact[]                     // stills + render refs + derived, deduplicated by sha256
  operations: { requestId, traceSeq?, op, auditOpId?,
                evidenceRefs: string[],             // artifact/segment ids
                coverage: "screen"|"render"|"both"|"none",
                uncovered?: string }[]              // ops that ran with no evidence — explicit
  gaps: { uncapturable: string[], unrecorded: string[], orphaned: string[] }
  captureStats?: { requestedFps, achievedFps?, droppedFrames?, encodeCpu?, measuredOverheadMs? }
  clock: { skewEstimateMs?, basis: "epoch+mono" }
  capturedAt, updatedAt
}
```

Rules:

- **Gaps are first-class**: `uncovered` operations (a GUI op ran while recording was off or failed to start) and `uncapturable`/`unrecorded` reasons are listed, never omitted — same honesty rule as `uncapturableEvidence` in #342.
- The index **references** render artifacts (paths + sha256) rather than copying them into a new tree; `comp.renderFrame` already lands in a caller-chosen `outputDir`, and ae-test's `collectRenders` scans `session.artifactsDir` — render outputs directed there appear in the index automatically when a render op carries an `evidenceRefs` link (T003 wiring).
- The index is **append-tolerant**: a second writer (e.g., a later `record.start` in the same session) merges by artifact id; last-writer-wins only on scalar session fields. Concurrent writers are excluded by the session's single-driver model.
- A `kind: "index"` artifact entry points at the index file itself so artifact enumerations are self-describing.

### 5.6 Operation classes and gates

| Operation | Class | Gate |
| --- | --- | --- |
| Enumerate capture capability, resolve `CaptureScope`, probe recorder availability, read index | `observe` | existing read-only path; no lease |
| Still capture (`capture`, `captureRegion`, `captureWindowById`) | `observe` (capture, not mutation) — subject to B-PANEL's `attribution==="owned"` rule for non-full-screen scopes | same as panel spec §6.2 `observe` row |
| `record.start`/`record.stop` on `window`/`region` scope of an owned target | `observe`-class capture, **but** serialized on the GUI lease anyway (a recorder reading the same WindowServer/capture pipeline must not race a mutation's pre/post captures) | lease held for the segment duration **or** per-frame lease — T001 PoC decides; lease-per-segment is the safe default |
| `record.start` on `display`/`session` scope, or any scope while `sessionKind==="console"`/`"attached"` shared session | `observe`-class capture + **`requiresRecordingAuthorization`** | explicit authorization token/scope per session kind (§7.2); dedicated/isolated sessions relax to the isolation check |
| Anything that *acts* on the GUI | unchanged | B-PANEL/B-IME/B-WORKSPACE classes — recording never grants mutation authority |

Recording is deliberately **not** a `mutate-*` class: it does not change target state. Its hazard is privacy/scope, handled by §7, not by the mutation gates. It also never satisfies a mutation precondition — a running recorder is not a reason to skip identity re-checks.

## 6. Per-OS recording mechanism — decision

### 6.1 macOS

Candidates evaluated:

| Mechanism | Scope | Container/codec | Permission | Verdict |
| --- | --- | --- | --- | --- |
| **ScreenCaptureKit `SCStream`** (new `scripts/isolated-session/screen-record.swift`, `SCContentFilter` window/display init, `AVAssetWriter` .mov, H.264/HEVC) | window, region (crop of display content), display | `.mov` H.264/HEVC — OS-native, no custom codec | Screen Recording TCC (same grant `screencapture` needs; prompt behavior on first use **unverified**) | **preferred** — only OS API offering HWND-equivalent window-scoped video with frame callbacks (dropped-frame accounting) |
| `screencapture -V<seconds> <file>` / `-v` | display only (no window/region scope for video) | `.mov` | same TCC | **fallback** — trivial to invoke through `runInSession`, bounded via `-V`, but whole-display only and stop is duration- or signal-driven; acceptable for `display` scope PoC, not for window scope |
| `CGDisplayStream`/`CGDisplayCreateStream` | display | raw frames → needs own encoder | same | **rejected** — deprecated API path, pushes encoding onto us (custom codec territory, non-goal) |
| `ffmpeg`/`avfoundation` | display | any | none beyond TCC | **rejected as primary** — external tool dependency for what SCStream does natively; may return later as `needs-external-tool` tier if SCStream fails on a real host |

Decision: **ScreenCaptureKit is the contract target; `screencapture -V` is the documented fallback tier.** Both are `unverified` until a real-host PoC (T001): SCStream's behavior under `launchctl asuser` session exec, TCC grant prompting inside an isolated session, achievable fps on Retina multi-display, and `.mov` finalize-on-SIGTERM semantics are all open questions. Audio is off in every configuration (`capturesAudio = false` equivalent) — no audio contract exists.

### 6.2 Windows

| Mechanism | Scope | Container/codec | Permission | Verdict |
| --- | --- | --- | --- | --- |
| **Windows.Graphics.Capture** (`Direct3D11CaptureFramePool` → `MediaFoundation` encode → `.mp4`; HWND-scoped via `GraphicsCaptureItemInterop`) | window (HWID), monitor | `.mp4` H.264/HEVC via OS MFTs | none beyond the session (own desktop); Win10 1903+ | **preferred candidate** — the only built-in HWND-scoped video API; implementation vehicle is a C# helper (`Add-Type` in the existing PowerShell observer family, or a shipped exe) — **unverified** on AE's windows, on UIPI boundaries, and on whether AE/CEF windows are capturable (`IsBorderRequired`, protected-content denial is a real failure mode to record honestly) |
| `ffmpeg -f gdigrab`/`ddagrab` | display/monitor | any container ffmpeg muxes | none | **fallback tier** — `needs-external-tool` capability: allowed only when declared, version-checked, and the artifact records `tool: "ffmpeg"` + version; never silently assumed present |
| `PrintWindow` | window stills only | — | none | stills candidate per panel spec §8; **not video** — listed to prevent the "PrintWindow = recording" confusion |

Decision: **WGC is the contract target, ffmpeg the declared-external fallback, everything `unverified`** — there is no Windows real-host lane in this repo's evidence today, so every Windows cell stays `unverified`/`unsupported` until one runs. If WGC cannot capture a given window class, the honest answer is `unavailable: "window-not-capturable"` on that scope, not a silent display-scope substitution.

### 6.3 Feasibility tiers (what "done" means per tier)

- **T0 — contract + fakes**: schemas, index read/write/merge, gap accounting, lifecycle state machine, capability matrix — all `automated test` against fakes; no OS calls.
- **T1 — stills binding**: existing/reused still paths emit `EvidenceArtifact` records into the index (depends on 343's capture impl landing or re-implementing the same `screencapture` invocations — contract-level only here).
- **T2 — macOS recording PoC**: `screen-record.swift` SCStream helper at `implemented`, exercised `automated test` for arg validation; real-host verification deferred to an owned-AE lane (same blocker class as #339).
- **T3 — Windows recording PoC**: WGC helper `implemented`; `unverified` until a Windows host runs it.
- **T4 — derived media**: frame extraction / trim / re-encode as `derived` artifacts via OS tools (`sips`, `afconvert`-family/AVFoundation) — labelled `transform`, original always retained; lowest priority, explicitly deferrable.

## 7. Privacy, retention, publication

1. **Scope minimization is the default**: `window`/`region` scope preferred; `display`/`session` scope requires the §5.6 authorization and is recorded with `leakage` on every contained artifact.
2. **Exclusions are declarative**: `record.start` accepts `exclude: [{kind:"window", predicate}]` recorded on the segment; on macOS SCStream this maps to excluding other `SCWindow`s from a display filter where the API allows — where it does not, `actualScope` records the gap. Exclusion *requests* that cannot be honored are `unavailable` reasons, never silent.
3. **No audio, ever** in v1; microphone/system audio is out of contract.
4. **Retention**: artifacts live under `<sessionRoot>/artifacts/` and die with `disposeSession`/runner cleanup unless the caller copies them out — same lifecycle as every existing artifact; the index states `retention: "session-artifacts"`.
5. **Publication boundary**: nothing is uploaded, synced, or committed by the driver. `docs/evidence/` committed evidence is a *manual, reviewed* act (existing convention: dated directories with README/report); automated runs never write there.
6. **Other apps' content**: a `display`-scope recording necessarily contains whatever else was on screen. That is why §5.6 gates it; the artifact does not redact and does not claim to — consumers publishing artifacts must treat full-scope media as containing arbitrary user data.
7. **Secrets on screen**: a password field visible during recording is captured like any pixel; scope minimization + `window` scope is the mitigation, and the spec does not pretend pixel-level redaction exists.

## 8. Interruption and residue (AC mapping)

| AC element | Contract answer |
| --- | --- |
| 中断後に録画残留を防止 | §5.4: bounded helper lifetime, `finally` stop, `recorderResidue` field, orphan marking |
| 入力残留を防止 | unchanged — B-IME §5.5 cleanup; recording adds no input path |
| プロセス残留を防止 | recorder pid tracked per segment; session teardown terminates survivors and records the outcome |
| 対象外データ漏れなし | §7 scope/exclusion/leakage declaration; `foreign`/`unproven` scope refused |
| 未取得を明示 | `uncovered`/`uncapturable`/`unrecorded`/`orphaned` gap lists on the index |

## 9. Non-goals

- No viewer, editor, or timeline UI; no streaming/live preview.
- No custom codec, no hardware-encoder tuning, no adaptive bitrate — OS defaults only.
- No OCR/image analysis, no frame-diff *assertions* inside ae-a8n (that decision belongs to ae-test; this repo ships pixels + metadata).
- No recording as a substitute for supervision: `MacGuiProbe`/census stay the *detection* path (gui-supervision prohibits screenshot-as-detection); video is evidence, never a probe input.
- No cross-session or cross-host recording aggregation; one index per session.
- No enablement of `display`/`session` scope or shared-console recording without the authorization gate — same posture as B-IME §5.4.
- No Windows real-host verification claims — every Windows row is `unverified`.

## 10. Verification plan

**Provable now (this ticket / follow-ups without real AE):**

- All schemas and the index state machine: T0 — unit-tested against fakes (`src/platform/fake-adapter.ts` family, `GuiRecoverySurface`-style structural seams).
- Lifecycle logic: start/stop pairing, deadline enforcement, `finally` finalize, residue accounting, orphan marking — automated test with a fake recorder process.
- Correlation math: dual-clock join, `coversOperations` computation, `uncovered` gap detection — pure functions, automated test.
- Capability matrix emission with honest verification levels per OS — automated test.
- Helper *code*: `screen-record.swift` argument validation + `osacompile` precedent; WGC helper script compilation — `implemented` only.
- Still-artifact binding: given a fake capture result, correct `EvidenceArtifact`/`CaptureArtifact` records and index entries — automated test.

**Requires real host (owned AE launch; blocked same class as #339):**

- SCStream actually delivering frames under `runInSession`; TCC prompt/failure modes in isolated sessions; achievable fps and dropped-frame counters on Retina hardware.
- `screencapture -V` bounded-recording semantics (file finalize on duration end vs signal).
- Whether `-R`-equivalent region cropping inside SCStream matches census point→pixel scaling (`backingScale` from panel spec §6.3 applies unchanged).
- Recording during real B-PANEL/B-IME/B-WORKSPACE ops — the T003 "same run" check needs the whole vertical.
- Windows: everything — WGC on AE/CEF windows, protected-content denials, UIPI, ffmpeg fallback presence.
- Overhead measurement (§11) — only meaningful on real hardware under real load.

**Negative cases (automatable at contract level now):** recorder start failure → `unavailable` + gap recorded, ops continue unrecorded; stop timeout → `incomplete` segment, residue check; foreign/ambiguous scope → refuse before any capture call; authorization absent on shared session → refuse; index merge under second writer; sha256 failure → `null` + reason, never omitted.

## 11. Performance and timing impact (T001 PoC metrics)

Recording must not silently perturb the operations it evidences. The PoC measures and the manifest records:

- `requestedFps` vs `achievedFps` and `droppedFrames` where the API reports them (SCStream `didDrop`/`captureStats`; WGC frame-pool stats);
- encode CPU/time-share during a segment;
- added latency to a concurrent `mutate-gui` op vs the same op unrecorded (bounded sample, reported as `measuredOverheadMs` with methodology noted — a single number without context is not evidence);
- capture-to-index latency (`capturedAt` vs file mtime vs index `updatedAt`).

If overhead exceeds a declared budget (proposal: <5% frame-drop at 30 fps target, no measurable op-latency regression beyond noise), the capability reports `degraded` with numbers — the honest answer, not a hidden quality loss.

## 12. Vertical slices

| Slice | Content | Depends on |
| --- | --- | --- |
| **E1 — evidence index + stills binding** | `GuiEvidenceIndex` schema, artifact records, index read/write/merge, gap accounting; bind existing `capture`/`captureRegion`/`captureWindowById` outputs (contract-level; 343 code or re-implementation) | 342 manifest pattern (concept), 343 CaptureArtifact (concept) |
| **E2 — macOS recording** | `screen-record.swift` SCStream helper + `screencapture -V` fallback tier, `record.start/stop` lifecycle, scope resolution, authorization gate, residue/finalize | E1; real-host PoC for verification level |
| **E3 — Windows recording** | WGC helper (or ffmpeg declared-external fallback), same lifecycle contract | E1; Windows host lane |
| **E4 — render-evidence join + consumer handoff** | `render-frame`/`render-sequence` artifact records, `operationIds`/`coversOperations` wiring for `comp.renderFrame` and render-queue outputs, T003 same-run verification, ae-test `Artifact` mapping notes for B-TEST | E1–E3 (contract can land earlier) |

Ordering rationale: E1 is pure contract and unblocks everything; E2/E3 are per-OS and parallel; E4 is the integration proof and lands last but its *schema* is fixed in E1.

## 13. Traceability

| Issue element | Where addressed |
| --- | --- |
| FR: GUI静止画・領域・パネル・dialog (Plan A/B-PANEL capture 再利用) | §4.1 inventory, §5.1 `screen-still`, §6.1 stills path reuse |
| FR: リアルタイムGUI録画 | §5.2–5.4, §6 recording contracts and per-OS mechanisms |
| FR: 既存AE render/決定的frame収録を別能力として提供 | §3.2 Channel R, §5.1 `render-*` kinds, §12 E4 |
| FR: 原本とcrop/resize/変換を区別 | §5.1 `role: original\|derived` + `transform`, §6.3 T4 |
| FR: timestamp/session/request/test id | §5.3 id binding, §5.5 `consumerRefs` |
| FR: 寸法/範囲、取得失敗、保存場所をtrace/artifactへ紐付け | §5.1 `geometry`/`unavailable`, §5.5 index under `artifacts/`, trace `result.evidenceId` |
| FR: 画面録画でrender結果を代替せず、render映像でGUI操作を代替しない | §3 channel boundary, §3.3 coexistence rule |
| FR: OS標準capture/既存encoder/image library利用 | §6 — SCStream/screencapture, WGC/ffmpeg-external, no custom codec |
| FR: 個人情報/対象外window/保存期間/公開境界 | §7 privacy/retention/publication |
| FR: 性能・タイミング影響を評価 | §11 metrics, `captureStats` |
| FR: 高機能viewer/独自codecは非目的 | §2 out-of-scope, §9 non-goals |
| T001 OS/isolated session別の撮影・録画PoC、対象範囲・権限・性能計測 | §6 candidates + §10 real-host list + §11 metrics |
| T002 public capture/record lifecycle・artifact metadata、原本/加工、失敗/中断時finalize | §5.4 lifecycle, §5.1 metadata, §5.5 index, §8 residue |
| T003 GUI操作録画とrender出力が同じrunに由来することを検証、B-CONSUMER/B-TESTへ接続 | §5.3 correlation, §5.5 `coversOperations`/`coverage`, §12 E4 |
| AC: 代表操作の実画像・実動画・render証跡を取得、時間軸・対象・操作と対応 | §5.3–5.5; real-host deferred per §10 |
| AC: 中断後に録画/入力/プロセス残留を防止 | §5.4, §8 |
| AC: 対象外データ漏れなし | §7.1–7.2 scope/exclusion, foreign-scope refusal |
| AC: 通常操作のoverheadを測定 | §11 |
| AC: 未取得を明示 | §5.5 gap lists, `unavailable` fields |

## 14. Verification levels reached by this document

| Claim | Level |
| --- | --- |
| No video recording path exists on either OS; stills exist only as cited | `implemented`-verified by source search (§4) |
| Session layout, trace schema, requestId/audit id families, #342 manifest pattern, ae-test artifact expectations | `implemented` (read from source); #342/#343 contract parts are **unmerged drafts — concepts only** |
| `comp.renderFrame` produces PNG frames via `saveFrameToPng` | `implemented` in `host/`; real-render behavior per existing docs |
| macOS SCStream / `screencapture -V` feasibility under `runInSession`, TCC prompts, fps | `unverified` — T001 real-host PoC |
| Windows WGC feasibility on AE windows; ffmpeg fallback | `unverified` — no Windows lane |
| Contract, schemas, lifecycle, correlation, gates, privacy rules | this document only; `automated test` arrives with E1 |
