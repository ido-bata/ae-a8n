# CLI contract

- T003 (Issue #54)
- Applies to both macOS and Windows. Platform differences appear as diagnostic
  codes and human steps, never as different commands or flags.

## 1. Commands

```text
ae-a8n doctor   [--json] [--target <name>] [--verbose]
ae-a8n setup    [--json] [--target <name>] [--yes] [--resume] [--dry-run]
ae-a8n test     [--json] [--target <name>] [--timeout <ms>] [--keep] -- <command...>
ae-a8n recover  [--json] [--target <name>] [--run <id>] [--dry-run] [--force]
ae-a8n report   [--json] [--run <id>] [--format <summary|json|junit>]
```

- `--target <name>` selects a configured target (a saved platform + host pair).
  Default: the single configured target, or the local platform when none is.
- `--yes` permits steps marked "automatable, but changes the machine". It never
  permits an action that requires OS/Adobe consent; those remain human.
- `--dry-run` performs probes and prints the plan; it changes nothing.
- `--keep` keeps the run directory after a passing run (default: keep on
  failure, keep for `--json`).
- `test` requires `--` before the test command, so panics/typos in the test
  command are not parsed as `ae-a8n` flags.

## 2. Exit codes

Every command uses this table. The code is part of the contract.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `ok` | The command's own goal was reached |
| 1 | `failed` | Operational failure not covered below (I/O, unexpected exception) |
| 2 | `usage` | Bad flags, missing `--`, unknown command |
| 3 | `blocked` | Environment cannot run the command; `doctor`/`setup` codes say why |
| 4 | `refused` | Safety refusal: ambiguous target, another AE running, unowned AE, unproven job |
| 5 | `test-failed` | The test command ran and reported a failure |
| 6 | `unknown` | Timeout or indeterminate outcome; the run is quarantined |
| 7 | `setup-incomplete` | Setup needs a human action; state is saved and resumable |

`test` maps its report to the highest-severity verdict: any `fail` → 5; else
any `unknown`/`blocked` → 6; else 0. A `blocked` that is a safety refusal is 4,
not 6.

## 3. Output rules

- With `--json`, stdout contains **exactly one** JSON document and nothing
  else. Progress, warnings and human text go to stderr.
- Without `--json`, stdout is human-readable; `report.json` remains the
  machine-readable source of truth.
- Secrets never appear in either stream: no passwords, tokens, Adobe IDs, or
  full environment dumps.
- Paths are printed as given; the runner never rewrites a user path.

## 4. Common JSON envelope

```json
{
  "schemaVersion": "1.0",
  "command": "doctor",
  "status": "ok | blocked | refused | failed | unknown",
  "exitCode": 0,
  "startedAt": "2026-11-10T12:00:00.000Z",
  "finishedAt": "2026-11-10T12:00:01.234Z",
  "platform": {
    "os": "darwin | win32",
    "release": "27.0.0",
    "arch": "arm64 | x64",
    "backend": "macos-session-agent | windows-remote-agent"
  },
  "package": { "name": "@ido-bata/ae-a8n", "version": "0.2.0-next.0", "commit": "…" },
  "target": { "name": "local-test-user", "isolation": "session | remote-host" },
  "checks": [],
  "nextActions": []
}
```

`checks[]` is the diagnostic list described below. `status` is the aggregate;
`exitCode` always matches §2.

## 5. Diagnostic codes

Format: `A8N-<AREA>-<NNN>`. Areas: `ENV`, `SESSION`, `PERM`, `AE`, `JOB`,
`SEC`, `EXT`, `RELEASE`.

Each check:

```json
{
  "code": "A8N-SESSION-002",
  "severity": "info | warning | blocker",
  "title": "No GUI session for the test user",
  "detail": "user test (uid 502) has no Aqua session",
  "remedy": "Log test in once with fast user switching, then switch back.",
  "remedyKind": "human | automatic | none",
  "evidence": { "uid": 502, "asid": null }
}
```

Codes are append-only. A code's meaning does not change between minor versions.
`severity` describes how a check affects the aggregate `status`; whether a run
is *refused* (exit 4) or *quarantined* (exit 6) is decided by the runner from
the check plus the run state, not from the severity alone.

Initial set:

| Code | Severity | Meaning |
| --- | --- | --- |
| `A8N-ENV-001` | blocker | Unsupported OS/architecture |
| `A8N-ENV-002` | blocker | Node version below the package floor |
| `A8N-ENV-003` | blocker | After Effects not found |
| `A8N-ENV-004` | warning | Multiple AE installations; the selected one is named |
| `A8N-SESSION-001` | blocker | Target account does not exist |
| `A8N-SESSION-002` | blocker | Target account has no GUI session |
| `A8N-SESSION-003` | blocker | Target session is the console session |
| `A8N-SESSION-004` | blocker | Session identity changed during the run |
| `A8N-SESSION-005` | blocker | The controller cannot enter the target session |
| `A8N-SESSION-006` | blocker | The named remote host is this controller's own machine |
| `A8N-PERM-001` | blocker | Screen Recording not granted in the target session |
| `A8N-PERM-002` | blocker | Accessibility not granted in the target session |
| `A8N-PERM-003` | blocker | AE script file/network permission off |
| `A8N-PERM-004` | blocker | Adobe sign-in required in the target session |
| `A8N-PERM-005` | blocker | The channel key file is readable by another account (nothing sent) |
| `A8N-PERM-006` | blocker | The channel directory is writable by another account (nothing sent) |
| `A8N-AE-001` | blocker | Another AE is running on the target (run refused) |
| `A8N-AE-002` | blocker | The AE is not owned by this run (lifecycle refused) |
| `A8N-AE-003` | blocker | The script destination could not be proven (nothing sent) |
| `A8N-AE-004` | warning | A timed-out script may still be running (run quarantined) |
| `A8N-JOB-001` | blocker | Job or result file failed ownership/integrity checks |
| `A8N-JOB-002` | warning | Prior run left a lock or quarantine state |
| `A8N-JOB-003` | blocker | Job or result is not from a trusted issuer (nothing executed/accepted) |
| `A8N-JOB-004` | blocker | Job, result or payload exceeds its size limit (nothing parsed) |
| `A8N-JOB-005` | blocker | The agent is not alive in an interactive session (nothing sent) |
| `A8N-JOB-006` | blocker | The agent is not the host, user or version the target names (nothing sent) |
| `A8N-JOB-007` | blocker | The channel root is not reachable from this controller (nothing sent) |
| `A8N-SEC-001` | blocker | A licence/sign-in/permission dialog is present (never pressed) |
| `A8N-EXT-001` | blocker | Extension registration is invalid (duplicate/unnamed method) |
| `A8N-RELEASE-001` | blocker | Package version already exists on the registry |

## 6. `doctor`

Read-only. Never creates an account, launches AE, writes TCC, sends an Apple
Event, or elevates. Every check must be safe to run on a machine where the user
is working.

Output: the common envelope with `command: "doctor"` and `checks[]`.
Exit: 0 when no `blocker`; 3 otherwise. A `refused`/`unknown` severity does not
by itself fail `doctor` (it describes a live run, not the environment) but is
reported.

## 7. `setup`

Steps are a list; each is `done`, `skipped`, `needs-human`, or `failed`.

```json
{
  "schemaVersion": "1.0",
  "command": "setup",
  "status": "ok | setup-incomplete | blocked",
  "steps": [
    {
      "id": "macos.create-test-user",
      "state": "needs-human",
      "reason": "Creating an OS account requires an administrator.",
      "action": "Run: sudo sysadminctl -addUser …  (exact command shown)",
      "automatable": false
    }
  ],
  "stateFile": "/Users/…/.ae-a8n/setup-state.json"
}
```

Guarantees:

- `--dry-run` changes nothing and prints the same steps with `state: "planned"`.
- Re-running after success performs no destructive action (idempotent).
- The state file records only step ids and outcomes, never credentials.
- Interrupting mid-step leaves the state file consistent; `--resume` continues.
- No absolute Node path, UID, username or home directory is written into the
  package or into a file that ships with it.

## 8. `test`

Runs the given command inside the target session with the environment
variables documented in `quickstart.md`, then collects:

```json
{
  "schemaVersion": "1.0",
  "command": "test",
  "status": "ok | test-failed | unknown | refused | blocked",
  "runId": "20261110T120000Z-4f2a8c11",
  "target": { "name": "…", "isolation": "session", "identity": { "uid": 502, "asid": 109086 } },
  "verdicts": [ { "id": "…", "verdict": "pass | fail | blocked | unknown", "message": "…" } ],
  "artifacts": { "manifest": "…", "report": "…", "trace": "…", "files": [] }
}
```

**Decision (T027):** the run's per-check verdicts are the field `verdicts[]`,
not `checks[]`. `checks[]` is fixed by §4 as the diagnostic list (code,
severity, remedy), and a test outcome has none of those fields; naming both
`checks` would make one key carry two shapes. `report.json` stores the same
`verdicts[]`. `target.identity` is present only when a session was opened, so a
run stopped at `doctor`'s blockers reports no identity rather than a guessed
one. The host/ownership facts named in the earlier draft live in
`manifest.json` (`adapter`, `identity`, per-platform run manifest), not in the
envelope; `recover` and `report` read them from there.

`runId` has the same shape on both platforms — `YYYYMMDDTHHMMSSZ-<8 hex>` —
and is the name of the run directory under the state root.

- The run is refused before launching AE if `doctor`'s blockers are present.
- The lock is exclusive per target. A second `test` on the same target exits 4
  or waits, never runs concurrently.
- A timeout or an unprovable outcome sets `status: "unknown"` and quarantines
  the run; the next run refuses until `recover` clears it (T034–T039; until
  then the remedy text names the files by path and calls that a manual step).
- The test command's own stdout/stderr are captured into the run directory and
  summarized on stderr, not mixed into the JSON document.
- A run that reaches a diagnostic `blocker` exits 3 without opening a session;
  a safety refusal (unproven destination, another AE running) exits 4; a
  command that exits non-zero is `test-failed` (5). Only timeout, an
  uncapturable output and an exception with no diagnostic code are `unknown`.

## 9. `recover`

Inspects one run (default: the quarantined one) and reports what it found.
Without `--force`, it performs only safe cleanup: release a lock whose owner is
gone, mark an incomplete run `unknown`, never quit an unowned AE, never re-send
a script.

```json
{
  "schemaVersion": "1.0",
  "command": "recover",
  "runId": "…",
  "findings": [
    { "code": "A8N-JOB-002", "action": "reported | cleared | refused | recorded", "detail": "…", "remedy": "…" }
  ],
  "cleared": false,
  "nextActions": [ { "kind": "human", "code": "A8N-JOB-002", "action": "…" } ]
}
```

`nextActions[]` keeps the common envelope's shape (§4: `kind`, `code`,
`action`) rather than the `detail` key of an earlier draft, so a reader parses
one shape across all five commands.

**Decision (T038):** a quarantine record is *reported*, never cleared, unless
`--force` is passed: it exists because nobody could prove the run had ended,
and clearing it silently would let a possibly-running After Effects be reused
by the next run. `--force` is the human's explicit statement that they checked.
A lock whose recorded pid is gone is safe to release without `--force`, because
nothing can be holding it. An unreadable lock or quarantine record is never
deleted; `recover` exits 6 and names the file for a human.

`recover` never quits After Effects, never re-sends a command, and never
deletes a run directory; the only file it writes is a `report.json` for an
incomplete run, recording it as `unknown` rather than as a pass.

## 10. `report`

Reads a run directory and prints or re-renders its report. It never runs AE and
never modifies the run.

- `--format summary` (default): human table.
- `--format json`: the stored `report.json`, unchanged.
- `--format junit`: derived for CI; the mapping is documented and lossy only in
  fields CI does not use.
- A missing or malformed file is an error (exit 1), never an empty success.

**Decisions (T094).**

- **Default run.** `--run` names a run id; without it the most recent run under
  `~/.ae-a8n/runs` is read (run ids sort chronologically). A directory that is
  not named like a run id is not a candidate: a stray folder never becomes the
  "latest run".
- **A run with no report is unknown, not empty.** The run directory exists but
  `report.json` does not: exit 1, and the message names `ae-a8n recover`, which
  is the command that records such a run as `unknown`. `report` does not write
  that record itself — a reader must stay a reader.
- **`--json` and `--format` are exclusive.** `--json` prints the common
  envelope (with `runId`, `verdicts`, `report` and `artifacts`); `--format`
  prints the rendered document and no envelope. Both at once is a usage error
  (exit 2): one stream cannot be a document and an envelope about it.
- **`--format json` is byte-for-byte.** It prints the stored file, not a
  re-serialisation, so a script that hashes or compares it keeps working.
- **`report` exits 0 when it read the run.** The run's own verdict lives in
  `report.status` and in the JUnit attributes; the command's goal is to read.
  A reader that exited 5 for a failing run would make "I can read this" and
  "the test failed" the same signal.
- **JUnit mapping.** One `<testcase>` per verdict, `classname="ae-a8n"`:
  `pass` → no child element, `fail` → `<failure>`, `blocked`/`unknown` →
  `<error>`. An indeterminate run is an error in CI, never a pass. Per-verdict
  timing is not recorded, so `time` is omitted rather than invented.
- **The run id is validated before it reaches the filesystem.** `--run` must
  match the run-id format (`YYYYMMDDTHHMMSSZ-<8 hex>`); anything else, including
  a path fragment, is a usage error. This applies to `recover` too.

## 11. Versioning

The CLI contract follows the package's semver. `schemaVersion` is independent:
an additive field does not bump it; removing/renaming a field or changing an
exit code does. Readers reject an unknown major version.
