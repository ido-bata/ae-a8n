/**
 * A stand-in After Effects host process for the end-to-end test.
 *
 * It is spawned as a separate process by the agent's executor, exactly where a
 * real `AfterFX.exe` invocation would be. It does nothing to a real After
 * Effects and owns no GUI: it writes one line to stdout and one to stderr,
 * appends its invocation to `A8N_FAKE_HOST_LOG` when that is set, and exits
 * with a code the mode names.
 *
 * Modes: `ok` -> 0, `fail` -> 3. Anything else is a usage error (2).
 */

import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "";
const logPath = process.env["A8N_FAKE_HOST_LOG"];

if (logPath !== undefined && logPath !== "") {
  appendFileSync(logPath, `${mode} ${process.pid}\n`);
}

if (mode === "ok") {
  process.stdout.write("fake-ae-host:ok\n");
  process.stderr.write("fake-ae-host:stderr-ok\n");
  process.exit(0);
}

if (mode === "fail") {
  process.stdout.write("fake-ae-host:fail\n");
  process.stderr.write("fake-ae-host:stderr-fail\n");
  process.exit(3);
}

process.stderr.write(`fake-ae-host: unknown mode "${mode}"\n`);
process.exit(2);
