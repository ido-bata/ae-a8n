/**
 * The exports map must name files the build actually produces.
 *
 * This exists because the map was wrong and nothing caught it. `./testing`
 * pointed at `dist/testing.js` while `tsc` emits `dist/testing/index.js`, so
 * the package's own test suite passed — every test imported through `../src/`
 * — and the subpath was broken for every consumer. The failure only appeared
 * when a clean install tried to resolve it.
 *
 * The check works from source, so it does not need a build to have run.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ConditionalExport = string | { types?: string; default?: string; [key: string]: string | undefined };

const manifest = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8"),
) as {
  name: string;
  main: string;
  types: string;
  exports: Record<string, ConditionalExport>;
  files: string[];
};

/** The emit layout tsc produces, from tsconfig.build.json's rootDir/outDir. */
const BUILD_CONFIG = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "tsconfig.build.json"), "utf-8"),
) as { compilerOptions: { outDir: string; rootDir: string } };

function emittedFileForSource(relativeSource: string): string {
  const { outDir } = BUILD_CONFIG.compilerOptions;
  return `${outDir}/${relativeSource.replace(/^src\//, "").replace(/\.ts$/, ".js")}`;
}

/** Exports-map targets are written `./dist/…`; tsconfig paths are `dist/…`. */
function normalise(path: string): string {
  return path.replace(/^\.\//, "");
}

function targetsOf(entry: ConditionalExport): string[] {
  return typeof entry === "string" ? [entry] : Object.values(entry).filter((v): v is string => !!v);
}

function rootExport(): { types: string; default: string } {
  const entry = manifest.exports["."];
  if (entry === undefined || typeof entry === "string") {
    throw new Error(`the "." export must be a conditions object, got ${typeof entry}`);
  }
  const { types, default: main } = entry;
  if (types === undefined || main === undefined) {
    throw new Error('the "." export needs both "types" and "default"');
  }
  return { types, default: main };
}

function testingExport(): { types: string | undefined; default: string } {
  const entry = manifest.exports["./testing"];
  if (entry === undefined || typeof entry === "string") {
    throw new Error(`the "./testing" export must be a conditions object, got ${typeof entry}`);
  }
  const { types, default: main } = entry;
  if (main === undefined) {
    throw new Error('the "./testing" export needs a "default"');
  }
  return { types, default: main };
}

describe("package exports", () => {
  it("declares the entries consumers are expected to use", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
  });

  it.each(Object.entries(manifest.exports))(
    "%s names files the build produces",
    (subpath, entry) => {
      for (const target of targetsOf(entry)) {
        const source = target.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
        expect(
          existsSync(resolve(PACKAGE_ROOT, source)),
          `${subpath} points at ${target}, which would come from ${source}, and that source does not exist`,
        ).toBe(true);
        expect(emittedFileForSource(source)).toBe(
          normalise(target.replace(/\.d\.ts$/, ".js")),
        );
      }
    },
  );

  it("would have caught the broken ./testing path", () => {
    // A check nobody has seen fail is a check nobody can trust. This is the
    // exact mistake that shipped: src/testing/index.ts emitting to
    // dist/testing/index.js while the map named dist/testing.js.
    const wrong = "./dist/testing.js";
    const right = emittedFileForSource("src/testing/index.ts");
    expect(normalise(wrong)).not.toBe(right);
    expect(normalise(testingExport().default)).toBe(right);
  });

  it("keeps main and types in step with the exports map", () => {
    expect(manifest.main).toBe(rootExport().default);
    expect(manifest.types).toBe(rootExport().types);
  });

  it("ships the host scripts, which the runtime needs and the build does not produce", () => {
    // dist/ comes from tsc; host/ does not. A "files" entry that dropped it
    // would produce a package that installs cleanly and then fails on first
    // use, so it is asserted rather than assumed.
    expect(manifest.files).toContain("dist");
    expect(manifest.files).toContain("host");
    expect(existsSync(resolve(PACKAGE_ROOT, "host", "a8n-host.js"))).toBe(true);
    expect(existsSync(resolve(PACKAGE_ROOT, "host", "a8n-json.js"))).toBe(true);
  });
});
