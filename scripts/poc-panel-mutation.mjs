#!/usr/bin/env node
/**
 * Issue #357 real-host PoC: does the panel mutation path
 * (`PanelController.resize`/`restore` → `set size` via System Events)
 * actually change an After Effects panel's geometry on a real host, in
 * which coordinate space, and does restore return the original frame?
 *
 * This is a real-host experiment, not a shipped feature. It mirrors
 * `poc-boot-attribution.mjs`: it REFUSES to run when the target install
 * already has an in-scope After Effects process — it never attaches to
 * or disturbs an instance it did not start.
 *
 * What is gated vs bypassed, exactly:
 *
 *   - The production path `ae.panel(locator)` is exercised first. Its
 *     `panelMutationGate()` (src/panels/gate.ts) is fail-closed, so
 *     `resize`/`restore` must refuse with PanelError "refused". That
 *     refusal is recorded as evidence the gate still holds.
 *   - The PoC then calls `panelForTarget()` directly with an
 *     `authorizeMutation` seam that returns `{allowed: true}` — the same
 *     seam tests inject. Everything else is production code: owned-pid
 *     attribution re-check, AX frame re-verification inside the System
 *     Events session, the mutation lease, and the audit record all still
 *     run. Only the A-SAFETY policy verdict is bypassed, which is the
 *     point of the PoC (docs/gui-supervision-safety-gates.md unblock
 *     conditions (b) and (c)).
 *   - A ScriptUI resizeable palette window is created inside the owned
 *     AE through a consumer extension host script (`ae-a8n extension
 *     build` + `launch({ hostScript })`), giving an in-AE readback
 *     channel (`poc.panelInfo` → `Window.size`/`bounds`) that production
 *     does not have yet.
 *
 * Requires `npm run build` first (drives `dist/`).
 *
 * Usage:
 *   node scripts/poc-panel-mutation.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-<date>/panel-mutation-poc.json
 *
 * Outcome is one JSON document on stdout (and `--out` when given).
 * Capture PNGs land under `<out-dir>/panels/` via the controller's own
 * artifactDir.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distIndex = resolve(root, "dist", "index.js");
const distPanels = resolve(root, "dist", "api", "panels.js");
const distGate = resolve(root, "dist", "panels", "gate.js");
const distHostProcesses = resolve(root, "dist", "driver", "host-processes.js");
const cli = resolve(root, "dist", "cli.js");

const api = await import(distIndex);
const { AfterEffects } = api;
const { panelForTarget, PanelError } = await import(distPanels);
const { panelMutationGate } = await import(distGate);
const { psProcesses } = await import(distHostProcesses);

function fail(message) {
  console.error(`poc-panel-mutation: ${message}`);
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

/**
 * Diagnostic AppleScript probes (read-only unless noted). Written to the
 * PoC workdir at run time; they only ever address the OWNED pid this
 * script launched — never a foreign process.
 */
const AX_PROBE_SCRIPT = `on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    set wc to count of windows of p
    set uic to count of UI elements of p
    set wincount to 0
    set roles to ""
    repeat with e in UI elements of p
      try
        set r to (role of e) as string
        set roles to roles & r & ","
        if r is "AXLayoutArea" or r is "AXSheet" or r is "AXDialog" or r is "AXSystemDialog" or r is "AXWindow" then set wincount to wincount + 1
      end try
    end repeat
    set fmostVal to "unknown"
    try
      set fmostVal to frontmost of p
    end try
    set visVal to "unknown"
    try
      set visVal to visible of p
    end try
    set out to "windowsClass=" & wc & " uiElements=" & uic & " windowRoles=" & wincount & " frontmost=" & fmostVal & " visible=" & visVal & " roles=" & roles
    -- AE vends nothing under AXChildren/AXWindows on this host, but
    -- AXFocusedWindow still resolves (measured on foreign AE 2026 pid
    -- 49400: an AXLayoutArea/AXDialog modal). Dump it one level deep.
    try
      set fw to value of attribute "AXFocusedWindow" of p
      set fr to ""
      try
        set fr to (role of fw) as string
      end try
      set fsub to ""
      try
        set fsub to (subrole of fw) as string
      end try
      set ft to ""
      try
        set ft to (name of fw) as string
      end try
      set fpos to ""
      set fsize to ""
      try
        set fpos to ((item 1 of (get position of fw)) as string) & "," & ((item 2 of (get position of fw)) as string)
        set fsize to ((item 1 of (get size of fw)) as string) & "," & ((item 2 of (get size of fw)) as string)
      end try
      set out to out & " | focusedWindow role=" & fr & " sub=" & fsub & " title=" & ft & " pos=" & fpos & " size=" & fsize
      set fkids to ""
      try
        set klist to UI elements of fw
        repeat with k in klist
          set kr to ""
          try
            set kr to (role of k) as string
          end try
          set kt to ""
          try
            set kt to (name of k) as string
          end try
          set fkids to fkids & kr & ":" & kt & ","
        end repeat
      end try
      set out to out & " kids=" & fkids
    on error fwerr
      set out to out & " | focusedWindow ERR " & fwerr
    end try
    return out
  end tell
end run
`;

const AX_SET_ATTR_SCRIPT = `on run argv
  set targetPid to (item 1 of argv) as integer
  set attrName to item 2 of argv
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    try
      set value of attribute attrName of p to true
      return "SET-OK"
    on error errMsg
      return "SET-FAIL " & errMsg
    end try
  end tell
end run
`;

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = {
    schema: "a8n.poc-panel-mutation/v1",
    issue: 357,
    recordedAt: new Date().toISOString(),
    install: options.install,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(resolve(root, "dist", "driver", "install-path.js"));
  const install = resolveInstall(process.platform, { installDir: options.install });
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
  const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-panel-poc-"));
  const extensionPath = join(here, "poc-panel-extension.mjs");
  const hostScript = join(workdir, "a8n-panel-poc-host.jsx");
  execFileSync(
    process.execPath,
    [cli, "extension", "build", "--extension", extensionPath, "--out", hostScript],
    { stdio: "pipe" },
  );
  step("extension-build", { hostScript });

  const artifactDir = options.out
    ? join(dirname(resolve(options.out)), "panel-artifacts")
    : join(workdir, "artifacts");

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

    // --- AX observability diagnostics on the OWNED pid only. The prior
    // PoC (#339) and this script's first run both saw AE vend zero AX
    // windows; offstage-macos.md records that this is the signature of a
    // missing Accessibility grant — but Vivaldi's AX tree was readable in
    // the same session, so the probe distinguishes "no grant" from
    // "AE builds its AX tree lazily" (activation / AXManualAccessibility
    // are the known triggers). ---
    const probePath = writeScript(workdir, "axprobe.scpt", AX_PROBE_SCRIPT);
    const setAttrPath = writeScript(workdir, "axsetattr.scpt", AX_SET_ATTR_SCRIPT);
    const activatePath = writeScript(workdir, "axactivate.scpt", AX_ACTIVATE_SCRIPT);
    const pidText = String(target.pid);

    step("ax-baseline", runOsascript(probePath, [pidText]));
    for (const attr of ["AXManualAccessibility", "AXEnhancedUserInterface"]) {
      step(`ax-set-${attr}`, runOsascript(setAttrPath, [pidText, attr]));
    }
    await new Promise((r) => setTimeout(r, 800));
    step("ax-after-attr", runOsascript(probePath, [pidText]));
    step("ax-activate", runOsascript(activatePath, [pidText]));
    await new Promise((r) => setTimeout(r, 1500));
    step("ax-after-activate", runOsascript(probePath, [pidText]));

    // `set frontmost` reported success but the process stayed non-frontmost
    // in the last run; `open` on the already-running owned bundle is the
    // stronger activation (LaunchServices activate, no new instance).
    const bundlePath = join(options.install, install.versionName);
    try {
      execFileSync("/usr/bin/open", [bundlePath], { timeout: 15_000 });
      step("ax-open-activate", { ok: true, bundlePath });
    } catch (error) {
      step("ax-open-activate", {
        ok: false,
        bundlePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await new Promise((r) => setTimeout(r, 2500));
    step("ax-after-open", runOsascript(probePath, [pidText]));
    await new Promise((r) => setTimeout(r, 3000));
    step("ax-after-open-settled", runOsascript(probePath, [pidText]));

    const locator = { title: PANEL_TITLE, titleMatch: "contains" };

    // --- (1) Production gated path: must refuse. ---
    const prodPanel = ae.panel(locator);
    const prodIdentify = await prodPanel.identify();
    step("production-identify", { target: prodIdentify });
    const prodMeasureBefore = await prodPanel.measure();
    step("production-measure-before", { measurement: prodMeasureBefore });
    try {
      await prodPanel.resize(RESIZE_TO);
      step("production-resize", { result: "UNEXPECTEDLY-ALLOWED" });
    } catch (error) {
      step("production-resize", {
        refused: error instanceof PanelError ? error.code : "non-PanelError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await prodPanel.restore();
      step("production-restore", { result: "UNEXPECTEDLY-ALLOWED" });
    } catch (error) {
      step("production-restore", {
        refused: error instanceof PanelError ? error.code : "non-PanelError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    step("production-gate-direct", { verdict: panelMutationGate()("resize") });

    // --- (2) PoC path: same controller, authorizeMutation seam allowed. ---
    const pocPanel = panelForTarget(
      target,
      locator,
      artifactDir,
      {
        authorizeMutation: () => ({ allowed: true }),
        settleMs: options.settleMs,
      },
    );

    const identify = await pocPanel.identify();
    step("identify", { target: identify });
    const measureBefore = await pocPanel.measure();
    step("measure-before", { measurement: measureBefore });
    const inAeBefore = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-before", { inAe: inAeBefore });
    const captureBefore = await pocPanel.capture();
    step("capture-before", { capture: captureBefore });

    const resized = await pocPanel.resize(RESIZE_TO);
    step("resize", { requested: RESIZE_TO, measurement: resized });
    const inAeResized = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-resized", { inAe: inAeResized });
    const captureResized = await pocPanel.capture();
    step("capture-resized", { capture: captureResized });

    const restored = await pocPanel.restore();
    step("restore", { measurement: restored });
    const inAeRestored = await ae.call("poc.panelInfo", {});
    step("in-ae-readback-restored", { inAe: inAeRestored });
    const captureRestored = await pocPanel.capture();
    step("capture-restored", { capture: captureRestored });

    // --- (3) Negative: a window number belonging to another pid must
    // never resolve as this AE's panel. ---
    try {
      const census = api.windowServerCensus(api.execFileCensusRunner());
      const foreign = census.available
        ? census.windows.find((w) => w.pid !== target.pid && w.onScreen === true)
        : undefined;
      if (foreign === undefined) {
        step("negative-foreign", { skipped: "no foreign on-screen window in census" });
      } else {
        const foreignPanel = panelForTarget(
          target,
          { windowNumber: foreign.windowNumber ?? -1 },
          artifactDir,
          { authorizeMutation: () => ({ allowed: true }) },
        );
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
