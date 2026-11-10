/**
 * Runs `test/isolated-session.check.mjs`, or says why it cannot run here.
 *
 * Those checks drive the macOS `.command` helpers through bash and assert on
 * POSIX mode bits — "writable by group or others" is a refusal they prove by
 * `chmod`. Windows models neither, so on Windows every case fails for a
 * reason that says nothing about the code: the helper cannot start, its
 * output is empty, and `''` does not match the expected refusal.
 *
 * The checks are not skipped everywhere, only where the subject is absent.
 * Linux CI and macOS run them through this wrapper unchanged.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.stderr.write(
    "isolated-session checks: skipped on Windows — they need a POSIX shell and " +
      "POSIX mode bits, which Windows does not have.\n",
  );
  process.exit(0);
}

const checks = fileURLToPath(new URL("../test/isolated-session.check.mjs", import.meta.url));
const result = spawnSync(process.execPath, ["--test", checks], { stdio: "inherit" });
if (result.error !== undefined) {
  throw result.error;
}
process.exit(result.status ?? 1);
