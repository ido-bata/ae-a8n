# ADR 0004 — Native-channel mutation authorization: grant gate + §7g consent proof

- Status: accepted
- Date: 2026-11-20
- Issue: [#245](https://github.com/ido-bata/ae-a8n/issues/245), refined by [#247](https://github.com/ido-bata/ae-a8n/issues/247) (shared consent fixture) and [#248](https://github.com/ido-bata/ae-a8n/issues/248) (grant scope/lease)
- Contract: ae-devtools `specs/ae-capability-coverage/contracts/native-channel.md` §7g/§7h, `design/trusted-execution.md` §8
- Affects: `src/driver/native-channel.ts`, `src/driver/native-consent.ts`

## Context

ae-devtools `release-0-5-0` added the first mutating native-intake
operation, `AEGP_ItemSuite9.AEGP_SetItemComment`, gated by a per-request
consent proof: an envelope-level `{"consent":{"v":1,"mac":...}}` whose
HMAC-SHA256 covers `operationId`, `requestId`, the session pin, the
canonical args, and the target (contract §7g). The plug-in verifies the
MAC after session attestation and before any AEGP call.

On the ae-a8n side, `channel.json` carried only `token`, and
`publishNativeRequest` had no way to issue a consent proof — the
mutation path was dead. Issue #245 requires `consentKey` minting,
per-request proof issuance, and — explicitly — an authorization policy:
a computable HMAC must not be treated as an approved request.

## Decision

Three layers, kept separate on purpose:

1. **Channel capability** — `token` and `consentKey` in `channel.json`
   (0600, private directory). `prepareNativeChannel` mints both
   idempotently and backfills `consentKey` into legacy metadata. These
   secrets prove only that a writer could read the channel directory.
2. **Operation authorization (ae-a8n-owned)** —
   `PrepareNativeChannelOptions.authorization`, a
   `NativeMutationAuthorization` `{sessionIds?, grants}` snapshotted at
   prepare time (same model as `LaunchOptions.authorization` for
   attached sessions, #145) and replaceable/revocable while the channel
   lives via `updateNativeChannelAuthorization` (#248). Each grant
   entry names exactly one `requiresConsent` operationId plus optional
   `targets` and an `args` partial deep-match pattern, so a grant can
   pin the project/item descriptor a mutation may touch. `sessionIds`
   binds the whole authorization to named sessions — absent means any
   session on this channel (documented, not a boundary). Grant
   evaluation happens BEFORE any MAC is issued and refuses uncovered
   mutations as `ScriptNotSentError` — provably nothing was sent.
   There is no "send mutation without consent" path, and a grant entry
   can never name a non-consent operation, so a future mutation op
   cannot inherit authority: it needs its own explicit entry.
   Already-published requests and issued MACs cannot be recalled —
   revocation gates only future publishes.
3. **Channel-verifiable proof** — for covered mutations only, the §7g
   canonical consent string is HMAC'd with `consentKey` and attached as
   `envelope.consent`. The MAC binds the exact scope, so a proof minted
   for one request cannot be re-serialized into another (replay- and
   tamper-bound to `requestId` + session + args + target).

`authorizationRef` stays an opaque pass-through for caller-side audit;
it is not consulted by the grant check and never substitutes for the MAC.

`reconcileItemComment` implements the §8.3 read-back path for
`SetItemComment`: after an uncertain outcome it issues the read-only
`AEGP_GetItemComment` on the same descriptor and classifies
`state-consistent` / `state-inconsistent` / `unobservable`.
`state-consistent` is consistency evidence, never causal proof.

## Threat boundary — what this does and does not guarantee

Verified against the contract's threat model, not assumed:

- `channel.json` is readable by any process running as the same OS
  user. Such a process can mint valid MACs and write request files
  directly, bypassing this client entirely. The HMAC therefore proves
  **possession of `consentKey` and binding to the exact scope fields**
  (operationId, requestId, session, args, target) — tamper-evidence and
  scope binding, NOT authentication and NOT evidence that any
  particular code path ran. POSIX directory privacy remains the outer
  boundary, exactly as contract §7g states.
- What the grant layer adds inside that boundary: through the supported
  client, an unapproved mutation is refused before anything reaches the
  wire — the authorization decision is explicit, scoped to
  (session, operationId, target, args), snapshotted at prepare time,
  and revocable for future requests. The MAC binding args and the
  grant authorizing args are different checks: the MAC proves the
  bytes, the grant decides whether those bytes were permitted.
- A same-user process that ignores the client can still forge requests,
  results, and heartbeats — the same residual the `token` already has
  for read-only ops. Closing that gap requires asymmetric consent
  signing (ae-a8n-held signing key, plug-in-held verify key), which is
  a contract-level change owned by ae-devtools and an explicit non-goal
  of #245. It is the documented proportionate answer for the current
  single-user private-channel model; revisit if the channel ever
  crosses a trust boundary.

## Consequences

- `requiresConsent` op knowledge is mirrored client-side in
  `NATIVE_REQUIRES_CONSENT_OPERATIONS` (currently exactly
  `AEGP_ItemSuite9.AEGP_SetItemComment`). Drift fails closed: a missed
  op gets `CONSENT_REQUIRED` from the plug-in; a stale entry only makes
  the client stricter than needed.
- Consent canonicalization rejects non-integer numbers and lone UTF-16
  surrogates; such args surface as `ScriptNotSentError` before any file
  is written. The canonical encoder and its shared vectors are kept
  byte-identical with ae-devtools via `native-consent-vectors.json`
  (vendored by `scripts/sync-consent-vectors.mjs`, #247).
- Grant `args` patterns must live in the same canonical domain;
  anything else (floats, `undefined`, lone surrogates, functions) is a
  `TypeError` at validation. An absent `args` pattern is an explicit
  operation-wide grant — documented, and the recommended narrow form
  pins descriptor fields like `projectIndex` + `item.aeRef.itemId`.
- Verification level: `fake/mock only` — the consent boundary is proven
  against the real C++ intake (`probe_test --channel-server`) and the
  shared vectors, never against a real After Effects. `verifiedOnRealHost`
  remains gated on devtools #223.
