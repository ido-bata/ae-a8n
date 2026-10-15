/**
 * The README and the agent skill may only name API that exists.
 *
 * An agent follows the skill literally; a method that is not there costs it a
 * failed run and a guess. This checks, mechanically, that every name imported
 * from the package is exported, and every method called on an API object in
 * a code block is declared in the API source.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
const DOCS = ["README.md", "skills/after-effects-automation/SKILL.md"];
const SOURCE = ["src/api/index.ts", "src/api/errors.ts", "src/driver/install-path.ts"].map(read).join("\n");

/** Calls on things that are not ours: Node, the console, arrays. */
const NOT_OURS = new Set(["log", "error", "exit", "slice", "map", "push", "join", "toString", "digest", "update", "createHash"]);

function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)].map((match) => match[1] as string);
}

describe.each(DOCS)("%s", (doc) => {
  const blocks = codeBlocks(read(doc));

  it("has TypeScript examples to check", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("imports only names the package exports", () => {
    const imported = blocks.flatMap((block) =>
      [...block.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@ido-bata\/ae-a8n"/g)].flatMap((match) =>
        (match[1] as string).split(",").map((name) => name.trim()).filter(Boolean),
      ),
    );
    expect(imported.filter((name) => !(name in api))).toEqual([]);
  });

  it("calls only methods the API declares", () => {
    const called = new Set(
      blocks.flatMap((block) => [...block.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1] as string)),
    );
    const missing = [...called].filter(
      (name) => !NOT_OURS.has(name) && !new RegExp(`(^|\\s)(async\\s+|static\\s+async\\s+|get\\s+)?${name}\\s*[(<]`, "m").test(SOURCE),
    );
    expect(missing).toEqual([]);
  });
});
