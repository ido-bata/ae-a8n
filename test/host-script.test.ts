/**
 * The host scripts ship verbatim, not compiled, so nothing else in the build
 * would catch modern syntax before it reached a live ExtendScript engine and
 * failed there with a far worse error message.
 *
 * The check parses as ES3 rather than grepping. Grepping flags `const` inside
 * a comment that exists precisely to say `const` is unavailable, which is the
 * kind of check people learn to disable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as acorn from "acorn";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SCRIPTS = ["host/a8n-host.js", "host/a8n-json.js"] as const;

function parse(path: string): void {
  acorn.parse(readFileSync(path, "utf-8"), { ecmaVersion: 3 });
}

/** Line numbers of every conditional that has a conditional in a branch. */
function nestedConditionals(root: unknown): string[] {
  const found: string[] = [];

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["type"] === "ConditionalExpression") {
      for (const branch of ["consequent", "alternate"]) {
        const child = record[branch] as { type?: string } | undefined;
        if (child?.type === "ConditionalExpression") {
          const loc = (record["loc"] as { start: { line: number } } | undefined)?.start.line;
          found.push(`line ${String(loc ?? "?")}`);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "loc" || key === "start" || key === "end") {
        continue;
      }
      visit(value);
    }
  };

  visit(root);
  return found;
}

describe("host scripts", () => {
  it.each(HOST_SCRIPTS)("%s parses under Node too", (relative) => {
    const path = resolve(PACKAGE_ROOT, relative);
    expect(() => execFileSync(process.execPath, ["--check", path])).not.toThrow();
  });

  it.each(HOST_SCRIPTS)("%s is valid ES3", (relative) => {
    // acorn enforces the version: `let`, `const`, arrow functions, template
    // literals, and trailing commas in some positions are all syntax errors at
    // ecmaVersion 3, which is exactly the constraint ExtendScript imposes.
    expect(() => parse(resolve(PACKAGE_ROOT, relative))).not.toThrow();
  });

  it("would actually reject modern syntax, so the check above means something", () => {
    const modern = ["const x = 1;", "let y = 2;", "const f = () => 1;", "const s = `x`;"];
    for (const source of modern) {
      expect(() => acorn.parse(source, { ecmaVersion: 3 })).toThrow();
    }
  });

  it("keeps the dispatch table in the reviewed source, not a generator", () => {
    const source = readFileSync(resolve(PACKAGE_ROOT, "host/a8n-host.js"), "utf-8");
    // The method names are the bridge protocol's contract. If they moved into
    // a code generator, the ES3 guarantee would rest on that template instead.
    for (const method of [
      "comp.renderFrame",
      "layer.applyEffect",
      "effect.setParameter",
      "project.open",
      "app.info",
    ]) {
      expect(source).toContain(`methods["${method}"]`);
    }
  });

  it.each(HOST_SCRIPTS)("%s puts no conditional inside a conditional", (relative) => {
    // Measured on AE 26.5x89 (ExtendScript 4.5.6), 2026-11-10: given
    //
    //   var m = has(a, k) ? a[k] : has(b, k) ? b[k] : undefined;
    //
    // the engine lets the *second* test decide the whole expression. A name
    // found in `a` therefore evaluated to `b[k]` — undefined — and the host
    // answered every request with "unknown method". Grouping the inner
    // conditional, or writing statements, evaluates correctly.
    //
    // Node evaluates the ungrouped form as ES3 says, so the fake host cannot
    // expose this: only a check on the shipped text can.
    const ast = acorn.parse(readFileSync(resolve(PACKAGE_ROOT, relative), "utf-8"), {
      ecmaVersion: 3,
      locations: true,
    });
    expect(nestedConditionals(ast)).toEqual([]);
  });
});
