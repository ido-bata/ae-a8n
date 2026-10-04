# ADR 0001 — Bridge transport for the After Effects host

- Status: accepted
- Date: 2026-10-04
- Affects: `host/`, `src/protocol/`, `src/driver/`

## Context

`ae-a8n` must run code inside After Effects from an external process. ExtendScript
provides no socket, no IPC, and no import mechanism. Whatever transport is chosen
becomes the shape of the whole runtime, so it is worth picking on evidence rather
than convenience.

## What the available interfaces actually offer

Grounded on the existing, maintained implementation in
[`BenZed/after-effects`](https://github.com/BenZed/after-effects) (`lib/platform-win.js`,
`lib/platform-mac.js`), which drives AE from Node today:

| Interface | Usable externally | Windows | macOS | Deterministic | Verdict |
| --- | --- | --- | --- | --- | --- |
| `AfterFX.exe -r <script.jsx>` | yes | native | n/a | yes | **adopted** |
| `osascript` → `tell application "Adobe After Effects" to DoScript` | yes | n/a | native | yes | **adopted** |
| `aerender -r <script>` | yes | native | native | yes | render only; later candidate |
| CEP panel + Node socket | yes | needs a host-side install | needs a host-side install | yes | deferred |
| UXP | no | — | — | — | AE is not a UXP host |
| UI automation / image recognition | yes | fragile | fragile | no | last resort, never for model operations |

A prerequisite both adopted paths share: **After Effects → Preferences → General →
*Allow Scripts to Write Files and Access Network*** must be enabled. Without it the
host cannot read the request file or write the result.

## The constraint that decides the design

`AfterFX.exe -r` returns nothing. The process exits without a value the caller can
read, and the established implementation ignores the exec error entirely because
Windows reports failure even on success. So on Windows there is **no synchronous
return path**.

macOS does have one — `osascript` prints the result to stdout — but a protocol that
works on only one platform is not a protocol.

## Decision

**Split request and result into two channels, and make the file the only result
channel on both platforms.**

```text
driver ──writes──▶  inbox/<id>.request.json
      ──launches─▶  AfterFX.exe -r <id>.entry.jsx   |   osascript … DoScript
                    host/a8n-host.js  reads request, dispatches, writes
      ◀─polls────  outbox/<id>.result.json
```

- The driver writes a request, then asks the transport to run a generated entry
  script. The entry script is a three-line stub that publishes `__a8n` (the
  request and result paths) and evals the host script.
- The host script is a **static, versioned file** (`host/a8n-host.js`), not
  regenerated per command. It is ES3, because ExtendScript is ES3.
- Both envelopes are published by **rename**, so a reader never observes a
  half-written file.
- The driver polls the result file with a backoff and turns absence past the
  deadline into a typed `TimeoutError`.

The transport sits behind `HostTransport` (`src/driver/transport.ts`), so swapping
in a CEP socket later does not move the protocol, the host script, or the API.

## Consequences

- ExtendScript has no `JSON`, so `host/a8n-json.js` ships a codec. The host
  feature-detects a native `JSON` first, in case Adobe ever adds one. The codec is
  differential-tested against Node's `JSON` over a shared corpus, because a
  divergence would corrupt envelopes in a way no type test would catch.
- `renderFrame` **reads the output directory back** rather than reconstructing
  Adobe's PNG-sequence filename. Adobe's naming has varied; reading the directory
  is not a guess.
- The fake host evaluates the *same* `host/a8n-host.js` in a `node:vm` context,
  with `JSON` removed, so the code path under test is the one production takes.

## Evidence level

| Claim | Level |
| --- | --- |
| Envelope, codec, host dispatch, driver loop, trace, render plumbing | **automated test** against the fake host |
| ES3 JSON codec equals Node `JSON` | **automated test**, differential |
| `AfterFX.exe -r <jsx>` executes a script in AE | **not verified here** — `AfterFX.exe` is not installed on this machine |
| `osascript … DoScript` executes a script in AE | **not verified here** — no macOS host |
| `RenderQueue` PNG-sequence settings | **not verified here** — written to the documented API |
| `ADBE Effect Parade` match-name lookup for third-party effects | **not verified here** — needs a real plugin installed |

The first two rows are proven. Everything requiring an After Effects installation is
written to the documented API and unproven; see `docs/verification.md` for what to
run on a real host to close that gap.
