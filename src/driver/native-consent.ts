/**
 * native-consent.ts — mutation consent proof (ae-a8n #245).
 *
 * Canonical encoder + HMAC-SHA256 for the `native-channel/v1` per-request
 * authorization MAC, implementing ae-devtools
 * `specs/ae-capability-coverage/contracts/native-channel.md` §7g. The
 * implementation is contract-identical to ae-devtools
 * `packages/native-adapter/src/consent.ts` and the C++ plug-in
 * (`native_consent.cpp`); the shared test vectors committed on both
 * sides pin byte-identical output — any divergence is a contract bug.
 *
 * What this proves and what it does not (contract §7g threat model,
 * ae-a8n #249):
 *
 * - `consentKey` is a second shared secret in `channel.json`, in the
 *   same 0600/private-directory domain as `token`. Anyone who can read
 *   `channel.json` — i.e. any process running as the same OS user — can
 *   compute valid MACs. The MAC therefore proves exactly two things:
 *   (a) the writer possessed `consentKey` at signing time, and (b) the
 *   MAC binds the request to the exact scope fields
 *   (operationId/requestId/session/args/target). It does NOT prove
 *   which code path or process produced it — same-user forgery is
 *   undetectable at this layer — and it is NOT authentication.
 * - Operation authorization is a separate, ae-a8n-owned layer:
 *   `publishNativeRequest` evaluates the channel's explicit grant
 *   BEFORE a MAC is issued and refuses unapproved mutations before
 *   anything is sent. Key possession proves channel capability only.
 * - Product model assumption: the native channel trusts processes
 *   running as the same OS user. The channel directory's POSIX
 *   privacy is the outer boundary; a malicious same-user process can
 *   forge requests, results, and heartbeats regardless of consent.
 *   Isolating untrusted local agents requires contract-level work —
 *   signing-key separation AND channel access control AND result
 *   authenticity; asymmetric request signing alone does not close the
 *   result-forgery gap. That redesign is owned by ae-devtools.
 */

import { createHmac } from "node:crypto";

/** Thrown when a value cannot be canonically encoded (non-integer or
 *  out-of-range number — floats are not consent-encodable in v1). */
export class ConsentCanonicalError extends Error {
  constructor(detail: string) {
    super(`value is not consent-canonical: ${detail}`);
    this.name = "ConsentCanonicalError";
  }
}

const MAX_SAFE = 9007199254740991;
const HEX64 = /^[a-f0-9]{64}$/;

/* Lone UTF-16 surrogates have no UTF-8 form: the C++ plug-in's JSON
   parser (native_json.cpp JParseString) maps them to U+FFFD while
   JSON.stringify re-emits them as \uDXXX escapes — the two sides could
   never produce the same canonical bytes, so the value is not
   consent-encodable (contract §7g: canonicalization fails → the
   request refuses CONSENT_INVALID). Rejecting at issuance is the
   fail-closed mirror of that outcome. Identical to ae-devtools
   packages/native-adapter/src/consent.ts. */
function assertNoLoneSurrogate(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      throw new ConsentCanonicalError("lone surrogate in string");
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ConsentCanonicalError("lone surrogate in string");
    }
  }
}

/**
 * canonicalJson — restricted JSON canonical form (contract §7g):
 * no whitespace; object keys sorted by UTF-8 byte order; strings
 * escaped exactly like JSON.stringify; integers only.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v) || Math.abs(v) > MAX_SAFE) {
      throw new ConsentCanonicalError(`non-canonical number ${v}`);
    }
    return String(v);
  }
  if (typeof v === "string") {
    assertNoLoneSurrogate(v);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    /* A hole would canonicalize differently from JSON.stringify
       ([1,,2] vs [1,null,2]) — the MAC would cover bytes the plug-in
       never rebuilds, so refuse before sending. */
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) {
        throw new ConsentCanonicalError("sparse array");
      }
    }
    return `[${v.map((e) => canonicalJson(e)).join(",")}]`;
  }
  if (typeof v === "object") {
    /* Only plain records belong to the canonical domain: a class
       instance or a toJSON-bearing object serializes differently on
       the wire than the canonical bytes the MAC covers. */
    const proto = Object.getPrototypeOf(v);
    if ((proto !== Object.prototype && proto !== null) ||
        typeof (v as { toJSON?: unknown }).toJSON === "function") {
      throw new ConsentCanonicalError("non-plain object");
    }
    const keys = Object.keys(v).sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const parts = keys.map((k) => {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) {
        /* JSON.stringify drops undefined object values; the canonical
           form treats them as absent — same semantics. */
        return null;
      }
      assertNoLoneSurrogate(k);
      return `${JSON.stringify(k)}:${canonicalJson(val)}`;
    }).filter((p): p is string => p !== null);
    return `{${parts.join(",")}}`;
  }
  throw new ConsentCanonicalError(`unsupported value type ${typeof v}`);
}

export type ConsentScopeInput = {
  operationId: string;
  requestId: string;
  session: unknown;
  args?: unknown;
  target?: string;
};

/**
 * canonicalConsentString (contract §7g):
 *   "native-consent/v1\n" ++ operationId ++ "\n" ++ requestId ++ "\n"
 *     ++ canonicalJson(session) ++ "\n" ++ canonicalJson(args ?? null)
 *     ++ "\n" ++ (target ?? "")
 */
export function canonicalConsentString(input: ConsentScopeInput): string {
  return (
    "native-consent/v1\n" +
    input.operationId + "\n" +
    input.requestId + "\n" +
    canonicalJson(input.session) + "\n" +
    canonicalJson(input.args ?? null) + "\n" +
    (input.target ?? "")
  );
}

/**
 * Issue a consent MAC: HMAC-SHA256 over the canonical consent string,
 * keyed by the 32-byte consentKey (64 lowercase hex). Returns the
 * 64-char lowercase hex MAC for the request envelope's `consent.mac`.
 */
export function issueConsentMac(
  consentKeyHex: string,
  scope: ConsentScopeInput,
): string {
  if (!HEX64.test(consentKeyHex)) {
    throw new ConsentCanonicalError("consentKey must be 64 lowercase hex chars");
  }
  const msg = canonicalConsentString(scope);
  return createHmac("sha256", Buffer.from(consentKeyHex, "hex"))
    .update(msg, "utf8")
    .digest("hex");
}

/**
 * The intake-allowlist operations that require a §7g consent proof.
 * Mirrors the mutating executor binding in ae-devtools — the C++
 * allowlist table is the source of truth and
 * `NATIVE_INTAKE_CONSENT_OPS` in `packages/native-adapter/src/dispatch.ts`
 * mirrors it devtools-side (contract §7). Currently exactly one —
 * `AEGP_ItemSuite9.AEGP_SetItemComment` (§7h). Keep in sync with the
 * contract: a stale entry fails closed in the safe direction (the
 * plug-in refuses `CONSENT_REQUIRED` for an op this list misses, and
 * ignores `consent` on read-only ops).
 */
export const NATIVE_REQUIRES_CONSENT_OPERATIONS: readonly string[] = [
  "AEGP_ItemSuite9.AEGP_SetItemComment",
];

export function nativeOperationRequiresConsent(operationId: string): boolean {
  return NATIVE_REQUIRES_CONSENT_OPERATIONS.includes(operationId);
}
