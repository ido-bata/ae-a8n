/**
 * The entry script is the one file handed to After Effects directly, and it is
 * generated per call from paths the caller chose. A path that breaks its syntax
 * would not run at all, and AE answers a script it cannot run with its own modal
 * rather than an ExtendScript alert, so this checks the *generated* file, not
 * only the shipped host script, against the ES3 grammar ExtendScript parses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acorn from "acorn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entryScriptPath, stageHostScript, writeBootstrapScript } from "../src/driver/bootstrap.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a8n-entry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PATHS: [string, string][] = [
  ["plain", "C:\\a8n\\sessions\\x"],
  ["space", "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\ae-a8n x"],
  ["japanese", "C:\\Users\\山田太郎\\セッション"],
  ["japanese and space", "C:\\Users\\山田 太郎\\セッション with space"],
  ["double quote", 'C:\\odd"dir\\x'],
  ["single quote", "C:\\it's\\x"],
  ["trailing backslash", "C:\\dir\\"],
  ["line and paragraph separators", "C:\\a\u2028b\u2029c"],
  ["newline", "C:\\a\nb"],
  ["non-BMP", "C:\\a\u{1F600}b"],
  ["posix", "/Users/me/My Projects/日本語"],
];

describe("the generated entry script", () => {
  it.each(PATHS)("parses as ES3 with a %s path", (_label, root) => {
    const entry = join(dir, "entry.jsx");
    writeBootstrapScript({
      entryPath: entry,
      hostScriptPath: `${root}\\host\\a8n-host.js`,
      requestPath: `${root}\\inbox\\r.request.json`,
      resultPath: `${root}\\outbox\\r.result.json`,
      id: "0f0e1d2c-3b4a-4958-8776-655443322110",
    });
    const source = readFileSync(entry, "utf-8");
    expect(() => acorn.parse(source, { ecmaVersion: 3 })).not.toThrow();
  });

  it("keeps the path it was given, not a mangled one", () => {
    const entry = join(dir, "entry.jsx");
    writeBootstrapScript({
      entryPath: entry,
      hostScriptPath: "C:\\Users\\山田 太郎\\host.js",
      requestPath: "C:\\Users\\山田 太郎\\r.json",
      resultPath: "C:\\Users\\山田 太郎\\o.json",
      id: "i",
    });
    const source = readFileSync(entry, "utf-8");
    // Evaluated as ES3 would see it: the literal must equal the path with `/`.
    const literal = /request: ("(?:[^"\\]|\\.)*"),/.exec(source)?.[1] ?? "";
    expect(JSON.parse(literal)).toBe("C:/Users/山田 太郎/r.json");
  });

  it("uses no syntax newer than ES3 (the parse would reject it)", () => {
    expect(() => acorn.parse("var f = () => 1;", { ecmaVersion: 3 })).toThrow();
    expect(() => acorn.parse("var o = { a: 1, };", { ecmaVersion: 3 })).toThrow();
  });
});

describe("the staged host script", () => {
  it("gives every call its own entry file, so a script that is still running cannot read the next request", () => {
    const first = entryScriptPath("/sessions/x", "11111111-1111-4111-8111-111111111111");
    const second = entryScriptPath("/sessions/x", "22222222-2222-4222-8222-222222222222");
    expect(first).not.toBe(second);
  });

  it("copies the host script and the files next to it into the session's staging folder", () => {
    const source = mkdtempSync(join(tmpdir(), "a8n-host-src-"));
    writeFileSync(join(source, "a8n-host.js"), "// host\n");
    writeFileSync(join(source, "a8n-json.js"), "// codec\n");
    const staged = stageHostScript(dir, join(source, "a8n-host.js"));
    expect(staged).toBe(join(dir, "host", "a8n-host.js"));
    expect(readFileSync(staged, "utf-8")).toBe("// host\n");
    expect(readFileSync(join(dir, "host", "a8n-json.js"), "utf-8")).toBe("// codec\n");
    rmSync(source, { recursive: true, force: true });
  });
});
