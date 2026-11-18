#!/usr/bin/env node
/**
 * Reports the permission state of the session it runs in, as JSON.
 *
 *   node permission-probe.mjs
 *
 * Run it **inside the target user's session** — as a child of the app that
 * will do the work (the terminal the test command runs under), through the
 * usual substrates:
 *
 *   node run-in-isolated-session.mjs --user ae-test --substrate terminal -- \
 *     node scripts/isolated-session/permission-probe.mjs
 *
 * TCC grants belong to the responsible process — the innermost app bundle.
 * A probe run here measures the same grants the test's own commands inherit,
 * which is why it must run here and not from the controller's session.
 *
 * The probe never *requests* a permission: the preflight APIs
 * (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`) only report.
 * The Automation check does send one Apple Event (`count processes`), which
 * is the contract's designated probe — on a machine that has never granted
 * it, macOS may show the consent dialog on this session's desktop. That is
 * the grant path working, not a side effect to avoid; see
 * specs/isolated-ae/contracts/permissions.md §1 and §3.
 *
 * Output is one JSON document on stdout. Every permission is
 * `granted | denied | unproven`; an unmeasured state is never a pass.
 * Exit status is 0 whenever the probe itself ran; consumers judge the
 * states, not the exit code.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Same interpreter the packaged window census / TCC probe uses. */
const PROBE_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";

/**
 * The preflight script, kept in step with `src/platform/darwin/tcc.ts`
 * (the packaged doctor's local-intent probe). Prints `screen=N` / `ax=N`:
 * 1 granted, 0 denied, -1 the symbol or framework was absent.
 */
export const TCC_PROBE_SCRIPT = String.raw`
import ctypes
def load(framework, name):
    try:
        return ctypes.CDLL("/System/Library/Frameworks/%s.framework/%s" % (framework, name))
    except Exception:
        return None
def trusted(lib, symbol):
    if lib is None or not hasattr(lib, symbol):
        return -1
    try:
        fn = getattr(lib, symbol)
        fn.restype = ctypes.c_bool
        return 1 if fn() else 0
    except Exception:
        return -1
cg = load("CoreGraphics", "CoreGraphics")
ass = load("ApplicationServices", "ApplicationServices")
print("screen=%d" % trusted(cg, "CGPreflightScreenCaptureAccess"))
print("ax=%d" % trusted(ass, "AXIsProcessTrusted"))
`;

const AUTOMATION_APPLESCRIPT =
  'tell application "System Events" to count processes';

function run(bin, args, timeoutMs = 15_000) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error?.status === "number" ? error.status : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr:
        typeof error?.stderr === "string" && error.stderr.length > 0
          ? error.stderr
          : error instanceof Error
            ? error.message
            : String(error),
      killed: error?.killed === true,
    };
  }
}

/** `screen=N` / `ax=N` lines → numbers; null when absent or malformed. */
export function parseTccLines(text) {
  const read = (name) => {
    for (const line of text.split("\n")) {
      const match = new RegExp(`^${name}=(-?\\d+)\\s*$`).exec(line.trim());
      if (match !== null) {
        return Number(match[1]);
      }
    }
    return null;
  };
  return { screen: read("screen"), ax: read("ax") };
}

function tccState(value, unansweredDetail) {
  if (value === 1) {
    return { state: "granted", detail: null };
  }
  if (value === 0) {
    return { state: "denied", detail: null };
  }
  return {
    state: "unproven",
    detail:
      value === null
        ? unansweredDetail
        : "the OS did not provide this preflight symbol",
  };
}

/**
 * Classify the Automation→System Events probe. A numeric answer is the
 * pass; -1743 is the denial signature (permissions.md §4); anything else —
 * a timeout, another error, no answer — is unproven, never denied-by-guess.
 */
export function classifyAutomation(result) {
  if (result.killed === true) {
    return { state: "unproven", detail: "the probe timed out" };
  }
  const stdout = result.stdout.trim();
  if (/^\d+$/.test(stdout)) {
    return { state: "granted", detail: `System Events answered: ${stdout} process(es)` };
  }
  const text = `${result.stderr}\n${result.stdout}`;
  if (text.includes("-1743")) {
    return {
      state: "denied",
      detail: "Apple Events to System Events were refused (-1743): Automation not granted, or no responsible-process bundle",
    };
  }
  if (text.includes("-1712")) {
    return { state: "unproven", detail: "the event timed out (-1712); System Events did not answer" };
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return { state: "unproven", detail: `the probe did not produce a verdict: ${detail}` };
}

/**
 * `Pref_SCRIPTING_FILE_NETWORK_SECURITY` per AE prefs version directory.
 * `entries` is a list of {versionDir, value} already extracted from the
 * `Adobe After Effects <ver> *.txt` files; an empty list is unproven.
 */
export function summarizeAePrefs(entries) {
  if (entries.length === 0) {
    return {
      state: "unproven",
      detail: "no AE prefs file carried Pref_SCRIPTING_FILE_NETWORK_SECURITY",
      versions: {},
    };
  }
  const versions = {};
  let sawBlocked = false;
  let sawAllowed = false;
  for (const entry of entries) {
    versions[entry.versionDir] = entry.value;
    if (entry.value === "0") {
      sawBlocked = true;
    } else if (entry.value === "1") {
      sawAllowed = true;
    }
  }
  if (sawBlocked) {
    return {
      state: "blocked",
      detail: "Pref_SCRIPTING_FILE_NETWORK_SECURITY is \"0\" for at least one AE version",
      versions,
    };
  }
  if (sawAllowed) {
    return {
      state: "allowed",
      detail: "Pref_SCRIPTING_FILE_NETWORK_SECURITY is \"1\" for every AE version found",
      versions,
    };
  }
  return {
    state: "unproven",
    detail: "the preference value was neither \"0\" nor \"1\"",
    versions,
  };
}

/** Read the pref out of every AE version prefs dir under the home folder. */
function readAePrefsEntries() {
  const root = join(homedir(), "Library", "Preferences", "Adobe", "After Effects");
  const entries = [];
  let versionDirs;
  try {
    versionDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dir of versionDirs) {
    if (!dir.isDirectory() || !/^\d+\.\d+$/.test(dir.name)) {
      continue;
    }
    const prefsDir = join(root, dir.name);
    let files;
    try {
      files = readdirSync(prefsDir);
    } catch {
      continue;
    }
    const prefix = `Adobe After Effects ${dir.name} `;
    for (const name of files) {
      if (!name.startsWith(prefix) || !name.endsWith(".txt")) {
        continue;
      }
      let text;
      try {
        text = readFileSync(join(prefsDir, name), "utf-8");
      } catch {
        continue;
      }
      const match = /Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "([^"]+)"/.exec(text);
      if (match !== null) {
        entries.push({ versionDir: dir.name, value: match[1] });
      }
    }
  }
  return entries;
}

function readSession() {
  const uid = process.getuid();
  let username = "unknown";
  let asid = null;
  let kind = "none";
  try {
    username = execFileSync("id", ["-un"], { encoding: "utf-8" }).trim();
  } catch {
    // keep "unknown"
  }
  try {
    const text = execFileSync("launchctl", ["print", `gui/${uid}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const asidMatch = /\b(?:gui )?asid = (\d+)/.exec(text);
    const kindMatch = /^\s*session = (\w+)\s*$/m.exec(text);
    asid = asidMatch === null ? null : Number(asidMatch[1]);
    kind = kindMatch === null ? "none" : kindMatch[1];
  } catch {
    // keep nulls
  }
  let onConsole = null;
  try {
    onConsole = Number(execFileSync("stat", ["-f", "%u", "/dev/console"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()) === uid;
  } catch {
    onConsole = null;
  }
  return { uid, username, asid, kind, onConsole };
}

function probeTcc() {
  const result = run(PROBE_PYTHON, ["-c", TCC_PROBE_SCRIPT]);
  if (result.status !== 0) {
    const detail =
      result.stderr.trim().length > 0
        ? result.stderr.trim()
        : `the probe exited with ${result.status}`;
    return {
      screenRecording: { state: "unproven", detail: `the TCC probe failed: ${detail}` },
      accessibility: { state: "unproven", detail: `the TCC probe failed: ${detail}` },
    };
  }
  const parsed = parseTccLines(result.stdout);
  return {
    screenRecording: tccState(parsed.screen, "the probe output did not answer for screen recording"),
    accessibility: tccState(parsed.ax, "the probe output did not answer for accessibility"),
  };
}

function probeAutomation() {
  const result = run("/usr/bin/osascript", ["-e", AUTOMATION_APPLESCRIPT], 20_000);
  return classifyAutomation(result);
}

/** The whole probe; `run`/`readPrefs` seams keep it testable off-macOS. */
export function permissionProbe({ session, tcc, automation, aePrefs }) {
  return {
    probe: "ae-a8n-permission-probe/1",
    at: new Date().toISOString(),
    platform: process.platform,
    session,
    permissions: {
      screenRecording: tcc.screenRecording,
      accessibility: tcc.accessibility,
      automationSystemEvents: automation,
      aeScriptFileNetwork: aePrefs,
    },
  };
}

function main() {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "permission-probe: this probe is macOS-only; the Windows permission surface is the interactive desktop session.\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = permissionProbe({
    session: readSession(),
    tcc: probeTcc(),
    automation: probeAutomation(),
    aePrefs: summarizeAePrefs(readAePrefsEntries()),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `permission-probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
