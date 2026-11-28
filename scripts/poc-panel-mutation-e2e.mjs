#!/usr/bin/env node
/**
 * Issue #358 real-host verification: the PRODUCTION `ae.panel()` path —
 * identify → measure → resize → measure → restore — against an owned
 * After Effects 2027, through the window-ops `act` vehicle
 * (`AXUIElementSetAttributeValue`) that #357 proved and the #358
 * A-SAFETY class decision permitted for resize/restore only.
 *
 * Unlike scripts/poc-panel-mutation.mjs (#357, which bypassed the gate
 * with an `authorizeMutation` seam to test the vehicle), this script
 * exercises `ae.panel(locator)` exactly as a consumer calls it: the
 * production `panelMutationGate()` decides. It REFUSES to run when the
 * target install already has an in-scope After Effects process — it
 * never attaches to or disturbs an instance it did not start, and it
 * never mutates a foreign AE.
 *
 * Requires `npm run build` first (drives `dist/`).
 *
 * Usage:
 *   node scripts/poc-panel-mutation-e2e.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-<date>/panel-mutation-e2e.json
 *
 * Outcome is one JSON document on stdout (and `--out` when given).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distIndex = resolve(root, "dist", "index.js");
const distGate = resolve(root, "dist", "panels", "gate.js");
const distHostProcesses = resolve(root, "dist", "driver", "host-processes.js");
const cli = resolve(root, "dist", "cli.js");

const api = await import(distIndex);
const { AfterEffects } = api;
const { PanelError } = await import(resolve(root, "dist", "api", "panels.js"));
const { panelMutationGate } = await import(distGate);
const { psProcesses } = await import(distHostProcesses);

function fail(message) {
  console.error(`poc-panel-mutation-e2e: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { install: undefined, out: undefined, settleMs: 800, readinessTimeoutMs: 240_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--readiness-timeout-ms") options.readinessTimeoutMs = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) {
    fail("--install <dir> is required (this PoC never guesses an install)");
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    fail("--settle-ms must be a non-negative number");
  }
  if (!Number.isFinite(options.readinessTimeoutMs) || options.readinessTimeoutMs <= 0) {
    fail("--readiness-timeout-ms must be a positive number");
  }
  return options;
}

const PANEL_TITLE = "ae-a8n PoC Panel";
const RESIZE_TO = { width: 560, height: 440 };
// The consumer extension module lives next to this script so it can be
// reviewed and built on its own: scripts/poc-panel-extension.mjs.

const AX_PROBE_SCRIPT = `on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    set wc to count of windows of p
    set uic to count of UI elements of p
    set fmostVal to "unknown"
    try
      set fmostVal to frontmost of p
    end try
    return "windowsClass=" & wc & " uiElements=" & uic & " frontmost=" & fmostVal
  end tell
end run
`;

const AX_JXA_ACTIVATE = `ObjC.import('stdlib');
var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(PID_PLACEHOLDER);
if (app == null) { 'NO-APP'; } else {
  // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
  app.activateWithOptions(3);
  'ACTIVATED ' + app.processIdentifier;
}`;

const AX_ACTIVATE_SCRIPT = `on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    try
      set frontmost of p to true
      return "FRONTMOST-SET"
    on error errMsg
      return "FRONTMOST-FAIL " & errMsg
    end try
  end tell
end run
`;

function inScopeAEPids(install) {
  return psProcesses()
    .filter((p) => p.executable === install.executable)
    .map((p) => p.pid);
}

function writeScript(workdir, name, source) {
  const path = join(workdir, name);
  writeFileSync(path, source, "utf-8");
  return path;
}

function runOsascript(scriptPath, args) {
  try {
    const out = execFileSync("/usr/bin/osascript", [scriptPath, ...args], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    return { ok: true, output: out.trim() };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function runJxa(source) {
  try {
    const out = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { ok: true, output: out.trim() };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function framesAgree(a, b, tolerance = 4) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = {
    schema: "a8n.poc-panel-mutation-e2e/v1",
    issue: 358,
    recordedAt: new Date().toISOString(),
    install: options.install,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(
    resolve(root, "dist", "driver", "install-path.js")
  );
  const install = resolveInstall(process.platform, {
    installDir: options.install,
  });
  const preexisting = inScopeAEPids(install);
  step("preflight", { install: install.executable, preexisting });
  if (preexisting.length > 0) {
    evidence.outcome = "refused";
    evidence.reason =
      `${preexisting.length} in-scope instance(s) of ${install.executable} already ` +
      "running; an owned launch would attach to them, which this PoC never does";
    emit(evidence, options.out);
    return;
  }

  // --- Build the extension host script (no AE needed). ---
  const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-panel-e2e-"));
  const extensionPath = join(here, "poc-panel-extension.mjs");
  const hostScript = join(workdir, "a8n-panel-e2e-host.jsx");
  execFileSync(
    process.execPath,
    [cli, "extension", "build", "--extension", extensionPath, "--out", hostScript],
    { stdio: "pipe" },
  );
  step("extension-build", { hostScript });

  const ae = await AfterEffects.launch({
    installDir: options.install,
    hostScript,
    timeoutMs: 300_000,
    readinessTimeoutMs: options.readinessTimeoutMs,
  });
  step("launch", {
    pid: ae.recoveryTarget()?.pid ?? null,
    info: ae.info(),
    readinessTimeoutMs: options.readinessTimeoutMs,
  });

  try {
    const target = ae.recoveryTarget();
    if (target === null) {
      // Throw instead of emit+return: an early emit here would write the
      // evidence BEFORE the finally close() and the postflight census run,
      // losing the cleanup record.
      throw new Error("recoveryTarget() is null; no owned pid/session attested");
    }
    step("recovery-target", { pid: target.pid });

    // Create the ScriptUI resizeable palette inside the owned AE.
    const shown = await ae.call("poc.panelShow", { width: 400, height: 300 });
    step("panel-show", { inAe: shown });
    await new Promise((r) => setTimeout(r, 500));

    // AE only vends its AX window enumeration after the app has been
    // frontmost at least once (#406/#357). Activate the owned instance
    // through LaunchServices (`open` on the running bundle), then probe.
    const probePath = writeScript(workdir, "axprobe.scpt", AX_PROBE_SCRIPT);
    const activatePath = writeScript(workdir, "axactivate.scpt", AX_ACTIVATE_SCRIPT);
    const pidText = String(target.pid);
    step("ax-baseline", runOsascript(probePath, [pidText]));
    const bundlePath = join(options.install, install.versionName);
    // AE only vends its AX window enumeration after the app has been
    // frontmost at least once (#406/#357). `set frontmost` alone did not
    // stick in the #357 run; alternate it with `open` on the running
    // bundle (LaunchServices activate) until the probe reports
    // frontmost, then give the AX tree time to populate.
    let activated = false;
    for (let i = 0; i < 12 && !activated; i += 1) {
      step(`ax-activate-${i}`, runOsascript(activatePath, [pidText]));
      // NSRunningApplication activate targets the pid exactly — the two
      // installed AE versions share bundle id/name, so AppleScript
      // `tell application` cannot pick the owned one.
      step(
        `ax-jxa-activate-${i}`,
        runJxa(AX_JXA_ACTIVATE.replace("PID_PLACEHOLDER", pidText)),
      );
      try {
        execFileSync("/usr/bin/open", [bundlePath], { timeout: 15_000 });
        step(`ax-open-${i}`, { ok: true, bundlePath });
      } catch (error) {
        step(`ax-open-${i}`, {
          ok: false,
          bundlePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise((r) => setTimeout(r, 2500));
      const probe = runOsascript(probePath, [pidText]);
      step(`ax-probe-${i}`, probe);
      activated = probe.ok && /frontmost=true/.test(probe.output);
    }
    step("ax-activated", { activated });
    // Give the AX tree a moment to populate after activation.
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const probe = runOsascript(probePath, [pidText]);
      step(`ax-settle-${i}`, probe);
      if (probe.ok && /windowsClass=[1-9]/.test(probe.output)) break;
    }

    // --- Gate verdicts, production gate object, no seam. ---
    step("gate-verdicts", {
      resize: panelMutationGate()("resize"),
      restore: panelMutationGate()("restore"),
      move: panelMutationGate()("move"),
      capture: panelMutationGate()("capture"),
    });

    const locator = { title: PANEL_TITLE, titleMatch: "contains" };
    const panel = ae.panel(locator);

    // --- (1) identify → measure. AX vend can lag activation; retry the
    // read-only identify a few times and record each attempt. ---
    let identified = null;
    let identifyError = null;
    for (let i = 0; i < 6; i += 1) {
      try {
        identified = await panel.identify();
        step(`identify-attempt-${i}`, { target: identified });
        break;
      } catch (error) {
        identifyError = error;
        step(`identify-attempt-${i}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (identified === null) {
      throw identifyError ?? new Error("identify never resolved");
    }
    const measureBefore = await panel.measure();
    step("measure-before", { measurement: measureBefore });
    const inAeBefore = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-before", { inAe: inAeBefore });

    // --- (2) resize through the production gate. ---
    const resized = await panel.resize(RESIZE_TO);
    step("resize", { requested: RESIZE_TO, measurement: resized });
    await new Promise((r) => setTimeout(r, options.settleMs));
    const inAeResized = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-resized", { inAe: inAeResized });

    // --- (3) restore through the production gate. ---
    const restored = await panel.restore();
    step("restore", { measurement: restored });
    await new Promise((r) => setTimeout(r, options.settleMs));
    const inAeRestored = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-restored", { inAe: inAeRestored });

    // --- (4) Three-channel agreement summary. ---
    const censusAfter = api.windowServerCensus(api.execFileCensusRunner());
    const censusRow =
      censusAfter.available && identified.surface.windowNumber !== null
        ? censusAfter.windows.find(
            (w) => w.windowNumber === identified.surface.windowNumber,
          )
        : undefined;
    step("postflight-frame-check", {
      identifiedWindowNumber: identified.surface.windowNumber,
      censusRow: censusRow ?? null,
      measureRestoredFrame: restored?.frame ?? null,
      inAeRestored: inAeRestored,
      framesAgree4pt:
        restored?.frame !== undefined &&
        restored?.frame !== null &&
        censusRow?.bounds !== undefined &&
        censusRow?.bounds !== null
          ? framesAgree(restored.frame, censusRow.bounds)
          : null,
    });

    // --- (5) Negative: a census window owned by another pid must never
    // resolve as this AE's panel, even through the production path. ---
    try {
      const foreign = censusAfter.available
        ? censusAfter.windows.find(
            (w) => w.pid !== target.pid && w.onScreen === true,
          )
        : undefined;
      if (foreign === undefined) {
        step("negative-foreign", { skipped: "no foreign on-screen window in census" });
      } else {
        const foreignPanel = ae.panel({
          windowNumber: foreign.windowNumber ?? -1,
        });
        try {
          await foreignPanel.identify();
          step("negative-foreign", {
            result: "UNEXPECTEDLY-RESOLVED",
            foreign,
          });
        } catch (error) {
          step("negative-foreign", {
            windowNumber: foreign.windowNumber,
            ownerPid: foreign.pid,
            owner: foreign.owner,
            refused: error instanceof PanelError ? error.code : "non-PanelError",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      step("negative-foreign", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // In-AE close of the PoC window before quitting AE.
    try {
      await ae.call("poc.panelClose", {});
    } catch {
      // best-effort; ae.close() ends the process anyway
    }

    evidence.outcome = "completed";
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.errorStack = error instanceof Error ? error.stack : undefined;
    try {
      await ae.call("poc.panelClose", {});
    } catch {
      // ignore
    }
  } finally {
    try {
      const closed = await ae.close();
      step("close", { closed });
    } catch (error) {
      step("close", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Post-flight census: the owned AE must be gone; report what remains.
  const post = inScopeAEPids(install);
  step("postflight-census", { remainingInScope: post });
  if (evidence.outcome === "completed" && post.length > 0) {
    evidence.postflightNote =
      "owned AE did not exit cleanly; remaining in-scope pid(s) reported, not killed";
  }
  emit(evidence, options.out);
}

function emit(evidence, out) {
  const json = JSON.stringify(evidence, null, 2);
  if (out !== undefined) {
    writeFileSync(resolve(out), json + "\n", "utf-8");
  }
  console.log(json);
}

await main();
