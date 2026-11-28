/**
 * Guarantee-boundary matrix generator (#435,
 * `specs/release-acceptance/spec.md` §9).
 *
 *   node scripts/guarantee-boundary.js [--out <path>]
 *
 * Bundles `src/acceptance/guarantee-boundary.ts` with esbuild (the same
 * mechanism `test/gui-lease.test.ts` uses for worker bundles) and prints
 * the machine-readable matrix as JSON. The matrix is a *projection* of
 * the live `*Capabilities()` declarations, mutation gates,
 * `classifyOperationRetry`, dispatch-gate probes and
 * `NEXT_ACTION_REASON_CODES` — it is never hand-maintained, so it must
 * be regenerated whenever those sources change (the contract test
 * `test/guarantee-boundary.test.ts` fails when the committed artifact
 * under `docs/evidence/` drifts).
 *
 * Default output: `docs/evidence/guarantee-boundary-matrix.json`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(root, "docs", "evidence", "guarantee-boundary-matrix.json");

export function generateGuaranteeBoundaryMatrix() {
  const dir = mkdtempSync(join(tmpdir(), "a8n-guarantee-boundary-"));
  const bundle = join(dir, "guarantee-boundary.mjs");
  buildSync({
    entryPoints: [join(root, "src", "acceptance", "guarantee-boundary.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundle,
    logLevel: "silent",
  });
  return import(pathToFileURL(bundle).href).then((mod) => mod.buildGuaranteeBoundaryMatrix());
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out") {
      out = resolve(args[i + 1] ?? "");
      i += 1;
    }
  }
  const matrix = await generateGuaranteeBoundaryMatrix();
  const json = `${JSON.stringify(matrix, null, 2)}\n`;
  if (args.includes("--stdout")) {
    process.stdout.write(json);
  } else {
    writeFileSync(out, json, "utf-8");
    console.log(`guarantee-boundary matrix: ${matrix.rows.length} rows -> ${out}`);
  }
}
