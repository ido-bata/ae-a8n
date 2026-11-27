#!/usr/bin/env node
/**
 * Issue #357 real-host PoC, second vehicle: does a FULLY-STARTED owned
 * After Effects vend the ScriptUI palette to AX enumeration, and does
 * the direct-AXUIElement vehicle (window-ops `act` / AXFocusedWindow +
 * AXUIElementSetAttributeValue) resize/restore/move that palette —
 * focused and unfocused?
 *
 * Follow-up to scripts/poc-panel-mutation.mjs + the #406 correction
 * (docs/evidence/realhost-2026-11-27/README.md): non-vending is
 * startup-phase dependent, so this run waits for real startup
 * completion (generous readiness timeout + an enumeration poll) before
 * concluding anything about enumeration.
 *
 * Same ownership contract as poc-panel-mutation.mjs: REFUSES to run
 * when the target install already has an in-scope After Effects
 * process — it never attaches to or disturbs an instance it did not
 * start. Foreign AE instances are census-observed read-only at most.
 *
 * What is gated vs bypassed, exactly:
 *
 *   - `ae.panel()`/`ae.windowOps()` production observe paths run
 *     unmodified (identify/state/measure).
 *   - Mutations run through the PRODUCTION `WindowOpsController` via
 *     `windowOpsForTarget()` with the same `authorizeMutation` test
 *     seam the unit tests inject — owned attribution, frame
 *     re-verification inside the session, GUI lease, audit and the
 *     bounded postcondition poll all still run. Only the A-SAFETY
 *     policy verdict is bypassed, which is the point of the PoC
 *     (docs/gui-supervision-safety-gates.md unblock conditions).
 *   - The AXFocusedWindow element has NO production mutation vehicle
 *     (controller refuses under focusedOnly by design). It is probed
 *     with the evidence helper ax-focused-set.swift compiled from
 *     docs/evidence/realhost-2026-11-27/ — the same class of probe as
 *     axsetsize.swift, extended to move/state and JSON output. The
 *     driver applies the contract's identity rule itself: it reads
 *     `state` first and only mutates when the focused element's frame
 *     matches the expected palette frame within 4pt.
 *
 * Requires `npm run build` first (drives `dist/`).
 *
 * Usage:
 *   node scripts/poc-panel-ax-vehicle.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-<date>/panel-ax-vehicle-poc.json
 *
 * Outcome is one JSON document on stdout (and `--out` when given).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distIndex = resolve(root, "dist", "index.js");
const distPanels = resolve(root, "dist", "api", "panels.js");
const distWindowOps = resolve(root, "dist", "api", "window-ops.js");
const distHostProcesses = resolve(root, "dist", "driver", "host-processes.js");
const cli = resolve(root, "dist", "cli.js");
const FOCUSED_SET_SOURCE = resolve(
  root,
  "docs/evidence/realhost-2026-11-27/ax-focused-set.swift",
);

const api = await import(distIndex);
const { AfterEffects } = api;
const { panelForTarget, PanelError } = await import(distPanels);
const { windowOpsForTarget } = await import(distWindowOps);
const { psProcesses } = await import(distHostProcesses);

const PANEL_TITLE = "ae-a8n PoC Panel";
const PANEL_SIZE = { width: 400, height: 300 };
const RESIZE_TO = { width: 560, height: 440 };
const FRAME_TOLERANCE = 4;

function fail(message) {
  console.error(`poc-panel-ax-vehicle: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    install: undefined,
    out: undefined,
    settleMs: 800,
    enumTimeoutMs: 300_000,
    pollMs: 5_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--enum-timeout-ms") options.enumTimeoutMs = Number(argv[++i]);
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) {
    fail("--install <dir> is required (this PoC never guesses an install)");
  }
  for (const key of ["settleMs", "enumTimeoutMs", "pollMs"]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a non-negative number`);
    }
  }
  return options;
}

function inScopeAEPids(install) {
  return psProcesses()
    .filter((p) => p.executable === install.executable)
    .map((p) => p.pid);
}

function run(file, args, timeoutMs = 60_000) {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    return { ok: true, output: out.trim() };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function runJson(file, args, timeoutMs = 60_000) {
  const result = run(file, args, timeoutMs);
  if (!result.ok) {
    return { ok: false, error: result.output };
  }
  try {
    return { ok: true, json: JSON.parse(result.output) };
  } catch {
    return { ok: false, error: `unparseable output: ${result.output.slice(0, 200)}` };
  }
}

function framesMatch(a, b, tolerance = FRAME_TOLERANCE) {
  if (a == null || b == null) return false;
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeWindowOpsState(json) {
  if (json === null || typeof json !== "object") return null;
  return {
    frontmostPid: json.frontmostPid ?? null,
    focusedWindowIndex: json.focusedWindowIndex ?? null,
    axTrusted: json.axTrusted ?? null,
    focusedWindow: json.focusedWindow ?? null,
    windows: Array.isArray(json.windows)
      ? json.windows.map((w) => ({
          index: w.index,
          title: w.title,
          role: w.role,
          subrole: w.subrole ?? null,
          frame: w.frame ?? null,
          miniaturized: w.miniaturized ?? null,
          main: w.main ?? null,
          focused: w.focused ?? null,
        }))
      : [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = {
    schema: "a8n.poc-panel-ax-vehicle/v1",
    issue: 357,
    recordedAt: new Date().toISOString(),
    install: options.install,
    verificationLevel: "verified on real host",
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(
    resolve(root, "dist", "driver", "install-path.js")
  );
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

  // --- Build the extension host script + compile helpers (no AE). ---
  const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-panel-ax-"));
  const helpersDir = join(workdir, "helpers");
  mkdirSync(helpersDir, { recursive: true });
  const extensionPath = join(here, "poc-panel-extension.mjs");
  const hostScript = join(workdir, "a8n-panel-ax-host.jsx");
  execFileSync(
    process.execPath,
    [cli, "extension", "build", "--extension", extensionPath, "--out", hostScript],
    { stdio: "pipe" },
  );
  step("extension-build", { hostScript });

  for (const helper of ["window-ops", "input-focus", "input-mouse"]) {
    const src = join(root, "scripts", "isolated-session", `${helper}.swift`);
    const res = run("swiftc", ["-O", src, "-o", join(helpersDir, helper)], 120_000);
    step("helper-compile", { helper, ok: res.ok, detail: res.ok ? undefined : res.output });
    if (!res.ok) fail(`swiftc failed for ${helper}: ${res.output}`);
  }
  const focusedSetBin = join(workdir, "ax-focused-set");
  const fsRes = run("swiftc", ["-O", FOCUSED_SET_SOURCE, "-o", focusedSetBin], 120_000);
  step("helper-compile", { helper: "ax-focused-set", ok: fsRes.ok, detail: fsRes.ok ? undefined : fsRes.output });
  if (!fsRes.ok) fail(`swiftc failed for ax-focused-set: ${fsRes.output}`);

  const artifactDir = options.out
    ? join(dirname(resolve(options.out)), "panel-ax-artifacts")
    : join(workdir, "artifacts");

  const windowOpsState = () =>
    runJson(join(helpersDir, "window-ops"), ["state", "--pid", String(targetPid)]);
  const focusedSet = (args) =>
    runJson(focusedSetBin, ["--pid", String(targetPid), ...args]);

  let targetPid = 0;
  let ae;
  try {
    ae = await AfterEffects.launch({
      installDir: options.install,
      hostScript,
      timeoutMs: 300_000,
      // Prior run hit a >4min cold start; poll transport readiness
      // patiently instead of timing out early.
      readinessTimeoutMs: 600_000,
    });
    step("launch", { pid: ae.recoveryTarget()?.pid ?? null, info: ae.info() });
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = `launch failed: ${error instanceof Error ? error.message : String(error)}`;
    // Best-effort cleanup: any in-scope pid now is ours (preflight saw none).
    const leftovers = inScopeAEPids(install);
    step("launch-failure-leftovers", { pids: leftovers });
    if (leftovers.length > 0) {
      const bundlePath = join(options.install, install.versionName);
      const q = run(
        "/usr/bin/osascript",
        ["-e", `tell application "${bundlePath}" to quit`],
        30_000,
      );
      step("launch-failure-quit", { ok: q.ok, detail: q.output });
    }
    emit(evidence, options.out);
    return;
  }

  try {
    const target = ae.recoveryTarget();
    if (target === null) {
      evidence.outcome = "failed";
      evidence.reason = "recoveryTarget() is null; no owned pid/session attested";
      emit(evidence, options.out);
      return;
    }
    targetPid = target.pid;
    step("recovery-target", { pid: targetPid });

    // Create the ScriptUI resizeable palette inside the owned AE.
    const shown = await ae.call("poc.panelShow", { width: PANEL_SIZE.width, height: PANEL_SIZE.height });
    step("panel-show", { inAe: shown });
    await sleep(500);

    const locator = { title: PANEL_TITLE, titleMatch: "contains" };
    const focusedSet = (args) =>
      runJson(focusedSetBin, ["--pid", String(targetPid), ...args]);
    const inAeInfo = async (label) => {
      const info = await ae.call("poc.panelInfo", {});
      step(label, { inAe: info });
      return info;
    };
    const censusNow = () => api.windowServerCensus(api.execFileCensusRunner());
    const panelRow = (census) => {
      if (!census.available) return null;
      return census.windows.find(
        (w) => w.pid === targetPid && typeof w.name === "string" && w.name.includes(PANEL_TITLE),
      ) ?? null;
    };

    // --- (0) Vehicle B FIRST: while the palette is still the app's
    // AXFocusedWindow (it is immediately after panelShow — `open`
    // activation later steals focus to the main window), drive the
    // focused element through ax-focused-set. Identity = census row
    // (windowNumber + bounds) matched against the focused element's
    // AX frame; no match → no mutation (fail-closed, same rule the
    // production contract will encode). ---
    try {
      const c0 = censusNow();
      const panel0 = panelRow(c0);
      step("vehicleB-census-initial", {
        available: c0.available,
        panel: panel0
          ? { windowNumber: panel0.windowNumber, bounds: panel0.bounds, onScreen: panel0.onScreen, name: panel0.name }
          : null,
      });
      const fs0 = focusedSet(["--op", "state"]);
      step("vehicleB-focused-state-initial", fs0);
      const focused0 = fs0.ok ? fs0.json?.window : null;
      const focusedIsPalette0 =
        typeof focused0?.title === "string" && focused0.title.includes(PANEL_TITLE);
      const identityOk0 =
        focused0?.frame != null &&
        panel0?.bounds != null &&
        framesMatch(focused0.frame, panel0.bounds);
      step("vehicleB-identity-check", {
        focusedElement: focused0,
        censusWindowNumber: panel0?.windowNumber ?? null,
        censusFrame: panel0?.bounds ?? null,
        focusedIsPalette: focusedIsPalette0,
        match: identityOk0,
        censusProven: panel0 != null,
      });
      if (focusedIsPalette0 && identityOk0) {
        const beforeInfo = await inAeInfo("vehicleB-in-ae-before");
        const origSize = beforeInfo?.size ?? { width: PANEL_SIZE.width, height: PANEL_SIZE.height };
        const origFrame = focused0.frame;

        const fsResize = focusedSet([
          "--op", "resize", "--width", String(RESIZE_TO.width), "--height", String(RESIZE_TO.height),
        ]);
        step("vehicleB-focused-resize", fsResize);
        await sleep(options.settleMs);
        await inAeInfo("vehicleB-in-ae-resized");
        const cResized = censusNow();
        const panelResized = panelRow(cResized);
        step("vehicleB-census-resized", {
          windowNumber: panelResized?.windowNumber ?? null,
          bounds: panelResized?.bounds ?? null,
        });

        const fsRestore = focusedSet([
          "--op", "resize", "--width", String(origSize.width), "--height", String(origSize.height),
        ]);
        step("vehicleB-focused-restore", fsRestore);
        await sleep(options.settleMs);
        await inAeInfo("vehicleB-in-ae-restored");

        // Move on the focused element, verify, move back.
        const fsMove = focusedSet([
          "--op", "move",
          "--x", String(Math.round(origFrame.x + 90)),
          "--y", String(Math.round(origFrame.y + 60)),
        ]);
        step("vehicleB-focused-move", fsMove);
        await sleep(options.settleMs);
        await inAeInfo("vehicleB-in-ae-moved");
        const cMoved = censusNow();
        const panelMoved = panelRow(cMoved);
        step("vehicleB-census-moved", {
          windowNumber: panelMoved?.windowNumber ?? null,
          bounds: panelMoved?.bounds ?? null,
        });
        const fsMoveBack = focusedSet([
          "--op", "move",
          "--x", String(Math.round(origFrame.x)),
          "--y", String(Math.round(origFrame.y)),
        ]);
        step("vehicleB-focused-move-back", fsMoveBack);
        await sleep(options.settleMs);
        await inAeInfo("vehicleB-in-ae-moved-back");
        const cFinal = censusNow();
        const panelFinal = panelRow(cFinal);
        step("vehicleB-census-final", {
          windowNumber: panelFinal?.windowNumber ?? null,
          bounds: panelFinal?.bounds ?? null,
          expectedApprox: { x: origFrame.x, y: origFrame.y, width: origSize.width, height: origSize.height },
        });
      } else {
        step("vehicleB-mutations", {
          skipped: !focusedIsPalette0
            ? "AXFocusedWindow is not the palette"
            : "census identity unproven — fail-closed, no mutation issued",
        });
      }
    } catch (error) {
      step("vehicleB-focused-mutations", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- (1) Enumeration timing: poll `window-ops state` until the
    // palette appears in the AX *window listing* (or timeout). The
    // AXFocusedWindow report alone does NOT end the poll — #406's
    // correction says fully-started AE vends windows, and this run
    // must measure how long that takes (or whether activation is the
    // trigger). Samples are kept so the JSON shows the timeline. ---
    const enumPoll = {
      startedAt: new Date().toISOString(),
      deadlineMs: options.enumTimeoutMs,
      intervalMs: options.pollMs,
      samples: [],
      found: null,
    };
    const pollOnce = async () => {
      const res = windowOpsState();
      const summary = res.ok ? summarizeWindowOpsState(res.json) : { error: res.error };
      const listed = (summary?.windows ?? []).find(
        (w) => typeof w.title === "string" && w.title.includes(PANEL_TITLE),
      );
      const focusedIsPanel =
        summary?.focusedWindow != null &&
        typeof summary.focusedWindow.title === "string" &&
        summary.focusedWindow.title.includes(PANEL_TITLE);
      return { summary, listed, focusedIsPanel };
    };
    const enumStart = Date.now();
    let lastState = null;
    let enumDone = false;
    while (!enumDone && Date.now() - enumStart < options.enumTimeoutMs) {
      const { summary, listed, focusedIsPanel } = await pollOnce();
      lastState = summary;
      enumPoll.samples.push({
        tMs: Date.now() - enumStart,
        windowCount: summary?.windows?.length ?? null,
        focusedTitle: summary?.focusedWindow?.title ?? null,
        panelListed: listed !== undefined,
        panelFocused: focusedIsPanel === true,
        frontmostPid: summary?.frontmostPid ?? null,
      });
      if (listed !== undefined) {
        enumPoll.found = {
          viaEnumeration: true,
          viaFocusedWindow: focusedIsPanel,
          window: listed,
          afterMs: Date.now() - enumStart,
        };
        enumDone = true;
      }
      await sleep(options.pollMs);
    }
    enumPoll.finishedAt = new Date().toISOString();
    enumPoll.finalState = lastState;
    step("enumeration-poll", enumPoll);

    // Activation experiment: #406 observed vended windows on instances
    // that had been activated/used. `open` on the already-running owned
    // bundle is the strongest activation (LaunchServices activate, no
    // new instance) — then re-poll briefly to see if vending starts.
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
    await sleep(3_000);
    const postActivate = await pollOnce();
    step("enumeration-after-activate", {
      windowCount: postActivate.summary?.windows?.length ?? null,
      focusedTitle: postActivate.summary?.focusedWindow?.title ?? null,
      panelListed: postActivate.listed !== undefined,
      windows: postActivate.summary?.windows ?? null,
    });
    if (enumPoll.found === null && postActivate.listed !== undefined) {
      enumPoll.found = {
        viaEnumeration: true,
        viaFocusedWindow: postActivate.focusedIsPanel,
        window: postActivate.listed,
        afterMs: Date.now() - enumStart,
        note: "appeared only after `open` activation",
      };
      lastState = postActivate.summary;
      enumPoll.finalState = lastState;
    } else if (postActivate.listed === undefined) {
      // Keep polling a while after activation — vending may lag.
      const actStart = Date.now();
      while (Date.now() - actStart < Math.min(options.enumTimeoutMs, 120_000)) {
        const { summary, listed, focusedIsPanel } = await pollOnce();
        lastState = summary;
        enumPoll.samples.push({
          tMs: Date.now() - enumStart,
          windowCount: summary?.windows?.length ?? null,
          focusedTitle: summary?.focusedWindow?.title ?? null,
          panelListed: listed !== undefined,
          panelFocused: focusedIsPanel === true,
          frontmostPid: summary?.frontmostPid ?? null,
          phase: "post-activate",
        });
        if (listed !== undefined) {
          enumPoll.found = {
            viaEnumeration: true,
            viaFocusedWindow: focusedIsPanel,
            window: listed,
            afterMs: Date.now() - enumStart,
            note: "appeared during post-activation poll",
          };
          break;
        }
        await sleep(options.pollMs);
      }
      enumPoll.finalState = lastState;
    }

    // Production observe path: does ae.panel().identify() resolve now?
    try {
      const prodPanel = ae.panel(locator);
      const prodIdentify = await prodPanel.identify();
      step("production-identify", { target: prodIdentify });
      const prodMeasure = await prodPanel.measure();
      step("production-measure", { measurement: prodMeasure });
    } catch (error) {
      step("production-identify", {
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PanelError ? error.code : "non-PanelError",
      });
    }

    // Census for this pid — windowNumber is the capture/identity handle.
    const census = api.windowServerCensus(api.execFileCensusRunner());
    const pidCensus = census.available
      ? census.windows.filter((w) => w.pid === targetPid)
      : [];
    step("census", {
      available: census.available,
      reason: census.available ? undefined : census.reason,
      pidWindows: pidCensus.map((w) => ({
        windowNumber: w.windowNumber,
        bounds: w.bounds,
        onScreen: w.onScreen,
        owner: w.owner,
        name: w.name,
      })),
    });

    // Locate the palette's census row by frame match against the AX
    // window the poll found (or the focusedWindow report).
    const foundWindow = enumPoll.found?.window ?? null;
    const fw = enumPoll.finalState?.focusedWindow ?? null;
    const panelFrame =
      foundWindow?.frame ??
      (fw != null && typeof fw.title === "string" && fw.title.includes(PANEL_TITLE)
        ? fw.frame
        : null);
    // Census-first resolve has two keys: frame match against any AX
    // evidence, and — crucially while the AX enumeration is empty —
    // the census window NAME (CGWindowList names were NOT redacted on
    // this host: the palette row carries "ae-a8n PoC Panel"). Name is
    // a locator hint, never sole identity; the frame re-check below
    // and inside every act is what proves it.
    const panelCensus =
      (panelFrame != null
        ? pidCensus.find((w) => w.bounds != null && framesMatch(panelFrame, w.bounds))
        : undefined) ??
      pidCensus.find(
        (w) => typeof w.name === "string" && w.name.includes(PANEL_TITLE),
      );
    step("panel-census-match", {
      axFrame: panelFrame,
      censusWindow: panelCensus
        ? {
            windowNumber: panelCensus.windowNumber,
            bounds: panelCensus.bounds,
            onScreen: panelCensus.onScreen,
            name: panelCensus.name,
          }
        : null,
    });

    const ops = windowOpsForTarget(target, locator, {
      authorizeMutation: () => ({ allowed: true }),
      helpersDir,
    });
    const opsFocusedOnly = windowOpsForTarget(
      target,
      locator,
      { authorizeMutation: () => ({ allowed: true }), helpersDir },
      { focusedOnly: true },
    );

    // --- (2) Vehicle A: production window-ops enumeration path. ---
    // Unfocused case first: the palette is not focused after panelShow
    // unless something else took focus — state() tells us.
    try {
      const before = await ops.state();
      step("vehicleA-state-before", {
        resolution: before.resolution,
        window: before.window,
        windowNumber: before.windowNumber,
        attribution: before.attribution,
        app: before.app,
      });
      await inAeInfo("vehicleA-in-ae-before");

      const resized = await ops.resize(RESIZE_TO);
      step("vehicleA-resize", {
        verdict: resized.verdict,
        afterFrame: resized.after?.window.frame ?? null,
        observedAt: resized.observedAt,
      });
      await inAeInfo("vehicleA-in-ae-resized");
      const censusResized = api.windowServerCensus(api.execFileCensusRunner());
      const resizedCensus = censusResized.available && panelCensus
        ? censusResized.windows.find((w) => w.windowNumber === panelCensus.windowNumber)
        : undefined;
      step("vehicleA-census-resized", {
        windowNumber: panelCensus?.windowNumber ?? null,
        bounds: resizedCensus?.bounds ?? null,
      });

      const origFrame = before.window.frame;
      const moved = origFrame
        ? await ops.move({
            x: Math.round(origFrame.x) + 140,
            y: Math.round(origFrame.y) + 90,
          })
        : null;
      step("vehicleA-move", moved === null ? { skipped: "no original frame" } : {
        verdict: moved.verdict,
        afterFrame: moved.after?.window.frame ?? null,
      });
      await inAeInfo("vehicleA-in-ae-moved");

      // Restore: back to the pre-op size, then the pre-op position.
      const restoredSize = await ops.resize(PANEL_SIZE);
      step("vehicleA-restore-size", {
        verdict: restoredSize.verdict,
        afterFrame: restoredSize.after?.window.frame ?? null,
      });
      if (origFrame) {
        const restoredPos = await ops.move({
          x: Math.round(origFrame.x),
          y: Math.round(origFrame.y),
        });
        step("vehicleA-restore-position", {
          verdict: restoredPos.verdict,
          afterFrame: restoredPos.after?.window.frame ?? null,
          expected: { x: origFrame.x, y: origFrame.y },
        });
      }
      await inAeInfo("vehicleA-in-ae-restored");
    } catch (error) {
      step("vehicleA", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // focusedOnly observe path — does it resolve the palette when the
    // palette is (probably) unfocused?
    try {
      const focusedState = await opsFocusedOnly.state();
      step("focusedOnly-state-unfocused", {
        resolution: focusedState.resolution,
        window: focusedState.window,
        windowNumber: focusedState.windowNumber,
      });
    } catch (error) {
      step("focusedOnly-state-unfocused", {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code ?? null,
      });
    }
    // Mutations under focusedOnly must refuse regardless of seam.
    try {
      await opsFocusedOnly.resize(RESIZE_TO);
      step("focusedOnly-resize", { result: "UNEXPECTEDLY-ALLOWED" });
    } catch (error) {
      step("focusedOnly-resize", {
        refused: error instanceof Error ? error.message : String(error),
      });
    }

    // --- (3) Unfocused-window evidence ---
    // `open` activation moved the app's AXFocusedWindow to the main
    // window, so the palette is now UNFOCUSED while the AX enumeration
    // stays empty. Record what each channel sees; no mutation is
    // possible or attempted on this path.
    try {
      // System Events enumeration probe for the record: production
      // identify() walks `UI elements of process`; window-ops walks
      // AXUIElement AXWindows/AXChildren. Record both shapes.
      const seProbe = `on run argv
        set targetPid to (item 1 of argv) as integer
        tell application "System Events"
          set procs to (every application process whose unix id is targetPid)
          if (count of procs) is 0 then return "MISSING"
          set p to item 1 of procs
          set uic to count of UI elements of p
          set roles to ""
          repeat with e in UI elements of p
            try
              set roles to roles & (role of e as string) & ","
            end try
          end repeat
          return "uiElements=" & uic & " roles=" & roles
        end tell
      end run`;
      const sePath = join(workdir, "seprobe.scpt");
      writeFileSync(sePath, seProbe, "utf-8");
      step("system-events-probe", run("/usr/bin/osascript", [sePath, String(targetPid)]));

      const fsUnfocused = focusedSet(["--op", "state"]);
      step("vehicleB-focused-state-unfocused", fsUnfocused);
      const focusedUnfocused = fsUnfocused.ok ? fsUnfocused.json?.window : null;
      step("vehicleB-unfocused-check", {
        paletteIsFocusedWindow:
          typeof focusedUnfocused?.title === "string" &&
          focusedUnfocused.title.includes(PANEL_TITLE),
        focusedElement: focusedUnfocused,
        paletteCensusFrame: panelCensus?.bounds ?? null,
        focusedElementIsPaletteByFrame:
          focusedUnfocused?.frame != null && panelCensus?.bounds != null
            ? framesMatch(focusedUnfocused.frame, panelCensus.bounds)
            : null,
        note:
          "with another window holding focus, AXFocusedWindow no " +
          "longer addresses the palette — the focused-element vehicle " +
          "is focus-dependent by construction; the driver-side " +
          "identity guard (frame match vs census) is what prevents a " +
          "wrong-target mutation here",
      });
      try {
        const fo = await opsFocusedOnly.state();
        step("focusedOnly-state-after-refocus", {
          resolution: fo.resolution,
          window: fo.window,
        });
      } catch (error) {
        step("focusedOnly-state-after-refocus", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      step("vehicleB-unfocused", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- (4) Negative: foreign census windowNumber must never resolve. ---
    try {
      const foreign = census.available
        ? census.windows.find((w) => w.pid !== targetPid && w.onScreen === true)
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
          step("negative-foreign", { result: "UNEXPECTEDLY-RESOLVED", foreign });
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
      step("negative-foreign", { error: error instanceof Error ? error.message : String(error) });
    }

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
      step("close", { error: error instanceof Error ? error.message : String(error) });
    }
  }

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
