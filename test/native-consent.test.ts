/**
 * Contract tests for the §7g consent encoder (ae-a8n #245/#247).
 *
 * The canonical cross-repo fixture is vendored at
 * `test/fixtures/native-consent-vectors.json` — the SAME file the
 * ae-devtools C++ intake suite (`native_consent.cpp` via
 * CONSENT_VECTORS_PATH) and `packages/native-adapter/src/consent.ts`
 * verify against. It is refreshed by `npm run sync:consent-vectors`
 * (scripts/sync-consent-vectors.mjs), never hand-edited; the sha256 in
 * `native-consent-vectors.meta.json` proves the vendored copy is
 * intact. `AE_DEVTOOLS_ROOT=<ae-devtools checkout>` additionally runs a
 * live drift check against the upstream worktree. Evidence level:
 * fake/mock only.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canonicalConsentString,
  canonicalJson,
  ConsentCanonicalError,
  issueConsentMac,
  NATIVE_REQUIRES_CONSENT_OPERATIONS,
  nativeOperationRequiresConsent,
} from "../src/driver/native-consent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "native-consent-vectors.json");
const META_PATH = join(HERE, "fixtures", "native-consent-vectors.meta.json");

type CanonicalVector = {
  name: string;
  operationId: string;
  requestId: string;
  sessionJson: string;
  argsJson?: string;
  target?: string;
  canonicalString: string;
  mac: string;
};

type FixtureMeta = {
  v: number;
  upstream: { repo: string; path: string; ref: string };
  sha256: string;
};

type Fixture = {
  v: number;
  consentKey: string;
  channelToken: string;
  operationId: string;
  session: { sessionId: string; aeVersion: string };
  argsJson: string;
  canonicalVectors: CanonicalVector[];
  wireCases: unknown[];
};

const fixtureBytes = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(fixtureBytes.toString("utf-8")) as Fixture;
const meta = JSON.parse(readFileSync(META_PATH, "utf-8")) as FixtureMeta;
const KEY = fixture.consentKey;

function vectorScope(v: CanonicalVector) {
  return {
    operationId: v.operationId,
    requestId: v.requestId,
    session: JSON.parse(v.sessionJson),
    args: v.argsJson === undefined ? undefined : JSON.parse(v.argsJson),
    ...(v.target === undefined ? {} : { target: v.target }),
  };
}

describe("consent fixture integrity", () => {
  it("vendored bytes match the recorded upstream sha256", () => {
    const digest = createHash("sha256").update(fixtureBytes).digest("hex");
    expect(digest).toBe(meta.sha256);
    expect(meta.v).toBe(1);
    expect(meta.upstream.path).toBe(
      "packages/native-adapter/tests/fixtures/native-consent-vectors.json",
    );
  });

  it("fixture shape is the contract v1", () => {
    expect(fixture.v).toBe(1);
    expect(fixture.consentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.canonicalVectors.length).toBeGreaterThan(0);
    expect(fixture.wireCases.length).toBeGreaterThan(0);
  });

  it.skipIf(process.env.AE_DEVTOOLS_ROOT === undefined)(
    "vendored copy is byte-identical to the AE_DEVTOOLS_ROOT worktree",
    () => {
      const upstream = join(
        process.env.AE_DEVTOOLS_ROOT as string,
        meta.upstream.path,
      );
      expect(existsSync(upstream)).toBe(true);
      expect(readFileSync(upstream).equals(fixtureBytes)).toBe(true);
    },
  );
});

describe("consent canonicalJson", () => {
  it("sorts object keys by UTF-8 byte order, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x\"y"] })).toBe(
      '{"a":[true,null,"x\\"y"],"b":1}');
  });

  it("rejects non-integer and out-of-range numbers", () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      ConsentCanonicalError);
    expect(canonicalJson(-0)).toBe("0");
  });

  it("rejects lone UTF-16 surrogates in strings and object keys", () => {
    /* contract §7g (devtools #337): no shared canonical form exists —
       the C++ parser maps them to U+FFFD while JSON.stringify re-emits
       \uDXXX escapes. Issuance must fail closed. */
    expect(() => canonicalJson("lone \uD800 high")).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson("lone \uDC00 low")).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson("\uD800\uD800 pair")).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson({ "\uD800key": 1 })).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson(["ok", "\uDC00"])).toThrow(ConsentCanonicalError);
    /* well-formed surrogate pairs stay encodable */
    expect(canonicalJson("café 😀")).toBe('"café 😀"');
  });

  it("undefined object values are dropped like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("consent shared vectors (native-consent-vectors.json)", () => {
  for (const v of fixture.canonicalVectors) {
    it(`${v.name}: canon string + MAC match the contract`, () => {
      expect(canonicalConsentString(vectorScope(v))).toBe(v.canonicalString);
      expect(issueConsentMac(KEY, vectorScope(v))).toBe(v.mac);
    });
  }

  it("every wireCase consent.expectedMac reproduces under the fixture key", () => {
    /* The wireCases pin the MAC ae-a8n must present for each scenario;
       recompute it over the presented scope (macFor overrides apply). */
    type WireConsent =
      | { mode: string; macFor?: Record<string, unknown>; expectedMac?: string }
      | undefined;
    type WireCase = {
      requestId: string;
      argsJson?: string;
      consent?: WireConsent;
    };
    const cases = fixture.wireCases as WireCase[];
    let checked = 0;
    for (const c of cases) {
      const consent = c.consent;
      if (
        consent === undefined ||
        (consent.mode !== "valid" && consent.mode !== "macFor") ||
        typeof consent.expectedMac !== "string"
      ) {
        continue;
      }
      const over = consent.macFor ?? {};
      const argsJson =
        over.argsJson !== undefined ? over.argsJson : (c.argsJson ?? fixture.argsJson);
      const scope = {
        operationId:
          typeof over.operationId === "string" ? over.operationId : fixture.operationId,
        requestId:
          typeof over.requestId === "string" ? over.requestId : c.requestId,
        session: JSON.parse(
          typeof over.sessionJson === "string"
            ? over.sessionJson
            : JSON.stringify(fixture.session),
        ),
        args: argsJson === null || argsJson === undefined ? null : JSON.parse(argsJson as string),
        ...(typeof over.target === "string" ? { target: over.target } : {}),
      };
      expect(issueConsentMac(KEY, scope), `wireCase ${c.requestId}`).toBe(
        consent.expectedMac,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("tampered scope field breaks the MAC", () => {
    const v = fixture.canonicalVectors[0]!;
    const mac = issueConsentMac(KEY, { ...vectorScope(v), operationId: "OP.TAMPERED" });
    expect(mac).not.toBe(v.mac);
  });

  it("wrong key never verifies the vector MAC", () => {
    const v = fixture.canonicalVectors[0]!;
    expect(issueConsentMac("b".repeat(64), vectorScope(v))).not.toBe(v.mac);
  });

  it("malformed key shape is rejected", () => {
    const v = fixture.canonicalVectors[0]!;
    expect(() => issueConsentMac("abc", vectorScope(v))).toThrow(
      ConsentCanonicalError);
    expect(() => issueConsentMac("A".repeat(64), vectorScope(v))).toThrow(
      ConsentCanonicalError);
  });
});

describe("requiresConsent operation set", () => {
  it("covers exactly the contract's mutating op today", () => {
    expect(NATIVE_REQUIRES_CONSENT_OPERATIONS).toEqual([
      "AEGP_ItemSuite9.AEGP_SetItemComment",
    ]);
    expect(nativeOperationRequiresConsent("AEGP_ItemSuite9.AEGP_SetItemComment")).toBe(true);
    expect(nativeOperationRequiresConsent("AEGP_ItemSuite9.AEGP_GetItemComment")).toBe(false);
    expect(nativeOperationRequiresConsent("AEGP_ProjSuite6.AEGP_GetNumProjects")).toBe(false);
  });
});
