# Real Windows 11 host — 2026-11-10

T092 evidence. Every row below was run on the host described here, through
`herdr` over the network, not on a mock and not in CI.

**Nothing in this file says Windows "works".** It says which gate each row
reached, on which commit, and what is still blocked. `verified on real host`
is claimed only where After Effects itself was driven — which is no row yet,
because AE was not running and starting it needs a human decision (§5).

## 1. Host identity

| | |
| --- | --- |
| Machine | `UUU` (Windows 11 Home Insider Preview, build `29704`, x64) |
| Account used | `UUU\basic`, session **1**, and it is also the console user |
| Access | `herdr --machine Windows`, over the network; PowerShell 7.6.3 |
| Node / npm | v24.22.0 / 11.19.1 (native Windows; no WSL) |
| After Effects | **not running** (`Get-Process AfterFX` = 0). Installed: 26.0 and 26.5, both `D:\4_apps\adobe`, each registered in the 64-bit and 32-bit uninstall hives |
| Date | 2026-11-10 |
| Source SHAs | gate and Windows backend: `74@d6d24fc`; packaged CLI: `86@79d8ab1` |
| Package tarball | `ido-bata-ae-a8n-0.1.0-alpha.1.tgz`, sha256 `651b2f27c283743b2524e8bb7d7c6fd43b14fcb12e0d90f368e714a71a8015c7` |

Two source SHAs, because the Windows backend and the CLI are on separate
ticket branches that are not yet integrated: `74` carries the Windows
backend and does not have `src/cli`, `86` carries the CLI and `bin` and is
what was packed. Anything below marked **(package)** was measured from the
installed tarball, not from a checkout.

## 2. Matrix

| # | Row | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Toolchain bootstrap (`npm ci`, `npm run build`) | **PASS** | exit 0 on `74@d6d24fc` and on `86@79d8ab1` |
| 2 | Quality gate `npm test` (`mise run check`'s test half) | **PASS** | `74@d6d24fc`: 46 files, 729 passed, 5 skipped (734); POSIX-only checks printed their skip reason |
| 3 | Windows-only test defects | **FAIL, then fixed** | 3 defects, found here and nowhere else; see §3 |
| 4 | `npm pack` and clean-consumer install **(package)** | **PASS** | `86@79d8ab1`; installed into an empty `%TEMP%` project with `npm install <tarball>`; `node_modules/.bin/ae-a8n.cmd` linked |
| 5 | `ae-a8n --version` **(package)** | **PASS** | exit 0, `ae-a8n 0.1.0-alpha.1` |
| 6 | `ae-a8n doctor --json` **(package)** | **PASS** — the refusal is the result | exit 3; `status: blocked`; one finding: `A8N-SESSION-003` `Target session is the console session`, `evidence.currentUser` = `evidence.consoleUser` = `UUU\basic`, remedy `human`; `platform` = `win32 10.0.29704 x64`, `backend: windows-remote-host` |
| 7 | `ae-a8n test -- node --version` **(package)** | **PASS** — the refusal is the result | exit 3; `A8N-SESSION-003`, "the target account UUU\basic is also the console user"; nothing was run |
| 8 | `ae-a8n test --json` with no command **(package)** | **PASS** | exit 2, `test needs a command after "--", for example: ae-a8n test -- npm test`; one JSON document on stdout |
| 9 | `ae-a8n report --json` with no runs **(package)** | **PASS** | exit 1, `there is no run under C:\Users\rebui\.ae-a8n\runs; run "ae-a8n test" first. Nothing is being reported as a success.` |
| 10 | `ae-a8n recover --json` with no runs **(package)** | **PASS** | exit 0, `status: ok`, nothing to do |
| 11 | `ae-a8n setup --dry-run --json` **(package)** | **BLOCKED** | exit 7, `setup is not implemented in this increment (issue #56); nothing was run or changed.` The Windows six-step plan exists in `WindowsAdapter` but is not reachable from the CLI on `86@79d8ab1` — the setup wiring was moved off the CLI branch (`562d8f1`) and #56 is open |
| 12 | Isolated, non-console session | **BLOCKED** | needs a second Windows account and one interactive logon; §5 |
| 13 | Non-interference measurement | **UNVERIFIED** | cannot be measured while the only account is the console user. A pass on a temporarily exclusive host is explicitly *not* evidence for this row |
| 14 | Ownership and destination proof against a real AE | **BLOCKED** | needs §12 and a started After Effects; `fake/mock only` today |
| 15 | Recovery from a real crash / dialog | **BLOCKED** | same as §14 |
| 16 | Extension call through the Windows agent (T091) | **BLOCKED** | the agent must poll from the dedicated account; `fake/mock only` today |
| 17 | Any AE start / script / render / quit | **NOT RUN** | AE was not running; starting or quitting it needs the approval in §5 |

Rows 12–17 are the reason `latest` stays blocked (T093).

## 3. Found only on this host

All three are Windows-only and none is visible in CI: the Windows CI job runs
six release-tooling files, not the suite.

1. **`test/windows-agent-main.test.ts` — "refuses a key file readable by group
   or others" hangs.** `key-store.ts` deliberately skips the POSIX mode check on
   win32 (ACLs are the equivalent; verifying them is T092 work), so the agent
   accepts the key and enters its job loop. The test waited for a refusal that
   cannot come: 5.0 s and 15.0 s at two budgets. Fixed by skipping the case on
   win32 with the reason in the test (`a84a06c`).
2. **`test/windows-host.test.ts` — two launch tests reach the real process
   list.** Both build a `win32` transport and call `launch()`, which snapshots
   processes first; the win32 default for that is a synchronous
   `powershell.exe`/CIM query. Measured on this host: **515 ms** idle, past the
   5 s default timeout under the full suite's parallelism. macOS never pays it —
   `powershell.exe` is absent there, so the snapshot throws at once. Both call
   sites now pass the empty list this file's own `winTransport` helper already
   used (`054abc2`).
3. **`npm test`'s second half cannot pass on Windows.** `test/isolated-session.check.mjs`
   drives the macOS `.command` helpers through bash and proves refusals by
   `chmod` plus POSIX mode bits; on Windows the helper cannot start, its output
   is empty, and `ax-grant-all.command applies the same checks` failed on `''`.
   The gate now runs those checks through `scripts/run-isolated-session-checks.mjs`,
   which spawns the same `node --test` on Linux and macOS and prints one line of
   explanation on Windows (`d6d24fc`). 46/46 still pass on macOS.

Rows 1–3 together: before the fixes the suite was `1 failed | 728 passed` plus a
gate failure; after them, `729 passed | 5 skipped` and exit 0.

## 4. What this host cannot show

- Whether a **separate account** exists, can log on, and can hold its own
  session. `qwinsta`/`query session` are unavailable on Windows 11 Home, so
  session identity here comes from `node:os` + the process's own session id and
  the console-user comparison.
- Whether an AE started by the supervisor in another session is reachable at all
  (the whole point of the dedicated-host backend).
- Anything about non-interference. The current account *is* the console user, so
  every isolation gate refuses before AE is touched. That refusal is the correct
  behaviour and it is what rows 6, 7 and 9 above measure.

## 5. Minimal steps to unblock rows 12–17

In order; each needs a human, and 1–2 change this machine's account list.

1. Create a second local Windows account for the test session, and log it in
   once interactively so a session exists to target. (Admin action; approval
   pending.)
2. Grant that account read/execute on the After Effects install and write access
   to the channel root the runner will use. (Approval pending — it widens one
   account's rights on one machine.)
3. Register a logon task so the in-session agent starts in that session, and
   create the channel root with its key file. (Approval pending.)
4. Then: `ae-a8n doctor --target <that account>` (expect no `A8N-SESSION-003`),
   `ae-a8n test -- <a probe>` from the package, then an AE start/probe/quit on
   the *isolated* session, and only after that the extension call (row 16).
5. Non-interference (row 13) is measured by doing 4 while the console user is
   working normally — not on a host taken over for the test.

## 6. How to repeat

```powershell
# gate, Windows backend
git -C C:\Users\rebui\work\ae-a8n fetch origin +refs/heads/74:refs/remotes/origin/74
git -C C:\Users\rebui\work\ae-a8n merge --ff-only origin/74   # d6d24fc
npm ci; npm test                                               # exit 0

# packaged CLI
git worktree add C:\Users\rebui\work\ae-a8n-86 origin/86       # 79d8ab1
cd C:\Users\rebui\work\ae-a8n-86; npm ci; npm pack
$c = Join-Path $env:TEMP "a8n-consumer"; mkdir $c; cd $c
npm init -y; npm install <path-to-tarball>
npx ae-a8n --version; npx ae-a8n doctor --json        # exit 0 / exit 3
npx ae-a8n test -- node --version                     # exit 3, A8N-SESSION-003
npx ae-a8n report --json; npx ae-a8n recover --json   # exit 1 / exit 0
npx ae-a8n setup --dry-run --json                     # exit 7, not implemented
```

`npx ae-a8n` only resolves because `86`'s `package.json` has
`bin: {"ae-a8n": "./dist/cli.js"}`; the tarball has no `bin` on branches that
do not carry `src/cli`, so a pack from those cannot be invoked by name.
