/**
 * scripts/check-doc-snippets.js (run by CI on docs/verification.md) must see
 * the same JSX snippets in a CRLF checkout — Git for Windows' default — as in
 * an LF one. Before, a CRLF file matched no block and passed with "0
 * snippet(s) valid".
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-doc-snippets.js", import.meta.url));
const doc = readFileSync(new URL("../docs/verification.md", import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("check-doc-snippets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "a8n-snippets-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check(text: string): string {
    const file = join(dir, "doc.md");
    writeFileSync(file, text);
    return execFileSync(process.execPath, [script, file], { encoding: "utf-8" });
  }

  it("checks the same snippets with LF and CRLF line ends", () => {
    const counted = (output: string) => Number(/: (\d+) JSX snippet/.exec(output)?.[1]);
    const withLf = counted(check(doc));
    expect(withLf).toBeGreaterThan(0);
    expect(counted(check(doc.replace(/\n/g, "\r\n")))).toBe(withLf);
  });

  it("still rejects an invalid snippet in a CRLF file", () => {
    expect(() => check("```js\r\nconst x = 1;\r\n```\r\n")).toThrow();
  });
});
