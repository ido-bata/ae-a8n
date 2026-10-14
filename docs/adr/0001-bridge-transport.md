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
| `osascript` → `tell application <bundle path>` → `DoScriptFile` | yes | n/a | native | yes | **adopted** (see note) |
| `aerender -r <script>` | yes | native | native | yes | render only; later candidate |
| CEP panel + Node socket | yes | needs a host-side install | needs a host-side install | yes | deferred |
| UXP | no | — | — | — | AE is not a UXP host |

Note (macOS, amended after the first real-host run on AE 26.5x89): the bare
application name `"Adobe After Effects"` does not resolve to AE — osascript
fails to compile with -2741. The transport therefore addresses the discovered
`.app` bundle by path and sends `DoScriptFile` as its raw event (`miscfile`),
with the bundle and script paths passed as `argv` so neither is spliced into
AppleScript source.
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
      ──launches─▶  AfterFX.exe -r <id>.entry.jsx   |   osascript … DoScriptFile
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

## The publication rule

A result is published by **rename within the same directory**, which is atomic:
a reader sees either nothing or a whole envelope. That is a guarantee the
protocol makes and the reader relies on, so it needs a stated failure story,
not an assumption.

The host retries the rename before giving up — on Windows a transient handle
(antivirus, After Effects itself) is the usual cause. If every attempt fails it
writes the result directly instead of discarding a computed result. That write
is **not** atomic, and it is the only way a reader can observe a partial file.

So the reader is defined accordingly: `probeResult` reports three states —
`absent`, `unreadable`, `read` — and **only `read` counts as a result**. A file
that exists but does not parse is *not ready*, not broken. The driver keeps
polling, and only at the deadline does it report, naming the unparseable
result rather than claiming a timeout.

This was a real defect, found in review of the first draft of this branch:

```text
rename fails → direct write → poller reads part of it → ProtocolError
```

Every step of that chain is reachable, and the final error pointed at the
protocol rather than at the publication failure that caused it. `test/publication.test.ts`
executes the whole chain by making `File.rename` fail inside the real host
script, so the guarantee is exercised rather than asserted.

## Evidence level

| Claim | Level |
| --- | --- |
| Envelope, codec, host dispatch, driver loop, trace, render plumbing | **automated test** against the fake host |
| ES3 JSON codec equals Node `JSON` | **automated test**, differential |
| `AfterFX.exe -r <jsx>` executes a script in AE | **not verified here** — `AfterFX.exe` is not installed on this machine |
| `osascript … DoScript` executes a script in AE | **not verified here** — no macOS host |
| `RenderQueue` PNG-sequence settings | **not verified here** — written to the documented API |
| `ADBE Effect Parade` match-name lookup for third-party effects | **not verified here** — needs a real plugin installed |

The first two rows are proven. The rest are unproven, and the unproven set is
larger than this table: it also covers process launch and exit, AE's
`File`/`Folder` semantics, flush and encoding behaviour, what happens when AE is
already running, modal dialogs, plugin load failure, AE crash and hang, and
path representation on each platform.

**`docs/verification.md` is the authority on this**, and the full boundary it
draws — confirmed versus not confirmed — should be read as the measure of what
is still unknown, not as a list of loose ends to be tidied later.
