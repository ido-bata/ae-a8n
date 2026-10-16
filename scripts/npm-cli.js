/**
 * Finds the npm CLI's JavaScript entry point (`npm-cli.js`), so callers can
 * run npm as `node <npm-cli.js> …` with no shell.
 *
 * `spawnSync("npm")` does not work everywhere: on Windows `npm` is `npm.cmd`,
 * which Node will not start without a shell (observed on the windows-latest
 * runner: `spawn npm ENOENT`), and a shell would re-parse every argument.
 * Under mise, the `npm` on PATH is a bash wrapper, not a link to npm-cli.js.
 *
 * Order, first hit wins; nothing falls back to a shell or a bare "npm":
 *   1. NPM_CLI_JS — set explicitly (the publish workflow sets it from
 *      `npm root -g` right after pinning the CLI); if set but not an existing
 *      npm-cli.js, resolution fails instead of trying anything else;
 *   2. npm_execpath — set by npm itself under `npm run` / `npm exec`, when it
 *      names npm-cli.js (npx sets it to npx-cli.js, which is skipped);
 *   3. each PATH directory holding an `npm` launcher (PATHEXT on Windows):
 *      Windows `<dir>\node_modules\npm\bin\npm-cli.js`; POSIX the launcher's
 *      real path when it is npm-cli.js, else `<dir>/../lib/node_modules/npm/bin/npm-cli.js`;
 *   4. next to the running node: the same two layouts relative to execPath.
 * Fails with every candidate it tried.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   platform: string,
 *   execPath: string,
 *   exists?: (p: string) => boolean,
 *   realpath?: (p: string) => string,
 * }} ResolveOptions
 */

/**
 * @param {ResolveOptions} options
 * @returns {{ cliJs: string, source: string }}
 */
export function resolveNpmCli(options) {
  const { env, platform, execPath } = options;
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? realpathSync;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  /** @type {string[]} */
  const tried = [];
  /** @param {string | undefined} candidate */
  const usable = (candidate) => {
    if (candidate === undefined || candidate === "") return false;
    tried.push(candidate);
    return /npm-cli\.js$/i.test(candidate) && exists(candidate);
  };
  /** The layouts an npm installation puts next to its launcher directory. */
  const besideLauncher = (dir) =>
    windows
      ? [p.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];

  // An explicit NPM_CLI_JS is a decision, not a hint: if it is wrong, fail
  // rather than quietly pick another npm (possibly the same version from a
  // different install, which the version check would not catch).
  if (env.NPM_CLI_JS !== undefined && env.NPM_CLI_JS !== "") {
    if (usable(env.NPM_CLI_JS)) return { cliJs: env.NPM_CLI_JS, source: "NPM_CLI_JS" };
    throw new Error(`NPM_CLI_JS is set to ${env.NPM_CLI_JS}, which is not an existing npm-cli.js`);
  }
  if (usable(env.npm_execpath)) return { cliJs: /** @type {string} */ (env.npm_execpath), source: "npm_execpath" };

  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];
  for (const dir of pathValue.split(windows ? ";" : ":").filter(Boolean)) {
    const launcher = extensions.map((ext) => p.join(dir, `npm${ext}`)).find((l) => exists(l));
    if (launcher === undefined) continue;
    if (!windows) {
      let real;
      try {
        real = realpath(launcher);
      } catch {
        real = undefined;
      }
      if (real !== undefined && usable(real)) return { cliJs: real, source: `PATH (${launcher})` };
    }
    for (const candidate of besideLauncher(dir)) {
      if (usable(candidate)) return { cliJs: candidate, source: `PATH (${launcher})` };
    }
  }

  for (const candidate of besideLauncher(p.dirname(execPath))) {
    if (usable(candidate)) return { cliJs: candidate, source: "beside node" };
  }

  throw new Error(`cannot find the npm CLI (npm-cli.js); tried: ${tried.length ? tried.join(", ") : "nothing (no npm on PATH)"}`);
}

/** Command and leading arguments to run npm without a shell. */
export function npmCommand(options = { env: process.env, platform: process.platform, execPath: process.execPath }) {
  const { cliJs } = resolveNpmCli(options);
  return { command: options.execPath, args: [cliJs] };
}
