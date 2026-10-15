import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { A8N_VERSION } from "../src/index.js";

describe("package", () => {
  it("exposes the version package.json declares", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(A8N_VERSION).toBe(manifest.version);
  });
});
