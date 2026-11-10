# Quickstart

> **Status.** The commands in this file are the target contract
> (`specs/isolated-ae/contracts/cli.md`). Today the package has no `bin`; the
> macOS isolated runner exists only on Draft PR #50, and no Windows backend
> exists. This file is written for the release it specifies, not as a claim
> that the release exists.

## What you need

| | macOS | Windows |
| --- | --- | --- |
| A machine to run tests on | this Mac, with a second OS account | a dedicated Windows 11 PC or VM |
| After Effects | 2026 (26.5x89) | 2026 (26.5x89) |
| Node | 22+ on the machine that runs the CLI | 22+ on the Windows test host |
| Developer machine | command line only | command line only |

The Windows test host is a whole machine (or VM) on purpose. A second user
session on the same Windows PC cannot be kept off the person at the keyboard;
see [research.md](research.md) §3.

## 1. Diagnose

```bash
npx @ido-bata/ae-a8n doctor
```

Every blocker prints one line: what is wrong, why it matters, and the exact
next action. `--json` prints one JSON document for a script; human text is on
stderr.

What `doctor` will never do: create an account, launch After Effects, change a
TCC permission, send an Apple Event, or elevate.

## 2. Set up

```bash
npx @ido-bata/ae-a8n setup
```

The flow is resumable. Steps are one of:

- **automatic** — done for you;
- **needs-human** — the OS or Adobe requires a person. The reason and the exact
  action are printed; nothing is typed for you;
- **skipped** — already done.

Setup never asks for and never stores an Adobe ID or password. It does not
disable SIP, edit the TCC database, or approve a consent dialog.

Manual actions you should expect on macOS:

1. create the test account (an administrator does this);
2. log the test account in once with fast user switching, then switch back;
3. inside that session, allow **Screen Recording**, **Accessibility** and
   **Automation → System Events**;
4. in After Effects, enable **Settings → Scripting & Expressions → Allow
   Scripts to Write Files and Access Network** and allow the staging folder;
5. sign in to Adobe once, in that session, yourself.

On Windows, the equivalent actions happen on the dedicated host, once.

Re-run `setup` after any interruption. A completed step is a no-op.

## 3. Run a test

```bash
npx @ido-bata/ae-a8n test -- ./node_modules/.bin/vitest run
```

`test` runs the command inside the isolated session and writes, under the run
directory:

```text
manifest.json   what ran, with hashes, versions and identities
report.json     pass / fail / blocked / unknown per verdict
trace.jsonl     ordered events, including refusals
artifacts/      PNGs and other outputs
```

Exit codes: `0` pass, `5` test failed, `4` refused for safety, `6` unknown and
quarantined, `3` environment blocked. The full table is in
`contracts/cli.md` §2.

## 4. After a failure

```bash
npx @ido-bata/ae-a8n report          # read the last run
npx @ido-bata/ae-a8n report --format junit   # the same run, for CI
npx @ido-bata/ae-a8n recover         # inspect and safely clear a stuck run
```

`recover` will not quit an After Effects it does not own, re-send a timed-out
script, or dismiss a licence dialog. If it cannot decide, it says so and leaves
the run quarantined. A quarantine record is cleared only when you pass
`--force`, after you have checked that nothing from that run is still working.

## 5. Use it from your own project

```ts
import { AfterEffects } from "@ido-bata/ae-a8n";

const ae = await AfterEffects.launch({ hostScript: "./.ae-a8n/host.generated.js" });
const scene = await ae.call("yourpack.buildScene", { name: "E2E" });
```

Your host methods are built into the host script ahead of time:

```bash
npx @ido-bata/ae-a8n extension build --extension ./host-extension.ts --out ./.ae-a8n/host.generated.js
```

The build validates ES3 and the method names; nothing is evaluated at call
time. See `contracts/extensions.md`.

## Troubleshooting

| Symptom | Meaning | Next |
| --- | --- | --- |
| `A8N-SESSION-002` | the test account is not logged in | log it in once with fast user switching, then switch back |
| `A8N-PERM-001/002` | Screen Recording / Accessibility missing in that session | grant it inside the session, then re-run `setup` |
| `A8N-PERM-003` | AE scripting permission is off | enable it in AE settings |
| `A8N-AE-001` | an AE is already running on the target | quit it; the runner will not quit it for you |
| `A8N-AE-003` | the script destination could not be proven | nothing was sent; collect the trace and open an issue |
| `A8N-SEC-001` | a licence/sign-in dialog is open | handle it yourself; the runner will not press it |
| `A8N-JOB-002` | a previous run is quarantined | `ae-a8n recover` |
