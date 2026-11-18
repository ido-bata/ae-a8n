/**
 * The smallest consumer-side static extension: declare a method in your own
 * module, build a host script with `ae-a8n extension build`, launch with it,
 * and call the method through `ae.call` — the same envelope as a built-in.
 *
 * This file is shipped in the package so a consumer can copy the pattern:
 * it imports only `@ido-bata/ae-a8n`, never `src/` internals.
 *
 *   node examples/extension-consumer.ts [path/to/my-extension.mjs]
 *
 * With no argument it builds and calls a bundled demo method
 * (`example.double`). The build step needs no After Effects; the call does,
 * and the example exits 0 with a skip notice when no install is discoverable
 * — a skip is not a pass (docs/consumer-acceptance.md).
 *
 * The contract is `specs/isolated-ae/contracts/extensions.md`: methods are
 * static ES3 function expressions fixed before a session starts, names may
 * not collide with built-ins, and an undeclared name is refused before
 * anything reaches After Effects.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AfterEffects,
  AfterEffectsNotInstalledError,
  resolveInstall,
} from "@ido-bata/ae-a8n";

// The CLI ships next to this file in the installed package (and in a source
// checkout after `npm run build`): examples/ -> <package>/dist/cli.js.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const DEMO_EXTENSION = `// A consumer extension module: default-exports a HostExtension.
// Method sources are ES3 function expressions — no eval, no closures over
// Node state; they run inside After Effects.
export default {
  name: "example-extension",
  version: "1.0.0",
  methods: [
    {
      name: "example.double",
      source:
        "function (params) { var v = params === undefined || params.value === undefined ? 0 : params.value; return v * 2; }",
    },
  ],
};
`;

const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-extension-example-"));
const extensionPath = process.argv[2] ?? join(workdir, "extension.mjs");
if (process.argv[2] === undefined) {
  writeFileSync(extensionPath, DEMO_EXTENSION, "utf-8");
}
const hostScript = join(workdir, "a8n-example-host.jsx");

execFileSync(
  process.execPath,
  [CLI, "extension", "build", "--extension", extensionPath, "--out", hostScript],
  { stdio: "inherit" },
);
console.log(`host script: ${hostScript}`);

let install: ReturnType<typeof resolveInstall>;
try {
  install = resolveInstall();
} catch (error) {
  if (error instanceof AfterEffectsNotInstalledError) {
    console.log("skipped: no After Effects installation is discoverable on this host");
    process.exit(0);
  }
  throw error;
}
console.log(`install: ${install.versionName} (${install.executable})`);

const ae = await AfterEffects.launch({ hostScript, timeoutMs: 120_000 });
try {
  console.log(`extension methods: ${ae.extensionMethods().join(", ")}`);
  const doubled = await ae.call<number>("example.double", { value: 21 });
  console.log(`example.double(21) = ${doubled}`);

  // An undeclared name is refused before anything reaches After Effects.
  try {
    await ae.call("example.notDeclared", {});
    console.log("unexpected: undeclared method was not refused");
  } catch (error) {
    console.log(`undeclared method refused: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await ae.close();
}
