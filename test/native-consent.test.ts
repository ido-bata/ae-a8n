/**
 * Contract tests for the §7g consent encoder (ae-a8n #245).
 *
 * The shared vectors are committed verbatim in ae-devtools
 * `packages/native-adapter/tests/consent.test.ts` and mirrored in the
 * C++ plug-in tests — both sides must produce byte-identical canon
 * strings and MACs; divergence is a contract bug, not an
 * implementation detail. Evidence level: fake/mock only.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalConsentString,
  canonicalJson,
  ConsentCanonicalError,
  issueConsentMac,
  NATIVE_REQUIRES_CONSENT_OPERATIONS,
  nativeOperationRequiresConsent,
} from "../src/driver/native-consent.js";

const KEY = "a".repeat(64);

const VECTORS = [
  {
    scope: {
      operationId: "AEGP_ItemSuite9.AEGP_SetItemComment",
      requestId: "r1",
      session: { sessionId: "s1", aeVersion: "26.5" },
      args: {
        projectIndex: 0,
        item: {
          aeRef: { type: "comp", name: "C", path: [0], itemId: 1 },
        },
        comment: "hi",
      },
    },
    wantCanon:
      "native-consent/v1\nAEGP_ItemSuite9.AEGP_SetItemComment\nr1\n" +
      "{\"aeVersion\":\"26.5\",\"sessionId\":\"s1\"}\n" +
      "{\"comment\":\"hi\",\"item\":{\"aeRef\":{\"itemId\":1,\"name\":\"C\",\"path\":[0],\"type\":\"comp\"}},\"projectIndex\":0}\n",
    wantMac: "6253c53d4af5731e9cbfb96141c66b4d782e0675fc1ef020528a73799200e888",
  },
  {
    scope: {
      operationId: "OP.X",
      requestId: "req-2",
      session: {
        aeVersion: "26.5",
        sdkRelease: { distribution: "macos", identifier: "26.5" },
        sessionId: "s",
      },
      args: null,
      target: "inst-1",
    },
    wantCanon:
      "native-consent/v1\nOP.X\nreq-2\n" +
      "{\"aeVersion\":\"26.5\",\"sdkRelease\":{\"distribution\":\"macos\",\"identifier\":\"26.5\"},\"sessionId\":\"s\"}\n" +
      "null\ninst-1",
    wantMac: "4d2eb82d4d845f24b3e24e544026f306d75d6152f008a0f67cab9c665c902e1f",
  },
  {
    scope: {
      operationId: "OP.Y",
      requestId: "r3",
      session: { aeVersion: "1.0", sessionId: "s\"q" },
      args: { a: [1, -2, 0], b: { k: true, z: "x\ny" }, c: null },
    },
    wantCanon:
      "native-consent/v1\nOP.Y\nr3\n" +
      "{\"aeVersion\":\"1.0\",\"sessionId\":\"s\\\"q\"}\n" +
      "{\"a\":[1,-2,0],\"b\":{\"k\":true,\"z\":\"x\\ny\"},\"c\":null}\n",
    wantMac: "cb89c6ba1fb651081c0b790a02085206dba9fbff80f3fbe748abf672fe34ae67",
  },
];

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

  it("undefined object values are dropped like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("consent shared vectors", () => {
  for (const [i, v] of VECTORS.entries()) {
    it(`vector ${i}: canon + MAC match the C++ plug-in`, () => {
      expect(canonicalConsentString(v.scope)).toBe(v.wantCanon);
      expect(issueConsentMac(KEY, v.scope)).toBe(v.wantMac);
    });
  }

  it("tampered scope field breaks the MAC", () => {
    const v = VECTORS[0]!;
    const mac = issueConsentMac(KEY, { ...v.scope, operationId: "OP.TAMPERED" });
    expect(mac).not.toBe(v.wantMac);
  });

  it("wrong key never verifies the vector MAC", () => {
    const v = VECTORS[0]!;
    expect(issueConsentMac("b".repeat(64), v.scope)).not.toBe(v.wantMac);
  });

  it("malformed key shape is rejected", () => {
    expect(() => issueConsentMac("abc", VECTORS[0]!.scope)).toThrow(
      ConsentCanonicalError);
    expect(() => issueConsentMac("A".repeat(64), VECTORS[0]!.scope)).toThrow(
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
