/**
 * Differential test: the host's ES3 JSON codec against Node's.
 *
 * Both sides are held to the same corpus. The host codec is the one that
 * matters on Windows, where ExtendScript has no `JSON`; a divergence here
 * would corrupt envelopes in a way no type test would catch.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runHostScript } from "../src/testing/fake-ae/es3-runtime.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_JSON = resolve(PACKAGE_ROOT, "host", "a8n-json.js");

type Codec = { stringify(value: unknown): string | undefined; parse(text: string): unknown };

function loadHostCodec(): Codec {
  const outcome = runHostScript(HOST_JSON, {} as never);
  if (!outcome.success) {
    throw outcome.error;
  }
  const codec = outcome.globals["A8NJson"] as Codec | undefined;
  if (codec === undefined) {
    throw new Error("host codec did not define A8NJson");
  }
  return codec;
}

const codec = loadHostCodec();

/** Round-trips through both codecs, so each value must survive both. */
const CORPUS: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  3.5,
  1e21,
  1e-7,
  Number.MAX_SAFE_INTEGER,
  "",
  "plain",
  'quote " backslash \\ slash /',
  "newline \n tab \t return \r",
  "control \u0001\u001f",
  "unicode: 日本語 — ünïcødé 😀",
  "trailing space ",
  [],
  [1, "two", false, null],
  [[[[1]]]],
  {},
  { a: 1 },
  { a: 1, b: "two", c: [3], d: { e: null } },
  { nested: { deeply: { value: [1, { x: true }] } } },
  { "key with spaces": 1, "key.with.dots": 2, "": 3 },
];

describe("host JSON codec", () => {
  it("parses (the engine already has JSON, so the fallback is only exercised explicitly)", () => {
    expect(codec.parse('{"a":1}')).toEqual({ a: 1 });
  });

  it.each(CORPUS)("stringifies %# identically to JSON.stringify", (value) => {
    expect(codec.stringify(value)).toBe(JSON.stringify(value));
  });

  it.each(CORPUS)("round-trips %#", (value) => {
    const text = codec.stringify(value);
    expect(text).toBeDefined();
    // -0 does not survive JSON round-tripping anywhere; normalise it away.
    const expected = JSON.parse(JSON.stringify(Object.is(value, -0) ? 0 : value));
    expect(codec.parse(text as string)).toEqual(expected);
  });

  it("rejects malformed input instead of returning junk", () => {
    const malformed = [
      "",
      "{",
      "[1,",
      '{"a" 1}',
      '{"a":}',
      "tru",
      '"unterminated',
      "{} extra",
      "01",
      '"bad \\q escape"',
      '"bad \\u12 escape"',
    ];
    for (const text of malformed) {
      expect(() => codec.parse(text), `expected ${JSON.stringify(text)} to throw`).toThrow();
    }
  });

  it("reports a line number for parse failures", () => {
    try {
      codec.parse('{\n  "a": 1,\n  bad\n}');
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { line?: number }).line).toBe(3);
    }
  });
});
