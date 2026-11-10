# The result that was there and was not seen — 2026-11-10 (T087 evidence, P0)

A job was refused by the agent 3 ms after it was claimed, and the controller
reported a timeout 57 s later. The refusal was in the channel the whole time.
This records what the channel did, how the controller was blind to it, and what
changed.

**Source:** `integration/win-cli` at `002e9a6`.
**Host:** `UUU`, Windows 11, account `basic`, session 1.
**Transport:** `\\100.118.123.62\Users` mounted at `/Volumes/Users`.

## 1. The incident, from the channel's own files

| Item | Value |
| --- | --- |
| controller run | `20261110T125714Z-d66d7203`, ended `unknown` (exit 6) |
| job | `20261110T125800Z-0e4096a1`, `createdAt` `12:58:00.795Z` |
| job manifest | `writer: {host: "UUU", user: ""}` — the empty-writer defect |
| claim | `claimedAt` `12:58:03.655Z`, agent `ae-a8n/UUU/basic/session 1/0.1.0-alpha.1` |
| result | `status: refused`, `code: A8N-JOB-001`, `finishedAt` `12:58:03.657Z` |
| controller deadline | `12:59:00.795Z` (`createdAt + 60000`) |
| controller gave up | `12:59:01.977Z` — 1.18 s after its own deadline |
| margin the result had | **57.1 s** before the deadline |

All three files still exist on the share and name the same job id, so a
different-directory or different-job mix-up is excluded.

## 2. The checks this was asked to make

| Question | Answer |
| --- | --- |
| when the agent published the result | `12:58:03.657Z` (claim 2 ms earlier) |
| when the controller read the result, and what it got | **not recorded** — that build kept no poll evidence. This is why the loop now records it (§4) |
| deadline vs publication | publication was 57.1 s before the deadline |
| clock difference Mac / Windows | bounded by the ssh round trip (1.8–2.6 s per sample); observed offset stayed inside that window in 3 samples, so no skew of the size that could matter |
| SMB visibility right after the mount | reproduced and measured — §3 |
| does `read()` tell "missing" from "broken" | it did: only `ENOENT`/`ENOTDIR` became `null`, anything else threw. The poll loop rethrew what it did not recognise, so a broken channel **aborted the run inside the loop** rather than timing out |
| did the result belong to a different job id or directory | no |

## 3. What the mounted share does — measured from this Mac

The suspect was a negative lookup cached by the macOS SMB client. The
experiments poison the controller's view with one `stat` on a path that is not
there yet, create the file from the Windows side over ssh, and poll from here.

| # | What was missing when the first `stat` ran | Written at | Seen by the controller at | Lag |
| --- | --- | --- | --- | --- |
| 1 | nothing (directory and file both pre-existed) | — | immediately | — |
| 2–3 | the file, inside an existing directory | 2.4 s / 9.4 s | 2.8 s / 11.3 s | 0.4 s / 1.9 s |
| 4–8 | the file, inside an existing directory (5 trials) | ~2.3 s | 2.7–5.2 s | **0.4–2.9 s** |
| 9 | **the job's directory** | 2.3 s | never within 40 s | ≥ 38 s |
| 10 | **the job's directory** | 9.4 s | never within 40 s | ≥ 31 s |
| 11 | **the job's directory**, `readdir` of the parent each poll | 3.0 s | `readdir` saw it at 3.4 s; `stat` at **35.8 s** | 32.8 s |
| 12 | **the job's directory**, no `readdir`; both `stat` and `readFile` tried | 3.0 s | neither within 60 s | **≥ 60 s** |

Two conclusions:

1. The stale answer is attached to the **directory component**, not the file.
   A missing file in an existing directory becomes visible in under 3 s.
2. It is a name-lookup cache, not a `stat` quirk: `open`/`readFile` stayed
   blind exactly as long as `stat` did (trial 12), so "don't stat, just read"
   would not have fixed anything. `readdir` of the parent saw the truth at
   0.3 s, but did not clear the deeper lookup by itself.

That is the incident: the controller's first polls went through
`results/<jobId>/` while the agent had not created it, and the cached "no such
directory" outlived the deadline.

## 4. What changed

- `FileChannel.ensureDirectory`; `submitJob` creates `results/<jobId>/`
  **before** it publishes the job, so no poll walks through a directory that
  does not exist yet. Trials 4–8 measure what this buys: 0.4–2.9 s instead of
  40 s+.
- The poll loop keeps evidence and says it: `polls`, `absent`, `failed`,
  `lastError`, `slowestReadMs`, in the timeout message and in
  `SubmitResult.evidence`.
- A read that throws is a failed observation, not the end of the run — the job
  may already be executing, so the loop keeps polling and reports `unknown`
  with the last error instead of crashing.
- A read that never answers is bounded (`readTimeoutMs`, default 10 s, never
  more than the time left) so it cannot carry the controller past its deadline.
- The deadline is checked before each read; the first read still happens even
  if publishing the job used up a short timeout ("never looked" is not a
  verdict).
- One bounded last look after the deadline. A signed result found there is
  recorded as `lateResult` with its status, exit code and sha256; the run stays
  `unknown`, the target stays quarantined, and **nothing is re-sent**.

Tests: `test/windows-result-visibility.test.ts` — 8 cases: directory before
manifest, a read that fails then recovers, a channel that keeps failing, a read
that never returns, a result on the last poll before the deadline, a result
after it, the at-least-one-read case, and poll accounting.

## 5. On the real host, after the fix

The controller is the new build and the agent is still the packed
`0.1.0-alpha.1` from `18a0a7d`, so this is also a compatibility check.

| Run | What it did | Result |
| --- | --- | --- |
| `20261110T135335Z-b93ac15a` | `node -e "…hello-after-fix…"` | `ok`, exit 0 |
| `20261110T135437Z-6faaa764` | a 6 s command, ~24 absent polls | `ok`, exit 0 |
| `20261110T135858Z-804c5d24` | a 8 s command with `--timeout 3000` | `unknown`, exit 6, `(1 read(s): 1 absent, 0 failed); the job was left in place…`, quarantined |
| `20261110T135950Z-66b49b6e` | the same command while quarantined | `refused`, exit 4 — the quarantine held |

The third row is also where the fix's own regression showed up: with the
timeout shorter than the publish, the loop first reported `0 read(s)` — it had
never looked. That is fixed and pinned by a test.

## 6. Not proven

- The blindness was reproduced on the mount, not by the controller's own
  process; the cache lifetime was observed at 35–60 s and is not documented
  anywhere, so the bound is empirical.
- One trial is not a distribution: 5 trials put the file-path lag at 0.4–2.9 s.
  A longer run of trials would be needed to call that a bound.
- No evidence can reconstruct what a *past* read returned. The loop now records
  it, so a second occurrence is diagnosable rather than argued about.
