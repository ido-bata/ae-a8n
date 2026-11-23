# Real-host evidence — @ido-bata/ae-a8n 0.6.0 (release-0-6-0, main merge 8cb1b71)

Candidate: `v0.6.0` tag → `8cb1b7126dc7dce2da195d3092be969301c80606` (tree identical to
`release-0-6-0 @ cb627d2`). Tarball `ido-bata-ae-a8n-0.6.0.tgz`,
sha1 `2ae3b960364552969744e647b5f23b5f3ab83df1`, sha256
`87a494c62a0e8d167eab4400adb9e2ee90894112d8beb0d552a851d17bf195be`.

## macOS (verified on real host)

Host: macOS 27.2.1 arm64, Node v24.22.1. Packaged tarball → clean `npm install`
consumer (`A8N_VERSION === "0.6.0"`). Owned AE 2027 sessions launched by the
package itself; the user's AE 2026 instance was never sent input.

- owned `launch()` → live supervision monitor (`running`/`ok`), durable
  `supervision.json` + heartbeat; `ae-a8n supervise status|watch` read the same
  document; `monitor-lost`/`process-gone` transitions observed
- `showModalDialog` timeout → `blocked` within ~4s with structured window
  evidence (`ui.alert` auto-safe tier; AX-invisible windows unknown tier, no
  auto-press); late result stayed in outbox, never resent
- #321: AX-invisible layer-8 modal (ui.alert / crash-recovery) detected via
  WindowServer census frame reconciliation
- #322: launch-transient AX emptiness deferred during 5min startup grace —
  see `supervision-grace.json` ("blocking evidence deferred", phase `running`,
  `observationHealth=degraded`); post-grace fail-closed `blocked`
- #330: with AE 2026 + AE 2027 co-resident, AX windows are attributed to their
  pid via the census; foreign windows cannot become blocking evidence or press
  targets (press refuses unless attribution is `"owned"`, re-derived in-lease)
- attach semantics: `ownership.kind="attached"`, `close()` never quits,
  `recoveryTarget=null`, `supervisionState()` honestly `unavailable`

Files here: `evidence-owned3.log`, `evidence-supervision3.json`,
`evidence-status.json`, `evidence-trace3.jsonl`, `supervision-grace.json`,
`supervision-blocked.json`. Raw session dirs lived under `/tmp/ae-accept-rc2/`
(ephemeral); key durable docs copied here.

Not fully run to completion (environment-bound, recorded as known limitations):
post-dismissal return to `running`, `needs-human`/`quarantined` end-state,
owned `close()` while a modal is pending — detection→`blocked`→finite deadline
was observed; console-session GUI mutation refuses by design (isolated-session
lane requires a logged-in test user).

## Windows (verified on real host)

Host: `device-windows` (hostname UUU), Windows 11 build ~29712, Node v26.13.1,
AE 2026 `26.5.3x9` at `D:\4_apps\adobe\Adobe After Effects 2026` with AE 2027
co-resident (untouched — pid/CreationDate/window census identical before/after).
Consumer `C:\Users\rebui\ae-accept-060b` on the host; raw evidence under
`C:\Users\rebui\ae-accept-060b\evidence\` and `evidence2\`.

All 8 acceptance targets PASS on RC fb22b22 (the #332 delta is script-parse +
fail-closed attribution fixes, re-verified by unit tests and real PS 5.1
`Parser::ParseInput` errors=0 for every generated script mode):

- `installDir`-pinned owned launch of AE 2026 while AE 2027 runs (#323 census
  scoping) → `ownership.kind="owned"`, supervision monitor live for the first
  time on win32 (`phase:"running"`, `observationHealth:"ok"`, heartbeat)
- `showModalDialog` → Script Alert (#32770) detected as `blocked` ~5s with
  structured evidence; `pendingRequests` in-flight; **no auto-press** (zero
  measured-safe Windows classes)
- `WindowsGuiProbe.observe()` 1757ms bounded return (#324)
- `supervise status|watch` same durable document; `ae.close()` owned quit;
  attach refusal honest; TimeoutError reports real elapsed

Known limitations (tracked issues): #329 helper-window false-positive
classification, contaminated-listing end-to-end repro, grace-window real
dialog delay, Windows detached supervisor unsupported, no auto-safe Windows
dialog classes registered.
