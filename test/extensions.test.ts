/**
 * Extension methods (issue #61, `contracts/extensions.md`).
 *
 * The feature exists so a consumer can add host operations without forking
 * this package and without handing script text to a running After Effects.
 * The tests below are about the refusals as much as the happy path: a build
 * that accepted modern syntax or a colliding name would turn the extension
 * contract into an eval with extra steps.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as acorn from "acorn";
import { afterEach, describe, expect, it } from "vitest";

import { AfterEffects, ExtensionMethodNotFoundError } from "../src/api/index.js";
import { runExtensionCommand } from "../src/cli/extension.js";
import {
  buildHostScript,
  extensionHeader,
  readExtensionHeader,
  validateExtension,
  type HostExtension,
} from "../src/extensions/manifest.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-ext-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const parse = (source: string): void => {
  // The real parser, not a stub: an ES3 refusal is the point of this check.
  acorn.parse(source, { ecmaVersion: 3 });
};

const BUILTINS = ["app.info", "project.open"];

function extension(methods: HostExtension["methods"]): HostExtension {
  return { name: "aulymo", version: "1.0.0", methods };
}

describe("extension validation", () => {
  it("accepts a lower-case dotted name and an ES3 function", () => {
    const result = validateExtension(
      extension([{ name: "aulymo.buildScene", source: "function (params) { return params.name; }" }]),
      { builtins: BUILTINS, parseEs3: parse },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a name that is not lower-case and dotted", () => {
    for (const name of ["buildScene", "Aulymo.build", "aulymo..build", "aulymo.build-scene"]) {
      const result = validateExtension(extension([{ name, source: "function () {}" }]), {
        builtins: BUILTINS,
        parseEs3: parse,
      });
      expect(result.ok, name).toBe(false);
      expect(result.ok === false ? result.detail : "").toContain(name);
    }
  });

  it("refuses a name that would replace a built-in host method", () => {
    const result = validateExtension(extension([{ name: "app.info", source: "function () {}" }]), {
      builtins: BUILTINS,
      parseEs3: parse,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.detail : "").toContain("built-in");
  });

  it("refuses a duplicate name", () => {
    const result = validateExtension(
      extension([
        { name: "aulymo.a", source: "function () {}" },
        { name: "aulymo.a", source: "function () {}" },
      ]),
      { builtins: BUILTINS, parseEs3: parse },
    );
    expect(result.ok).toBe(false);
  });

  it("refuses source that is not ES3, naming the method", () => {
    const result = validateExtension(
      extension([{ name: "aulymo.modern", source: "params => params.name" }]),
      { builtins: BUILTINS, parseEs3: parse },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.detail : "").toContain("aulymo.modern");
    expect(result.ok === false ? result.detail : "").toContain("not ES3");
  });

  it("refuses a method without a source, and an extension without a name or version", () => {
    expect(
      validateExtension(extension([{ name: "aulymo.empty", source: "  " }]), {
        builtins: BUILTINS,
        parseEs3: parse,
      }).ok,
    ).toBe(false);
    expect(validateExtension({ ...extension([]), name: "" }, { builtins: BUILTINS, parseEs3: parse }).ok).toBe(false);
    expect(
      validateExtension({ ...extension([{ name: "aulymo.a", source: "function () {}" }]), version: "" }, {
        builtins: BUILTINS,
        parseEs3: parse,
      }).ok,
    ).toBe(false);
  });
});

describe("the generated host script", () => {
  const HOST = "var hostLoaded = true;\n";

  it("puts the registration before the host, which reads it as it loads", () => {
    const built = buildHostScript(HOST, [{ name: "aulymo.a", source: "function () { return 1; }" }]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.source.indexOf("context.extensions[")).toBeLessThan(built.source.indexOf("hostLoaded"));
    expect(built.source.endsWith(HOST)).toBe(true);
    expect(built.methods).toEqual(["aulymo.a"]);
  });

  it("carries the declared names in a header the Node side can read back", () => {
    const built = buildHostScript(HOST, [
      { name: "aulymo.a", source: "function () { return 1; }" },
      { name: "aulymo.b", source: "function () { return 2; }" },
    ]);
    if (!built.ok) throw new Error(built.detail);
    expect(readExtensionHeader(built.source)).toEqual(["aulymo.a", "aulymo.b"]);
  });

  it("refuses to read a header out of a host script it did not build", () => {
    expect(readExtensionHeader(HOST)).toBeNull();
    expect(readExtensionHeader(extensionHeader([]).replace('"contract":1', '"contract":2'))).toBeNull();
  });
});

describe("ae-a8n extension build", () => {
  function writeExtensionModule(source: object): string {
    const dir = tempDir();
    const path = join(dir, "host-extension.mjs");
    writeFileSync(path, `export default ${JSON.stringify(source)};\n`, "utf-8");
    return path;
  }

  it("writes a buildable host script and reports what it declares", async () => {
    const dir = tempDir();
    const out = join(dir, "host.generated.js");
    const lines: string[] = [];
    const result = await runExtensionCommand(
      [
        "build",
        "--extension",
        writeExtensionModule({
          name: "aulymo",
          version: "1.0.0",
          methods: [{ name: "aulymo.echo", source: "function (params) { return params.value; }" }],
        }),
        "--out",
        out,
      ],
      { writeOut: (text) => lines.push(text), writeErr: () => undefined },
    );
    expect(result.exitCode).toBe(0);
    const reported = JSON.parse(lines.join("")) as { path: string; sha256: string; methods: string[] };
    expect(reported.path).toBe(out);
    expect(reported.methods).toEqual(["aulymo.echo"]);
    expect(reported.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(out, "utf-8")).toContain("aulymo.echo");
  });

  it("refuses a module that is not ES3 and writes nothing", async () => {
    const dir = tempDir();
    const out = join(dir, "host.generated.js");
    const errors: string[] = [];
    const result = await runExtensionCommand(
      [
        "build",
        "--extension",
        writeExtensionModule({
          name: "aulymo",
          version: "1.0.0",
          methods: [{ name: "aulymo.modern", source: "const f = () => 1;" }],
        }),
        "--out",
        out,
      ],
      { writeOut: () => undefined, writeErr: (text) => errors.push(text) },
    );
    expect(result.exitCode).toBe(1);
    expect(errors.join("")).toContain("not ES3");
  });

  it("refuses a missing flag with a usage error", async () => {
    const errors: string[] = [];
    const result = await runExtensionCommand(["build", "--out", "/tmp/x.js"], {
      writeOut: () => undefined,
      writeErr: (text) => errors.push(text),
    });
    expect(result.exitCode).toBe(2);
  });
});

describe("ae.call through the fake host", () => {
  async function launchedWithExtension(dir: string): Promise<AfterEffects> {
    const out = join(dir, "host.generated.js");
    const result = await runExtensionCommand(
      [
        "build",
        "--extension",
        (() => {
          const path = join(dir, "ext.mjs");
          writeFileSync(
            path,
            'export default { name: "aulymo", version: "1.0.0", methods: [' +
              '{ name: "aulymo.echo", source: "function (params) { return params.value; }" },' +
              '{ name: "aulymo.boom", source: "function () { throw new Error(\\"extension failed\\"); }" }' +
              "] };\n",
            "utf-8",
          );
          return path;
        })(),
        "--out",
        out,
      ],
      { writeOut: () => undefined, writeErr: () => undefined },
    );
    expect(result.exitCode).toBe(0);
    return AfterEffects.launch({
      transport: new FakeAfterEffectsTransport(),
      hostScript: out,
      sessionRoot: join(dir, "session"),
    });
  }

  it("declares the methods the host script names", async () => {
    const dir = tempDir();
    const ae = await launchedWithExtension(dir);
    expect(ae.extensionMethods()).toEqual(["aulymo.echo", "aulymo.boom"]);
    await ae.close();
  });

  it("runs the method and returns its value", async () => {
    const dir = tempDir();
    const ae = await launchedWithExtension(dir);
    await expect(ae.call("aulymo.echo", { value: "hello" })).resolves.toBe("hello");
    await ae.close();
  });

  it("refuses an unknown name before sending anything, listing what exists", async () => {
    const dir = tempDir();
    const ae = await launchedWithExtension(dir);
    const attempt = ae.call("aulymo.missing");
    await expect(attempt).rejects.toBeInstanceOf(ExtensionMethodNotFoundError);
    await expect(attempt).rejects.toThrow(/aulymo\.echo/u);
    await ae.close();
  });

  it("surfaces a failure inside the method as that failure", async () => {
    const dir = tempDir();
    const ae = await launchedWithExtension(dir);
    await expect(ae.call("aulymo.boom")).rejects.toThrow(/extension failed/u);
    await ae.close();
  });

  it("refuses a host script that was not built by ae-a8n", async () => {
    const dir = tempDir();
    const plain = join(dir, "plain.js");
    writeFileSync(plain, "// not a generated host script\n", "utf-8");
    await expect(
      AfterEffects.launch({
        transport: new FakeAfterEffectsTransport(),
        hostScript: plain,
        sessionRoot: join(dir, "session"),
      }),
    ).rejects.toThrow(/not built by/u);
  });
});
