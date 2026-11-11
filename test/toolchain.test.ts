import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { A8N_VERSION } from "../src/index.js";

describe("package", () => {
  it("exposes the version package.json declares", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(A8N_VERSION).toBe(manifest.version);
  });

  it("passes the release gate that reads the constant from the source", () => {
    // The gate reads source text, not the build, so it has to find the
    // declaration where it lives (src/version.ts, re-exported by index.ts).
    // It said "A8N_VERSION is undefined" on the publish job when the constant
    // moved (#70).
    const script = fileURLToPath(new URL("../scripts/check-release.js", import.meta.url));
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf-8" })).not.toThrow();
  });
});
