# Read-only AE in-process dispatch proof

Tracking: [#98](https://github.com/ido-bata/ae-a8n/issues/98). Architecture: [#97](https://github.com/ido-bata/ae-a8n/issues/97).

**Not a release feature. Not a general remote bridge. Do not use with production projects or grant access to untrusted channel writers.**

## What it tests

A human activates a small ES3 script inside an already open After Effects. The script polls a user-private local channel with `app.scheduleTask` and answers exactly one method: `app.version`. Node submits request/result files and does not use Apple Events, `AfterFX.exe -r`, GUI input, `sudo`, or `launchctl` **for each request**. Only the AE itself reads the request and produces the answer.

This does **not** establish host-process ownership, non-interference, unattended startup, automatic setup, stable polling under load, remote security or full API compatibility.

## Manual test (macOS and Windows)

Use a disposable macOS/Windows user account with AE installed. In this repository, Node >=22:

```sh
node scripts/inprocess-proof.mjs prepare "<absolute-path-to-private-empty-channel>"
```

The program prints `<channel>/bridge-start.jsx`. In the **already running AE**, choose **File → Scripts → Run Script File** and select it. Adobe's normal *Allow Scripts to Write Files and Access Network* preference must be enabled by the human as required; never modify permission databases.

From the same OS user account, run twice:

```sh
node scripts/inprocess-proof.mjs ping "<same-channel>" 8000
node scripts/inprocess-proof.mjs ping "<same-channel>" 8000
```

Each result must contain a different `requestId` and a genuine `aeVersion`. Check AE's own version, system focus, TCC prompts on macOS, activity/CPU during host load, and the files in `inbox`/`outbox`. Record exact AE build, OS, source SHA and timestamps in the evidence directory. Do **not** mark a fake reply as a real AE result.

To stop the proof, **quit AE normally**. The proof dispatcher does not quit AE, change projects, grant permissions, run a caller's JavaScript, or open a network listener. Do not activate twice in one AE session. Delete the channel only after AE has exited and no run is active.

## Negative cases

- A ping with no AE listener must time out as **UNKNOWN** without retry. It may leave a request file for later refusal by its deadline. Do not treat it as a successful connection.
- A non-private directory (POSIX group/other permissions) is refused; on Windows, POSIX mode is insufficient proof of ACLs, so this remains a **local, read-only experiment**, not a secure production dispatcher.
- AE accepts only the fixed `app.version` method, exact request id/token and an unexpired deadline. An invalid request is refused and not executed.
- Duplicate ids cannot be created by Node; AE renames a job to `.claimed` before evaluating it. A failed/late reply never triggers an automatic re-send.

## Acceptance threshold

This experiment graduates only if two successive calls succeed on **real macOS and Windows After Effects** with no per-operation TCC prompt, console focus theft or unauthorized side effects, and if shutdown/malformed/duplicate handling is observed. If not, document the failure and evaluate a persistent extension-host alternative; do not extend the cross-user sudo/launchctl workaround.

Automated tests use a **fake file responder**, not AE. They only validate the Node/ES3 boundary and basic protocol expectations.
