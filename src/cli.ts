#!/usr/bin/env node
/**
 * `npx @ido-bata/ae-a8n doctor` lands here. The implementation lives in
 * `src/cli/`; this file exists so the built entry is `dist/cli.js` and the bin
 * can be pointed at it directly.
 */

import { main } from "./cli/main.js";

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `ae-a8n: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
