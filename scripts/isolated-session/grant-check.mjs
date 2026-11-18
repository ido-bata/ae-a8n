#!/usr/bin/env node
/**
 * The guided grant/check loop for the permissions a session needs
 * (contracts/permissions.md §2–§3, issue #57 T021/T022).
 *
 *   node run-in-isolated-session.mjs --user ae-test --substrate terminal -- \
 *     node scripts/isolated-session/grant-check.mjs [--wait-ms 300000]
 *
 * Run it **inside the target user's session**, as a child of the app that
 * will do the work — the same responsible-process context the test's own
 * commands inherit. It:
 *
 *   1. probes every permission first, so an already-granted one is never
 *      re-requested;
 *   2. for each permission still missing, raises the OS's own request —
 *      `CGRequestScreenCaptureAccess` for Screen Recording, the verified
 *      `ax-grant.command` helper for Accessibility and Automation — and
 *      prints, *before* the dialog can appear, which desktop it lands on
 *      and how to reach it with fast user switching;
 *   3. polls the probes until every requestable permission is granted or
 *      the wait expires, then reports `granted | denied | unproven` per
 *      permission — an unmeasured state is never a pass.
 *
 * What it never does: press a dialog (the OS shows them; a human answers
 * them), write TCC.db, run tccutil, store a credential, or retry a timed-out
 * Apple Event as a permission problem. AE's own script-trust/file-network
 * preference and Adobe sign-in are human steps inside After Effects; they
 * are reported with instructions, never automated.
 *
 * Output is one JSON document on stdout; routing and progress go to stderr.
 * Exit status is 0 whenever the loop itself ran; consumers judge the states.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyAutomation,
  probeAutomation,
  probeTcc,
  readAePrefsEntries,
  readSession,
  run,
  summarizeAePrefs,
} from "./permission-probe.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = resolve(SELF, "..");

/** The interpreter the request probe needs; the census's CLT python3. */
const TCC_REQUEST_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";

/** How often the probes are re-run while a human answers the dialogs. */
const POLL_MS = 2_000;

/**
 * The Screen Recording request. `CGRequestScreenCaptureAccess` opens the
 * System Settings pane on this session's desktop; the grant itself is a
 * human toggle there. Preflight afterwards reports the new state.
 */
export const SCREEN_RECORDING_REQUEST_SCRIPT = String.raw`
import ctypes
def load(framework, name):
    try:
        return ctypes.CDLL("/System/Library/Frameworks/%s.framework/%s" % (framework, name))
    except Exception:
        return None
cg = load("CoreGraphics", "CoreGraphics")
if cg is None or not hasattr(cg, "CGRequestScreenCaptureAccess"):
    print("screen_request=-1")
else:
    fn = cg.CGRequestScreenCaptureAccess
    fn.restype = ctypes.c_bool
    print("screen_request=%d" % (1 if fn() else 0))
`;

/**
 * The requestable permissions, in the order their dialogs are raised.
 * `request` names the mechanism; `check` re-reads the state afterwards.
 */
export const GRANT_TARGETS = [
  {
    id: "screenRecording",
    title: "Screen Recording",
    dialog:
      "System Settings > Privacy & Security > Screen Recording (the pane opens on this desktop; " +
      "enable the entry for the terminal or app that runs ae-a8n)",
    request: "screen-recording",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    dialog:
      'the "… wants to control this computer" dialog (answer OK/Allow on this desktop)',
    request: "ax-grant",
  },
  {
    id: "automationSystemEvents",
    title: "Automation → System Events",
    dialog:
      'the "… wants to control System Events" consent dialog (answer OK/Allow on this desktop)',
    request: "ax-grant",
  },
];

function parseArgs(argv) {
  const options = { waitMs: 300_000, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--wait-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--wait-ms needs a positive number of milliseconds, not ${String(argv[index + 1])}`);
      }
      options.waitMs = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

/** One full measurement of the requestable permissions. */
function measure() {
  const tcc = probeTcc();
  return {
    screenRecording: tcc.screenRecording,
    accessibility: tcc.accessibility,
    automationSystemEvents: classifyAutomation(probeAutomation()),
  };
}

/**
 * Raises the Screen Recording request. Returns "requested", "already" or a
 * detail string when the OS could not be asked — never throws for a denied
 * answer, because a `0` from the request API is still a raised request.
 */
export function requestScreenRecording(exec = run) {
  const result = exec(TCC_REQUEST_PYTHON, ["-c", SCREEN_RECORDING_REQUEST_SCRIPT], 15_000);
  if (result.status !== 0) {
    return { requested: false, detail: result.stderr.trim() || `exit ${result.status}` };
  }
  const match = /screen_request=(-?\d+)/.exec(result.stdout);
  if (match === null) {
    return { requested: false, detail: "the request probe did not answer" };
  }
  const value = Number(match[1]);
  if (value === -1) {
    return { requested: false, detail: "the OS did not provide CGRequestScreenCaptureAccess" };
  }
  return { requested: true, detail: null };
}

/**
 * The verified `ax-grant.command` helper, resolved next to this script or in
 * the shared run directory — the same two places the .command itself looks.
 */
export function findAxGrant(here = HERE, shared = "/Users/Shared/ae-a8n/run") {
  for (const dir of [here, shared]) {
    const candidate = join(dir, "ax-grant.command");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Runs the verified grant helper for Accessibility + Automation. The helper
 * re-checks the pinned source hash and compiles privately before it asks;
 * this wrapper only decides *whether* to invoke it and reports its exit.
 */
export function requestAxAndAutomation(path = findAxGrant()) {
  if (path === null) {
    return { requested: false, detail: "ax-grant.command was not found next to this script or in the shared run directory" };
  }
  const result = spawnSync("/bin/sh", [path], { encoding: "utf-8", timeout: 120_000 });
  if (result.error !== undefined) {
    return { requested: false, detail: result.error.message };
  }
  return { requested: result.status === 0, detail: result.status === 0 ? null : `ax-grant.command exited ${result.status}` };
}

/**
 * The guided loop. `deps` are the seams tests use off-macOS: the probe
 * functions, the request functions and the clock/sleep.
 */
export function grantCheck({
  waitMs = 300_000,
  now = () => Date.now(),
  sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]),
  measureFn = measure,
  requestScreen = requestScreenRecording,
  requestAx = requestAxAndAutomation,
  readSessionFn = readSession,
  aePrefsFn = () => summarizeAePrefs(readAePrefsEntries()),
} = {}) {
  const session = readSessionFn();
  const startedAt = now();
  const report = {
    probe: "ae-a8n-grant-check/1",
    at: new Date(startedAt).toISOString(),
    session,
    routing:
      `permission dialogs appear on ${session.username}'s desktop ` +
      `(uid ${session.uid}, asid ${session.asid ?? "unknown"}). Reach it with macOS fast user ` +
      "switching — do not log out — answer each dialog there, then return here; this loop keeps checking.",
    requests: [],
    permissions: {},
    pending: [],
    waitedMs: 0,
  };

  let states = measureFn();
  const deadline = startedAt + waitMs;
  const axAutomationRequested = { value: false };

  for (;;) {
    const missing = GRANT_TARGETS.filter((target) => states[target.id]?.state !== "granted");
    if (missing.length === 0 || now() >= deadline) {
      break;
    }
    for (const target of missing) {
      if (target.request === "screen-recording") {
        if (!report.requests.some((r) => r.permission === target.id)) {
          const outcome = requestScreen();
          report.requests.push({
            permission: target.id,
            dialog: target.dialog,
            requested: outcome.requested,
            detail: outcome.detail,
          });
        }
      } else if (target.request === "ax-grant" && !axAutomationRequested.value) {
        // One helper run raises both the Accessibility and the Automation
        // dialogs; it is invoked once, after the routing line is printed.
        axAutomationRequested.value = true;
        const outcome = requestAx();
        for (const id of ["accessibility", "automationSystemEvents"]) {
          report.requests.push({
            permission: id,
            dialog: GRANT_TARGETS.find((t) => t.id === id).dialog,
            requested: outcome.requested,
            detail: outcome.detail,
          });
        }
      }
    }
    sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    states = measureFn();
  }

  report.permissions = {
    ...states,
    aeScriptFileNetwork: aePrefsFn(),
    adobeSignIn: {
      state: "unproven",
      detail:
        "sign-in is a human step inside After Effects on the target desktop; it is never automated " +
        "and never probed destructively",
    },
  };
  report.pending = GRANT_TARGETS.filter((target) => states[target.id]?.state !== "granted").map(
    (target) => target.id,
  );
  report.waitedMs = now() - startedAt;
  return report;
}

function main() {
  if (process.platform !== "darwin") {
    process.stderr.write("grant-check: this loop is macOS-only; the Windows permission surface is the interactive desktop session.\n");
    process.exitCode = 2;
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const report = grantCheck({ waitMs: options.waitMs });
  process.stderr.write(`${report.routing}\n`);
  for (const request of report.requests) {
    process.stderr.write(
      `grant-check: requested ${request.permission}${request.requested ? "" : ` (not raised: ${request.detail})`}; ` +
        `dialog: ${request.dialog}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`grant-check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
