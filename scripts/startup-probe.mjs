/**
 * G0 bootstrap probe for Issue #99: does After Effects run a per-user
 * `Scripts/Startup` entry without administrator privileges?
 *
 * This is a real-host experiment, not a shipped feature. It installs one
 * marker `.jsx` into the *user* Scripts/Startup folder for the targeted AE
 * version, launches AE through the public `AfterEffects` API, waits for the
 * marker file the script writes, then removes the marker script and closes
 * AE. Nothing is written outside the user Library/Application Data folder,
 * and no global or app-bundle Scripts folder is touched.
 *
 * Requires `npm run build` first (the probe drives `dist/`).
 *
 * Usage:
 *   node scripts/startup-probe.mjs <ae-install-dir> <work-dir> [timeout-ms]
 *
 * `<ae-install-dir>` is the install directory or .app bundle, e.g.
 * "/Applications/Adobe After Effects 2026". `<work-dir>` is a private
 * directory (mode 700) that receives the marker file and result JSON.
 *
 * Outcome is printed as one JSON document on stdout. `startupExecuted` is
 * the G0 fact; `marker` carries the AE version/build the script observed.
 * A missing marker is reported, never retried silently — a permission
 * prompt or a blocked quit is a result, not a failure to route around.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
const here = dirname(fileURLToPath(import.meta.url));
const distIndex = resolve(here, "..", "dist", "index.js");
const PROBE_SCRIPT = "a8n-g0-startup-probe.jsx";
const MARKER = "startup-marker.txt";

function fail(message) {
  console.error(`startup-probe: ${message}`);
  process.exit(2);
}

async function checkPrivateDir(dir) {
  if (!isAbsolute(dir)) fail("work-dir must be absolute");
  const root = resolve(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const st = await stat(root);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    fail("work-dir is accessible to group/other; chmod 700 first");
  }
  return root;
}

/** AE app version → the per-user Scripts folder AE actually reads. */
async function userStartupDir(appPath, platform = process.platform) {
  const plist = join(appPath, "Contents", "Info.plist");
  const text = await readFile(plist, "utf-8").catch(() => null);
  const short = text === null ? null : /CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(text)?.[1];
  if (short === undefined || short === null) {
    fail(`cannot read CFBundleShortVersionString from ${plist}`);
  }
  const [major, minor] = short.split(".");
  if (major === undefined || minor === undefined) {
    fail(`unexpected AE version ${JSON.stringify(short)}`);
  }
  const rel =
    platform === "darwin"
      ? join(homedir(), "Library", "Preferences", "Adobe", "After Effects", `${major}.${minor}`, "Scripts", "Startup")
      : join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          "Adobe",
          "After Effects",
          `${major}.${minor}`,
          "Scripts",
          "Startup",
        );
  return { dir: rel, aeVersion: short };
}

function markerScript(markerPath) {
  // ES3 only. Writes one line of evidence; File I/O needs the user's
  // "Allow Scripts To Write Files" preference — if it is off, AE refuses
  // or prompts and the marker simply never appears.
  return [
    "(function () {",
    `  var f = new File(${JSON.stringify(markerPath)});`,
    '  if (!f.open("w")) { throw new Error("marker open failed"); }',
    '  f.write("version=" + app.version + "\\n");',
    '  f.write("build=" + app.buildNumber + "\\n");',
    '  f.write("buildName=" + app.buildName + "\\n");',
    '  f.write("at=" + new Date().toString() + "\\n");',
    "  f.close();",
    "})();",
    "",
  ].join("\n");
}

async function main() {
  const [installDir, workDir, timeoutArg] = process.argv.slice(2);
  if (installDir === undefined || workDir === undefined) {
    fail("usage: node scripts/startup-probe.mjs <ae-install-dir> <work-dir> [timeout-ms]");
  }
  const timeoutMs = timeoutArg === undefined ? 90_000 : Number(timeoutArg);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    fail("timeout-ms must be a positive number <= 600000");
  }

  const work = await checkPrivateDir(workDir);
  const markerPath = join(work, MARKER);
  const resultPath = join(work, "startup-probe-result.json");

  // Resolve the .app bundle from the install dir or a direct .app path.
  const appPath = installDir.endsWith(".app") ? installDir : join(installDir, `${installDir.split("/").pop()}.app`);
  if (!existsSync(join(appPath, "Contents", "Info.plist"))) {
    fail(`no After Effects bundle at ${appPath}`);
  }

  const { dir: startupDir, aeVersion } = await userStartupDir(appPath);
  const probePath = join(startupDir, PROBE_SCRIPT);
  await mkdir(startupDir, { recursive: true });
  await writeFile(probePath, markerScript(markerPath), { mode: 0o644 });

  const result = {
    probe: "g0-startup",
    issue: 99,
    platform: process.platform,
    aeInstall: installDir,
    aeShortVersion: aeVersion,
    userStartupDir: startupDir,
    adminRequired: false,
    startupExecuted: null,
    marker: null,
    notes: [],
  };

  let ae = null;
  try {
    const { AfterEffects } = await import(distIndex);
    ae = await AfterEffects.launch({ installDir, sessionRoot: join(work, "session") });
    result.aeInfo = ae.info();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(markerPath)) break;
      await sleep(500);
    }
    if (existsSync(markerPath)) {
      result.startupExecuted = true;
      result.marker = await readFile(markerPath, "utf-8");
    } else {
      result.startupExecuted = false;
      result.notes.push(
        "no marker before timeout: the Startup script did not run, was refused " +
          "(scripting/file permission), or a dialog blocked it — check AE manually",
      );
    }
  } catch (error) {
    result.notes.push(`launch/probe error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (ae !== null) {
      try {
        result.close = await ae.close({ unsavedChanges: "discard" });
      } catch (error) {
        result.notes.push(
          `close failed (a modal may be blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await rm(probePath, { force: true }).catch(() => {});
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.startupExecuted !== true) process.exitCode = 1;
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
