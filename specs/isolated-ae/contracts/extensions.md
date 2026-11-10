# Extension contract

- T004 (Issue #54)
- Goal: an external project (Aulymo through `ae-test`) adds its own host
  operations without forking `ae-a8n`, injecting script text at call time, or
  putting its names into this package.

## 1. Principles

1. **Static.** Methods are declared in the consumer's source and built into a
   host script **before** a session starts. Nothing is `eval`'d at call time.
2. **Named.** A call is a method name plus a JSON parameter object. The host
   dispatches from a fixed table; there is no "run this string" method.
3. **Owned.** Every extension method has the same safety envelope as a built-in
   method: it runs only in an owned or proven-attached target, it is traced,
   and it is subject to the call timeout.
4. **Generic.** `ae-a8n` never learns consumer-specific names, match names,
   fixture paths or assertions. Removing the consumer leaves the package
   unchanged.

## 2. Shape

```ts
export type ExtensionMethod = {
  /** Unique, dot-separated, lower-case: "aulymo.buildScene". */
  readonly name: string;
  /**
   * ES3 function expression: `function (params) { … return value; }`.
   * Stored and built; never passed to eval/Function by the Node process.
   */
  readonly source: string;
  /** Upper bound for one call; the session budget applies when omitted. */
  readonly timeoutMs?: number;
};

export type HostExtension = {
  readonly name: string;   // "aulymo"
  readonly version: string;
  readonly methods: readonly ExtensionMethod[];
};
```

Build step, run by the consumer (not at session start):

```bash
npx ae-a8n extension build --extension ./host-extension.ts --out ./.ae-a8n/host.generated.js
```

Output:

```json
{
  "path": "/abs/path/.ae-a8n/host.generated.js",
  "sha256": "…",
  "methods": ["aulymo.buildScene", "aulymo.readTextAnimator"],
  "es3Validated": true
}
```

`launch({ hostScript })` (or the target's saved configuration) points at that
file. The generated file is the shipped `host/a8n-host.js` plus the extension
module; the same file also runs against the in-repo fake host.

## 3. Validation (refuse before anything runs)

`extension build` rejects, with a message naming the method:

- `source` that is not ES3: parsed with `acorn` at `ecmaVersion: 3` after
  stripping the function expression; a syntax error is fatal;
- a name that does not match `/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/`;
- a name equal to a built-in host method or to another extension method;
- a method without a `source`;
- an extension whose `name`/`version` are missing.

At session start, the generated file's `sha256` is recorded in the manifest. A
file that changes between build and launch is refused (`A8N-JOB-001`).

## 4. Calling

```ts
const ae = await AfterEffects.launch({ hostScript: "./.ae-a8n/host.generated.js" });
const result = await ae.call("aulymo.buildScene", { name: "E2E", width: 400 });
```

`ae.call`:

- rejects with `HostNotOwnedError` before sending when ownership is not
  `owned` or proven-attached;
- rejects with `ExtensionMethodNotFoundError` when the loaded host script does
  not declare the name (the error lists the declared names);
- applies the per-call `timeoutMs`, then the session budget;
- never retries on timeout;
- traces `extension.call` with the name and duration, and the params only if
  they are already redacted by the caller's `redact` option.

## 5. Host-side dispatch

The generated host script adds one entry to the existing dispatch table:

```js
__a8n.extensions["aulymo.buildScene"] = function (params) { … };
```

`a8n-host.js` looks up the exact key, checks it is a function, and calls it
inside its existing request/result envelope. It does not use `eval` on params,
and it does not expose `__a8n` to the consumer's code beyond the method body.

The host script remains ES3:
- no `JSON`; use the existing `a8n-json.js` codec;
- no `let`/`const`, arrow functions, template literals, `Array.prototype.map`,
  or `Object.keys` unless the existing runtime shim provides them;
- the same file runs unmodified in the in-repo fake host.

## 6. `ae-test` pass-through (consumer side)

`ae-test`'s fixture accepts the same `hostScript` and forwards it to
`AfterEffects.launch`. The fixture does not parse or rewrite the file. Its
failure behaviour is unchanged: a hard failure in an extension method is a
test failure, not a retry.

This is required by ido-bata/ae-test#19; `ae-a8n` supplies only the launch
option and the build command.

## 7. Compatibility

- Adding a method is additive.
- Renaming or removing one is a breaking change for the consumer, which is
  documented in `CHANGELOG.md`; the host refuses an unknown name with a
  distinct error.
- The extension contract version is `1`. A generated file records it; a host
  script built for a different major version is refused at launch.
