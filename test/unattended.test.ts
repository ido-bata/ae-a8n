/**
 * Nothing the host does may need a person to recover from.
 *
 * On a real AE (26.5x89) an exception that escapes a script run through
 * `DoScriptFile` becomes a modal alert, and AE answers nothing more until
 * someone dismisses it. The first cold-start run at be03189 hit exactly that:
 *
 *   cold start → no global JSON → host loads its codec → looks it up on the
 *   global object, where a real AE never puts it → codec undefined → the error
 *   handler calls codec.stringify → throws past the host → modal alert →
 *   AppleEvent timeout after 120 s
 *
 * Warm, the same host worked, because by then another extension had installed
 * a `JSON` polyfill the host preferred. These tests pin each link.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import { HostError } from "../src/protocol/envelope.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { runHostScript } from "../src/testing/fake-ae/es3-runtime.js";
import { createFakeGlobals, FakeApplication } from "../src/testing/fake-ae/object-model.js";
import { TraceRecorder } from "../src/trace/trace.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a8n-unattended-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function driverFor(
  transport: FakeAfterEffectsTransport,
  options: { hostScriptPath?: string } = {},
): AeDriver {
  return new AeDriver({
    transport,
    sessionRoot: join(dir, "session"),
    trace: new TraceRecorder({ file: join(dir, "trace.jsonl") }),
    defaultTimeoutMs: 2_000,
    readinessTimeoutMs: 2_000,
    ...options,
  });
}

describe("the fake's $.evalFile follows a real AE's scoping", () => {
  function run(entrySource: string): Record<string, unknown> {
    writeFileSync(join(dir, "inner.jsx"), "var leaked = 42;\nleaked + 1;\n");
    const entry = join(dir, "entry.jsx");
    writeFileSync(entry, entrySource.replace("INNER", JSON.stringify(join(dir, "inner.jsx"))));
    const outcome = runHostScript(entry, createFakeGlobals(new FakeApplication()));
    expect(outcome.success).toBe(true);
    return outcome.globals;
  }

  it("returns the included file's completion value", () => {
    const globals = run("var got = $.evalFile(INNER);");
    expect(globals["got"]).toBe(43);
  });

  it("puts a top-level include's vars on the global object", () => {
    expect(run("$.evalFile(INNER);")["leaked"]).toBe(42);
  });

  it("keeps a nested include's vars off the global object", () => {
    writeFileSync(join(dir, "middle.jsx"), "(function () { $.evalFile(INNER); })();".replace(
      "INNER",
      JSON.stringify(join(dir, "inner.jsx")),
    ));
    const globals = run(`$.evalFile(${JSON.stringify(join(dir, "middle.jsx"))});`);
    expect(globals["leaked"]).toBeUndefined();
  });
});

describe("the host's JSON codec", () => {
  it("works with no global JSON, as on a cold start", async () => {
    const d = driverFor(new FakeAfterEffectsTransport());
    await expect(d.start()).resolves.toMatchObject({ version: "26.0.0" });
    await d.stop();
  });

  it("ignores a global JSON some other extension installed", async () => {
    // A polyfill the host must not depend on. If the host used it, every
    // call would fail.
    const transport = new FakeAfterEffectsTransport();
    transport.foreignJson = {
      parse(): never {
        throw new Error("foreign JSON.parse used");
      },
      stringify(): never {
        throw new Error("foreign JSON.stringify used");
      },
    };
    const d = driverFor(transport);
    await d.start();
    await expect(d.call("app.info")).resolves.toMatchObject({ version: "26.0.0" });
    await d.stop();
  });
});

describe("an exception that escapes the host", () => {
  async function failureFrom(hostSource: string): Promise<HostError> {
    const host = join(dir, "broken-host.js");
    writeFileSync(host, hostSource);
    const transport = new FakeAfterEffectsTransport();
    const d = driverFor(transport, { hostScriptPath: host });
    const error = await d.start().then(
      () => null,
      (caught: unknown) => caught,
    );
    // The cause, not "timed out": the guard answered the request.
    expect(error).toBeInstanceOf(HostError);
    return error as HostError;
  }

  it("is published as a failure instead of escaping the entry script", async () => {
    const error = await failureFrom('throw new Error("boom");\n');
    expect(error.message).toMatch(/raised past its own handler: boom/);
  });

  it("is published even for a syntax error in the host", async () => {
    const error = await failureFrom('var x = "unterminated;\n');
    expect(error.message).toMatch(/raised past its own handler/);
  });

  it("survives quotes, backslashes and line terminators in the message", async () => {
    const message = 'a "quoted" \\ back\nnew\u2028line';
    const literal = JSON.stringify(message).replace(/\u2028/g, "\\u2028");
    const error = await failureFrom(`throw new Error(${literal});\n`);
    expect(error.message).toBe(`host script raised past its own handler: ${message}`);
  });
});
