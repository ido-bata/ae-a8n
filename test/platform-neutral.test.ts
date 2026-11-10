import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Layers that must ask the platform adapter. A `process.platform` branch here
 * means OS-specific behaviour escaped the adapter, which the spec forbids
 * (`specs/isolated-ae/spec.md` FR-04).
 */
const NEUTRAL_LAYERS = ["src/cli", "src/doctor", "src/setup", "src/runner", "src/reporter"];

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("platform neutrality", () => {
  it("keeps process.platform out of the neutral layers", () => {
    const offenders: string[] = [];
    for (const layer of NEUTRAL_LAYERS) {
      const directory = join(ROOT, layer);
      if (!existsSync(directory)) {
        continue;
      }
      for (const file of filesUnder(directory)) {
        if (readFileSync(file, "utf8").includes("process.platform")) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares the neutral layers the plan names", () => {
    expect(NEUTRAL_LAYERS).toEqual([
      "src/cli",
      "src/doctor",
      "src/setup",
      "src/runner",
      "src/reporter",
    ]);
  });
});
