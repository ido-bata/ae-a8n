# ADR 0007 — Recording authorization: per-start scope × session-kind grant

- Status: accepted
- Date: 2026-11-24
- Issue: [#383](https://github.com/ido-bata/ae-a8n/issues/383) (program #337, tracking #346), spec `specs/gui-evidence/spec.md` §5.7
- Affects: `src/evidence/recording.ts`, `src/evidence/types.ts`, `src/api/record.ts`

## Context

Spec §5.6 gates `record.start` on `display`/`session` scopes — and on
every scope while the session kind is not proven `"isolated"` — behind
`requiresRecordingAuthorization`, referencing an "explicit authorization
token/scope per session kind" that no ticket had defined. #381 shipped
the gate fail-closed (absent seam ⇒ refuse); #382/#384 shipped the
recorders. This ticket fixes the authorization contract itself so the
gate has a real path and the Windows backend (#384) reuses the same
shape.

## Decision

The authorization is a **caller-side grant declaration** passed per
`record.start` as `options.authorization`:

```ts
type RecordingAuthorization = {
  scopes:       ("window" | "region" | "display" | "session")[];
  sessionKinds: ("isolated" | "attached" | "console" | "unknown")[];
  grantedBy?:   string;   // audit label, recorded verbatim
};
```

- **Conjunctive coverage**: the grant must name BOTH `scope.kind` and
  the proven `sessionKind`. `"unknown"` session kinds must be granted
  explicitly; nothing upgrades them.
- **Recorded, not trusted**: an accepted grant is persisted verbatim on
  the segment (`authorization`) — the index carries the consent that
  permitted the capture, alongside `leakage` on every artifact.
- **Fail-closed default**: `RecordingController` uses
  `recordingScopeAuthorizer` when no `authorizeRecording` seam is
  injected; absent/malformed/non-covering grants refuse `unauthorized`
  and land in `gaps.unrecorded`. A configured seam replaces the grant
  check wholesale — a policy injection point, not a caller bypass.
- **No ambient state**: the grant is per-start. There is no session-level
  cache, env var, or token file — consent is re-declared for every wide
  or shared capture and each declaration is auditable per segment.

## Threat boundary — what this does and does not guarantee

Same posture as ADR-0004 and the #145 launch grant: ae-a8n is a
single-user automation runtime. The grant proves that *the API caller
explicitly declared consent for this scope × session-kind pair*, and
the index proves the declaration was recorded. It is **not**
authentication: any process that can call `ae.record.start` can declare
any grant. What the contract adds over a bare boolean is precision
(scope × session-kind conjunctive coverage), per-segment audit
persistence, and a single platform-neutral shape both recorder backends
consume. Real consent UX (OS prompt, policy engine, token issuance) is
out of scope and would plug in through the `authorizeRecording` seam.

Exclusions remain declarative (§7.2): backends report
`unhonoredExclusions`, which are recorded per-segment and in
`gaps.uncapturable` — never silently dropped.

## Consequences

- `display`/`session` recordings are now *possible* with an explicit
  grant; the capability matrix says so instead of claiming they always
  refuse.
- `window`/`region` on proven `"isolated"` sessions still need no grant
  — the isolation check is the authorization, unchanged.
- Verification level: `automated test` (fake recorder + grant fixtures).
  Whether a real host honors SCStream window exclusion, TCC prompts, or
  shared-session capture behavior is `unverified` — frozen for the
  real-host lane.
