# Architecture

## What this repository owns

- After Effects process lifecycle (launch / close)
- project / comp / layer / effect / parameter operations
- render, and retrieval of results and errors
- the programmatic API that higher-level tools consume
- the bridge protocol and transport contract, when one is needed

## What it does not own

- test DSL / assertion / snapshot runner → `ido-bata/ae-test`
- remote worker / queue / GitHub integration → `ido-bata/ae-farm`
- dev-tooling UX → `ido-bata/ae-devtools` (a separate axis; no shared-core dependency in either direction)

The series is `ae-a8n → ae-test → ae-farm`. A dependency that inverts or merges
these series is out of scope.

`docs/vision.md` holds the longer statement of this scope.

## Three layers, strictly separated

The separation is a requirement, not an implementation detail.

```
public API (src/api)          typed objects: AfterEffects → Project → Comp → Layer → Effect → Parameter
   ↓  request envelope (JSON file)
driver (src/driver)           AeDriver: writes requests, polls results, owns timeouts, ownership, trace
   ↓  HostTransport interface
transport                      real: script-invocation.ts (macOS osascript → DoScriptFile; Windows AfterFX.exe -r)
                              fake: src/testing/fake-transport.ts (in-process, same code path)
   ↓
host script (host/a8n-host.js) ES3 ExtendScript running inside AE; writes the result envelope
```

- **Bridge protocol** (`src/protocol/`): file-based JSON envelopes (`PROTOCOL_VERSION = 1`). The
  driver writes into `inbox/`, the host writes into `outbox/`, and every file is published by
  **rename** so a reader never sees a half-written envelope. File-based transport is the only
  channel Windows offers.
- **Session workspace** (`src/protocol/workspace.ts`): `inbox/`, `outbox/`, `artifacts/`,
  `staging/`, `trace.jsonl`.
- **Bootstrap** (`src/driver/bootstrap.ts`): ExtendScript has no imports and no argument passing, so
  each invocation gets a tiny generated entry script that hands the host its request/result paths
  through a global. The entry also catches anything that escapes the host and publishes it as a
  failure envelope — an exception escaping `DoScriptFile` pops a modal alert in AE and blocks it
  until a human clicks.
- **Fake host** (`src/testing/fake-ae/`): `es3-runtime.ts` interprets the **unmodified**
  `host/a8n-host.js`; `object-model.ts` models AE's object model. The host script runs verbatim
  against both a real AE and the fake — only the peer differs. `src/testing/index.ts` is a separate
  package entry point (`@ido-bata/ae-a8n/testing`) on purpose: it is a test surface, not
  automation.
- **Trace** (`src/trace/trace.ts`): every call is recorded as JSONL evidence in the session
  workspace.
- Errors are typed and mapped in `src/api/errors.ts`; public types in `src/api/types.ts`.

## Bridge rules

- Callers never see the bridge protocol, the ExtendScript host script, or raw script strings.
- ExtendScript host code is **ES3**. It is not TypeScript and does not live in `src/`; it ships
  verbatim as `host/`. Anything TypeScript would not compile must not be the host's only copy.
- The host script must run unmodified against both a real AE and the in-repo fake host. Only the
  peer differs.

## Published surface

The package publishes `dist/` (compiled API), `host/` (verbatim host scripts), `skills/` (the
agent skill), and `examples/*.ts`. `src/testing/` is a second entry point, `./testing`, published
deliberately so consumers can run the same assertions against the fake host.

`@ido-bata/ae-a8n/testing` is a test surface, not automation: it never launches After Effects.
