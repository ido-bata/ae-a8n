## 1. [HIGH] src/cli/args.ts:350-359 (bug)

The value is taken from the next token with no check that it is not itself a flag, so a forgotten value silently swallows the following option instead of being a usage error: `setup --channel --dry-run` sets `channel = "--dry-run"` and leaves `dryRun` false — setup then changes the machine although the user explicitly asked for a dry run; `doctor --target --json` loses `--json`, `doctor --target --help` runs doctor instead of showing help, and `recover --channel --force` loses `--force`. `agent-main.ts`'s parser already refuses values starting with `--` (`value.startsWith("--")` → "needs a value"); applying the same rule here keeps this parser as strict as its own header comment claims.

```
const value = inline ?? rest[index + 1];
    if (value === undefined) {
      return usage(`${name} needs a value`, wantsJson || state.json);
    }
    if (inline === undefined) {
      index += 1;
    }
    if (value.length === 0) {
      return usage(`${name} needs a non-empty value`, wantsJson || state.json);
    }
```

Suggestion:
```
if (inline === undefined) {
      index += 1;
    }
    if (value.length === 0) {
      return usage(`${name} needs a non-empty value`, wantsJson || state.json);
    }
    if (value.startsWith("--")) {
      return usage(`${name} needs a value`, wantsJson || state.json);
    }
```

## 2. [HIGH] src/driver/driver.ts:429-431 (bug)

A quarantined recovery is reported as an ordinary timeout. `RecoveryOutcome.code` (`A8N-SEC-001`) and `outcome: "quarantined"` / human-only refusal are dropped here: the caller distinguishes the outcome only by `recovered !== undefined`, so the run rethrows the original `TimeoutError` (which `api/contextualise` then wraps as a generic `AfterEffectsError`). Verified: the code survives only in the `session.recover` trace row — nothing in `src/runner`, `src/api` or `src/cli` reads it back — while `recovery.ts` promises "the run reports `A8N-SEC-001`". A user then sees a plain timeout and is invited to retry the exact state the design says must stop for human inspection. Suggestion: when `outcome.code` is set (or `outcome === "quarantined"`), throw an error carrying `code` instead of returning undefined — `test-run.ts`'s `codeOf()` already classifies adapter errors by an `error.code` property, and `MacSessionError` uses this pattern.

```
if (!outcome.recovered) {
      return undefined;
    }
```

Suggestion:
```
if (!outcome.recovered) {
      if (outcome.code !== undefined) {
        // The quarantine must reach the caller, not only the trace row.
        throw new RecoveryQuarantinedError(outcome.code, outcome.evidence);
      }
      return undefined;
    }
```

## 3. [HIGH] src/platform/windows/acl.ts:169-170 (security)

Fail-open in the owner allowlist: `owner` comes from `currentUser()` in key-store.ts, which is `userInfo().username` — an *unqualified* name on Windows (e.g. `alice`). The suffix test `name.endsWith(`\\${ownerName}`)` therefore accepts `CONTOSO\alice` when the key's owner is the local account `alice` — two different security principals, one name. On a domain-joined host (exactly the SMB-share deployment this targets) a read grant to a domain account that merely shares the owner's name returns `{ok: true}`, breaking the module's stated property that "no account outside those can read the key". Compare qualified names: derive the owner as `<machine-or-domain>\<username>` (or resolve SIDs via `whoami /user`), and at minimum require the entry's qualifier to equal the owner's machine/domain rather than accepting any qualifier.

```
const name = normalise(entry.principal);
    return name !== ownerName && !name.endsWith(`\\${ownerName}`);
```

Suggestion:
```
const name = normalise(entry.principal);
    // The owner is an unqualified name from `userInfo().username`; a suffix
    // match would accept `CONTOSO\alice` for the local account `alice`.
    // Accept only the owner's own qualification (local machine or its
    // domain), or compare SIDs instead of names.
```

## 4. [HIGH] src/platform/windows/acl.ts:189-190 (security)

Fail-open against this function's own stated property: only principals on the hard-coded SHARED list are refused, so a write grant to a domain group (e.g. `CONTOSO\Domain Users`) or an arbitrary local account returns `{ok: true}` — while the docstring promises the channel "must not be writable by accounts outside the two that use it" and the project rule is fail-closed. Unlike `keyFileAclVerdict`, which takes the `owner` and treats unknown accounts as foreign, this function receives no trusted-account set, so it cannot implement its own check; comms.ts is the only caller and applies no second filter, so on a real host a channel writable by any other account passes the sticky-bit-equivalent check unchallenged. Pass the controller/agent accounts in (mirroring the `owner` parameter) and refuse any other writable principal; when the trusted set is unknown, refuse — the same rule `keyFileAclVerdict` applies for a null owner.

```
export function channelAclVerdict(entries: readonly AccessControlEntry[]): AclVerdict {
  const open = entries.filter((entry) => isShared(entry.principal) && hasWrite(entry.rights));
```

Suggestion:
```
export function channelAclVerdict(
  entries: readonly AccessControlEntry[],
  trusted: readonly string[] | null,
): AclVerdict {
  const trustedNames = trusted === null ? null : trusted.map(normalise);
  const open = entries.filter((entry) => {
    if (!hasWrite(entry.rights) || isPrivileged(entry.principal)) {
      return false;
    }
    if (trustedNames === null) {
      return true;
    }
    const name = normalise(entry.principal);
    return !trustedNames.some((t) => name === t || name.endsWith(`\\${t}`));
  });
```

## 5. [HIGH] src/platform/windows/agent.ts:336-345 (security)

The session marker is the one protocol document written without authentication, and the random `secret` it carries is never checked: `verifySessionMarker` (session-marker.ts) compares only `runId`, `jobId` and the agent identity — all of which any channel reader can copy from `job.json` and the presence file. So destination/ownership proof reduces to name matching that any writer to `results/<jobId>/` can forge, directly contradicting this module's own invariant in auth.ts ("a writer without the secret can still write a file, but not one either side will act on") and the marker header's claim that the secret makes it "cannot be predicted or replayed from public facts". Sign the marker with the channel `key` already in scope here (same HMAC pattern as claims/results/presence) and have the verifier check it, or have the controller challenge the secret before treating the destination as proven — otherwise a planted marker turns a fail-closed "unproven" into "proven" for the quit/ownership gate.

```
await writeSessionMarker(
    channel,
    createSessionMarker({
      runId: job.runId,
      jobId,
      agent: identity,
      now,
      random: options.random ?? randomBytes,
    }),
  );
```

Suggestion:
```
// The marker is acted on by quit/close paths, so it must be attributable:
  // sign it with the channel key like every other document here, and have
  // `verifySessionMarker` check the signature (or the secret) instead of
  // only the names a channel reader can already see.
  await writeSessionMarker(
    channel,
    createSessionMarker({
      runId: job.runId,
      jobId,
      agent: identity,
      now,
      random: options.random ?? randomBytes,
    }),
    key,
  );
```

## 6. [HIGH] src/platform/windows/runner.ts:705-708 (bug)

For a `--host` target the adapter is constructed with `remote`, but `recover()` still runs `WINDOWS_RECOVERY_COMMAND` through the local `#probeRunner` (select.ts wires a local `SpawnCommandRunner` regardless of `remote`). On a Windows controller this reports the controller's own `tasklist` output as the host's state — potentially a false "no AfterFX.exe was running; Nothing to do" while the host is actually stuck — and on a non-Windows controller every command fails to start. `#prepare` deliberately substitutes a `ChannelCommandRunner` for remote targets and refuses local answers (A8N-JOB-007); `recover()` needs the same substitution, or an explicit refusal when `remote` is set and `simulatedHostProbe` is false.

```
async recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    let result: CommandResult;
    try {
      result = await this.#probeRunner.run(WINDOWS_RECOVERY_COMMAND);
```

Suggestion:
```
async recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    let result: CommandResult;
    const runner = await this.#recoveryRunner(); // local SpawnCommandRunner, or ChannelCommandRunner for a remote target, or a refusal
    try {
      result = await runner.run(WINDOWS_RECOVERY_COMMAND);
```

## 7. [HIGH] src/runner/test-run.ts:253-255 (bug)

Fail-open race: the quarantine is read before the lock is taken, so its check is not under the lock. A concurrent run that quarantines the target (it writes the record while holding this same lock, then releases it) between this read and `acquireTargetLock` is never seen here — the new run then starts on a quarantined target, violating the contract's "the next run refuses until recover clears it" (contracts/cli.md §8) and the notice this file itself emits ("nothing will run until a recovery clears it"). The later `writeQuarantine` would also overwrite the other run's record. Re-read `readQuarantine` after the lock is acquired (inside the `try`, before `probe`) and refuse the same way if a record appeared.

```
// 1. A target left in an unknown state is never entered again by guessing.
  const prior = readQuarantine(layout, input.target.name);
  if (prior.quarantined) {
```

Suggestion:
```
// 1. A target left in an unknown state is never entered again by guessing.
  // The authoritative check runs again after the lock is held (see below):
  // this first read is only a fast path, never the guarantee.
```

## 8. [MEDIUM] .github/workflows/ci.yml:118-119 (other)

This new full-suite `windows` job is not registered in `REQUIRED_CHECKS` (scripts/github-rulesets.js, currently `["check", "release-tooling-windows"]` and documented as "ci.yml's Linux and Windows jobs"). Branch protection therefore will not require it: a PR whose `windows` run is red can still merge to main, and the suite this comment says exists to stop Windows-only breakage "reach[ing] a release candidate" only gates at tag time via publish.yml's `verify-windows`. Either add `"windows"` to `REQUIRED_CHECKS` (with the matching github-rulesets test/docs update), or, if the full suite is intentionally advisory at merge time while `release-tooling-windows` stays the required Windows check, say so in this comment — as written, the comment and the required-checks contract disagree about what this job enforces.

```
windows:
    runs-on: windows-latest
```

Suggestion:
```
windows:
    runs-on: windows-latest
```

## 9. [MEDIUM] .github/workflows/ci.yml:145-148 (bug)

On `windows-latest` the default shell for `run:` is pwsh, which does not stop at a non-zero native exit code: `$ErrorActionPreference = 'stop'` covers cmdlet errors only, and the step's result is the `$LASTEXITCODE` of the **last** command. If `host/a8n-host.js` fails to parse but `host/a8n-json.js` passes, this step exits 0 — a false green on the ES3 gate this job's comment says must hold. The Linux `check` job runs the same two checks as one `&&` line under bash `-e`, so it fails properly; make this step fail-fast too (bash on Windows runners is available and there is already `shell: bash` precedent in the `release-tooling-windows` job), or chain with `&&` (pwsh 7 supports it).

```
- name: Check the ES3 host script parses
        run: |
          node --check host/a8n-host.js
          node --check host/a8n-json.js
```

Suggestion:
```
- name: Check the ES3 host script parses
        shell: bash
        run: |
          node --check host/a8n-host.js
          node --check host/a8n-json.js
```

## 10. [MEDIUM] .github/workflows/publish.yml:167-170 (bug)

Same pwsh fail-open as in ci.yml: the default shell on `windows-latest` does not abort on a non-zero native exit code, and the step's exit code is that of the last command. If `a8n-host.js` fails `--check` while `a8n-json.js` passes, this release-gate step reports success. (The Linux `verify` job runs the same checks fail-fast under bash `-e`, so nothing broken ships overall — but this step is a false green as written.) Make it fail-fast: `shell: bash`, or a single line chained with `&&`.

```
- name: Check the ES3 host script parses
        run: |
          node --check host/a8n-host.js
          node --check host/a8n-json.js
```

Suggestion:
```
- name: Check the ES3 host parses
        shell: bash
        run: |
          node --check host/a8n-host.js
          node --check host/a8n-json.js
```

## 11. [MEDIUM] .github/workflows/publish.yml:172-175 (bug)

Same pwsh fail-open as the block above: if `check-packed-package.js` exits non-zero but `check-public-api.js` passes, the step exits 0. The two scripts are independent — `check-public-api.js` does its own `npm pack`/install and never asserts the `REQUIRED_FILES` surface that `check-packed-package.js` checks — so a packing-surface failure (e.g. a missing `dist/platform/windows/runner.js` that still leaves both entry points resolvable) is exactly the kind this masks. The Linux `verify` job runs both fail-fast under bash `-e`, so the gate as a whole still holds, but this Windows step cannot be trusted as written. Chain with `&&` or add `shell: bash`.

```
- name: Verify the tarball is usable as published
        run: |
          node scripts/check-packed-package.js
          node scripts/check-public-api.js
```

Suggestion:
```
- name: Verify the tarball is usable as published
        shell: bash
        run: |
          node scripts/check-packed-package.js
          node scripts/check-public-api.js
```

## 12. [MEDIUM] eslint.config.js:32-34 (maintainability)

`AbortController` is missing from this hand-listed globals set: `scripts/windows-agent.mjs:41` does `const controller = new AbortController();`, and this block's own `files` pattern `scripts/**/*.mjs` matches top-level scripts like it (in minimatch, `**` matches zero directories). With `js.configs.recommended`'s `no-undef` active for these files, `npx eslint scripts/windows-agent.mjs` fails today with `'AbortController' is not defined`, and the failure becomes a `npm run lint` break the moment the lint scope is widened to `scripts/` (the scope fix from the earlier finding). Add `AbortController: "readonly"` to the list — it is a Node global (≥15), same category as the `URL`/`Buffer` entries already here.

```
// The Node globals these scripts use. Listed by hand rather than pulled
      // from a package, so the lint setup stays dependency-free.
      globals: {
```

Suggestion:
```
// The Node globals these scripts use. Listed by hand rather than pulled
      // from a package, so the lint setup stays dependency-free.
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
```

## 13. [MEDIUM] host/a8n-host.js:422-426 (bug)

The GUI fallback this method exists for only recognises dialogs whose static text matches /^\s*ae-a8n:/ (KNOWN_DIALOG_CLASSES in src/driver/recovery.ts, mirrored in src/platform/recovery-policy.ts), but the message is shown verbatim and nothing in the send path — ae.showModalDialog → session.call("ui.alert", …) → this method — adds or requires that marker. A call with any other text (the API accepts any string and its doc comment unconditionally promises "the GUI fallback … closes the dialog") raises a dialog the fallback classifies as unknown: it presses nothing, the run is quarantined with A8N-SEC-001 and After Effects stays blocked until a human clicks it. The only caller in the repo (scripts/isolated-session/ae-e2e.mjs) happens to pass "ae-a8n: close me", which hides the gap. Either guarantee the marker where the dialog is raised, or validate/require it at the API boundary so every dialog this method raises is closable by the fallback.

```
methods["ui.alert"] = function (params) {
    var message = String(requireParam(params, "message"));
    alert(message);
    return { dismissed: true, message: message };
  };
```

Suggestion:
```
methods["ui.alert"] = function (params) {
    var message = String(requireParam(params, "message"));
    // The fallback may only press a measured dialog: its text must carry the
    // "ae-a8n:" marker (KNOWN_DIALOG_CLASSES), so every dialog this method
    // raises is recognisable regardless of what the caller passed.
    var text = /^\s*ae-a8n:/.test(message) ? message : "ae-a8n: " + message;
    alert(text);
    return { dismissed: true, message: message };
  };
```

## 14. [MEDIUM] package.json:50-50 (maintainability)

Lint scope mismatch: the new ESLint block targets `scripts/**/*.mjs` ("the plain-JavaScript runner scripts"), but this command only passes `scripts/isolated-session/`. Three runner scripts added in this release — `scripts/probe-windows.mjs`, `scripts/run-isolated-session-checks.mjs` and `scripts/windows-agent.mjs` — are therefore never linted, and `run-isolated-session-checks.mjs` is executed on every `npm test` (they are also outside `tsconfig.json`, so typecheck does not cover them either). Either add `scripts` to the lint path — together with widening the config block's `files` to `scripts/**/*.{js,mjs}`, since the `.js` scripts are equally outside the TS project and would otherwise hit type-aware rules with no project — or narrow the config block's `files`/comment to `scripts/isolated-session/**` so the intended scope is explicit.

```
"lint": "eslint src test examples scripts/isolated-session --no-error-on-unmatched-pattern",
```

Suggestion:
```
"lint": "eslint src test examples scripts --no-error-on-unmatched-pattern",
```

## 15. [MEDIUM] scripts/check-packed-package.js:148-151 (test)

This exact-match shebang assertion is line-ending fragile on the Windows gates this update adds. `split("\n", 1)[0]` keeps a trailing `\r` when the first line is CRLF-terminated; tsconfig.json/tsconfig.build.json do not pin `newLine` (tsc's default is platform-dependent, so a Windows build emits CRLF), and both new `windows-latest` jobs (ci `windows`, publish `verify-windows`) run this script after a Windows `npm run build`/`prepack` — `npm pack`/`install` preserve the bytes. If `dist/cli.js` starts `#!/usr/bin/env node\r\n`, the gate fails with a message that points at the shebang instead of the line ending, blocking the release for a property that actually holds. Strip a trailing `\r` before comparing, and/or pin `"newLine": "lf"` in tsconfig.build.json so published artifacts are byte-identical regardless of the build OS.

```
const firstLine = readFileSync(binPath, "utf-8").split("\n", 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    fail(`${binRelative} does not start with "#!/usr/bin/env node"`);
  }
```

Suggestion:
```
// tsc's newline defaults to the platform, so a Windows build can emit
  // "#!/usr/bin/env node\r\n"; the property under test is the line, not its
  // ending (see also pinning "newLine": "lf" in tsconfig.build.json).
  const firstLine = readFileSync(binPath, "utf-8").split("\n", 1)[0]?.replace(/\r$/, "");
  if (firstLine !== "#!/usr/bin/env node") {
    fail(`${binRelative} does not start with "#!/usr/bin/env node"`);
  }
```

## 16. [MEDIUM] scripts/isolated-session/dispatch.mjs:314-316 (security)

The result payload is never bound to the job id: `assertResultSession` only checks `session.uid`, so any target-owned file that lands at `resultPath` is accepted as *this* job's outcome. This is exactly the threat the comment above `assertTrustedResult` names ("another local process could leave a plausible-looking file at a guessed job id") — and uid+mode checks do not answer it, because macOS has no protected-hardlinks restriction: a local process can hardlink a **stale** result from an earlier run (results are never deleted here; only `jobPath` is removed) to the new id's path, and it passes `isFile`/`uid`/mode while describing a different job. The agent already binds payloads (`job?.id !== id` is refused before running); the controller should do the same. Check `result.id === id` after parsing, and remove the result file after a successful collection so stale target-owned results stop accumulating as material.

```
const result = JSON.parse(readFileSync(resultPath, "utf-8"));
      rmSync(jobPath, { force: true });
      assertResultSession(result, options.uid);
```

Suggestion:
```
const result = JSON.parse(readFileSync(resultPath, "utf-8"));
      if (result?.id !== id) {
        throw new Error(`the result ${resultPath} says id ${result?.id}, not ${id}; it is not trusted.`);
      }
      rmSync(jobPath, { force: true });
      assertResultSession(result, options.uid);
```

## 17. [MEDIUM] scripts/isolated-session/dispatch.mjs:331-339 (bug)

Cross-file contract mismatch with session-agent.mjs: the agent sets `ok: outcome.error === null`, and `execFile` reports an error for *any* non-zero child exit — so an ordinary failing command arrives here as `ok:false` **with** a numeric `exitCode`. Only genuine agent refusals omit `exitCode` (see the agent's refusal writes). This branch therefore mislabels every test failure as "the job was refused" — muddying the fail-closed audit trail where "refused" is a security-meaningful word — and returns before the stdout/stderr echo at lines 344-349, so a failing native-substrate run never prints the e2e's step log (all `record()` output goes to stdout), and `run-in-isolated-session.mjs` only reads the report when status is 0. The `exitCode === undefined` half of the condition alone identifies a refusal.

```
if (result.ok === false || result.exitCode === undefined) {
        // A refused job is written with `ok: false` and no exit code. Reading
        // that as exit 0 would report the defense as a successful run.
        if (typeof result.error === "string" && result.error.length > 0) {
          process.stderr.write(`[ae-a8n dispatch] the job was refused: ${result.error}\n`);
        }
        process.exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
        return;
      }
```

Suggestion:
```
if (result.exitCode === undefined) {
        // A refused job is written with `ok: false` and no exit code. Reading
        // that as exit 0 would report the defense as a successful run.
        if (typeof result.error === "string" && result.error.length > 0) {
          process.stderr.write(`[ae-a8n dispatch] the job was refused: ${result.error}\n`);
        }
        process.exitCode = 1;
        return;
      }
```

## 18. [MEDIUM] scripts/isolated-session/focus-watch.swift:158-158 (bug)

The key tap's CFRunLoopSource is added to the current run loop, but nothing ever runs that run loop: the sampling loop sleeps with `Thread.sleep`, which does not spin it. Tap callbacks therefore execute only incidentally while `Process.waitUntilExit()` runs the run loop inside the System Events fallback — and not at all on a machine where `NSWorkspace.frontmostApplication` returns non-nil (the fallback then never runs). In that state `KeyWatch.started` is true while `total` stays 0, so the log claims `keys=watched` with zero counts — precisely the false "quiet zero" the header says must never be produced — and events arriving between fallback windows may be delayed or dropped. Sleep by running the run loop instead, so sampling and tap dispatch share a running loop.

```
Thread.sleep(forTimeInterval: interval)
```

Suggestion:
```
RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: interval))
```

## 19. [MEDIUM] scripts/isolated-session/run-in-isolated-session.mjs:145-148 (maintainability)

`readGuiSession`, `consoleUid`, `consoleAsid` and `readOffstageStatus` are duplicated across dispatch.mjs, run-in-isolated-session.mjs and session-agent.mjs, and the copies have already drifted: this `consoleAsid` only guards `uid < 0`, while dispatch.mjs's copy also requires `Number.isInteger(uid)` (so `NaN` here reaches `launchctl print gui/NaN` before failing). The whole point of these helpers is consistent session-attribution evidence for the two dispatch paths; move them into session-rules.mjs (which exists precisely to hold the rules without side effects) so the checks cannot diverge further.

```
function consoleAsid(uid) {
  if (uid < 0) {
    return null;
  }
```

## 20. [MEDIUM] scripts/isolated-session/run-in-isolated-session.mjs:304-308 (bug)

Unconditional `chmodSync(dir, 0o1777)` with no EPERM/ownership fallback, unlike `ensureSharedDir` in dispatch.mjs and session-agent.mjs (which tolerate a directory owned by the other account via `sharedDirIsUsable`/`sharedDirIsUsableForOthers`). The startup order is explicitly allowed to go either way: if the target account created the root first, this controller is not the owner, `chmod` throws EPERM, and the terminal substrate refuses even when the directory is already 1777. Reuse the shared `ensureSharedDir` logic instead of a bare mkdir+chmod.

```
mkdirSync(dir, { recursive: true });
    // The job runs as the other user and writes its own result there, so the
    // directory has to be writable by it: 1777, and not the umask's idea of
    // it (mkdir applies the umask to the mode it is given).
    chmodSync(dir, 0o1777);
```

Suggestion:
```
ensureSharedDir(dir); // mkdir + sharedDirIsUsable check + chmod with EPERM fallback, as in dispatch.mjs
```

## 21. [MEDIUM] scripts/isolated-session/run-in-isolated-session.mjs:458-460 (bug)

The native substrate can never confirm its target session from the console. For `--substrate native`, `offstageStatus` is forced to `null`, so `resolveTargetSession` falls back to `readGuiSession` → `launchctl print gui/<other uid>` — which this change set's own comments and docs/offstage-macos.md (§ items 9/10) record as measured `EPERM` from the console session. `session` is therefore always `null` and `preflight` → `assertTargetSession` throws "uid X has no login session on this Mac. Log that user in…" — telling the operator the opposite of the truth (the account *is* logged in; the controller just cannot read its launchd domain). This is precisely the bug docs/offstage-macos.md item 10 says was fixed *in dispatch.mjs* (read offstage status first, else refuse with launchctl's reason) — but the parent runner refuses one level up, so dispatch's fixed path is never reached. Worse, the remedy text at preflight ("run the native substrate (`--substrate native`)") steers offstage-less users straight into this dead end. Fix: resolve the session via offstage status regardless of substrate (reading status does not require offstage to *run* anything), and/or surface `guiDomainError`'s launchctl reason like dispatch.mjs does instead of the "not logged in" message.

```
const binary = options.substrate === "native" ? "native" : offstageBinary();
  const offstageStatus = binary === "native" ? null : readOffstageStatus(options.user);
  const session = resolveTargetSession(options.user, targetUid, offstageStatus);
```

Suggestion:
```
const binary = options.substrate === "native" ? "native" : offstageBinary();
  // The offstage *status* is needed for session resolution on every substrate,
  // native included: from the console, launchctl print gui/<other uid> is EPERM,
  // so offstage's in-session answer is the only channel that works there.
  const offstageStatus = readOffstageStatus(options.user);
  const session = resolveTargetSession(options.user, targetUid, offstageStatus);
```

## 22. [MEDIUM] scripts/isolated-session/run-in-isolated-session.mjs:473-478 (bug)

`--substrate` is never validated against the three documented values, so a typo (e.g. `--substrate termnal`) silently falls through to `runOffstage` instead of refusing — an ambiguous input that proceeds rather than fails closed, and the failure mode (offstage required/available or not) hides the typo entirely. Validate in `parseArgs`/`preflight` against `terminal | offstage | native`. Note this nested ternary is also disallowed by the project's style rules; an if/else-if chain over the validated value satisfies both points.

```
const status =
    options.substrate === "native"
      ? runNative(options, targetUid)
      : options.substrate === "terminal"
        ? runTerminal(options, targetUid)
        : runOffstage(options);
```

Suggestion:
```
if (!["terminal", "offstage", "native"].includes(options.substrate)) {
    throw new Error(`unknown substrate "${options.substrate}"; pass terminal, offstage or native`);
  }
  let status;
  if (options.substrate === "native") {
    status = runNative(options, targetUid);
  } else if (options.substrate === "terminal") {
    status = runTerminal(options, targetUid);
  } else {
    status = runOffstage(options);
  }
```

## 23. [MEDIUM] scripts/isolated-session/session-agent.mjs:199-199 (bug)

`writeResult` failures are unguarded at this call site and at the two catch-block calls above (the parse-error and `assertJobSession` refusals): a rename hitting EPERM (a foreign file already at the result path in the sticky 1777 directory — a case `writeResult`'s own comment calls out) or a disk/quota error propagates out of the poll loop and out of the top-level `await main()`, killing the agent and silently stopping all job processing for the isolated session. Only the startup banner write is wrapped in try/catch. Guard the per-entry body so the agent logs the failure, marks the id as handled (so a job whose result publish failed is never re-executed on the next poll), and keeps polling.

```
await runJob({ id, job, resultPath, logs, session });
```

Suggestion:
```
try {
        await runJob({ id, job, resultPath, logs, session });
      } catch (error) {
        // The command may already have run: record the id so the next poll
        // does not execute it a second time, and keep the agent alive.
        ignored.add(entry);
        process.stderr.write(
          `[ae-a8n session agent] could not publish the result for ${id}: ${
            error instanceof Error ? error.message : String(error)
          }. The job is not re-run; the controller will time out.\n`,
        );
      }
```

## 24. [MEDIUM] scripts/isolated-session/session-agent.mjs:288-292 (bug)

No timeout is applied to the job, and none is carried in the job payload — dispatch.mjs publishes only `{id, command, cwd, session}`; its `--timeout` bounds only the controller's own poll. A hung child (e.g. AE quit stuck on a dialog, a render that never returns) blocks this single poll loop forever: no result file is ever written, no later job is processed, and the child — potentially holding After Effects open — is never killed, so subsequent runs then fail preflight with "After Effects is already running" until someone kills it by hand. The controller times out with "no result was produced" and the agent stays stuck. Pass a deadline in the job payload and give `execFile` a `timeout` (plus `killSignal`), writing a distinct timeout result on expiry.

```
const outcome = await new Promise((done) => {
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd, env: { ...process.env, ...(job.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 },
```

Suggestion:
```
const outcome = await new Promise((done) => {
    const child = execFile(
      command[0],
      command.slice(1),
      // job.timeoutMs comes from the controller's --timeout; undefined keeps
      // the old no-timeout behavior for payloads that predate it.
      { cwd, env: { ...process.env, ...(job.env ?? {}) }, maxBuffer: 64 * 1024 * 1024, timeout: job.timeoutMs },
```

## 25. [MEDIUM] scripts/isolated-session/session-agent.mjs:297-299 (bug)

Fire-and-forget log writes: a rejected `appendFile` promise (EACCES, disk full) becomes an unhandled rejection, which terminates the agent under Node's default `--unhandled-rejections=throw` — taking down all job processing mid-run. Concurrent un-awaited appends to the same file can also interleave or reorder chunks. Attach a `.catch` that reports to stderr (or buffer chunks and append them serially after the child exits).

```
child.stdout?.on("data", (chunk) => {
      void appendFile(logPath, chunk);
    });
```

Suggestion:
```
child.stdout?.on("data", (chunk) => {
      appendFile(logPath, chunk).catch((error) => {
        process.stderr.write(`[ae-a8n session agent] log write failed: ${error.message}\n`);
      });
    });
```

## 26. [MEDIUM] scripts/isolated-session/session-rules.mjs:204-210 (bug)

`sessionFromOffstageStatus` returns offstage's `guiSession.sessionId` in a field literally named `asid`, yet this same file documents (on `targetSessionFrom`) that offstage's session number is NOT launchd's asid (§10.12) and "is not carried as one". The invariant is enforced only by the caller-side patch `{ ...fromOffstage, asid: null }`; the function's other direct consumer, `resolveTargetSession` in scripts/isolated-session/run-in-isolated-session.mjs (line 247), returns the object unstripped, so a session whose `asid` is in the wrong id space escapes this file today (e.g. 258 vs 109086). Nothing downstream compares that `asid` right now, but any future comparison against a launchd asid — or any log line reporting it as one — will either refuse an isolated run or assert an equality that was never measured. Null the field at the source so every caller gets the invariant, and update the pinned test in test/isolated-session.check.mjs ("offstage's own report is the session fact", which asserts `asid: 258`) accordingly; `targetSessionFrom`'s `asid: null` spread then becomes redundant but harmless.

```
const gui = status.guiSession;
  return {
    uid: status.uid,
    username: status.user,
    asid: gui?.sessionId ?? null,
    kind: gui?.exists === true && gui?.loginDone === true ? "Aqua" : "none",
  };
```

Suggestion:
```
const gui = status.guiSession;
  return {
    uid: status.uid,
    username: status.user,
    // offstage's session number is not launchd's asid (§10.12), so it is
    // not carried as one — by any caller, not only targetSessionFrom.
    asid: null,
    kind: gui?.exists === true && gui?.loginDone === true ? "Aqua" : "none",
  };
```

## 27. [MEDIUM] scripts/isolated-session/session-rules.mjs:325-334 (bug)

`complete` only requires `uid` and `exit`, but the comment above it promises it "is false until every field is there". In particular a record with no `onconsole` line is flagged `complete: true` and `onConsole: false` (the trusting direction), while `assertOutcomeSession` only refuses when `onConsole === true` — so a result that is silent about the console is believed to be off-console, turning an unknown into an acceptance, contrary to the fail-closed rule. Today's writer emits `onconsole` before `exit`, so this is hard to hit, but the parser should not depend on the writer's line order: either include `onConsole !== undefined` (and any other field the guarantees rely on) in `complete`, or make `assertOutcomeSession` refuse an unknown `onConsole`, and fix the comment to match whichever fields `complete` actually checks.

```
// A file the controller has just seen is not necessarily a whole file:
    // the job publishes it by rename, but a reader can still catch an older
    // direct write. `complete` is false until every field is there, so a
    // half-written result is waited for instead of being read as uid -1 or
    // exit 1.
    complete: uidText.trim().length > 0 && exitText.trim().length > 0,
    uid: Number.isInteger(uid) ? uid : -1,
    username: fields.get("username") ?? "unknown",
    asid: asidText.trim().length > 0 && Number.isInteger(asid) ? asid : null,
    onConsole: onConsole === "1",
```

Suggestion:
```
// A file the controller has just seen is not necessarily a whole file:
    // the job publishes it by rename, but a reader can still catch an older
    // direct write. `complete` is false until every field the session checks
    // rely on is there — including `onconsole`, whose absence would otherwise
    // be read as "not on the console" — so a half-written or malformed result
    // is waited for instead of being read as uid -1 or exit 1.
    complete:
      uidText.trim().length > 0 && exitText.trim().length > 0 && onConsole !== undefined,
    uid: Number.isInteger(uid) ? uid : -1,
    username: fields.get("username") ?? "unknown",
    asid: asidText.trim().length > 0 && Number.isInteger(asid) ? asid : null,
    onConsole: onConsole === "1",
```

## 28. [MEDIUM] src/api/index.ts:137-141 (bug)

Only one launchctl failure phrasing is recognised: when `readGuiSessionFailure` returns text that does not match "not permitted" (e.g. a transient launchctl error, ENOENT off-macOS, or any other refusal), the actual failure text is discarded and the caller is told to log the user in — exactly the wrong-direction advice the comment above guards against, now with the evidence hidden. Append the launchctl text whenever it exists, so an unexpected failure mode is at least visible.

```
throw new AfterEffectsError(
      `uid ${uid} has no login session on this Mac, so no After Effects of that user could be reached. ` +
        "Log that user in — a fast user switch is enough — and try again. Nothing was started.",
      "session.launch",
    );
```

Suggestion:
```
throw new AfterEffectsError(
      `uid ${uid} has no login session on this Mac, so no After Effects of that user could be reached. ` +
        (failure === null ? "" : `launchctl said: ${failure}. `) +
        "Log that user in — a fast user switch is enough — and try again. Nothing was started.",
      "session.launch",
    );
```

## 29. [MEDIUM] src/api/index.ts:279-286 (bug)

Two problems in this wiring. (1) `recover: true` is silently dropped when the caller supplies their own `options.transport` (a supported LaunchOptions field) that is not a `ScriptInvocationTransport`: no recovery, no refusal — while `showModalDialog`'s contract promises "the timed-out call is followed by the GUI fallback". Project doctrine says ambiguous states refuse rather than proceed; failing to provide a requested safety behaviour should refuse too. (2) The session that receives key presses comes from `options.session.uid`, but the pid comes from the transport, which scopes processes by its *own* `sessionUid`: with a mismatched caller-supplied transport the fallback would automate a session different from the one the pid lives in. Derive the session from `transport.targetSession` (and refuse when it is null or disagrees with `options.session.uid`) so pid scope and automation session cannot diverge.

```
const recovery =
      options.session?.recover === true && transport instanceof ScriptInvocationTransport
        ? new MacHostRecovery({
            session: requireSession(options.session.uid),
            pid: () => transport.recoveryTargetPid(),
            screenshotDir: join(sessionRoot, "artifacts"),
          })
        : undefined;
```

Suggestion:
```
let recovery: MacHostRecovery | undefined;
    if (options.session?.recover === true) {
      if (!(transport instanceof ScriptInvocationTransport)) {
        throw new AfterEffectsError(
          "session.recover requires the built-in script transport; nothing was started",
          "session.launch",
        );
      }
      const session = requireSession(options.session.uid);
      // The pid comes from the transport, so the session it presses in must be the transport's own.
      if (transport.targetSession?.uid !== session.uid) {
        throw new AfterEffectsError(
          `session.recover: uid ${session.uid} is not the session the transport talks into; nothing was started`,
          "session.launch",
        );
      }
      recovery = new MacHostRecovery({
        session,
        pid: () => transport.recoveryTargetPid(),
        screenshotDir: join(sessionRoot, "artifacts"),
      });
    }
```

## 30. [MEDIUM] src/api/index.ts:394-396 (bug)

The doc comment promises that with `recover` enabled the GUI fallback "closes the dialog and lets the original call finish", but the recovery's allow list (`KNOWN_DIALOG_CLASSES` in src/driver/recovery.ts, mirrored in src/platform/recovery-policy.ts) only classifies a dialog whose static text starts with `ae-a8n:` — and this call passes the caller's message through untouched. Any message without that marker times out and is then *quarantined* as A8N-SEC-001 (nothing pressed) instead of being dismissed; `scripts/isolated-session/ae-e2e.mjs` only works because it hard-codes `"ae-a8n: close me"`. Ensure the marker here (e.g. `message.startsWith("ae-a8n:") ? message : "ae-a8n: " + message`, the same convention src/cli uses) or document and enforce the requirement. Also validate `message` with `requireString` like every other public method: a JS caller passing `undefined` only fails deep in the host (`missing required parameter: message`) and a number is silently coerced by `String(...)`, while the rest of this API refuses locally.

```
async showModalDialog(message: string, options: OperationOptions = {}): Promise<void> {
    await this.#session.call("ui.alert", "ui.alert", { message }, options);
  }
```

Suggestion:
```
async showModalDialog(message: string, options: OperationOptions = {}): Promise<void> {
    const text = requireString(message, "message");
    // The GUI recovery's allow list only recognizes dialogs whose text starts
    // with this marker (KNOWN_DIALOG_CLASSES), so the fallback can close what
    // this call raises only when the marker is present.
    const marked = text.startsWith("ae-a8n:") ? text : `ae-a8n: ${text}`;
    await this.#session.call("ui.alert", "ui.alert", { message: marked }, options);
  }
```

## 31. [MEDIUM] src/cli/agent.ts:93-95 (bug)

The foreground/detached decision is made by raw token membership, so the started mode can differ from the documented command: `ae-a8n agent --channel c --key-file k --host h --user u --log f` (no `--hidden`) passes `unknownAgentOption` and then starts a hidden, detached child, while `AGENT_HELP` documents `--log` as "With --hidden" and `detachAgent` never requires `--hidden` to be present. A `--hidden` token sitting in another flag's value position (e.g. `--key-file --hidden`) also flips this branch; `detachAgent`'s pair re-check catches that particular case with a misleading `--key-file needs a value`, but the `--log`-only invocation silently changes process mode with exit 0. Decide the mode from parsed flags, or reject `--log` without `--hidden` as a usage error.

```
if (argv.includes(HIDDEN_FLAG) || argv.includes(LOG_FLAG)) {
    return { exitCode: detachAgent(argv) };
  }
```

Suggestion:
```
if (argv.includes(LOG_FLAG) && !argv.includes(HIDDEN_FLAG)) {
    process.stderr.write('ae-a8n agent: --log requires --hidden; run "ae-a8n agent --help"\n');
    return { exitCode: 2 };
  }
  if (argv.includes(HIDDEN_FLAG)) {
    return { exitCode: detachAgent(argv) };
  }
```

## 32. [MEDIUM] src/doctor/index.ts:18-19 (maintainability)

Verified `package.json` currently has `"engines": { "node": ">=22" }`, so the value matches today, but nothing ties the two together: a search for `engines` across src/, test/, scripts/ and .github/ finds only this comment. If the engines floor is changed without updating this constant, `doctor` silently enforces the wrong version (block supported machines or pass unsupported ones). `test/diagnostics.test.ts` already pins the registry to `contracts/cli.md`; an assertion there comparing `NODE_FLOOR_MAJOR` with the parsed `package.json` `engines.node` floor would catch the drift.

```
/** The package's Node floor, mirrored from `package.json` `engines`. */
export const NODE_FLOOR_MAJOR = 22;
```

## 33. [MEDIUM] src/doctor/index.ts:29-32 (maintainability)

`nodeMajor` (and the whole A8N-ENV-002 detail/remedy/evidence construction below) is duplicated verbatim in `src/platform/darwin/adapter.ts:235` and `src/platform/darwin/adapter.ts:391-403`, which already imports `NODE_FLOOR_MAJOR` from this module. Two copies means any fix to the parser (e.g. the bare-major `v22` edge case) must be applied twice and can silently drift apart. Export the helper from a shared location (this module or `diagnostics.ts`) and import it in the darwin adapter instead of re-declaring it.

```
function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}
```

Suggestion:
```
export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

// src/platform/darwin/adapter.ts:
// import { NODE_FLOOR_MAJOR, nodeMajor } from "../../doctor/index.js";
```

## 34. [MEDIUM] src/doctor/index.ts:45-49 (bug)

This check always measures the controller's `process.version`, but `runDoctor` receives a `TargetSpec` that may name a remote Windows host (src/cli/run.ts:417 -> selectAdapter routes `target.host !== null` to the Windows adapter, whose probe executes on the host, runner.ts:450/841). The Windows probe never emits A8N-ENV-002 (only the darwin adapter does, where controller == target), so for `--host` targets: (a) an under-floor Node on the agent host — the machine that actually runs the resident Node agent — is never diagnosed by `doctor`, and (b) when the controller is under floor, a controller-scoped fact is reported in an envelope scoped to `target` with no machine attribution, and the remedy's "on this machine" is ambiguous. If the floor is intentionally controller-scoped, label the measured machine in detail/evidence (and consider having the Windows probe observe the host's Node floor for remote targets).

```
const major = nodeMajor(process.version);
  if (
    (major === null || major < NODE_FLOOR_MAJOR) &&
    !checks.some((check) => check.code === "A8N-ENV-002")
  ) {
```

Suggestion:
```
const major = nodeMajor(process.version);
  if (
    (major === null || major < NODE_FLOOR_MAJOR) &&
    !checks.some((check) => check.code === "A8N-ENV-002")
  ) {
    const machine = target.host ?? "this machine";
    checks.push(
      diagnostic("A8N-ENV-002", {
        detail:
          major === null
            ? `the Node version "${process.version}" on ${machine} could not be parsed`
            : `Node ${process.version} on ${machine} is below the package floor (${NODE_FLOOR_MAJOR}+)`,
        remedy: `Install Node ${NODE_FLOOR_MAJOR} or later on ${machine} and re-run doctor.`,
        remedyKind: "human",
        evidence: { node: process.version, floor: NODE_FLOOR_MAJOR, machine },
      }),
    );
  }
```

## 35. [MEDIUM] src/driver/bootstrap.ts:159-165 (bug)

For a generated extension host, `sourceDir` is the consumer's own directory (`extension build --out` writes anywhere the user chooses), and this first loop stages *every* file in it with an unconditional `copyFileSync` — unlike the shipped-dir loop below, which skips names already present. Consequences: (1) a stale consumer `a8n-json.js` is copied first and then wins over the shipped codec, because the shipped loop's `existsSync` guard skips it — AE runs an outdated codec next to the current host (`host/a8n-host.js:28` loads the sibling); (2) unrelated consumer files end up in the one folder AE is pointed at; (3) `statSync` on a broken symlink throws a raw ENOENT from the `AeDriver` constructor with no context. Suggestion: stage only the files the host actually loads (the host script + `a8n-json.js`), give the shipped codec precedence over a consumer copy, and treat an unreadable entry as a refusal with a clear message.

```
for (const name of readdirSync(sourceDir)) {
    const source = join(sourceDir, name);
    if (!statSync(source).isFile()) {
      continue;
    }
    copyFileSync(source, join(targetDir, name));
  }
```

Suggestion:
```
for (const name of readdirSync(sourceDir)) {
    if (name !== basename(hostScriptPath) && name !== "a8n-json.js") {
      continue;
    }
    const source = join(sourceDir, name);
    let stat;
    try {
      stat = statSync(source);
    } catch {
      throw new Error(`cannot stage ${source}: the file it names does not exist`);
    }
    if (!stat.isFile()) {
      continue;
    }
    copyFileSync(source, join(targetDir, name));
  }
```

## 36. [MEDIUM] src/driver/driver.ts:432-432 (bug)

This grace wait starts only *after* the operation's own `timeoutMs` has already expired, plus the GUI round trip (`recovery.attempt` runs listWindows/screenshot/presses, each `osascript` with up to 60 s, inside `MacGuiRecovery`). Nothing bounds the total: `api/index.ts` wires `recovery` without `recoveryGraceMs`, `LaunchOptions` exposes neither field, and `OperationOptions.timeoutMs` is documented as "ends the wait". A caller with `timeoutMs: 5_000` can therefore block for minutes with no way to tune it. Suggestion: expose `recoveryGraceMs` through `LaunchOptions` (or cap the grace at the caller's budget) and document the overrun when `session.recover` is enabled.

```
const result = await this.#awaitResult(id, method, params, this.#recoveryGraceMs, timeoutMs);
```

Suggestion:
```
const recoveryBegan = Date.now();
    const result = await this.#awaitResult(id, method, params, this.#recoveryGraceMs, timeoutMs);
```

## 37. [MEDIUM] src/driver/driver.ts:444-448 (bug)

Only `HostError` is surfaced from the post-recovery grace wait. `#awaitResult` can also return a `ProtocolError` — the result file existed but never became parseable — and that falls through to `return undefined`, so the caller rethrows the *original* `TimeoutError`. This is exactly the misdirection `#awaitResult` itself warns about ("A file that never became readable is a publication problem, not a slow host… saying 'timed out' here would send the reader looking in the wrong place entirely"). A recovery that successfully unblocks the host and then finds a corrupt/unpublishable result should report the publication failure, not a timeout. Surface `ProtocolError` here the same way as `HostError` (it is already imported in this file).

```
if (result.error instanceof HostError) {
      this.#trace.record(op, "error", 0, result.detail);
      throw result.error;
    }
    return undefined;
```

Suggestion:
```
if (result.error instanceof HostError || result.error instanceof ProtocolError) {
      this.#trace.record(op, "error", 0, result.detail);
      throw result.error;
    }
    return undefined;
```

## 38. [MEDIUM] src/driver/gui-recovery.ts:203-203 (bug)

`wtitle` is emitted raw here, and so are `btitle`/`bdesc` on the `B` line below, while `a8nClean` exists precisely because "the listing is line-based, so a line break inside a label would split it into two records" — yet it is only applied to static texts (`T|` lines). A newline in a window or button title splits the record: the remainder of the title becomes an ignored line, the window's role/subrole are lost, and `isBlockingWindow` can then classify a real dialog as non-blocking — the recovery reports "has no modal window; timed out for another reason" while the host is in fact blocked. Route `wtitle`, `btitle` and `bdesc` through `my a8nClean(...)` the same way the `T` line does (it also strips `|`, keeping the field layout stable).

```
"      set report to report & \"W|\" & wtitle & \"|\" & wrole & \"|\" & wsub & linefeed",
```

Suggestion:
```
"      set report to report & \"W|\" & my a8nClean(wtitle) & \"|\" & wrole & \"|\" & wsub & linefeed",
```

## 39. [MEDIUM] src/driver/gui-recovery.ts:281-287 (security)

The one measured dialog class (`ae-a8n ui.alert`) is defined as having an *empty* title, so for the only window the recovery ever presses this identity guard is skipped entirely and only the subrole is compared — two empty-title `AXDialog` windows become indistinguishable. The comment above says this guard exists because "a window that appeared in between would otherwise receive the press"; that race is exactly unprotected here. Between the listing and the press the recovery runs a screenshot (up to 30 s), and AE's start-up `警告` dialog — documented in `recovery.ts` as also having an empty Axis title — or an Adobe sign-in sheet that becomes window N in that window passes title(`""`)+subrole checks and receives the OK/Cancel press, a decision the policy reserves for a human. Suggestion: pass a stronger fingerprint as argv (e.g. the window's `ae-a8n:` static text, which the known class requires) and verify a static text inside the script, or refuse to press when `expectedTitle` is empty.

```
"    if expectedTitle is not \"\" then",
  "      set wtitle to \"\"",
  "      try",
  "        set wtitle to (name of w) as string",
  "      end try",
  "      if wtitle is not expectedTitle then return \"CHANGED\"",
  "    end if",
```

Suggestion:
```
"    if expectedText is not \"\" then",
  "      set found to false",
  "      try",
  "        repeat with t in static texts of w",
  "          try",
  "            if (value of t as string) contains expectedText then set found to true",
  "          end try",
  "        end repeat",
  "      end try",
  "      if not found then return \"CHANGED\"",
  "    end if",
```

## 40. [MEDIUM] src/driver/recovery.ts:249-253 (performance)

The comment understates the cost: each step is a blocking `execFileSync` (`MacGuiRecovery.#osascript` runs `osascript` with a 60 s budget, `capture` 30 s), and a full attempt — listWindows + screenshot + up to four titles × (press + re-list + click) — can hold the Node event loop for minutes. During that time no timer, no osascript completion callback, and no other work in the process runs: `api.launch()` creates independent sessions in one process, so one session's recovery freezes another session's in-flight calls and makes their deadlines fire late by the block duration. The `Promise<RecoveryOutcome>` contract suggests a non-blocking attempt; make the underlying session calls async (they already have async spawn primitives in `mac-session.ts`) or document that the whole process is stalled while a recovery runs.

```
attempt(context: RecoveryContext): Promise<RecoveryOutcome> {
    // The whole recovery is synchronous: every action is one Accessibility
    // query or one press inside the target session.
    return Promise.resolve(this.#attempt(context));
  }
```

## 41. [MEDIUM] src/driver/recovery.ts:331-333 (bug)

The branch is inverted relative to the documented fallback contract. When the listing *shows* the button (the case that matters: the only measured class, `ae-a8n ui.alert`, always lists its `OK`), only the AX press is tried; `pressButtonIn`'s coordinate fallback is reserved for buttons *absent* from the listing. If `click b` fails — the AppleScript wraps it in `try` and answers `NOT_FOUND`, i.e. AX-press failure is an anticipated outcome — the loop silently moves on to titles the window does not have, and the final refusal evidence claims `"none of OK, Cancel, Close, Dismiss was available"` although `OK` was listed, was pressed, and failed to click. `pressButtonIn` already starts with the identical AX press (same `expected` guard), so for the seen-button case it is a strict superset: either call it uniformly, or document why the one button the caller actually saw must never get the fallback.

```
const pressed = window.buttons.some((button) => button.title === title)
        ? gui.pressButton(choice.index, title, window)
        : gui.pressButtonIn(choice.index, title, window);
```

Suggestion:
```
const pressed = gui.pressButtonIn(choice.index, title, window);
```

## 42. [MEDIUM] src/driver/script-invocation.ts:872-877 (bug)

The serialization guard only holds for a single waiter. After `await untilAborted(this.#inFlight, ...)` resolves, `#inFlight` is never re-checked before the next `DoScriptFile` is sent. Nothing above the driver serializes calls, so with three concurrent `driver.call`s two callers can be queued on the same in-flight script; when it settles, both resume in the same tick and both spawn `osascript`, breaking the "one DoScriptFile at a time" invariant this block exists for. Worse, `#inFlight` is then only the *last* sender's promise — the other script is no longer tracked at all, so later callers wait for that one alone and can send while the untracked script is still running (and a timed-out caller's grace/recovery logic reasons about the wrong request). Since each waiter's check-to-send section is synchronous, wrapping the wait in `while (this.#inFlight !== null) { ... }` closes the race.

```
if (this.#inFlight !== null) {
        // If the deadline passes during this wait, the script was never
        // sent. Saying "timed out" would claim the operation ran and did not
        // answer, which is not what happened: nothing ran at all.
        try {
          await untilAborted(this.#inFlight, options.signal);
```

Suggestion:
```
while (this.#inFlight !== null) {
        // If the deadline passes during this wait, the script was never
        // sent. Saying "timed out" would claim the operation ran and did not
        // answer, which is not what happened: nothing ran at all.
        try {
          await untilAborted(this.#inFlight, options.signal);
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw new ScriptNotSentError(
              "the call was abandoned while it waited for the previous script to finish; " +
                "it was never sent to After Effects, so nothing ran",
            );
          }
          throw error;
        }
      }
```

## 43. [MEDIUM] src/driver/transport.ts:19-24 (bug)

The distinct type stops at the driver boundary. The driver rethrows it correctly (and `test/not-sent.test.ts` asserts it), but no layer above classifies it: `api/errors.contextualise()` has no branch for `ScriptNotSentError`, so it falls into the generic `AfterEffectsError` catch-all, and `src/index.ts` exports `TimeoutError` but not this class. A public-API caller therefore cannot distinguish "never sent — safe to retry" from other failures by type, only by matching message text — although `api/errors.ts` promises "Every failure a caller can meaningfully branch on has its own type", and this distinction is precisely the retry-safety boundary. Suggestion: add a branch in `contextualise` that preserves the classification and export `ScriptNotSentError` alongside `TimeoutError`.

```
export class ScriptNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptNotSentError";
  }
}
```

Suggestion:
```
export class ScriptNotSentError extends Error {
  /** Stable code so upper layers can classify without string matching. */
  readonly code = "A8N-AE-006" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScriptNotSentError";
  }
}
```

## 44. [MEDIUM] src/platform/contract.ts:152-156 (bug)

`capabilityChecks` has no production caller — only `test/platform-contract.test.ts` exercises it. `runTest` and `runDoctor` gate solely on `probe.checks`; `probe.capabilities` is passed into the envelope for display (src/cli/run.ts) and never consulted. So the refusal this module's header promises ("the runner turns that into a refusal rather than a warning", plan.md §3) does not exist: an adapter may report `nonInterference: "unproven"` and the run still proceeds. Note `darwinCapabilities()` returns `"unproven"` unconditionally, so simply calling this from `runTest` would block every macOS run — wire the enforcement point and the capability values together (or correct the header if the SESSION-003 probe checks are the intended enforcement).

```
export function capabilityChecks(
  capabilities: Capabilities,
  platform: PlatformId,
): readonly DiagnosticCheck[] {
  if (capabilities.nonInterference !== "unproven") {
```

Suggestion:
```
export function capabilityChecks(
  capabilities: Capabilities,
  platform: PlatformId,
): readonly DiagnosticCheck[] {
  if (capabilities.nonInterference !== "unproven") {
    return [];
  }
  // TODO(#58): runTest/runDoctor must call this and refuse when it returns a
  // blocker; today nothing in src/ does, so an "unproven" capability never
  // blocks a run.
```

## 45. [MEDIUM] src/platform/darwin/adapter.ts:851-863 (bug)

`sessionReady` does not require `gui.asid !== null`, so an Aqua session with an unreadable session id is reported by `setup` as "done" — with the reason literally printing `(asid null)` — while `probeDarwin` treats the same state as an A8N-SESSION-002 blocker and `resolveDarwinSession` marks the identity `proven: false`. `setup` calls `plan`/`apply` without probing first (src/cli/run.ts), so this check is the only gate and doctor/setup will contradict each other about the same machine. Add `gui.asid !== null` to the readiness check and give both the unreadable-asid case and the non-Aqua case their own reason (as `probeDarwin` does); today a non-Aqua session also falls through to "the target account has no GUI session" even though a session does exist.

```
const sessionReady =
        accountKnown && gui !== null && gui.uid === facts.targetUid && gui.kind === "Aqua";
      steps.push({
        id: "macos.session",
        state: sessionReady ? "done" : "needs-human",
        reason: sessionReady
          ? `the account has an Aqua session (asid ${String(gui.asid)})`
          : !accountKnown
            ? user === null
              ? "no target account was named, so its session cannot be looked for"
              : `the account ${user} could not be resolved, so its session cannot be looked for`
            : (facts.guiSessionFailure ??
              "the target account has no GUI session to run After Effects in"),
```

Suggestion:
```
const sessionReady =
        accountKnown &&
        gui !== null &&
        gui.uid === facts.targetUid &&
        gui.kind === "Aqua" &&
        gui.asid !== null;
```

## 46. [MEDIUM] src/platform/darwin/adapter.ts:896-905 (bug)

When exactly one installation exists but its version could not be read (`installed` is false via `installs[0]?.version !== null`), both chains fall into their final `else`: setup claims "more than one After Effects version is installed" and tells the user to "Disambiguate the installed After Effects versions" — factually wrong for a single install, and contradicting `probeDarwin`, which reports this exact state as "After Effects was found at X, but its version could not be read". Split the single-install/unreadable-version case out of the final `else` in both `reason` and `action` (four cases: folder unreadable, none found, one install with unreadable version, multiple installs).

```
: facts.installLookupFailure !== null
            ? `the installation folder could not be read: ${facts.installLookupFailure}`
            : installs.length === 0
              ? "no After Effects installation was found"
              : "more than one After Effects version is installed, so the version cannot be proven",
        action: installed
          ? null
          : installs.length === 0
            ? "Install After Effects for the target account."
            : "Disambiguate the installed After Effects versions, then run setup again.",
```

## 47. [MEDIUM] src/platform/select.ts:61-62 (bug)

`user` and `host` become `WindowsAdapterOptions.user/host`, i.e. the job writer, run-lock owner and manifest user (`#owner()`). For a local target with no `--user` the writer is `{ host: "local", user: "" }`, and the agent refuses any job whose `writer.user` is empty (`job.ts` requires a non-empty `writer.user`, refused as A8N-JOB-001 "writer.host and writer.user are required") — so a local Windows run fails with a message that blames the channel instead of the controller's missing identity, and the manifest records an empty user / host "local". Remote targets are repaired later from the host configuration (`#freshComms` only when `#user === ""`), but the local path never is. Record this machine's own account and hostname for a local target, keeping `""` only for a remote target so the `=== ""` repair path still triggers (use the guarded `userInfo()` pattern from `darwin/adapter.ts`'s `currentUsername()`).

```
const host = target.host ?? "local";
  const user = target.user ?? "";
```

Suggestion:
```
const host = target.host ?? hostname();
  // A local target records this machine's own account as the writer; "" is
  // reserved for a remote target, which the adapter fills from the host's
  // configuration (`#freshComms` repairs it only when it is still "").
  const user = target.user ?? (target.host === null ? userInfo().username : "");
```

## 48. [MEDIUM] src/platform/windows/acl.ts:129-134 (bug)

Fail-open on rights spelling: `hasWrite` is a positive list (F, M, W*), so any right `icacls` prints in another spelling is read as "no write" and the entry passes `channelAclVerdict`. Real examples: `AD` (append data / add subdirectory — enough to plant a `jobs/<id>/` directory and inject a job), `GW` (generic write), and non-standard ACEs printed as `(special access:…)`, none of which start with `W`. The tests only exercise F/M/W/WD forms. Invert to a read-only allowlist instead: unless every non-inheritance token is a known read-only right (R, RX, RC, REA…), treat the entry as writable so an unrecognised spelling fails closed, which is the direction this module promises.

```
function hasWrite(rights: string): boolean {
  const tokens = rights.split(",").map((token) => token.trim().toUpperCase());
  return tokens.some(
    (token) => token === "F" || token === "M" || token.startsWith("W"),
  );
}
```

Suggestion:
```
const READ_ONLY = new Set(["R", "RX", "RC", "REA", "GR", "GX", "S"]);

function hasWrite(rights: string): boolean {
  const tokens = rights.split(",").map((token) => token.trim().toUpperCase());
  // Unknown spellings (AD, GW, "special access:…") are not known to be
  // read-only, and a write we cannot see is a write we must refuse.
  return !tokens.every((token) => READ_ONLY.has(token));
}
```

## 49. [MEDIUM] src/platform/windows/agent-detach.ts:204-213 (bug)

`detachAgent` returns 0 before knowing the child actually spawned; this listener is the only path that reports an asynchronous spawn failure, and by then the exit code is already fixed at 0 — contradicting the module header's "a start that cannot happen is reported on stderr and exits non-zero". A logon task or shortcut therefore records success for a start that failed (the test suite only covers the synchronous-throw case, which does return 1). Node emits `spawn` or `error` on the next tick, so waiting for one of them before returning costs nothing and makes the answer deterministic; the `DetachChild` seam would need a `once` method and a `"spawn"` event in its type.

```
child.on("error", (error: Error) => {
    writeErr(`ae-a8n agent: the hidden agent failed: ${messageOf(error)}\n`);
  });
  child.unref();
  closeLog(fd);
  writeOut(
    `ae-a8n agent: started in the background (pid ${String(child.pid ?? "unknown")}); ` +
      `output: ${logPath}\n`,
  );
  return 0;
```

Suggestion:
```
return new Promise<number>((resolve) => {
    child.once("spawn", () => {
      child.unref();
      closeLog(fd);
      writeOut(
        `ae-a8n agent: started in the background (pid ${String(child.pid ?? "unknown")}); ` +
          `output: ${logPath}\n`,
      );
      resolve(0);
    });
    child.once("error", (error: Error) => {
      closeLog(fd);
      writeErr(`ae-a8n agent: the hidden agent could not be started: ${messageOf(error)}; nothing was started\n`);
      resolve(1);
    });
  });
```

## 50. [MEDIUM] src/platform/windows/agent-main.ts:265-269 (bug)

`stopped()` is only consulted *after* the inner loop has drained every queued job: once the signal aborts, the agent still claims and runs each remaining job (each up to the executor's 180s timeout) before returning 0. The help text in cli/agent.ts promises "Stop it with Ctrl+C or SIGTERM", but Ctrl+C can appear dead for minutes with a non-empty queue — which pushes an operator to force-kill the process, stranding a claim between claim and result (the exact stale-claim state nothing recovers). Checking the signal at the top of the inner loop is safe: at that point the previous job's result is already published, so returning leaves nothing half-finished.

```
for (const jobId of [...jobIds].sort()) {
      // A directory that is not a job id is not a job; never run it.
      if (!isJobId(jobId)) {
        continue;
      }
```

Suggestion:
```
for (const jobId of [...jobIds].sort()) {
      // Stop between jobs, not after the whole queue: the previous job's
      // result is published by now, so nothing is left half-claimed.
      if (stopped()) {
        return 0;
      }
      // A directory that is not a job id is not a job; never run it.
      if (!isJobId(jobId)) {
        continue;
      }
```

## 51. [MEDIUM] src/platform/windows/agent-main.ts:273-276 (bug)

This `channel.read` is the only channel operation in `main()` outside a try/catch, so it breaks the function's documented contract ("Returns the process exit code ... non-zero when ... the channel [is] unusable"). A transient SMB error or an oversized result file makes `main()` reject instead of returning: through `ae-a8n agent` the rejection surfaces as the CLI's last-resort `ae-a8n: <message>` exit 1, and through `scripts/windows-agent.mjs` (top-level `await`) as an unhandled rejection — either way one unreadable job directory takes down the resident agent and the heartbeat stops, with no restart guaranteed. Note agent.ts wraps its own reads in `readCapped` precisely so a size refusal becomes a controlled outcome rather than a throw. Wrap this read like its siblings; if a single bad directory shouldn't stop the whole agent, log and `continue` (the controller then times out that job to `unknown`, the fail-closed direction) instead of rejecting.

```
const result = await channel.read(jobPaths(jobId).result);
      if (result !== null) {
        continue;
      }
```

Suggestion:
```
let result: Uint8Array | null;
      try {
        result = await channel.read(jobPaths(jobId).result);
      } catch (error) {
        stderr(`windows-agent: job ${jobId}'s result could not be read: ${messageOf(error)}\n`);
        continue;
      }
      if (result !== null) {
        continue;
      }
```

## 52. [MEDIUM] src/platform/windows/agent.ts:194-201 (other)

Verified: no code in src/platform/windows ever removes or supersedes a stale claim (recovery.ts only assesses AE process state; the only claim-file writer is `createExclusive`), and agent-main.ts never logs this outcome. So an agent that dies between the exclusive claim and publishing a result strands the job permanently — on restart its own still-valid claim verifies and every later poll skips it — while the controller can only time out to `unknown` with no hint that a claim file exists and needs manual removal. Staying unexecuted is the right fail-closed direction; the silence is not. Log the skip in agent-main with the claim's agent id and `claimedAt`, and have the controller's unknown message name an existing signed claim as the likely cause, so a human knows exactly what to clean up.

```
const claimCheck = verifyClaimAuth(decodedClaim.value, [key]);
    if (!claimCheck.ok) {
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim is not from a trusted issuer: ${claimCheck.detail}`,
      };
    }
    return { state: "claimed-by-other" };
```

## 53. [MEDIUM] src/platform/windows/agent.ts:350-355 (bug)

An executor exception is exactly the case this file's own `JobExecution.status` contract describes — "`unknown` means the executor could not tell what happened; never retry it" — yet it is published as `failed`. Downstream, `submitJob` only routes `unknown` results into the A8N-AE-004 unknown/quarantine path; a `failed` result is a definite outcome, so a throw after the process may already have started is reported as an ordinary test failure and never reaches `recover`'s review. Publish `status: "unknown"` from this catch instead, so an outcome nobody observed stays unknown rather than becoming a claim.

```
} catch (error) {
    execution = {
      status: "failed",
      message: `the executor threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
```

Suggestion:
```
} catch (error) {
    execution = {
      status: "unknown",
      code: "A8N-AE-004",
      message: `the executor threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
```

## 54. [MEDIUM] src/platform/windows/channel.ts:103-106 (security)

The size cap is enforced only *after* `readFile` has buffered the whole file. The comment above admits the file can grow between `stat` and the read, but the second check detects that only once the allocation has happened — a channel writer (exactly the untrusted party this limit exists for) who extends the file inside that window can push the allocation far past `DEFAULT_MAX_READ_BYTES` and OOM the agent or controller before `ChannelFileTooLargeError` is ever thrown. Read through a handle with a hard bound instead: open the file, `stat`/verify, then read into a buffer of `maxReadBytes + 1` bytes and refuse if more remains — so the limit holds against a racing writer, not just a static one.

```
const bytes = new Uint8Array(await readFile(target));
      if (bytes.length > this.#maxReadBytes) {
        throw new ChannelFileTooLargeError(path, bytes.length, this.#maxReadBytes);
      }
```

Suggestion:
```
// Read with a hard bound: readFile buffers everything before the
      // post-check runs, so a writer racing the stat can still force an
      // allocation past the cap. Read at most maxReadBytes + 1 bytes via a
      // file handle and refuse if the file is longer.
```

## 55. [MEDIUM] src/platform/windows/channel.ts:124-129 (bug)

The fallback has two costs. (a) Between `unlink` and `rename` the path does not exist at all: the presence heartbeat is rewritten through `writeAtomic` on every poll, so a controller reading in that window — or after a crash between the two calls — sees "no heartbeat" and refuses; fail-closed, but a false negative induced by the writer's own refresh, and absence becomes indistinguishable from deletion. (b) The comment's premise is shaky (libuv renames with MOVEFILE_REPLACE_EXISTING, so rename-over-existing normally succeeds; EPERM usually means the destination is currently open) — and when the target is held open by a reader lacking delete-sharing, `unlink` fails too, `ignoreMissing` rethrows, `writeAtomic` rejects, and `publishPresence` in agent-main.ts turns that into `return 1`: one unlucky read stops the resident agent. Retry the rename briefly first (transient sharing violations clear) and keep unlink as the last resort.

```
// Windows refuses to rename onto an existing file.
      if (!isRenameRefused(error)) {
        throw error;
      }
      await unlink(target).catch(ignoreMissing);
      await rename(temporary, target);
```

Suggestion:
```
// The destination is usually open transiently; retry before deleting it,
      // so a reader never observes the path as absent.
      let renamed = false;
      for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
        try {
          await rename(temporary, target);
          renamed = true;
        } catch (renameError) {
          if (!isRenameRefused(renameError)) {
            throw renameError;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!renamed) {
        await unlink(target).catch(ignoreMissing);
        await rename(temporary, target);
      }
```

## 56. [MEDIUM] src/platform/windows/comms.ts:222-227 (bug)

The `fileConfig === null` condition makes this guard unreachable: `fileConfig` is loaded whenever `--channel` is absent (the block above), and every load/decode failure returns early, so it is always non-null at this point. The consequence is the asymmetric behaviour the docstring two paragraphs up says must fail — `--channel` without `--key-file` is refused, but `--key-file` without `--channel` silently pairs the flag-supplied key with the hosts file's channel (the test suite only covers the first direction). Either drop the dead condition so both halves are refused, or, if borrowing the config's channel with a flag key is actually intended, correct the docstring and delete the unreachable check.

```
if (anyFlag && options.keyFile !== null && options.channel === null && fileConfig === null) {
    return {
      ok: false,
      detail: "--key-file was given without --channel; there is no channel to put a job in",
    };
  }
```

Suggestion:
```
if (anyFlag && options.keyFile !== null && options.channel === null) {
    return {
      ok: false,
      detail: "--key-file was given without --channel; there is no channel to put a job in",
    };
  }
```

## 57. [MEDIUM] src/platform/windows/comms.ts:364-365 (security)

The channel-ACL verdict — openComms's stated sticky-bit equivalent — is gated on the *controller's* `process.platform`, so on a macOS/Linux controller (the primary deployment for this product) the check never runs, no finding is recorded, and openComms still promises "there is no probably-fine state". It also makes the injected `options.acl` unreachable off Windows: a caller that supplies a reader never gets it called. The key-file side is covered off Windows by key-store.ts's mode-bit check (line 116), but nothing anywhere verifies the channel directory on POSIX — a repo-wide search for a channel mode/sticky check finds none. At minimum honour `options.acl !== undefined` regardless of platform, and when no reader is available on a non-Windows controller, surface an explicit "channel ACL not verified on this platform" finding ("unproven" is the honest value per this project's rules) instead of silently omitting the check.

```
if (process.platform === "win32") {
    const readAcl = options.acl ?? defaultAclReader;
```

Suggestion:
```
if (options.acl !== undefined || process.platform === "win32") {
    const readAcl = options.acl ?? defaultAclReader;
```

## 58. [MEDIUM] src/platform/windows/comms.ts:546-548 (security)

These probe facts are acted on without authentication: `result.json` is HMAC-signed, but `JobResult` carries no digests of `stdout.log`/`stderr.log` (there is no artifacts field), so any writer that can replace a file in the channel — precisely the writer `channelAclVerdict` exists to exclude — can rewrite a probe's output *after* the signed result is published, and `tasklist`/`net user` answers are consumed as fact. That contradicts auth.ts's stated property that a writer without the secret "cannot produce a file either side will act on". Bind the artifact digests into the signed result on the agent side (they are already written before the result) and verify them here before decoding.

```
const directory = jobPaths(submitted.jobId).resultDirectory;
    const stdout = await state.channel.read(`${directory}/stdout.log`);
    const stderr = await state.channel.read(`${directory}/stderr.log`);
```

Suggestion:
```
const directory = jobPaths(submitted.jobId).resultDirectory;
    const stdout = await state.channel.read(`${directory}/stdout.log`);
    const stderr = await state.channel.read(`${directory}/stderr.log`);
    // TODO: verify stdout/stderr against digests the agent included in the
    // signed result before treating either as the probe's answer.
```

## 59. [MEDIUM] src/platform/windows/executor.ts:343-352 (bug)

Two gaps on the timeout path. (1) `killProcessTree` swallows every `taskkill` failure (its execFile callback ignores the error) and the catch above swallows throws, so `sameProcess === true` reports "the child was killed" even when the kill never happened (access denied, taskkill missing) — the message asserts a fact nobody verified. (2) When either identity read returns null (PowerShell blocked by policy/AV, Get-Process access denied), nothing is killed and no later cleanup path exists anywhere: the child runs indefinitely holding its pipes and CPU, with only the one-shot `unknown` result as a record. Not killing a reused pid is the right tradeoff, but the message should reflect whether the kill was actually issued/confirmed, and an unkillable-identity child should be recorded (pid + creation time) for recovery instead of being dropped entirely.

```
const sameProcess = before !== null && current !== null && before === current;
          if (sameProcess) {
            try {
              await this.#kill(child);
            } catch {
              // The kill failing does not make the outcome less unknown.
            }
          }
          const outcome = sameProcess
            ? `timed out after ${this.#timeoutMs}ms; the child was killed and the outcome is unknown`
```

Suggestion:
```
let killed = false;
          if (sameProcess) {
            try {
              await this.#kill(child);
              killed = true;
            } catch {
              // The kill failing does not make the outcome less unknown.
            }
          }
          const outcome = killed
            ? `timed out after ${this.#timeoutMs}ms; the child was killed and the outcome is unknown`
            : `timed out after ${this.#timeoutMs}ms; the child ${sameProcess ? "could not be killed" : "'s identity could not be re-checked, so nothing was killed"} and it may still be running`;
```

## 60. [MEDIUM] src/platform/windows/key-store.ts:66-67 (bug)

The `code` field's stated contract ("the diagnostic to report it under; permission refusals say so") is not honored by any production caller. The only caller that maps a `loadKeyFile` refusal to a diagnostic — the doctor's key step in `comms.ts` — hardcodes `diagnostic("A8N-JOB-003", ...)`, so a PERM-005 refusal ("key readable by accounts other than its owner") is surfaced to users as A8N-JOB-003 "Job or result is not from a trusted issuer", while `specs/isolated-ae/contracts/cli.md` and `doctor/diagnostics.ts` map `A8N-PERM-005` to its own blocker ("The channel key file is readable by another account"). Today the field is read only by tests. Either have callers report `loaded.code`, or remove the field — as written it promises a distinction the product never delivers.

```
/** The diagnostic to report it under; permission refusals say so. */
  readonly code: "A8N-JOB-003" | "A8N-PERM-005";
```

Suggestion:
```
/** The diagnostic to report it under; permission refusals say so. */
  readonly code: "A8N-JOB-003" | "A8N-PERM-005";
// callers: report `loaded.code`, not a hardcoded "A8N-JOB-003"
```

## 61. [MEDIUM] src/platform/windows/key-store.ts:125-125 (security)

TOCTOU between the checks and the read: `lstat` (symlink/regular-file/size), the `icacls` ACL check, and the POSIX mode check all inspect `path` at different times, but the bytes that become the channel key come from a later independent `readFile` of the same path. A process with write access to the key file's directory can replace the file (or swap in a symlink) after the checks pass and before this read, so the accepted bytes are not the bytes the header claims were proven safe — and neither `agent-main.ts` nor `comms.ts` re-verifies the file afterwards, making this module the only gate. Bind the proof to the bytes: open the file once (with `O_NOFOLLOW` on POSIX), validate the handle (`isFile`, size) and read from that handle, or at minimum re-`lstat` after the read and refuse when inode/size/mtime changed.

```
const decoded = decodeKeyFile(new Uint8Array(await readFile(path)));
```

Suggestion:
```
const bytes = new Uint8Array(await readFile(path));
  const after = await lstat(path);
  if (
    after.ino !== info.ino ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs ||
    after.isSymbolicLink() ||
    !after.isFile()
  ) {
    return {
      ok: false,
      code: "A8N-JOB-003",
      detail: `the key file ${path} changed while it was being checked`,
    };
  }
  const decoded = decodeKeyFile(bytes);
```

## 62. [MEDIUM] src/platform/windows/key-store.ts:125-125 (bug)

`readFile` is the one failure in this function that is not turned into a structured refusal. After the lstat/ACL/mode checks pass, the read can still reject — EACCES (a key owned by another account with mode 600 passes the group/other-bit check; a deny ACE on the current user passes `keyFileAclVerdict`), or ENOENT/ELOOP from a race on the path — and the rejection escapes `loadKeyFile`'s `KeyFileLoad` contract. `agent-main.ts` awaits it without a try/catch, so the clean `windows-agent: …; nothing was polled` path becomes a raw rejection, and `openComms`, whose doc promises "Every failure is one or more `checks`", turns it into an unhandled exception instead of the A8N-JOB-003/A8N-PERM-005 diagnostic with its remedy. Every other failure above returns `{ ok: false, code, detail }`; wrap the read the same way.

```
const decoded = decodeKeyFile(new Uint8Array(await readFile(path)));
```

Suggestion:
```
let bytes: Uint8Array;
try {
  bytes = new Uint8Array(await readFile(path));
} catch (error) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  return {
    ok: false,
    code: code === "EACCES" || code === "EPERM" ? "A8N-PERM-005" : "A8N-JOB-003",
    detail: `the key file ${path} could not be read (${code})`,
  };
}
const decoded = decodeKeyFile(bytes);
```

## 63. [MEDIUM] src/platform/windows/lock.ts:167-168 (bug)

Read-validate-remove is not atomic: `channel.remove` is a plain `unlink`, so another controller can hold this lock at unlink time. The interleaving is exactly the one this module is designed around — a human/recovery deletes our stale lock, another controller takes it via `createExclusive`, and then this delayed `remove` deletes the fresh lock it never owned; a third controller can then acquire while two believe they hold the run. The owner check above only guards the read, not the unlink. Re-read the file immediately before removing and only unlink when the bytes are still the ones that were validated (this narrows the window), or add a channel-level compare-and-delete so content verification and unlink are one step.

```
await channel.remove(path);
  return true;
```

Suggestion:
```
// Re-read immediately before unlinking: if the bytes are no longer the
  // ones just validated, someone else owns this lock now — leave it alone.
  const fresh = await channel.read(path);
  if (fresh === null || Buffer.compare(fresh, bytes) !== 0) {
    return false;
  }
  await channel.remove(path);
  return true;
```

## 64. [MEDIUM] src/platform/windows/manifest.ts:214-215 (security)

The run manifest is the one channel document that carries trust claims (`outcome`, `destinationProof`, `agentVerified`) with no signature, and `readRunManifest` verifies only shape and runId. Every sibling document — job, result, claim, heartbeat — is HMAC-bound precisely because, per auth.ts, "the channel is a directory any local process may be able to write"; the payload/result hashes this manifest names are themselves readable in the channel, so an unkeyed writer can rewrite `runs/<runId>/manifest.json` after `writeRunManifest` and flip `outcome` or the proof fields without breaking any check here. Only tests read it today, but T098 signs the session marker for the same reason — sign the manifest with the channel key, or cross-check it against the signed result it names, before any consumer treats these fields as evidence.

```
const decoded = decodeRunManifest(bytes);
  if (decoded.ok && decoded.value.runId !== runId) {
```

## 65. [MEDIUM] src/platform/windows/runner.ts:761-763 (bug)

`#freshComms()` re-resolves connection settings and reassigns `this.#channel`, and `#assertAgentAlive` (line 833) calls it after `acquireRunLock` (946) has already written the lock into the previous channel. If hosts.json or the flags change between the cached resolution used by `#signingKey` and this fresh one, the lock stays in the old root while the job, manifest and release go to the new one — lock/job atomicity breaks and `releaseRunLock` silently returns false. The comment on `#signingKey` (806-807) claims resolution "settles #channel before the run lock is written", which this later re-resolution violates. Liveness re-verification should re-check presence on the already-settled channel, not swap the channel root mid-run.

```
if (resolution.ok && !this.#channelInjected) {
        this.#channel = new DirectoryChannel(resolution.config.channel);
      }
```

Suggestion:
```
if (resolution.ok && !this.#channelInjected && this.#channelSettled === false) {
        this.#channel = new DirectoryChannel(resolution.config.channel);
        this.#channelSettled = true;
      }
```

## 66. [MEDIUM] src/platform/windows/runner.ts:976-977 (bug)

No release path exists for exceptions thrown after `acquireRunLock` (line 946): `#assertAgentAlive` (WindowsAgentUnavailableError), `#submit`, `writeRunManifest` (1009) or `#writeLocalArtifacts` (1021, before `releaseRunLock` at 1022) all propagate with the lock still held. The only planned release for such paths — `WindowsSession.close()` — has no production caller: nothing in src/ ever invokes `IsolatedSession.close()`, so the comment at 1016-1017 ("close() releases it") documents a mechanism that never runs. Impact today is bounded because lock paths are per-runId (`locks/<runId>.json` with a fresh random runId), so later runs are not blocked — but the channel accumulates orphaned lock files and the documented cleanup is dead code. Wrap the post-acquisition section so every path except the deliberate `unknown` case releases the lock, and either give `close()` a caller or stop relying on it in comments.

```
await this.#assertAgentAlive(target);
    const submitted = await this.#submit(this.#channel, submitOptions);
```

Suggestion:
```
try {
      await this.#assertAgentAlive(target);
      submitted = await this.#submit(this.#channel, submitOptions);
    } catch (error) {
      // Nothing was sent (or nothing can be observed): release this run's own
      // bookkeeping before propagating.
      await releaseRunLock(this.#channel, runId, owner);
      throw error;
    }
```

## 67. [MEDIUM] src/platform/windows/session-marker.ts:254-254 (security)

The 32-byte `secret` is generated, encoded, decoded and format-checked — but never read or compared by any code in `src/`. `verifySessionMarker` (and therefore `proveRunDestination` and the future quit/close path this gates) checks only `runId`, `jobId` and the agent's id/host/user/session, all of which are public facts visible anywhere in the channel; unlike jobs, results and claims, the marker carries no HMAC. Since `auth.ts` explicitly accepts that a writer without the key can still write files, a key-less channel writer can plant a marker that passes this check for a run it never executed, and the header's promise that the unguessable secret makes the marker unpreventable/replay-proof is not realised. Bind the secret (or the marker itself) to the key-holding agent — e.g. sign the marker with the channel key following the presence pattern, or include the marker secret in `resultSigningBytes` so the signed result proves which marker this run's agent wrote — and have this function verify that binding.

```
return { proven: true, proof: "marker", marker };
```

## 68. [MEDIUM] src/runner/recover-run.ts:156-159 (bug)

The invariant in the comment above ("an existing report is never overwritten") is enforced by a non-atomic `existsSync` + truncating `writeFileSync`. If the run being inspected finishes between the check and this write — possible when the operator passes `--run <id>` for a run that is still executing, since step 3 never consults whether the lock naming that run is alive — this write replaces the run's real `report.json` (ok/test-failed) with "unknown", destroying the evidence and misreporting a finished outcome; the contract (tasks.md T038) explicitly requires an existing report to be never overwritten. Write with `openSync(reportPath, "wx")` and treat EEXIST as "already has a report", and have step 3 skip recording while the lock's recorded pid is still alive (a run in progress is not an incomplete run).

```
try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return null;
  } catch (error) {
```

Suggestion:
```
try {
    // Exclusive create: if a report appeared since the caller's existsSync
    // check (the run just finished), it is kept, never overwritten.
    const fd = openSync(reportPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null; // a report already exists; nothing to record
    }
```

## 69. [MEDIUM] src/runner/recover-run.ts:234-235 (bug)

Fail-closed violation: a lock record that parses as JSON but carries no usable `pid` (missing, a string, or written by a different schema version — `readLock` never checks `schemaVersion`) reaches `alive === false` and is then deleted as "stale". `acquireTargetLock` is the only writer and always writes a positive numeric pid, so a pid-less record means corruption/foreign edit, not a dead owner. An owner that cannot be determined must be a refusal (exactly like the `unreadable` branch above, and cli.md §9's "an unreadable lock … is never deleted"), otherwise a lock that is actively protecting a run can be released by `recover`. Treat an unusable pid as `cannotDecide` + `refused`; keep the existing alive / dry-run / release branches as the remaining `else if`s.

```
const pid = lock.record.pid;
    const alive = typeof pid === "number" && isAlive(pid);
```

Suggestion:
```
const pid = lock.record.pid;
    const ownsPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
    if (!ownsPid) {
      // The record parses but names no owner: undecidable, like an unreadable file.
      cannotDecide = true;
      findings.push({
        code: "A8N-JOB-002",
        action: "refused",
        detail: `${lock.detail}; the record names no usable pid, so its owner cannot be determined`,
        remedy: `Inspect ${lock.path} and remove it yourself; recovery will not guess.`,
      });
    } else if (isAlive(pid)) {
```

## 70. [MEDIUM] src/runner/recover-run.ts:271-273 (bug)

Fail-closed / contract gap: the `runId` joined here can be `quarantine.record.runId`, and `isQuarantineRecord` (state.ts) validates only that it is a *string* — never that it matches `RUN_ID_PATTERN`. The CLI validates `--run` (args.ts: `--run needs a run id like 20261110T120000Z-4f2a8c11`), and contract §10 says "a path fragment is a usage error ... this applies to recover too" — but the default path (the quarantined run) is record-derived and unvalidated. A malformed or hand-edited record — precisely the corruption this module otherwise refuses on — makes `join(layout.runs, runId)` escape the runs directory, after which `recordUnknown` writes a `report.json` at the escaped path and step 4 hands that path to `adapter.recover`. Validate the derived id against `RUN_ID_PATTERN` before joining it and refuse (`cannotDecide`) when it does not match, mirroring how `readQuarantine` refuses a record with the wrong shape. (`RUN_ID_PATTERN` needs to be imported from `./run-id.js`.)

```
let runDirectory: string | null = null;
  if (runId !== null) {
    runDirectory = join(layout.runs, runId);
```

Suggestion:
```
let runDirectory: string | null = null;
  if (runId !== null && !RUN_ID_PATTERN.test(runId)) {
    cannotDecide = true;
    findings.push({
      code: "A8N-JOB-002",
      action: "refused",
      detail: `the recorded run id "${runId}" does not match the run-id format; no run directory was touched`,
      remedy: `Inspect the quarantine record for target ${input.target.name} and remove it yourself; recovery will not follow it.`,
    });
  } else if (runId !== null) {
    runDirectory = join(layout.runs, runId);
```

## 71. [MEDIUM] src/runner/test-run.ts:228-235 (bug)

`writeQuarantine` is unguarded: if it throws (disk full, quota, or `quarantine/` not creatable because a file occupies the path), the exception escapes `failWith` and the timeout/uncapturable-output branches *before* `finish()` runs. Consequences: no `report.json` is written for this run, no quarantine record exists, and the `finally` still releases the lock — so the target stays runnable although the outcome is unknown, and a later `ae-a8n recover` with no `--run` finds no quarantine and no lock to derive a run id from, so it reports "nothing to recover" while the report-less run directory sits there. This is the same fail-closed class as a failed lock write: catch the failure, still call `finish()` so the report records `unknown`, surface the failed quarantine write as a finding/notice, and ensure the next run is refused (the quarantine record is the only guard the next `test` checks).

```
let quarantined = false;
  const quarantine = (detail: string): void => {
    quarantined = true;
    const path = writeQuarantine(layout, input.target.name, {
      runId,
      quarantinedAt: now().toISOString(),
      detail,
    });
```

Suggestion:
```
const quarantine = (detail: string): void => {
    quarantined = true;
    try {
      const path = writeQuarantine(layout, input.target.name, {
        runId,
        quarantinedAt: now().toISOString(),
        detail,
      });
      event("run.quarantined", detail, { path });
      notice = `${detail}. The target is quarantined at ${path}; nothing will run until a recovery clears it.`;
    } catch (error) {
      // The record could not be written: still record the run (finish() runs
      // next), and say loudly that the target is NOT guarded.
      event("run.quarantine-write-failed", messageOf(error));
      notice = `${detail}. The quarantine record could not be written: ${messageOf(error)}. ` +
        "The next run is not blocked; inspect the target before running again.";
    }
  };
```

## 72. [MEDIUM] src/runner/test-run.ts:390-394 (bug)

The session opened above (`session = await input.adapter.open(...)`) is never closed: `IsolatedSession.close()` has no production caller anywhere in the codebase — only unit tests exercise it. On Windows that leaks state: after an unknown/timeout outcome the channel run lock is deliberately left for `close()` to release (windows/runner.ts: "Leave the lock: the job may still be executing. close() releases it only after the caller has decided what to do"), and because every run uses a fresh run id, nothing ever removes `locks/<jobId>.json` from the shared channel — `recover` does not touch it either. Await `session.close()` best-effort in this finally (after the quarantine record and artifacts are written) and trace its result. Note `session` is currently block-scoped inside the try, so it must be declared before it (`let session: IsolatedSession | null = null`). Adapters' `close()` is already ownership-checked and must never quit an AE this run does not own; if leaving sessions open is intentional instead, the contract method and that comment in windows/runner.ts need to say so.

```
} finally {
    // A lock is released last: the quarantine record and artifacts are written
    // before another run could be allowed in.
    lock.lock.release();
  }
```

Suggestion:
```
} finally {
    // A lock is released last: the quarantine record and artifacts are written
    // before another run could be allowed in.
    lock.lock.release();
    if (session !== null) {
      // Best-effort: adapters' close() is ownership-checked and must never
      // quit an After Effects this run does not own.
      await session.close().catch(() => undefined);
    }
  }
```

## 73. [LOW] .github/workflows/ci.yml:124-126 (security)

This job's checkout leaves the default `persist-credentials: true`, so the workflow token stays in `.git/config` while later steps run repo and dependency code (`npm ci` executes lifecycle scripts of locked packages). The new `verify-windows` job added in publish.yml sets `persist-credentials: false`; this job should match. Low impact today because the job is scoped to `permissions: contents: read`, but it is an easy hardening.

```
- uses: actions/checkout@v5

      - uses: actions/setup-node@v5
```

Suggestion:
```
- uses: actions/checkout@v5
        with:
          persist-credentials: false

      - uses: actions/setup-node@v5
```

## 74. [LOW] .github/workflows/ci.yml:124-128 (test)

This new job's checkout does not pin `core.autocrlf`, so the tree the full suite runs against (LF vs CRLF) is whatever the current windows-latest image default happens to be. The sibling job added in this same file (`release-tooling-windows`) treats that default as important enough to set explicitly and then hard-fail-verify the result ("this job would not reproduce #16"), because CRLF checkout has broken tests here before. As written, neither full-suite tree is guaranteed: if the image default is LF, no job runs the *full* suite under CRLF (the only configuration a Git for Windows contributor has); if the default flips, this job silently starts testing a different tree. Pin it before checkout — e.g. `run: git config --global core.autocrlf true` like `release-tooling-windows` does — so what the release-candidate suite exercises on Windows is deterministic.

```
- uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
```

Suggestion:
```
- name: Check out with a pinned line-ending config
        run: git config --global core.autocrlf true

      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
```

## 75. [LOW] .github/workflows/ci.yml:130-131 (performance)

This job runs on every push/PR and reinstalls the full dependency tree from scratch each time; `actions/setup-node` has built-in caching that just needs the lock file (which exists). Same applies to `verify-windows` in publish.yml. Not a correctness problem, but it is the slowest leg of the workflow and the cache costs one line.

```
- name: Install dependencies
        run: npm ci
```

Suggestion:
```
- uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci
```

## 76. [LOW] .github/workflows/publish.yml:150-154 (test)

Same line-ending gap as the new `windows` job in ci.yml, but higher-leverage here: this is the release gate, and `npm run check` runs the entire vitest suite against a checkout whose LF/CRLF state is left to the runner image default. ci.yml's `release-tooling-windows` pins `core.autocrlf true` and verifies it, because CRLF checkout has changed test behaviour in this repo before (#16); this job — the one whose success or failure decides releasability — does not. Pin `git config --global core.autocrlf true` before this checkout (matching the sibling job and a real Git for Windows contributor's tree) so the Windows leg of the release gate tests a known, intentional configuration.

```
- uses: actions/checkout@v5
        with:
          persist-credentials: false

      - uses: actions/setup-node@v5
```

Suggestion:
```
- name: Check out with a pinned line-ending config
        run: git config --global core.autocrlf true

      - uses: actions/checkout@v5
        with:
          persist-credentials: false

      - uses: actions/setup-node@v5
```

## 77. [LOW] eslint.config.js:29-29 (maintainability)

The comment says this block covers "the plain-JavaScript runner scripts", but the pattern only matches `.mjs`. The `scripts/` directory also contains plain-JavaScript runner/release scripts (check-release.js, check-packed-package.js, check-public-api.js, check-doc-snippets.js, publish-gate.js, ...). Today they are never linted (the lint command doesn't pass them), so nothing fails — but the obvious fix for the lint-scope mismatch in `scripts` is to pass `scripts` to eslint, which would then lint those `.js` files under the unscoped block above (`projectService: true`). None of them is in any tsconfig (`tsconfig.json` includes only `src/**/*.ts`/`test/**/*.ts`), so type-aware linting would fail with "file not found in the project service" errors instead of linting cleanly. Either add `scripts/**/*.js` to this `files` list (so the whole scripts directory can be linted in one go) or explicitly ignore `scripts/*.js` if they are intentionally out of scope.

```
files: ["scripts/**/*.mjs", "test/**/*.mjs"],
```

Suggestion:
```
files: ["scripts/**/*.mjs", "scripts/**/*.js", "test/**/*.mjs"],
```

## 78. [LOW] eslint.config.js:37-38 (maintainability)

`__dirname`, `__filename` (and the `module`/`exports` pair below) are CommonJS-only globals: none of them exist in `.mjs` modules, and no linted file uses them — every file matched by this block is ESM. Declaring them makes `no-undef` accept identifiers that would throw `ReferenceError` at runtime, which is the opposite of what the list is for. The comment says these are "the Node globals these scripts use"; suggest dropping the four that ESM cannot provide.

```
__dirname: "readonly",
        __filename: "readonly",
```

Suggestion:
```
globals: {
        Buffer: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
```

## 79. [LOW] package.json:3-3 (maintainability)

The version bump to `0.1.0-alpha.2` was not carried into `package-lock.json`: this diff updates the lock's root entry (moving `acorn` to `dependencies`, adding `bin`), but both `version` fields in the lock still read `0.1.0-alpha.1`. Regenerate the lock (`npm install`) so it ships consistent with the released version — otherwise the next `npm install` produces a spurious lockfile diff and anything reading the lock reports the wrong version for this release.

```
"version": "0.1.0-alpha.2",
```

## 80. [LOW] package.json:47-48 (bug)

Swapping `prepare` for `prepack` fixes the tarball path (and is asserted by `test/package-exports.test.ts`), but it silently breaks installs from git: for a `git+https://` dependency npm/pnpm/yarn clone the repo, install its deps and run **`prepare`** — `prepack` only runs on `npm pack`/`npm publish`, never during a git install. Before this change `npm i github:ido-bata/ae-a8n` produced a built package; after it, the same command installs a package with no `dist/`, so `main`/`exports`/`bin.ae-a8n` all point at files that do not exist and the first import fails with ERR_MODULE_NOT_FOUND. If git installs are not a supported channel, that is fine — but nothing documents the limitation, so consider noting it (or gating the build some other way) rather than leaving the channel broken by accident.

```
"postbuild": "node -e \"require('node:fs').chmodSync('dist/cli.js', 0o755)\"",
    "prepack": "npm run build",
```

Suggestion:
```
"postbuild": "node -e \"require('node:fs').chmodSync('dist/cli.js', 0o755)\"",
    "prepack": "npm run build",
    // Note: installs from a git URL run `prepare`, not `prepack`, so they ship
    // without dist/. The supported install channels are npm tarballs; git
    // installs are unsupported.
```

## 81. [LOW] scripts/check-packed-package.js:152-155 (maintainability)

The new `--help` execution bypasses this script's own failure convention. If the installed bin exits non-zero (startup crash, missing runtime dependency in `dist/cli.js`), `run` throws and the failure surfaces as an uncaught `execFileSync` exception without the `::error::` annotation the `fail()` helper produces, unlike the probe a few lines below which is wrapped and its stderr unwrapped. Wrap it and route through `fail()` so CI shows the cause as an annotation with the child's stderr.

```
const help = run(process.execPath, [binPath, "--help"], { cwd: workdir });
  if (!help.includes("doctor")) {
    fail(`${binRelative} --help does not describe doctor`);
  }
```

Suggestion:
```
let help;
  try {
    help = run(process.execPath, [binPath, "--help"], { cwd: workdir });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    fail(`${binRelative} --help failed: ${stderr.trim() || String(error.message)}`);
  }
  if (!help.includes("doctor")) {
    fail(`${binRelative} --help does not describe doctor`);
  }
```

## 82. [LOW] scripts/isolated-session/ae-e2e.mjs:32-35 (bug)

A flag as the last argv element assigns `undefined` to its option (e.g. `--pkg` with no value), which later surfaces as a bare `TypeError` from `join(undefined, …)` instead of a usage message; unknown flags are also silently ignored, so a typo like `--pakcage` runs the whole e2e with defaults. Validate that a value follows each flag and throw a usage error for unrecognized arguments.

```
if (arg === "--pkg" || arg === "--report" || arg === "--session-root") {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
      index += 1;
    }
```

Suggestion:
```
if (arg === "--pkg" || arg === "--report" || arg === "--session-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
```

## 83. [LOW] scripts/isolated-session/ae-e2e.mjs:64-66 (bug)

Fail-open on an unknown console: if `stat /dev/console` fails, `consoleUid` stays `-1`, so `isolated` becomes `true` for an *unreadable* console and the guard at line 113 passes — treating "cannot tell" as "isolated". Everywhere else in this change set the unknown is a refusal: `assertTargetSession` (session-rules.mjs) throws when the console uid is not a non-negative integer, and session-agent's `consoleIsOwn` treats an unreadable console as "own" and refuses to run. The report's `isolated` flag is what `readReport` in run-in-isolated-session.mjs later trusts, so this should fail closed like the other checks: `consoleUid < 0` → not isolated.

```
consoleUid,
    isolated: consoleUid !== uid,
  };
```

Suggestion:
```
consoleUid,
    // An unreadable console (-1) is not proof of isolation; treat it as
    // "not isolated" so the guard below refuses instead of proceeding.
    isolated: consoleUid >= 0 && consoleUid !== uid,
  };
```

## 84. [LOW] scripts/isolated-session/ae-e2e.mjs:108-108 (bug)

This top-level `await import(...)` — and `sessionIdentity()` above it, whose `execFileSync("id", ["-un"])` sits outside any try — run before the `try` block, so a missing/corrupt package, an undefined `--pkg` value, or an identity failure exits without ever calling `finish()`. No report file is written, and the controller only consults the report on exit 0 (`readReport` in run-in-isolated-session.mjs), so the run produces no diagnostic evidence at all. Move the import and identity probe inside the try (or wrap top-level setup) so `finish("failed", …)` always writes the report.

```
const { AfterEffects } = await import(join(options.pkg, "dist", "index.js"));
```

Suggestion:
```
let AfterEffects;
let ae = null;
try {
  ({ AfterEffects } = await import(join(options.pkg, "dist", "index.js")));
```

## 85. [LOW] scripts/isolated-session/ae-e2e.mjs:193-193 (bug)

`finish()` treats every step whose status is not `"ok"` as a failure (see the `failedSteps` filter), so recording `"skipped"` here guarantees the report flips to `failed` — contradicting the comment above that a non-quit close is "the library working, not a failure of this run". The status name promises tolerance that `finish()` does not deliver: either record `"ok"` with the reason when a non-quit close is acceptable, or record `"failed"` if a lingering After Effects should fail the run.

```
record("close", closed.quit ? "ok" : "skipped", closed);
```

Suggestion:
```
record("close", closed.quit ? "ok" : "failed", closed);
```

## 86. [LOW] scripts/isolated-session/analyze-focus.mjs:36-36 (bug)

`focus-watch.swift` emits `keys=gapped(N)` for a tap that *was* started and later disabled — watched, but with holes. With this exact-literal check, a log whose samples are all gapped prints `key input: NOT MONITORED (the witness could not watch key events…)` immediately followed by `key input gaps: the tap was disabled N time(s)` — two contradictory statements about the same measurement. Treat `gapped(N)` as watched and let the gaps line carry the caveat.

```
keysWatched: keysField === "keys=watched",
```

Suggestion:
```
keysWatched: keysField === "keys=watched" || gapMatch !== null,
```

## 87. [LOW] scripts/isolated-session/analyze-focus.mjs:98-98 (bug)

`KeyWatch.total` in focus-watch.swift increments for every event the tap delivers — including programmatically posted keys (otherwise `programmaticCount` could never be non-zero) and `flagsChanged` modifier events, both of which are in the tap mask. Labeling the raw total "(typed by the human)" overstates the attribution exactly when `programmatic > 0`. Subtract the programmatic count (and note that modifier events are included) or relabel.

```
console.log(`key events seen: ${keys} (typed by the human)`);
```

Suggestion:
```
console.log(`key events seen: ${keys} total, ${programmatic} posted programmatically (the rest may be typed input; modifier events included)`);
```

## 88. [LOW] scripts/isolated-session/dispatch.mjs:63-63 (bug)

`--timeout` is not validated: `--timeout abc` yields `NaN`, so `deadline = Date.now() + NaN` is `NaN` and `Date.now() >= deadline` is never true — the poll loop waits forever instead of refusing an ambiguous input (the same applies to `--timeout` in run-in-isolated-session.mjs). Validate a finite positive number in `parseArgs`.

```
timeoutMs = Number(argv[index + 1]);
```

Suggestion:
```
timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`--timeout expects a positive number of milliseconds`);
      }
```

## 89. [LOW] scripts/isolated-session/dispatch.mjs:195-196 (maintainability)

`session-rules.mjs` states that every trust rule is "kept in one file … where it is checked", and exports the predicate as `resultFileIsTrusted` (used by run-in-isolated-session.mjs via `assertTrustedSharedFile`). This function re-implements the same three checks inline instead of `lstatSync` + `resultFileIsTrusted`, so the two controllers can silently drift when the trust rule is strengthened — a security predicate with three copies of its logic (session-rules, dispatch, and the mode checks' error text) is how one copy ends up weaker than the others. Import the shared predicate here and keep only the error messages local.

```
export function assertTrustedResult(path, targetUid) {
  const info = lstatSync(path);
```

Suggestion:
```
export function assertTrustedResult(path, targetUid) {
  const info = lstatSync(path);
  if (!resultFileIsTrusted(info, targetUid)) {
    throw new Error(`the result ${path} is not a regular file owned by uid ${targetUid} that nobody else can change; it is not trusted.`);
  }
```

## 90. [LOW] scripts/isolated-session/dispatch.mjs:353-355 (bug)

On timeout the job file is never withdrawn. The controller owns it (the sticky 1777 directory lets the owner delete it), but nothing does: if the agent was merely slow to start, it will later run this abandoned job unattended — an execution whose session evidence no controller will ever validate — and the stale `.job.json` (plus a later `.result.json`) linger in the shared root across runs. A best-effort `rmSync(jobPath, { force: true })` before throwing narrows the window (documenting that an agent which already read the file may still run it).

```
if (Date.now() >= deadline) {
      throw new Error(`the job ${id} did not finish within ${options.timeoutMs}ms; no result was produced`);
    }
```

Suggestion:
```
if (Date.now() >= deadline) {
      // Withdraw the job we own so a slow agent cannot run it long after
      // this controller gave up on validating its result. An agent that
      // already read the file may still run it; that race cannot be closed
      // from here.
      rmSync(jobPath, { force: true });
      throw new Error(`the job ${id} did not finish within ${options.timeoutMs}ms; no result was produced`);
    }
```

## 91. [LOW] scripts/isolated-session/dispatch.mjs:356-356 (performance)

Spawning a `sleep` child process every 500 ms tick for up to 15 minutes (~1,800 processes per run) where an awaited timer promise suffices; the same pattern is copied into both poll loops of run-in-isolated-session.mjs. Replace with `await new Promise(done => setTimeout(done, 500))` in each loop.

```
execFileSync("sleep", ["0.5"]);
```

Suggestion:
```
await new Promise((done) => setTimeout(done, 500));
```

## 92. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:325-327 (security)

JSON string quoting is not sh quoting: these lines land in a script executed by `/bin/sh` inside the target session, where inside double quotes `$` and backticks are still expanded. A `--root` containing `$…` or `` … `` is expanded at job-launch time (or silently corrupts ROOT/COMMAND/OUT/ERR/DONE, so the launcher writes results to paths the controller never polls) — even though the very same root value written into the `.cmd` file above goes through `shellQuote`, which is sh-safe. The two artifacts should use the same quoting; `shellQuote` is already exported from session-rules.mjs.

```
`ROOT=${JSON.stringify(root)}`,
      `ID=${JSON.stringify(id)}`,
      `COMMAND=${JSON.stringify(commandPath)}`,
```

Suggestion:
```
`ROOT=${shellQuote(root)}`,
      `ID=${shellQuote(id)}`,
      `COMMAND=${shellQuote(commandPath)}`,
```

## 93. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:332-332 (bug)

POSIX mode issue: `$OUT`, `$ERR` and `$DONE.tmp` are created by shell redirection with mode `0666 & ~umask`, while `assertTrustedSharedFile` (`resultFileIsTrusted`) refuses any file with a group/other write bit. On a target account with umask 002 (common on shared machines) these come out 664, so *every* terminal-substrate run is refused as untrusted after the test has already executed — a systematic false refusal, fail-closed but unfixable from the controller. The native path is immune because the agent writes results with an explicit `mode: 0o644`. Set `umask 022` at the top of the launcher (or `chmod 644` the three files before publishing `.done`).

```
'/bin/sh "$COMMAND" > "$OUT" 2> "$ERR"',
```

Suggestion:
```
'umask 022',
      '/bin/sh "$COMMAND" > "$OUT" 2> "$ERR"',
```

## 94. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:335-338 (bug)

Same fail-open pattern as ae-e2e's identity check: if `stat /dev/console` fails inside the job, `onconsole` stays `0`, and `parseTerminalResult` maps anything but `1` to `onConsole: false` — so an unreadable console is reported as "did not run on the console", which is exactly what `assertOutcomeSession` must believe to accept the run. The job-side self-report plus the post-hoc asid comparison are the terminal substrate's evidence that a fast user switch did not put the job on the human's desktop. If the console owner cannot be read, the launcher should abort without publishing `.done` (the controller then times out and refuses) rather than defaulting to the safe-looking value.

```
'onconsole=0',
      // The console's owner, read from inside the job: 1 means this job ran
      // on the desktop the human is looking at.
      'if [ "$(/usr/bin/stat -f %u /dev/console)" = "$(/usr/bin/id -u)" ]; then onconsole=1; fi',
```

Suggestion:
```
'consoleuid=$(/usr/bin/stat -f %u /dev/console 2>/dev/null)',
      // The console's owner, read from inside the job: 1 means this job ran
      // on the desktop the human is looking at. If it cannot be read, do
      // not publish a result claiming anything — the controller then times
      // out and refuses rather than believing the default.
      'if [ -z "$consoleuid" ]; then exit 0; fi',
      'onconsole=0',
      'if [ "$consoleuid" = "$(/usr/bin/id -u)" ]; then onconsole=1; fi',
```

## 95. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:355-359 (bug)

`--timeout` never bounds this call: the spawn blocks the process (no `timeout` option), and the poll deadline is only computed *after* `session open` returns (line 373). A wedged offstage session helper therefore hangs the controller indefinitely — the documented contract "did not finish within Xms; no result was produced" never triggers. Every other external call in this file is bounded (`readOffstageStatus` 30s, `commandOutput` 10s); pass a `timeout` to this `spawnSync` (or run it through the same deadline) so the refusal still happens.

```
const opened = spawnSync(
    "offstage",
    ["session", "open", "--user", options.user, "--", "-a", "Terminal", launcherPath],
    { stdio: "inherit", shell: false },
  );
```

Suggestion:
```
const opened = spawnSync(
    "offstage",
    ["session", "open", "--user", options.user, "--", "-a", "Terminal", launcherPath],
    { stdio: "inherit", shell: false, timeout: options.timeoutMs },
  );
```

## 96. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:422-424 (bug)

Dead/misfiring branch: dispatch.mjs never exits 69 — its refusal paths set `process.exitCode = 1` or the child's own code (verified: no `69` anywhere in dispatch.mjs). So this check can never mean "the session agent did not run the job", while a command that legitimately exits 69 would be misreported as "nothing ran anywhere". Either define the contract (dispatch exits 69 on refusal, mirroring offstage's convention used in `runOffstage`) or drop this check and rely on dispatch's stderr, which already states the refusal reason.

```
if (child.status === 69) {
    throw new Error("the session agent did not run the job; nothing ran anywhere.");
  }
```

Suggestion:
```
// dispatch.mjs reports its own refusals on stderr and exits 1 (or the
  // command's own code); there is no separate "did not run" status to map.
```

## 97. [LOW] scripts/isolated-session/run-in-isolated-session.mjs:473-478 (style)

Nested ternary, which the project's style rules prohibit — and the fall-through `else` is exactly where the previously flagged unvalidated `--substrate` typo silently lands in `runOffstage`. A handler map makes the nesting go away and gives the unknown value a refusal at the same time.

```
const status =
    options.substrate === "native"
      ? runNative(options, targetUid)
      : options.substrate === "terminal"
        ? runTerminal(options, targetUid)
        : runOffstage(options);
```

Suggestion:
```
const substrates = {
    native: () => runNative(options, targetUid),
    terminal: () => runTerminal(options, targetUid),
    offstage: () => runOffstage(options),
  };
  const run = substrates[options.substrate];
  if (run === undefined) {
    throw new Error(
      `unknown substrate "${options.substrate}"; expected one of ${Object.keys(substrates).join(", ")}`,
    );
  }
  const status = run();
```

## 98. [LOW] scripts/isolated-session/session-agent.mjs:307-307 (style)

Nested ternary on one line, banned by the project's style rules and hard to read: the non-numeric `error.code` case (spawn failure, or a signal kill where `code` is undefined but `signal` is set) silently collapses to 1, and the null/undefined test is duplicated. Extracting a small outcome mapper would also let a signal-killed job be reported distinctly instead of looking like an ordinary exit 1.

```
exitCode: typeof outcome.error?.code === "number" ? outcome.error.code : outcome.error === null || outcome.error === undefined ? 0 : 1,
```

Suggestion:
```
exitCode: exitCodeOf(outcome.error),
    // where:
    // function exitCodeOf(error) {
    //   if (error === null || error === undefined) return 0;
    //   return typeof error.code === "number" ? error.code : 1;
    // }
```

## 99. [LOW] scripts/isolated-session/session-agent.mjs:322-322 (other)

Unlike dispatch.mjs and run-in-isolated-session.mjs (which wrap `main()` in try/catch and print "…refused: <message>"), this top-level `await main()` has no handler. Refusals that are designed as `throw`s escape as unhandled rejections with a stack trace instead of the friendly pattern — notably `ensureSharedDir`'s carefully worded "No job is run" refusal thrown at startup, and the awaited `appendFile(logPath, …)` header write in `runJob` (logs dir unwritable after startup). Under Node's default unhandled-rejection behavior the agent still exits non-zero, so nothing fails open, but every designed refusal in this file should get the same wrapping as its siblings: wrap the call and print `session agent refused: <message>`.

```
await main();
```

Suggestion:
```
try {
  await main();
} catch (error) {
  process.stderr.write(
    `[ae-a8n session agent] refused: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
```

## 100. [LOW] scripts/isolated-session/session-rules.mjs:48-52 (documentation)

This JSDoc block is orphaned: it is immediately followed by a second JSDoc block, so it documents nothing (the second block is what attaches to `assertOutcomeSession`). A reader scanning for which function "A result is only believed when it names the session it was asked to run in" describes will be confused — it reads more like the summary line intended for `assertResultSession`. Delete this block or merge its sentence into the `assertOutcomeSession`/`assertResultSession` doc.

```
/**
 * A result is only believed when it names the session it was asked to run in.
 */
/**
 * The result of a job that ran in the target session.
```

## 101. [LOW] scripts/isolated-session/session-rules.mjs:253-255 (bug)

The mask requires sticky + other-write but not other-execute, so a directory with a mode such as `0o1702` (sticky, other `w`, no other `x`) returns `true` even though no non-owner can create or open an entry in it — `ensureSharedDir` in dispatch.mjs and session-agent.mjs then accepts the directory and the run later dies with a raw `EACCES` from `writeFileSync`/`lstat` instead of the intended "nothing was run / no job is run" refusal. The owning account's side is unchecked as well: a mode like `0o1003` passes although the owner itself has no permission to write results there. This stays fail-closed (the later operation still errors), but the predicate's contract — "whether a shared directory already has the mode both accounts expect" — is not actually met by every mode it accepts. Require at least sticky + other w/x, plus the owner's rwx: `(mode & 0o1703) === 0o1703`.

```
export function sharedDirIsUsableForOthers(mode) {
  return (mode & 0o1002) === 0o1002;
}
```

Suggestion:
```
export function sharedDirIsUsableForOthers(mode) {
  // sticky + other w/x (the non-owner must be able to create and traverse)
  // and owner rwx (the owning account must be able to list and write there).
  return (mode & 0o1703) === 0o1703;
}
```

## 102. [LOW] scripts/probe-windows.mjs:43-46 (other)

The file header promises "one JSON document on stdout" and "Exit: 0 when no check is a blocker, 3 when one is", but there is no error handling around the probe call: if probeWindows rejects (e.g. the command runner fails to spawn PowerShell), the rejection escapes unhandled — no JSON is printed at all and the process exits 1, outside the documented 0/3 contract. A consumer parsing stdout gets an empty document instead of a structured report. Wrap the call and emit a structured error document (or document exit 1 as the failure path in the header) so the contract holds on every path.

```
const result = await probeWindows(new SpawnCommandRunner(), {
  isolation: isolationArgument,
  targetUser,
});
```

Suggestion:
```
let result;
try {
  result = await probeWindows(new SpawnCommandRunner(), {
    isolation: isolationArgument,
    targetUser,
  });
} catch (error) {
  // The header promises one JSON document and exit 0/3; a crashed probe must
  // still produce a structured document and a documented non-zero exit.
  process.stdout.write(
    `${JSON.stringify(
      { schemaVersion: "1.0", command: "probe-windows", status: "error", detail: String(error) },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}
```

## 103. [LOW] src/api/errors.ts:82-82 (bug)

`declared` stores the caller's array by reference, and in practice the caller passes the session's live `#extensionMethods` (from `AfterEffects.call`). A consumer that mutates the caught error's `.declared` silently changes what the session will accept on the next call — the same shared-state exposure as `AfterEffects.extensionMethods()`. Store a copy, or freeze the array where it is created so both sites are covered.

```
this.declared = declared;
```

Suggestion:
```
this.declared = [...declared];
```

## 104. [LOW] src/api/index.ts:121-122 (bug)

`readGuiSession` shells out to `launchctl`, which does not exist on Windows. With the Windows backend and `session.recover: true`, the spawn fails, the failure text does not match the permission pattern, and the caller gets "uid N has no login session on this Mac — log that user in" for a Windows run. The refusal is fail-safe, but the message sends the caller to macOS troubleshooting. Refuse explicitly with a platform message instead (LaunchOptions.session is documented as the macOS login session).

```
function requireSession(uid: number): MacSession {
  const session = readGuiSession(uid);
```

Suggestion:
```
function requireSession(uid: number): MacSession {
  if (process.platform !== "darwin") {
    throw new AfterEffectsError(
      `session.recover is the macOS GUI fallback and is not available on ${process.platform}; nothing was started`,
      "session.launch",
    );
  }
  const session = readGuiSession(uid);
```

## 105. [LOW] src/api/index.ts:274-274 (bug)

`options.session` is the only LaunchOptions field with no runtime validation, unlike `timeoutMs` (`optionalTimeout`), `hostEnvironment` (`requireEnvironment`) and `hostScript`. Two concrete failures for JS callers: (1) `session: null` passes the `=== undefined` test and crashes here with a raw `TypeError: Cannot read properties of null` before anything is explained; (2) a non-boolean `recover` (e.g. `recover: "true"`) fails the `=== true` check below and *silently* disables the GUI fallback that `showModalDialog`'s contract relies on — the same silent-drop shape as supplying a custom transport. Validate the option once at the top of `launch`: `uid` must be a positive integer and `recover`, when present, a boolean, refusing with a `TypeError` naming the field, as the rest of this file does.

```
...(options.session === undefined ? {} : { sessionUid: options.session.uid }),
```

Suggestion:
```
...(options.session === undefined ? {} : { sessionUid: requireSessionOption(options.session).uid }),
```

## 106. [LOW] src/api/index.ts:295-299 (bug)

This catch maps *every* read failure — EACCES, EISDIR (a directory passed as `hostScript`), ELOOP — to "host script not found", sending the caller to look for a file that exists. The refusal itself is right (fail closed); only the reported cause is wrong. Include the underlying reason.

```
try {
        source = readFileSync(hostScript, "utf-8");
      } catch {
        throw new AfterEffectsError(`host script not found: ${hostScript}`, "session.launch");
      }
```

Suggestion:
```
try {
        source = readFileSync(hostScript, "utf-8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new AfterEffectsError(
          `host script not readable: ${hostScript} (${reason})`,
          "session.launch",
        );
      }
```

## 107. [LOW] src/api/index.ts:362-363 (bug)

`name` is validated with `requireString` but `params` is forwarded unchecked — the only public method here that sends caller-supplied params verbatim. A JS caller passing `null` or an array crosses the whole launch path and fails later with an opaque error: a raw `JSON.stringify` TypeError from `writeRequest` for a cyclic value or BigInt, or — on the real host — an extension method receiving `null`/an array instead of the parameter object the contract promises (the fake host rejects it via `parseRequestEnvelope` as a ProtocolError, so the two hosts disagree on the same input). Validate that `params` is a non-array object here, the way `requireEnvironment` does for `hostEnvironment`.

```
requireString(name, "name");
    requireOwned(this.#session, "extension.call");
```

Suggestion:
```
requireString(name, "name");
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw new TypeError("params must be an object");
    }
    requireOwned(this.#session, "extension.call");
```

## 108. [LOW] src/api/index.ts:371-373 (bug)

`extensionMethods()` hands out the live internal array — the same instance stored on `ExtensionMethodNotFoundError.declared`. A JS caller can `push` a name onto it and defeat the guarantee (contracts/extensions.md §4) that an undeclared name is "refused before a request is written": the name then crosses to the host, where a built-in-looking entry reaches `dispatch` without the extra safeguards the normal API applies (for example `stop()` sends `app.quit` with a `require` session marker on `verifiesDestination` transports; a raw `call("app.quit")` would not). Return a copy, or freeze the array once in the constructor so both this accessor and the thrown error expose read-only state.

```
extensionMethods(): readonly string[] {
    return this.#extensionMethods;
  }
```

Suggestion:
```
extensionMethods(): readonly string[] {
    return [...this.#extensionMethods];
  }
```

## 109. [LOW] src/cli/agent.ts:69-74 (bug)

The token after a value flag is skipped without being inspected, so a flag appearing in value position is reported against the wrong token: `ae-a8n agent --channel --host node2` fails with `unknown option node2` instead of `--channel needs a value`, and `--host --user alice` reports `unknown option alice`. The exit code is still 2, but the message cannot point the user at the flag actually missing its value. Every agent flag starts with `--` and no real value (path, host, user) does, so a skipped token starting with `--` should surface as `<flag> needs a value` — the same rule `agent-main.ts` and `detachAgent`'s `checkArguments` already apply. (Returning a discriminated result instead of a bare token would let `runAgentCommand` print the right sentence.)

```
if (!AGENT_FLAGS.has(token)) {
      return token;
    }
    if (VALUE_FLAGS.has(token)) {
      index += 1;
    }
```

## 110. [LOW] src/cli/args.ts:452-457 (maintainability)

`json` is computed for these two variants but never read anywhere: run.ts's `parsed.kind === "help"`/`"version"` branches print plain text unconditionally, so `ae-a8n --version --json` and `ae-a8n --help --json` put human text on stdout even though `contracts/cli.md` §3 says that with `--json` stdout contains exactly one JSON document. The unread field suggests an unfinished path. Either honour the flag (emit an envelope for version/help) or drop the field and document that help/version ignore `--json`.

```
if (first === "--help" || first === "-h") {
    return { ok: true, kind: "help", command: null, json: wantsJson };
  }
  if (first === "--version" || first === "-V") {
    return { ok: true, kind: "version", json: wantsJson };
  }
```

## 111. [LOW] src/cli/extension.ts:179-180 (bug)

`valueOf` finds the first occurrence and takes the next token unchecked, so this parser accepts what the five contract commands reject: unknown flags after `build` (e.g. `--extensions`, `--outfile`) are silently ignored, a duplicated flag keeps only the first value, and `extension build --extension --out file` sets `extension = "--out"`, which resolves to `<cwd>/--out` and is reported as an import failure (exit 1) rather than the usage error (exit 2) it is. Parsing `argv` with the same strict loop as `src/cli/args.ts` — unknown flag → exit 2, value starting with `--` → `--extension needs a value` — would make typos fail the way they do everywhere else in the CLI.

```
const extension = valueOf(argv, "--extension");
  const out = valueOf(argv, "--out");
```

## 112. [LOW] src/cli/run.ts:809-818 (test)

Both branches run before `dependencies(input)`, so the injected `writeOut`/`writeErr`/`env` seams never apply to them: `runExtensionCommand` already accepts `{ writeOut, writeErr }` but is called without them, and `runAgentCommand` writes to `process.stdout/stderr` directly — `runCli(argv, { writeOut })` therefore silently fails to capture output for these two commands, unlike every contract command. Also, `result.exitCode as ExitCode` casts an unchecked number into the contract exit-code type; the helpers happen to return only 0/1/2 today, but nothing enforces that. Move `dependencies(input)` above the dispatch, pass the writers through (e.g. to `runExtensionCommand`), and type the helpers' `exitCode` as `ExitCode` instead of casting.

```
if (argv[0] === "agent") {
    const result = await runAgentCommand(argv.slice(1));
    return result.exitCode as ExitCode;
  }

  if (argv[0] === "extension") {
    const result = await runExtensionCommand(argv.slice(1));
    return result.exitCode as ExitCode;
  }
  const deps = dependencies(input);
```

Suggestion:
```
const deps = dependencies(input);
  if (argv[0] === "agent") {
    const result = await runAgentCommand(argv.slice(1));
    return result.exitCode as ExitCode;
  }

  if (argv[0] === "extension") {
    const result = await runExtensionCommand(argv.slice(1), {
      writeOut: deps.writeOut,
      writeErr: deps.writeErr,
    });
    return result.exitCode as ExitCode;
  }
```

## 113. [LOW] src/doctor/diagnostics.ts:43-50 (style)

Key `A8N-SESSION-006` is declared before `A8N-SESSION-005`, breaking the numeric ordering of an otherwise ordered registry, and the "reviewed copy" this doc comment points to (`specs/isolated-ae/contracts/cli.md` §5) lists 005 before 006. Both codes are emitted (005 in src/driver/mac-session.ts, 006 in src/platform/windows/runner.ts) and `test/diagnostics.test.ts` compares sorted sets, so nothing fails — but the mismatch makes manual audits against the contract harder. Swap the two blocks so the registry matches the contract's order.

```
"A8N-SESSION-006": {
    severity: "blocker",
    title: "The named remote host is this controller's own machine",
  },
  "A8N-SESSION-005": {
    severity: "blocker",
    title: "The controller cannot enter the target session",
  },
```

Suggestion:
```
"A8N-SESSION-005": {
    severity: "blocker",
    title: "The controller cannot enter the target session",
  },
  "A8N-SESSION-006": {
    severity: "blocker",
    title: "The named remote host is this controller's own machine",
  },
```

## 114. [LOW] src/doctor/index.ts:29-32 (maintainability)

The regex requires a trailing dot, so a bare major version (e.g. `v22`) returns `null` and A8N-ENV-002 is reported as "could not be parsed" paired with a remedy to install Node 22+ — misleading for what is only a parse edge case (it fails safe by blocking, so not urgent; real `process.version` always has minor.patch). Also, an identical private copy of `nodeMajor` exists at src/platform/darwin/adapter.ts:235 (duplicate code): export one shared helper from here — the darwin adapter already imports `NODE_FLOOR_MAJOR` from this module — and make the pattern accept a bare major.

```
function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}
```

Suggestion:
```
export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match === null ? null : Number(match[1]);
}
```

## 115. [LOW] src/driver/driver.ts:419-419 (maintainability)

Both this `session.recover` record and the recovered `op` record below pass a hardcoded duration of `0`, while the normal path records `Date.now() - began`. The trace then claims these operations took no time, so `trace.jsonl` / `traceEvents` cannot show how long the recovery or the grace wait actually took — misleading when diagnosing a slow or hanging recovery. Suggestion: capture `const began = Date.now()` before `recovery.attempt(...)` and pass real elapsed milliseconds for both records.

```
this.#trace.record("session.recover", outcome.recovered ? "ok" : "error", 0, {
```

Suggestion:
```
const recoverBegan = Date.now();
    this.#trace.record("session.recover", outcome.recovered ? "ok" : "error", Date.now() - recoverBegan, {
```

## 116. [LOW] src/driver/gui-recovery.ts:108-112 (bug)

A window title containing `|` (the field separator) shifts every later slot: `parts[2]`/`parts[3]` would be read from title fragments, so `role`/`subrole` are wrong and `isBlockingWindow` can classify a real dialog as non-blocking — the recovery then reports "has no modal window; timed out for another reason" while the host is in fact blocked — and the title-based identity check in `pressButton` plus the evidence string in `describeWindow` degrade (a full title never equals the truncated one, so presses are refused as `CHANGED`). Note the AppleScript already sanitises static texts (`a8nClean` replaces `|` with a space), but window titles, roles, subroles and the `B` line's title/description are not sanitised. Suggestion: run the W/B fields through the same cleaner in the script, or use a delimiter that cannot occur in UI text.

```
if (parts[0] === "W") {
      windows.push({
        title: parts[1] ?? "",
        role: parts[2] ?? "",
        subrole: parts[3] ?? null,
```

Suggestion:
```
if (parts[0] === "W") {
      windows.push({
        title: parts[1] ?? "",
        // Fields are sanitised by `a8nClean` in the script; still parse
        // defensively so a stray separator cannot shift role/subrole.
        role: parts[2] ?? "",
        subrole: parts[3] ?? null,
```

## 117. [LOW] src/driver/gui-recovery.ts:226-227 (bug)

`static texts of w` just above is deliberately guarded with `try`/`on error`, but this `buttons of w` enumeration is not. If the access raises (a window that does not expose buttons, or one that closes mid-enumeration — plausible exactly while dialogs appear and disappear during a recovery), osascript exits non-zero, `#osascript` throws, and `listWindows()` discards every `W|`/`T|` record already collected: the recovery reports "the target session could not be inspected" instead of classifying the blocking window it had just seen. Guarding the enumeration the same way as `wtexts` (empty list on error) keeps a partial listing; safety is unaffected — the allow-list classifier and the press's identity check still decide whether anything may be pressed, and a window with no listed buttons ends in the existing `refused` outcome.

```
"      end repeat",
      "      repeat with b in buttons of w",
```

## 118. [LOW] src/driver/gui-recovery.ts:411-414 (maintainability)

Dead code: `blockingWindows()` has no caller anywhere in `src/`, `test/` or `scripts/`. The recovery path does its own classification through `chooseRecoveryWindow` in `recovery.ts`, so this second entry point to the same rule is never exercised — if the two ever diverge, nothing notices. Delete it, or use it from the recovery policy so there is one classification path.

```
/** The windows that keep the application from taking a script. */
  blockingWindows(): GuiWindowInfo[] {
    return this.listWindows().windows.filter(isBlockingWindow);
  }
```

## 119. [LOW] src/driver/gui-recovery.ts:530-530 (maintainability)

Dead code: exported as a "test seam" but referenced nowhere — not in `src/`, `test/`, or `scripts/` — so in practice a screenshot is only validated by `capture()`'s exit status, never by its content/size. Either assert it in the recovery tests (where the comment says it belongs) or remove the export.

```
export function screenshotLooksReal(path: string): boolean {
```

## 120. [LOW] src/driver/mac-session.ts:133-133 (other)

`readGuiSession` (called by the `ScriptInvocationTransport` constructor), `readGuiSessionFailure`, `readUsername` and `consoleSessionUid` all call `execFileSync` with no `timeout`, unlike `listAppInstances` (15 s). A wedged `launchctl`/`id`/`stat` would block the driver constructor or the `MacGuiRecovery` console-session refusal check indefinitely — a hang in code whose purpose is to bound waits. Suggestion: add a bounded timeout (e.g. 10–15 s) and route the timeout through the existing failure paths (null / `uid-<n>` / -1).

```
text = execFileSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
```

Suggestion:
```
text = execFileSync("launchctl", ["print", `gui/${uid}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
```

## 121. [LOW] src/driver/mac-session.ts:162-167 (style)

Nested ternary — prohibited by the project's review checklist, and awkward to extend when a third stderr shape appears. Suggest extracting a small helper next to this function.

```
const text =
      typeof stderr === "string"
        ? stderr
        : stderr instanceof Buffer
          ? stderr.toString("utf-8")
          : "";
```

Suggestion:
```
const text = stderrText(stderr);
```

## 122. [LOW] src/driver/mac-session.ts:200-202 (maintainability)

Dead code: `listAppInstances()` has no caller anywhere in src/, test/, or scripts/ — `parseLsappinfo` is exercised directly by `test/macos-session.test.ts`, but this wrapper (the only production use of `lsappinfo`) is never invoked, so the `MacAppInstance` session-binding story it documents is not actually wired into the driver. Remove it for the release, or hook it up where the session/app binding needs it; shipping an unreferenced entry point invites the assumption that something depends on it.

```
export function listAppInstances(): MacAppInstance[] {
  let text: string;
  try {
```

## 123. [LOW] src/driver/mac-session.ts:294-297 (maintainability)

`options.timeoutMs` is declared but never read: unlike `run()`, which passes it to `execFileSync`, this body schedules no timer and never signals the child. A caller passing `timeoutMs` would reasonably believe the child process is bounded by it — it isn't; the child runs until it exits on its own. Either wire it (timer → kill on expiry) or remove it from the options type so the API does not promise a deadline it does not enforce.

```
options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly onStderr?: (chunk: string) => void;
```

Suggestion:
```
options: {
    readonly cwd?: string;
    readonly onStderr?: (chunk: string) => void;
```

## 124. [LOW] src/driver/mac-session.ts:368-373 (maintainability)

This ~5-line refusal is duplicated verbatim in `runInSession` and `spawnInSession` (only the final verb differs: "No command was sent" vs "Nothing was started"). A wording fix or a new refusal condition has to be made in three places, and the copies can — and already do — drift. Suggestion: extract a shared helper, e.g. `sessionRefusal(command: string, createdVerb: string): MacSessionError`, so the refusal contract stays identical across the three entry points.

```
throw new MacSessionError(
    `cannot start ${command} in the session of ${target.username} (uid ${target.uid}): this process runs as ` +
      `uid ${currentSession().uid} and is not root, so it cannot enter another user's session. ` +
      "Run the test from inside that user's session, or as root with launchctl asuser. " +
      "Nothing was started in the console session.",
  );
```

Suggestion:
```
throw sessionRefusal(command, target, "Nothing was started");
```

## 125. [LOW] src/driver/recovery.ts:330-330 (bug)

Unlike the constructor and `listWindows()` above, which are mapped to a `refused` outcome, a failure during the press escapes `#attempt` and rejects `attempt()`: `#osascript` throws on any non-zero exit (the host exiting mid-recovery, a 60 s osascript timeout), and `pressButtonIn`'s coordinate path re-lists and can throw too. The driver's catch then keeps only `{name, message}` in the trace — the screenshot path and `description` gathered just above are dropped, and `RecoveryOutcome`'s documented role ("how the attempt ended") never reports this ending. Wrap the loop in try/catch and return a `refused` outcome carrying the evidence already collected, so every ending is a value rather than an exception.

```
for (const title of this.#buttons) {
```

## 126. [LOW] src/driver/script-invocation.ts:207-208 (maintainability)

Dead field: no parser ever sets `sessionId` (`parsePsProcesses` fills only `pid`/`uid`/`startedAt`/`executable`; `parseWindowsProcessList` fills `identity`/`parentPid`), and nothing in `src/`, `test/` or `scripts/` reads it — the only source that could populate it (`lsappinfo` / `listAppInstances`) is itself unused (see the confirmed `listAppInstances` finding). A field that documents macOS session binding but is never populated invites future readers to trust it. Remove it, or wire it into the session scoping it describes.

```
/** macOS: the login session the process lives in, when the window server knows it. */
  readonly sessionId?: number | null;
```

## 127. [LOW] src/driver/script-invocation.ts:834-838 (bug)

Fail-open in a change whose stated rule is that unproven state is refused: `p.uid === undefined` is read as "this session's process". `parsePsProcesses` always sets uid today, but `HostProcess.uid` is optional (the Windows parser omits it) and the injected `processes` seam can supply a list without uid — such a process then counts as this run's instance and feeds `recoveryTargetPid` and `confirmLaunched`'s ownership evidence. Suggestion: on darwin require `p.uid === this.#sessionUid` and let `undefined` fail as "not ours"; production behaviour is unchanged because the uid column is always parsed.

```
return all.filter(
        (p) =>
          p.executable === this.#install.executable &&
          (p.uid === undefined || p.uid === this.#sessionUid),
      );
```

Suggestion:
```
return all.filter(
        (p) =>
          p.executable === this.#install.executable &&
          p.uid === this.#sessionUid,
      );
```

## 128. [LOW] src/platform/contract.ts:60-61 (bug)

The consent gate this doc promises is not implemented anywhere: `DarwinAdapter.apply` never reads `options.yes` (it performs no steps at all, so the parameter is dead there), and `WindowsAdapter.apply` performs its automatable `windows.channel` step even when `cli/run.ts` passes the default `yes: false` — nothing in the CLI asks first either. Today no automatable step makes a lasting change (the Windows step is only a create-and-remove probe), but any future automatable step would run without `--yes`. Either check `options.yes` before performing an `automatable` step in `apply` (reporting it as planned otherwise), or drop the promise from this doc and the parameter from the signature so the contract doesn't advertise a gate that doesn't exist.

```
/** True when `--yes` may perform it without asking again. */
  readonly automatable: boolean;
```

## 129. [LOW] src/platform/contract.ts:111-111 (bug)

`close()` has no production caller: `src/runner/test-run.ts` opens sessions (`adapter.open` + `session.open`) and never closes them — every call site is in `test/`. The Windows backend relies on this lifecycle: on the unknown (timeout) path it deliberately leaves the per-run channel lock with the comment "close() releases it only after the caller has decided what to do", but no caller ever does, so `locks/<runId>.json` stays in the channel forever (recover only touches the local stateRoot locks). Either have `runTest` close the session once the outcome is decided (e.g. in the `finally`), or move that release to the throw site so the designed lifecycle member isn't dead in production.

```
close(): Promise<{ readonly closed: boolean; readonly reason: string | null }>;
```

## 130. [LOW] src/platform/darwin/adapter.ts:683-683 (bug)

Every run leaves this directory behind: `runTest` only copies the files (`captureFile` uses `copyFileSync`) into the run artifacts, and nothing in the package ever removes `tmpdir()/ae-a8n-darwin-run-*` (the prefix appears nowhere else in src/). A machine running tests repeatedly accumulates one directory with two log files per run until OS temp cleanup. The runner already owns a run directory for evidence — write the logs where the caller can clean them, or reap the temp copy once the outcome has been captured.

```
const directory = mkdtempSync(join(tmpdir(), "ae-a8n-darwin-run-"));
```

## 131. [LOW] src/platform/darwin/adapter.ts:878-882 (style)

Nested ternary (three levels here; the same pattern repeats in the `macos.target-user`, `macos.session` and `macos.ae` steps). The review checklist prohibits nested ternaries — extracting small named helpers (e.g. `consoleSeparationReason(facts)`, `accountStep(...)`) would keep each step's plan logic readable and make the per-case message fixes above easier to apply.

```
reason: separated
          ? `the target uid ${String(facts.targetUid)} is not the console user ${String(facts.consoleUid)}`
          : facts.consoleUid === null
            ? "the console session owner could not be read, so separation cannot be proven"
            : `the target account is the console user (uid ${String(facts.consoleUid)}); tests would appear on the screen a person is using`,
```

## 132. [LOW] src/platform/darwin/adapter.ts:953-957 (maintainability)

`step.state === "planned" ? "planned" : step.state` always evaluates to `step.state` — the conditional is dead code and reads as if a dry run was meant to convert applied steps to "planned". Either drop it (`state: step.state`) or, if that was the intent, implement the mapping explicitly so a reader is not left guessing which behaviour is real.

```
outcomes: steps.map((step) => ({
            id: step.id,
            state: step.state === "planned" ? "planned" : step.state,
            detail: "dry run: nothing was changed",
          })),
```

Suggestion:
```
outcomes: steps.map((step) => ({
            id: step.id,
            state: step.state,
            detail: "dry run: nothing was changed",
          })),
```

## 133. [LOW] src/platform/recovery-policy.ts:235-235 (maintainability)

`chooseAction` routes measured *non-pressable* classes (crash-repair, second-script) through `humanOnlyDecision`, so they come back as `action: "human-only"` with the detail "<class> belongs to a human; nothing was pressed anywhere". Per this module's own policy, only licence/sign-in/permission windows are a human's decision; crash-repair is refused because no button on it was ever measured safe. The current detail misstates the reason to the person reading the recovery report (and consumers keying on `human-only` will repeat it). Give non-pressable measured classes their own wording — e.g. "no button on <class> was measured safe to press; nothing was pressed" — or their own action kind.

```
detail: `${dialogClass} belongs to a human; nothing was pressed anywhere`,
```

## 134. [LOW] src/platform/recovery-policy.ts:299-299 (bug)

Fail-open default in a fail-closed policy: `DialogClass.button` is documented as "null when `presses` is false", but the type still allows `presses: true` with `button: null`. If such a class ever ships, this silently presses `OK` instead of refusing — the one place a measured-class typo would turn into a click. Skip the window (or refuse the whole decision) when `button === null` so a missing button can never become a press.

```
button: classified.dialogClass.button ?? "OK",
```

Suggestion:
```
button: classified.dialogClass.button ?? "OK",
        // Note: `button` is null here only if a `presses: true` class ships
        // without one; prefer skipping that window over defaulting to OK.
```

## 135. [LOW] src/platform/windows/acl.ts:30-35 (style)

Misspelled allowlist entry: `adminstrators` can never appear in real `icacls` output, so this line matches nothing — the correctly spelled `builtin\administrators` is already the line above. An entry in a security allowlist that can never fire is a trap for the next reader (it looks like coverage of a second spelling); delete it.

```
const PRIVILEGED = [
  "nt authority\\system",
  "builtin\\administrators",
  "builtin\\adminstrators",
  "nt authority\\local system",
];
```

Suggestion:
```
const PRIVILEGED = [
  "nt authority\\system",
  "builtin\\administrators",
  "nt authority\\local system",
];
```

## 136. [LOW] src/platform/windows/acl.ts:203-211 (maintainability)

Neither function has a caller anywhere in src/, scripts/ or tests: `defaultAclReader` in comms.ts and `readAclWithIcacls` in key-store.ts both invoke `icacls` via `execFile` directly. This is dead exported code shipping in the release — delete both, or have those two call sites build their argv through `icaclsCommand` so the command lives in one place.

```
/** A path with an escaped single quote, for a PowerShell single-quoted string. */
export function quoteForPowerShell(path: string): string {
  return `'${path.replace(/'/gu, "''")}'`;
}

/** The command whose output `parseIcacls` reads. */
export function icaclsCommand(path: string): readonly string[] {
  return ["icacls", path];
}
```

## 137. [LOW] src/platform/windows/agent-detach.ts:47-48 (maintainability)

The agent's flag contract is now defined in two places: `AGENT_OPTIONS`/`REQUIRED` here (which `cli/agent.ts` also derives its usage check from) and `FLAGS` plus its own `required` list in `agent-main.ts`. If a flag is ever added to this set but not to `agent-main.ts`, the detached child rejects it with exit 2 *after* this function has already returned 0 — a silently dead agent that the async error listener can no longer turn into a non-zero exit (see the exit-code issue above). Export one shared flag set and required list from a single module while these files are new and the import cost is zero.

```
/** The flags a detached start needs before it can hand the work to a child. */
const REQUIRED = ["--channel", "--key-file", "--host", "--user"] as const;
```

Suggestion:
```
// Moved to agent-main.ts (or a shared flags module) and imported here:
// export const AGENT_FLAGS = …; export const AGENT_REQUIRED = …;
```

## 138. [LOW] src/platform/windows/agent-detach.ts:101-105 (bug)

`--log` is the only flag whose missing value is not refused: as the last token, `log` falls back to `null` and the default path is used silently, while every other flag would fail `checkArguments` with "needs a value". Worse, `--log --hidden` stores the literal path `"--hidden"` and consumes the `--hidden` token, so agent output lands in a file named `--hidden` in the current directory instead of the requested one. A malformed invocation should be a usage error here, like everywhere else in this function.

```
if (token === LOG_FLAG) {
      log = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
```

Suggestion:
```
if (token === LOG_FLAG) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        // Reported by the caller: keep the problem, do not swallow it.
        return { args, log: null, logProblem: `${LOG_FLAG} needs a value` };
      }
      log = value;
      index += 1;
      continue;
    }
```

## 139. [LOW] src/platform/windows/agent-detach.ts:135-137 (maintainability)

`messageOf` is defined identically in agent-detach.ts and agent-main.ts (comms.ts inlines the same stringification twice more) — four copies in one release. Extract it to a shared helper while these files are new and the import cost is zero.

```
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

## 140. [LOW] src/platform/windows/agent.ts:57-57 (other)

"no-job" is never returned by `runJob` (this declaration is its only occurrence in the repository) and no caller handles it — `agent-main.ts` only branches on `claim-unauthenticated`. A union member nothing can produce misleads the next reader about the protocol's real states; delete it, or make the path that should produce it (the no-manifest branch currently returning `not-ready`) actually do so.

```
| { readonly state: "no-job" }
```

## 141. [LOW] src/platform/windows/agent.ts:372-375 (security)

The artifact key is concatenated without validation: `../../claims/<id>.json` normalises to `claims/<id>.json`, which still passes `DirectoryChannel`'s `..` guard (it only rejects paths *starting* with `..`), so a bad key can write anywhere in the channel root — over another job's result or a claim file. The only producer today (`SpawnJobExecutor`) emits fixed `stdout.log`/`stderr.log` keys, so this is latent, but this loop is the trust boundary for executor-supplied output: reject absolute keys and any `..` segment (and ideally require the resolved path to stay under `results/<jobId>/`) rather than writing them.

```
// Artifacts first: a result that names them never precedes them.
  for (const [relativePath, bytes] of Object.entries(execution.artifacts ?? {})) {
    await channel.writeAtomic(`${paths.resultDirectory}/${relativePath}`, bytes);
  }
```

Suggestion:
```
// Artifacts first: a result that names them never precedes them.
  for (const [relativePath, bytes] of Object.entries(execution.artifacts ?? {})) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
      continue; // never let an artifact name leave its own result directory
    }
    await channel.writeAtomic(`${paths.resultDirectory}/${relativePath}`, bytes);
  }
```

## 142. [LOW] src/platform/windows/auth.ts:269-272 (maintainability)

`writerOf` has no callers anywhere in the repo — it returns `job.writer`, which every caller already has direct access to — and it is the sole user of the `JobWriter` import in this file. Dead code in the shipped surface; remove the function and the now-unused type import.

```
/** A job's writer, reconstructed from a verified document; for diagnostics. */
export function writerOf(job: Job): JobWriter {
  return job.writer;
}
```

## 143. [LOW] src/platform/windows/comms.ts:527-528 (security)

The fixed all-zero default means a `ChannelCommandRunner` constructed without `random` mints run ids whose suffix is always `00000000`, so two probe commands issued in the same second get identical run ids (`RUN_ID_PATTERN` still accepts it). Today the production path is only accidentally safe: runner.ts defaults its `#random` to `randomBytes` and always passes it in, and `submitJob` independently defaults its own `random`, so job ids keep entropy even here. A silent no-entropy default in production code is a footgun for the next caller; default to `randomBytes` exactly as `submitJob` does.

```
const random = options.random ?? (() => new Uint8Array([0, 0, 0, 0]));
    const runId = newJobId(now(), random(4));
```

Suggestion:
```
const random = options.random ?? randomBytes;
```

## 144. [LOW] src/platform/windows/comms.ts:592-595 (style)

Both ternary branches return `""`, so the condition is dead code that misleads the reader into thinking the branches were meant to differ. Either collapse to `return "";`, or implement the intended distinction (e.g. a note like `(no output captured)` when the process exited but the log file is missing).

```
function decodeUtf8(bytes: Uint8Array | null, exitCode: number | null): string {
  if (bytes === null) {
    return exitCode === null ? "" : "";
  }
```

Suggestion:
```
function decodeUtf8(bytes: Uint8Array | null, exitCode: number | null): string {
  if (bytes === null) {
    return "";
  }
```

## 145. [LOW] src/platform/windows/comms.ts:605-610 (other)

Neither export has a caller or importer anywhere: tests import only `decodeHostConfig`/`openComms`/`resolveComms` from this module, and every `sha256Hex` user imports it from `job.js`. `createHash` exists in this file solely for `describeChannel`, and `sha256Hex` is imported here solely to be re-exported. Dead surface shipping in the release — delete both exports and drop the two now-unused imports.

```
/** A stable description of a channel root, for an evidence record. */
export function describeChannel(channel: string): string {
  return createHash("sha256").update(channel).digest("hex").slice(0, 16);
}

export { sha256Hex };
```

## 146. [LOW] src/platform/windows/executor.ts:107-112 (maintainability)

`code === undefined` is unreachable: `for...of` yields at least one code unit per iteration, so `codePointAt(0)` is always defined. Dead condition that suggests empty/invalid code points are possible — drop it (or iterate code points explicitly if that was the intent).

```
for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
```

Suggestion:
```
for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
```

## 147. [LOW] src/platform/windows/executor.ts:309-314 (bug)

`artifacts` — the bytes the agent republishes to `results/<jobId>/` on the channel, which the controller's `#writeLocalArtifacts` reads — is only populated when this redundant local copy to `agent-runs` succeeds. A local write failure (disk full, ACL) drops stdout/stderr from the channel entirely; the controller then returns empty artifact files alongside the real exit code, and `test-run` can report an ok run with no output. The result message does carry `artifactNote`, but that message never reaches `CommandOutcome`. Return the in-memory `artifacts` unconditionally and let the note record the local-copy failure.

```
try {
          await mkdir(this.#runDirectory, { recursive: true });
          await writeFile(join(this.#runDirectory, "stdout.log"), stdout);
          await writeFile(join(this.#runDirectory, "stderr.log"), stderr);
          artifacts = { "stdout.log": stdout, "stderr.log": stderr };
        } catch (error) {
```

Suggestion:
```
artifacts = { "stdout.log": stdout, "stderr.log": stderr };
        try {
          await mkdir(this.#runDirectory, { recursive: true });
          await writeFile(join(this.#runDirectory, "stdout.log"), stdout);
          await writeFile(join(this.#runDirectory, "stderr.log"), stderr);
        } catch (error) {
```

## 148. [LOW] src/platform/windows/job.ts:174-177 (other)

argv entries, env keys and cwd are all screened with `hasControlCharacter`, but env values are not — a payload can put NUL or other C0 characters straight into the child's environment. Node throws on some of these at spawn time (turning into an executor "failed" instead of a clean pre-spawn refusal), and the inconsistency undermines the module's "strict JSON validated before anything is spawned" contract. Apply the same check to values.

```
if (typeof value !== "string") {
        return { ok: false, detail: `env["${key}"] is not a string` };
      }
      env[key] = value;
```

Suggestion:
```
if (typeof value !== "string") {
        return { ok: false, detail: `env["${key}"] is not a string` };
      }
      if (rules.hasControlCharacter(value)) {
        return { ok: false, detail: `env["${key}"] contains a control character` };
      }
      env[key] = value;
```

## 149. [LOW] src/platform/windows/job.ts:382-384 (security)

This accepts `"."` (the job directory itself), Windows reserved device names (`CON`, `NUL`, `COM1`…) and trailing dot/space names, all of which misresolve when the agent joins `jobs/<jobId>/<payloadFile>`. Exploitability is limited — `payloadFile` is covered by the job's HMAC and the controller always writes `payload.json` — but the check reads as a complete path-safety guard while it is not. Either tighten it (reject `.`, reserved names, trailing dot/space) or state that the signature is the actual boundary and this is belt-and-braces.

```
if (payloadFile.includes("/") || payloadFile.includes("\\") || payloadFile === "..") {
    return { ok: false, detail: `payloadFile "${payloadFile}" is a path, not a file name` };
  }
```

Suggestion:
```
if (
    payloadFile.includes("/") ||
    payloadFile.includes("\\") ||
    payloadFile === ".." ||
    payloadFile === "." ||
    /[. ]$/u.test(payloadFile) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(payloadFile)
  ) {
    return { ok: false, detail: `payloadFile "${payloadFile}" is a path, not a file name` };
  }
```

## 150. [LOW] src/platform/windows/key-store.ts:110-110 (bug)

`??` also swallows an explicitly passed `owner: null`. `keyFileAclVerdict` in `acl.ts` documents `null` as "the owner is unknown", where every non-privileged account is treated as foreign — the stricter refusal. A caller passing `owner: null` to request that behavior silently gets the looser current-user comparison instead, and the type's `| null` invites exactly that input. Distinguish "absent" from "explicitly unknown" (or narrow the type to `string`).

```
const verdict = keyFileAclVerdict(entries, options.owner ?? currentUser());
```

Suggestion:
```
const owner = "owner" in options ? options.owner : currentUser();
    const verdict = keyFileAclVerdict(entries, owner);
```

## 151. [LOW] src/platform/windows/lock.ts:19-21 (bug)

`RUN_ID_PATTERN` requires an alphanumeric first character, so `value !== "."` and `value !== ".."` are always true whenever they are evaluated — these guards can never fire (the pattern already refuses `.`, `..` and path separators). The doc comment above credits the refusal to these checks, which misleads a reader into thinking the pattern alone is insufficient. Simplify to just the pattern test, or keep an explicit `isRunId`-style guard only if the pattern is ever relaxed.

```
export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value) && value !== "." && value !== "..";
}
```

Suggestion:
```
export function isRunId(value: string): boolean {
  // The pattern's alphanumeric first character already excludes "." and "..".
  return RUN_ID_PATTERN.test(value);
}
```

## 152. [LOW] src/platform/windows/lock.ts:45-46 (documentation)

This parenthetical contradicts the code and the `stale` variant's comment below. An unreadable timestamp makes `decodeRunLock` return null (it rejects a NaN `Date.parse`), and `acquireRunLock` maps a null decode to `{ state: "stale", lock: null }` — the windows-lock test "treats a malformed lock as stale and leaves the bytes alone" pins exactly that behaviour. Only a decodable lock whose `acquiredAt` parses and is fresh can be `busy`. Drop the parenthetical (the stale doc already says "or unreadable") so a reader of the state machine gets the real classification.

```
/** A fresh lock held by someone else (or with an unreadable timestamp). */
| { readonly state: "busy"; readonly lock: RunLock }
```

## 153. [LOW] src/platform/windows/manifest.ts:85-87 (maintainability)

Unknown fields are accepted and silently dropped here, while every sibling decoder refuses them — auth.ts: "a file that carries an extra field is not one this version understands, and pretending otherwise is how a downgrade gets accepted"; presence.ts: "an unknown field is refused, so nothing is silently ignored". `schemaVersion` is pinned to exactly "1.1", so an extra key can only come from a document this version does not understand — refuse it instead of dropping it. (`decodeSessionMarker` in session-marker.ts has the same gap.)

```
if (!isRecord(parsed)) {
    return { ok: false, detail: "manifest.json is not an object" };
  }
```

Suggestion:
```
if (!isRecord(parsed)) {
  return { ok: false, detail: "manifest.json is not an object" };
}
for (const key of Object.keys(parsed)) {
  if (!MANIFEST_KEYS.has(key)) {
    return { ok: false, detail: `unknown manifest field "${key}"` };
  }
}
```

## 154. [LOW] src/platform/windows/presence.ts:50-52 (security)

Unlike every sibling path builder (`lockPath`, `runManifestPath`, `sessionMarkerPath`), `presencePath` interpolates its id with no path-component validation. Verified callers pass local config only (agent `--agent-id`, controller hosts file / CLI), not channel documents, so exposure today is limited — but `DirectoryChannel#resolve` only blocks escaping the channel root, not within-channel traversal: an id like `../results/<jobId>` resolves to `results/<jobId>.json`, and the agent's `writeAtomic(presencePath(identity.id), ...)` would clobber an unrelated channel file with heartbeat JSON. Validate the id here (or at every parse point) so the invariant travels with the function.

```
export function presencePath(agentId: string): string {
  return `agents/${agentId}.json`;
}
```

Suggestion:
```
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function presencePath(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`agent id "${agentId}" cannot be used as a path component`);
  }
  return `agents/${agentId}.json`;
}
```

## 155. [LOW] src/platform/windows/presence.ts:201-210 (security)

`decodePresence` type-checks `auth.alg` as a string, then discards the received value and hardcodes `JOB_AUTH_ALG` in the decoded document — so a heartbeat carrying e.g. `"RSA-OAEP"` is silently reinterpreted as HS256 instead of refused at decode, and `verifyPresenceAuth`'s `alg !== JOB_AUTH_ALG` refusal becomes unreachable for any document that came through this decoder. The signature check still fails for forged content (not fail-open), but this contradicts the function's stated "an unknown field is refused" strictness and is inconsistent with the job/result path, where `checkAuth` refuses a mismatched `alg`. Refuse a non-matching `alg` during decode and echo the received value in the message.

```
return {
    ok: true,
    value: {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      agent: { id, host, user, sessionId, version },
      heartbeatAt: parsed["heartbeatAt"],
      interactive: parsed["interactive"],
      auth: { alg: JOB_AUTH_ALG, keyId, signature },
    },
  };
```

Suggestion:
```
if (alg !== JOB_AUTH_ALG) {
    return refuse(`unsupported signature algorithm "${alg}"`);
  }
  return {
    ok: true,
    value: {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      agent: { id, host, user, sessionId, version },
      heartbeatAt: parsed["heartbeatAt"],
      interactive: parsed["interactive"],
      auth: { alg, keyId, signature },
    },
  };
```

## 156. [LOW] src/platform/windows/recovery.ts:69-72 (bug)

`INFO:` is an OS-generated string that Windows localizes — the same hazard `acl.ts` explicitly documents for `icacls` output ("The trailing summary is localised … recognised by shape"). On a non-English Windows, an empty `tasklist` answer never sets `sawInfo`, so `parseTasklistWindowStates` returns `null` ("unreadable") instead of `[]`, and every clean recovery reports "could not read the After Effects state … inspect by hand" instead of "nothing to do". The same class applies to the English literals in `parseState` ("running"/"not responding"): if the Status column is localized, a healthy AE parses as `unknown`, `syntheticWindow` marks it blocking, and `chooseAction` quarantines with A8N-SEC-001 and a remedy telling the human to close a dialog that does not exist. Both directions fail closed, but consider shape-based recognition (as `parseIcacls` does) or documenting an English-locale requirement.

```
if (line.startsWith("INFO:")) {
      sawInfo = true;
      continue;
    }
```

Suggestion:
```
// "INFO:" is localised on non-English Windows (see acl.ts on icacls);
    // recognise the no-tasks answer by shape (no colon / no CSV row) instead.
    if (line.startsWith("INFO:")) {
      sawInfo = true;
      continue;
    }
```

## 157. [LOW] src/platform/windows/recovery.ts:124-129 (style)

Nested ternary, which the review checklist prohibits; a three-way state-to-text mapping is also easier to extend with a lookup table or if/else chain (a fourth `AeProcessState` would silently fall into the final `?` arm today).

```
const said =
    process.state === "responding"
      ? "running"
      : process.state === "not-responding"
        ? "not responding"
        : "window state unknown";
```

Suggestion:
```
const STATE_TEXT: Record<AeProcessState, string> = {
    responding: "running",
    "not-responding": "not responding",
    unknown: "window state unknown",
  };
  const said = STATE_TEXT[process.state];
```

## 158. [LOW] src/platform/windows/runner.ts:505-509 (style)

Nested ternaries are not allowed by this project's rules; this is one of three in `plan()` (also the `windows.agent` reason at 535-539 and `windows.agent-autostart` at 555-559). Extract a small helper or build the three-state message with plain ifs so the reason reads linearly.

```
reason: channelReadable
        ? "the channel root exists and is readable"
        : channelExists
          ? "the channel root exists but could not be read"
          : "the channel root does not exist",
```

Suggestion:
```
reason: !channelReadable && !channelExists
        ? "the channel root does not exist"
        : channelReadable
          ? "the channel root exists and is readable"
          : "the channel root exists but could not be read",
```

## 159. [LOW] src/platform/windows/session-marker.ts:65-65 (maintainability)

The return value of `sessionMarkerPath(input.jobId)` is discarded; the call exists only for its throw-on-invalid side effect, which reads as dead code to a maintainer (a linter or a reader can't tell the validation intent). State the check explicitly — `isJobId` is already imported in this module — or assign the path and use it.

```
sessionMarkerPath(input.jobId);
```

Suggestion:
```
if (!isJobId(input.jobId)) {
    throw new Error(`job id "${input.jobId}" cannot be used as a path component`);
  }
```

## 160. [LOW] src/platform/windows/session-marker.ts:117-119 (maintainability)

Same strictness gap as the manifest decoder: extra keys are accepted and dropped although the module header promises "every field is checked before it is trusted", and `decodeJob`, `decodePresence` and `decodeKeyFile` all refuse unknown fields. A marker carrying a field this version does not know (a newer agent's writer, a planted document) is silently reinterpreted as this schema instead of refused — add the Object.keys/allowed-set refusal the siblings use.

```
if (!isRecord(parsed)) {
    return { ok: false, detail: "session-marker.json is not an object" };
  }
```

Suggestion:
```
if (!isRecord(parsed)) {
  return { ok: false, detail: "session-marker.json is not an object" };
}
for (const key of Object.keys(parsed)) {
  if (!MARKER_KEYS.has(key)) {
    return { ok: false, detail: `unknown session-marker field "${key}"` };
  }
}
```

## 161. [LOW] src/platform/windows/spawn-runner.ts:20-29 (bug)

Non-numeric `error.code` values other than a kill fall through to 127. A `maxBuffer` overflow arrives as `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (`killed` false) and is reported as "could not be started", so the probe records the fact as missing/unstartable instead of "output exceeded the 1 MiB buffer" — diagnostics then blame the host rather than the buffer limit. Distinguish known start failures (`ENOENT`, `EACCES`, …) from other string codes, or carry the code text into `stderr` so the evidence is honest.

```
/** 124 = the command did not finish; 127 = it could not be started. */
function exitCodeOf(error: ExecFileException | null): number {
  if (error === null) {
    return 0;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  return error.killed === true ? 124 : 127;
}
```

Suggestion:
```
/** 124 = the command did not finish; 127 = it could not be started. */
function exitCodeOf(error: ExecFileException | null): number {
  if (error === null) {
    return 0;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  if (error.killed === true) {
    return 124;
  }
  // ENOENT/EACCES mean "could not start"; ERR_CHILD_PROCESS_STDIO_MAXBUFFER
  // and friends mean it ran but could not answer within its limits.
  return error.code === "ENOENT" || error.code === "EACCES" ? 127 : 124;
}
```

## 162. [LOW] src/runner/artifacts.ts:16-18 (maintainability)

`RUN_TRACE_SCHEMA` has no reader anywhere (src, test, scripts), and the module header claims "Every file has a schemaVersion" while the trace events written by `writeRunArtifacts` carry none — a consumer reading `trace.jsonl` cannot tell which format version it is looking at, and the constant exists only to suggest otherwise. Either stamp the version into the trace (a first line, or a field on each event) and use this constant for it, or delete the constant and correct the header.

```
export const RUN_MANIFEST_SCHEMA = "1.0";
export const RUN_REPORT_SCHEMA = "1.0";
export const RUN_TRACE_SCHEMA = "1.0";
```

Suggestion:
```
export const RUN_MANIFEST_SCHEMA = "1.0";
export const RUN_REPORT_SCHEMA = "1.0";
// Used as the first line of trace.jsonl so a reader can refuse an
// unknown format (see writeRunArtifacts).
export const RUN_TRACE_SCHEMA = "1.0";
```

## 163. [LOW] src/runner/package-info.ts:27-30 (bug)

The `"0.0.0"` fallback is justified in the header for "a diagnostic command", but this value is recorded as fact elsewhere: `test-run.ts` writes `packageInfo().version` into every run's `manifest.json` (`package.version`) and `buildEnvelope` puts it into every envelope's `package.version` — while `ae-a8n --version` prints `A8N_VERSION` (src/version.ts), which release tooling (scripts/check-release.js) proves equal to package.json. On a read failure (permissions, packaging oddity) the persistent artifacts then claim version "0.0.0" with no hint, and the two version sources disagree within one release. Prefer `A8N_VERSION` for `version` (compile-time, release-checked, no disk read) and keep `packageInfo()` for `name` only; if the file-read version is kept, record an explicit sentinel like "unknown" instead of a plausible-looking fake version.

```
} catch {
    cached = { name: "@ido-bata/ae-a8n", version: "0.0.0" };
  }
  return cached;
```

Suggestion:
```
} catch {
    cached = { name: "@ido-bata/ae-a8n", version: A8N_VERSION };
  }
  return cached;
```

## 164. [LOW] src/runner/recover-run.ts:174-176 (bug)

A hard kill (SIGKILL/OOM/power loss) leaves a held lock, no quarantine record and no report — precisely the case `recover` exists for. There `runId` is null unless `--run` was passed, so `recover` releases the stale lock yet never inspects the run it names (`readLock` already parsed `runId` for its detail string), and that run stays report-less. `ae-a8n report` then says "\"ae-a8n recover\" records it as unknown", but a plain `ae-a8n recover` answers "nothing to recover": the two commands point at each other, and only `recover --run <id>` — which the message never mentions — breaks the loop. Consider making `runId` a `let` and falling back to `lock.record.runId` in the stale-lock `cleared` branch only (never for a live owner: recording the directory of a run that is still going would write a report under it).

```
const runId =
    input.runId ??
    (quarantine.quarantined && quarantine.record !== null ? quarantine.record.runId : null);
```

## 165. [LOW] src/runner/recover-run.ts:339-345 (bug)

`cannotDecide` is set only for unreadable inputs and an adapter throw, but several `action: "refused"` outcomes leave `status: "ok"`, so `recover` exits 0 (cli/run.ts: `result.status === "ok" ? EXIT.ok : EXIT.unknown`) even when a requested cleanup failed: the `--force` quarantine clear that `removeFile` could not perform, the stale-lock `rmSync` that threw, and a `recordUnknown` write failure all push "refused" yet report success — as do platform findings pushed at step 4 with `action: "refused"` (Windows returns one when a licence dialog blocks the target). By contrast an unreadable record — also "refused" — correctly yields "unknown"/exit 6, and exit-code.ts states callers key off the number. A caller cannot distinguish "nothing to clear" from "clear was attempted and failed". Fold refused findings into the status so every "refused" action maps to "unknown"/exit 6, consistent with the unreadable-record branch.

```
return {
    runId,
    findings,
    cleared,
    status: cannotDecide ? "unknown" : "ok",
    ...(notice === undefined ? {} : { notice }),
  };
```

Suggestion:
```
if (findings.some((finding) => finding.action === "refused")) {
    cannotDecide = true;
  }
  return {
    runId,
    findings,
    cleared,
    status: cannotDecide ? "unknown" : "ok",
    ...(notice === undefined ? {} : { notice }),
  };
```

## 166. [LOW] src/runner/state.ts:100-104 (bug)

If `writeFileSync` fails (disk full, quota), the exclusively-created lock file is left behind empty and the error escapes `acquireTargetLock` unclassified: every later run is then refused with "another run holds the lock (the file is empty)", and `recover` classifies an empty lock as unreadable — a human must delete a file that no run ever held. Since we exclusively created it, best-effort removing it before rethrowing leaves no debris.

```
try {
    writeFileSync(descriptor, `${JSON.stringify(body)}\n`);
  } finally {
    closeSync(descriptor);
  }
```

Suggestion:
```
try {
    writeFileSync(descriptor, `${JSON.stringify(body)}\n`);
  } catch (error) {
    // A lock exists only to describe a run that actually holds it; a lock we
    // failed to write would refuse every later run for nothing.
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort: an unremovable partial lock is left for `recover`.
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
```

## 167. [LOW] src/runner/test-run.ts:201-204 (performance)

On a passing run without `--keep` (the default human-summary path), `writeRunArtifacts` writes manifest/report/trace and the `captureFile` calls in step 6 have already copied stdout/stderr into `artifacts/` — all of it is deleted on the next line. Decide `keep` first and skip the write when the directory will be dropped; just `rmSync` the capture directory. (`captureFile` itself must still run — step 7 uses a null path to quarantine an uncapturable run.)

```
const artifacts = writeRunArtifacts(runDirectory, { manifest, report, trace });
    const keep = status !== "ok" || input.keepOnSuccess;
    if (!keep) {
      rmSync(runDirectory, { recursive: true, force: true });
```

Suggestion:
```
const keep = status !== "ok" || input.keepOnSuccess;
    if (!keep) {
      rmSync(runDirectory, { recursive: true, force: true });
      return {
        runId,
        status,
        runDir: null,
        artifacts: null,
        checks,
        verdicts,
        identity,
        ...(notice === undefined ? {} : { notice }),
      };
    }
    const artifacts = writeRunArtifacts(runDirectory, { manifest, report, trace });
```

## 168. [LOW] src/runner/test-run.ts:261-263 (documentation)

Stale user-facing text: `recover` is implemented in this very change (src/runner/recover-run.ts, wired up in src/cli/run.ts), so "(not implemented in this increment)" tells the user the fix does not exist and steers them away from it. It is also imprecise — clearing a quarantine requires `--force` (see the matching remedy in recover-run.ts). The same stale parenthetical appears in the lock-refusal remedy below (that one should just be dropped, since a stale lock is released without `--force`).

```
remedy:
          "Inspect the quarantined run, then clear the quarantine with `ae-a8n recover` " +
          "(not implemented in this increment) before running again.",
```

Suggestion:
```
remedy:
          "Inspect the quarantined run, then clear the quarantine with `ae-a8n recover --force` " +
          "before running again.",
```

## 169. [LOW] src/runner/test-run.ts:283-286 (bug)

Second occurrence of the stale text already reported for the quarantine remedy (line 262-263): `recover` *is* implemented in this very change (src/runner/recover-run.ts, wired up in src/cli/run.ts). This lock remedy is the one users hit most often — a second concurrent `test` — and it tells them the fix does not exist, steering them to manual file deletion instead of `ae-a8n recover` (which releases exactly this stale lock, and reports a live one). Drop the parenthetical here too.

```
detail: lock.detail,
        remedy:
          "Wait for the running test, or inspect and clear the lock with `ae-a8n recover` " +
          "(not implemented in this increment).",
```

Suggestion:
```
detail: lock.detail,
        remedy:
          "Wait for the running test, or inspect the lock with `ae-a8n recover`; " +
          "it releases a lock whose owner is gone and never takes over a live one.",
```

## 170. [LOW] src/testing/fake-ae/es3-runtime.ts:284-284 (maintainability)

`onAlert` has no consumers anywhere in the repo: none of the `runHostScript` call sites (`src/testing/fake-transport.ts`, `test/host-json.test.ts`, `test/unattended.test.ts`) passes it, and no test asserts on collected messages. As shipped, the stated purpose ("a test can assert that the host asked for a dialog") is unfulfilled, and the option is dead API surface in a release candidate. Either wire it through `FakeAfterEffectsTransport.invoke()` (so `ui.alert` runs are observable end to end) plus an assertion, or drop the hook until a consumer exists.

```
readonly onAlert?: (message: string) => void;
```

Suggestion:
```
readonly onAlert?: (message: string) => void;
  // (If kept: forward this from FakeAfterEffectsTransport so tests can
  // observe `ui.alert`; otherwise remove until a caller exists.)
```

