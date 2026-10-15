import { describe, expect, it } from "vitest";

import { A8N_VERSION } from "../src/index.js";

describe("package", () => {
  it("exposes a version", () => {
    expect(A8N_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
