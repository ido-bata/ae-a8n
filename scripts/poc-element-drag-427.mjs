#!/usr/bin/env node
/**
 * Issue #427 real-host e2e: `ae.dragDrop().dragElement` against an
 * owned AE 2027 launch — the production path, not the #411 PoC vehicle.
 *
 * What it does, in order:
 *   1. refuses to run when the target install already has an in-scope
 *      AE (an owned launch would attach to it — never done here);
 *   2. launches owned AE, resolves the recovery target, lists windows
 *      through `window-ops state` and builds the
 *      `DragDropSurfaceLocator` for the main window;
 *   3. sets up scripting-only fixtures (8 comps as Project items, 6
 *      text layers in the viewer-opened comp — setup is scripting,
 *      never the asserted GUI path);
 *   4. runs `dragElement` for each proven element class —
 *      `timeline-layer`, `project-item` (DOM delta oracle:
 *      `comp.layers` / `project.items` order) and `panel-tab`
 *      dock→float tear-off (census window-count oracle) — each the
 *      full production chain: gate → lease → census topmost endpoints
 *      → segmented CGEvent drag with per-segment re-check → oracle.
 *      Candidate loops stop on the first posted drag or on any
 *      post-act/unknown error code (`indeterminate` included): a partial
 *      drag may have landed, so the contract forbids resending — the
 *      loop re-observes instead;
 *   5. records every result verbatim plus screenshots, quits the
 *      owned instance, runs a postflight census, and only then emits
 *      the evidence file — the close result is always inside the JSON.
 *
 * Dialog handling is the sanctioned path only: the readiness wait is
 * sampled per poll (still-launching vs probe-failure), blocking windows
 * are classified through `createHostRecovery().attempt()` — the same
 * taxonomy/lease/audit/attribution path the driver builds — and
 * `ae.guiState()` during observation. Only a measured `auto-safe` class
 * may ever be pressed; every other dialog is recorded, never dismissed.
 * No key is ever posted to an unclassified window.
 *
 * Requires `npm run build` first. Usage:
 *   node scripts/poc-element-drag-427.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-2026-11-28/element-drag-427/run.json \
 *     [--timeout-ms 300000] [--readiness-timeout-ms 120000] \
 *     [--launch-poll-ms 1000]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distIndex = resolve(root, "dist", "index.js");
const distHostProcesses = resolve(root, "dist", "driver", "host-processes.js");
const distInstallPath = resolve(root, "dist", "driver", "install-path.js");
const distWindowOps = resolve(root, "dist", "windowops", "darwin.js");
const distWindowOpsApi = resolve(root, "dist", "api", "window-ops.js");

const api = await import(distIndex);
const { AfterEffects, windowServerCensus, execFileCensusRunner } = api;
const { psProcesses } = await import(distHostProcesses);
const { resolveInstall } = await import(distInstallPath);
const { darwinWindowOpsOps, sessionWindowOpsExec } = await import(distWindowOps);
const { ensureDarwinWindowOpsHelpers } = await import(distWindowOpsApi);

function fail(message) {
  console.error(`poc-element-drag-427: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    install: undefined,
    out: undefined,
    sessionRoot: undefined,
    // Readiness default is 120s, not the old fixed 240s: every successful
    // owned launch recorded on this host answered the probe in well under
    // 15s, and the larger budget was only ever consumed by modal-blocked
    // launches that failed anyway. `poc-boot-attribution.mjs` uses the
    // same 120s default for the same probe.
    timeoutMs: 300_000,
    readinessTimeoutMs: 120_000,
    launchPollMs: 1_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--session-root") options.sessionRoot = argv[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--readiness-timeout-ms") options.readinessTimeoutMs = Number(argv[++i]);
    else if (arg === "--launch-poll-ms") options.launchPollMs = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) fail("--install <dir> is required");
  if (options.out === undefined) fail("--out <file.json> is required");
  for (const key of ["timeoutMs", "readinessTimeoutMs", "launchPollMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive number`);
    }
  }
  return options;
}

function inScopeAEPids(install) {
  return psProcesses()
    .filter((p) => p.executable === install.executable)
    .map((p) => p.pid);
}

function screenshot(path) {
  try {
    execFileSync("/usr/sbin/screencapture", ["-x", path], { timeout: 30_000 });
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function captureWindow(path, windowNumber) {
  try {
    execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(windowNumber), path], { timeout: 30_000 });
    return { ok: true, path, windowNumber };
  } catch (error) {
    return { ok: false, windowNumber, error: error instanceof Error ? error.message : String(error) };
  }
}

function emit(evidence, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written: ${outPath}`);
}

/** Largest-frame window = the AE main window for locator purposes. */
function pickMainWindow(windows) {
  let best = null;
  let bestArea = -1;
  for (const w of windows) {
    if (w.frame == null) continue;
    const area = w.frame.width * w.frame.height;
    if (area > bestArea) {
      bestArea = area;
      best = w;
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outPath = resolve(options.out);
  const outDir = dirname(outPath);

  const evidence = {
    schema: "a8n.poc-element-drag-427/v1",
    issue: 427,
    recordedAt: new Date().toISOString(),
    install: options.install,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
    console.log(`step ${name}: ${JSON.stringify(data).slice(0, 400)}`);
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const install = resolveInstall(process.platform, { installDir: options.install });
  const preexisting = inScopeAEPids(install);
  step("preflight", { install: install.executable, preexisting });
  if (preexisting.length > 0) {
    evidence.outcome = "refused";
    evidence.reason =
      `${preexisting.length} in-scope instance(s) already running; ` +
      "an owned launch would attach to them, which this PoC never does";
    emit(evidence, outPath);
    return;
  }

  // --- Launch owned AE. ---
  // An explicit ScriptInvocationTransport (the same construction
  // poc-boot-attribution uses) gives the readiness sampler access to
  // `pendingLaunch()`/`hostState()`/`hostPid()`/`recoveryTargetPid()` —
  // the transport's own pid+start-time re-proof.
  const transport = new api.ScriptInvocationTransport({ install });
  const launchOptions = {
    transport,
    timeoutMs: options.timeoutMs,
    readinessTimeoutMs: options.readinessTimeoutMs,
  };
  if (options.sessionRoot !== undefined) launchOptions.sessionRoot = options.sessionRoot;

  // Focus helper only: bringing the owned app forward is sometimes needed
  // for the AX listing and census gates. It sends no keys and touches no
  // dialog — the old watchdog's Return injection is gone for good.
  const appPath = install.executable.replace(/\/Contents\/MacOS\/.*/, "");
  const activateApp = () => {
    try {
      execFileSync("/usr/bin/osascript", [
        "-e",
        `tell application "${appPath}" to activate`,
      ], { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  };

  // --- Dialog handling: sanctioned path only --------------------------
  // The previous watchdog pressed Return into heuristic dialog windows
  // (owned pid + onScreen + layer>=8 + <800x600), bypassing the dialog
  // taxonomy, the GUI lease, the audit log and pid attribution — an
  // unclassified "discard changes" or "crash recovery" sheet would have
  // been confirmed. That code is removed. What remains is the same
  // `HostRecovery` the driver builds for `session.recover`
  // (src/api/launch.ts): `attempt()` lists windows, classifies each
  // blocking window through the measured taxonomy, and presses ONLY a
  // measured `auto-safe` class through `pressButtonIn` (lease + audit +
  // pid attribution). Human-required, unpressable and unclassified
  // windows are recorded in the evidence and left for a human — the run
  // fails closed instead of dismissing anything.
  const dialogRecovery = (() => {
    const session = transport.targetSession;
    if (session === null || session.kind !== "Aqua") return null;
    try {
      return api.createHostRecovery({
        target: { platform: "darwin", session },
        pid: () => transport.recoveryTargetPid(),
        verifyProcess: (pid) => transport.recoveryTargetPid() === pid,
        screenshotDir: join(outDir, "recovery"),
      });
    } catch {
      return null;
    }
  })();
  let dialogObservations = 0;
  const observeDialogs = async (tag) => {
    if (dialogRecovery === null) return;
    try {
      const outcome = await dialogRecovery.attempt({
        requestId: `poc-element-drag-427-${tag}`,
        method: "session.launch",
        timeoutMs: options.readinessTimeoutMs,
      });
      // A "no modal window" refusal carries no window and is not worth a
      // step per poll. Anything that saw a window, pressed a button, or
      // quarantined is evidence.
      if (
        outcome.recovered === true ||
        outcome.outcome === "quarantined" ||
        outcome.window !== undefined
      ) {
        dialogObservations += 1;
        step(`dialog-${tag}`, {
          recovered: outcome.recovered,
          outcome: outcome.outcome ?? null,
          code: outcome.code ?? null,
          dialogTier: outcome.dialogTier ?? null,
          window: outcome.window ?? null,
          evidence: outcome.evidence,
          screenshotPath: outcome.screenshotPath ?? null,
        });
      }
    } catch (error) {
      step(`dialog-${tag}-error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const t0 = Date.now();
  let launchSettled = false;
  const launchPromise = AfterEffects.launch(launchOptions).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  launchPromise.then(() => {
    launchSettled = true;
  });

  // Readiness samples (poc-boot-attribution shape): on darwin
  // `awaitScriptable` returns immediately, so the whole readiness budget
  // is one `app.info` probe. Sampling per poll separates "still
  // launching" (no in-scope pid / hostState unknown) from "probe
  // failing" (pid present and alive while the probe never answers), and
  // the dialog-layer window count makes a modal-blocked launch visible
  // instead of a silent timeout.
  const readinessSamples = [];
  const sampleDeadline = t0 + options.timeoutMs + 60_000;
  while (!launchSettled && Date.now() < sampleDeadline) {
    const scoped = inScopeAEPids(install);
    const pending = transport.pendingLaunch();
    const census = windowServerCensus(execFileCensusRunner());
    readinessSamples.push({
      t: Date.now() - t0,
      scopedPids: scoped,
      pendingLaunch:
        pending === null
          ? null
          : {
              pid: pending.pid,
              startedAt: pending.startedAt,
              presentAtLastLookup: pending.presentAtLastLookup,
              session: pending.session,
            },
      hostState: transport.hostState(),
      hostPid: transport.hostPid(),
      dialogLayerWindows: census.available
        ? census.windows.filter(
            (w) =>
              scoped.includes(w.pid) &&
              w.onScreen &&
              (w.layer ?? 0) >= 8,
          ).length
        : null,
    });
    const won = await Promise.race([
      launchPromise.then(() => "settled"),
      sleep(options.launchPollMs).then(() => "tick"),
    ]);
    if (won === "settled") break;
  }
  const launchOutcome = await launchPromise;
  evidence.launchReadiness = {
    timeoutMs: options.timeoutMs,
    readinessTimeoutMs: options.readinessTimeoutMs,
    samples: readinessSamples,
  };

  let ae = null;
  try {
    if (!launchOutcome.ok) {
      step("launch-error", {
        message:
          launchOutcome.error instanceof Error
            ? launchOutcome.error.message
            : String(launchOutcome.error),
      });
      // Classify what may have blocked the probe — recorded, never
      // dismissed beyond the measured auto-safe class.
      await observeDialogs("launch-failed");
      evidence.outcome = "failed";
      evidence.reason = "AfterEffects.launch did not complete";
      return;
    }
    ae = launchOutcome.value;
    step("launch", {
      pid: ae.recoveryTarget()?.pid ?? null,
      info: ae.info(),
      dialogObservations,
    });

    const target = ae.recoveryTarget();
    if (target === null) {
      evidence.outcome = "failed";
      evidence.reason = "recoveryTarget() is null; no owned pid/session attested";
      return;
    }
    step("recovery-target", { pid: target.pid, sessionKind: target.session.kind });

    await sleep(5000);
    activateApp();
    // One sanctioned classification pass post-launch: a measured
    // auto-safe dialog may be pressed; anything else is recorded and
    // left blocking — the ops below then fail honestly.
    await observeDialogs("post-launch");

    // --- Window listing → DragDropSurfaceLocator (same as #422 e2e). ---
    const woHelpersDir = ensureDarwinWindowOpsHelpers();
    step("window-ops-helpers", { dir: woHelpersDir });
    const censusFn = () => windowServerCensus(execFileCensusRunner());
    const surfaceOps =
      woHelpersDir === null
        ? null
        : darwinWindowOpsOps({
            pid: target.pid,
            exec: sessionWindowOpsExec({
              session: target.session,
              helpersDir: woHelpersDir,
              timeoutMs: 30_000,
            }),
          });

    const observeRows = () => {
      if (surfaceOps === null) {
        throw new Error("window-ops helpers unavailable; no listing channel");
      }
      const listing = surfaceOps.observeWindows();
      const census = censusFn();
      const rows = census.available ? census.windows : [];
      const infos = [...listing.windows];
      const fw = listing.focusedWindow;
      if (
        fw !== null &&
        !infos.some(
          (w) =>
            w.title === fw.title &&
            w.subrole === fw.subrole &&
            w.frame !== null &&
            fw.frame !== null &&
            w.frame.x === fw.frame.x &&
            w.frame.y === fw.frame.y &&
            w.frame.width === fw.frame.width &&
            w.frame.height === fw.frame.height,
        )
      ) {
        infos.push({ ...fw, index: 0 });
      }
      return infos.map((info, i) => {
        let attribution = "unmatched";
        if (info.frame !== null && rows.length > 0) {
          const f = info.frame;
          const mine = rows.filter(
            (ws) =>
              ws.pid === target.pid &&
              ws.bounds !== null &&
              Math.abs(ws.bounds.x - f.x) <= 4 &&
              Math.abs(ws.bounds.y - f.y) <= 4 &&
              Math.abs(ws.bounds.width - f.width) <= 4 &&
              Math.abs(ws.bounds.height - f.height) <= 4,
          );
          if (mine.length === 1) attribution = "owned";
        }
        return {
          index: i + 1,
          title: info.title,
          subrole: info.subrole,
          role: info.role,
          frame: info.frame,
          attribution,
        };
      });
    };

    // Read-only dialog observation through the sanctioned classifier:
    // `ae.guiState()` lists the owned instance's windows inside its own
    // session and reports the verdict `session.recover` would reach —
    // without pressing anything. A blocking or unclassified window is
    // recorded once per distinct state; nothing is ever dismissed here.
    let lastDialogKey = null;
    const observeGuiDialogs = async () => {
      try {
        const report = await ae.guiState();
        if (report.status !== "observed") {
          const key = `unavailable:${report.reason}`;
          if (key !== lastDialogKey) {
            lastDialogKey = key;
            step("gui-state-dialog", { status: "unavailable", reason: report.reason });
          }
          return;
        }
        const action = report.assessment.action;
        const key = `${action}:${report.assessment.window ?? ""}`;
        if (action !== "none" && key !== lastDialogKey) {
          lastDialogKey = key;
          step("gui-state-dialog", {
            status: "observed",
            action,
            code: report.assessment.code,
            detail: report.assessment.detail,
            window: report.assessment.window,
            blockingWindows: report.windows
              .filter((w) => w.blocking)
              .map((w) => ({
                index: w.index,
                title: w.title,
                classification: w.classification,
              })),
            axSuspect: report.axSuspect,
            axUnaccountedWindowCount: report.axUnaccountedWindows.length,
          });
        }
      } catch (error) {
        step("gui-state-error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    let rows = [];
    let main = null;
    const listDeadline = Date.now() + 120_000;
    while (Date.now() < listDeadline) {
      activateApp();
      await sleep(2000);
      await observeGuiDialogs();
      try {
        rows = observeRows();
        const ownedRows = rows.filter((r) => r.attribution === "owned");
        main = pickMainWindow(ownedRows.length > 0 ? ownedRows : rows);
        if (main !== null && main.frame != null) break;
      } catch (error) {
        step("observe-poll-error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(3000);
    }
    if (main === null || main.frame == null) {
      evidence.outcome = "failed";
      evidence.reason =
        "no framed owned window in the window-ops listing; cannot build a surface locator";
      evidence.windows = rows;
      return;
    }
    const windowIndex = rows.indexOf(main) + 1;
    const surface = {
      windowIndex,
      expected: {
        title: main.title,
        subrole: main.subrole ?? null,
        frame: main.frame,
      },
    };
    step("surface", {
      windowIndex,
      title: main.title,
      frame: main.frame,
      windows: rows.length,
      attribution: main.attribution,
    });
    step("screenshot-setup", screenshot(join(outDir, "element-drag-427-setup.png")));
    step("window-capture-setup", captureWindow(join(outDir, "element-drag-427-window-setup.png"), main.windowNumber ?? -1));

    // --- Scripting-only fixture setup (never the asserted path). ---
    const project = await ae.project();
    const COMP_NAMES = [];
    for (let i = 1; i <= 8; i += 1) {
      COMP_NAMES.push(`e427-C${String(i).padStart(2, "0")}`);
    }
    const createdComps = [];
    for (const name of COMP_NAMES) {
      try {
        createdComps.push(await project.createComp({
          name,
          width: 64,
          height: 64,
          duration: 1,
          frameRate: 30,
        }));
      } catch (error) {
        step("create-comp-error", { name, error: String(error).slice(0, 200) });
      }
    }
    step("created-comps", { count: createdComps.length, names: COMP_NAMES });
    const viewerComp = createdComps[0];
    if (viewerComp !== undefined) {
      await viewerComp.openInViewer();
      for (let i = 1; i <= 6; i += 1) {
        try {
          await viewerComp.addTextLayer({ name: `e427-L${i}`, text: `L${i}` });
        } catch (error) {
          step("add-text-error", { i, error: String(error).slice(0, 200) });
        }
      }
    }
    // `project.items` is the dragDrop oracle's internal readback; the
    // public Project API exposes comps()+state() — comps() preserves
    // panel order, which is the evidence we record here.
    const compsBefore = await project.comps();
    step("project-comps-before", { count: compsBefore.length, names: compsBefore.map((c) => c.name) });
    const layersBefore = viewerComp === undefined ? null : await viewerComp.layers();
    step("layers-before", { count: layersBefore?.length ?? null, names: (layersBefore ?? []).map((l) => l.name) });
    const stateBefore = await project.state();
    step("project-state-before", stateBefore);

    // --- Re-resolve the surface AFTER fixture mutations. ---------------
    // Creating comps/layers dirties the project: the window title gains
    // " *" and the frame may shift. The surface locator re-verifies
    // title+frame on every op, so the pre-setup snapshot goes
    // stale-locator on the first drag. Re-observe now.
    try {
      const freshRows = observeRows();
      const ownedFresh = freshRows.filter((r) => r.attribution === "owned");
      const freshMain = pickMainWindow(
        ownedFresh.length > 0 ? ownedFresh : freshRows,
      );
      if (freshMain !== null && freshMain.frame != null) {
        const previousTitle = surface.expected.title;
        main = freshMain;
        surface.windowIndex = freshRows.indexOf(freshMain) + 1;
        surface.expected = {
          title: freshMain.title,
          subrole: freshMain.subrole ?? null,
          frame: freshMain.frame,
        };
        step("surface-after-setup", {
          windowIndex: surface.windowIndex,
          title: freshMain.title,
          frame: freshMain.frame,
          previousTitle,
          windows: freshRows.map((r) => ({
            title: r.title,
            subrole: r.subrole,
            frame: r.frame,
            attribution: r.attribution,
          })),
        });
      } else {
        step("surface-after-setup-error", { reason: "no framed main window" });
      }
    } catch (error) {
      step("surface-after-setup-error", {
        error: String(error?.message ?? error).slice(0, 300),
      });
    }

    // --- Pane frames (best-effort; coordinates fall back to the #411 layout). ---
    // The window-ops listing rows do not carry the CGWindowID; resolve the
    // main window's `windowNumber` from the census by pid+frame match so
    // `dockedPane({ parent: { windowNumber } })` can parent the pane walk.
    // Without it the locator degenerates to `{}` and every pane call
    // refuses "0 window(s) observed" (run2 evidence).
    const mainWindowNumber = (() => {
      const census = censusFn();
      if (!census.available) return null;
      const f = main.frame;
      const hit = census.windows.find(
        (w) =>
          w.pid === target.pid &&
          w.bounds !== null &&
          Math.abs(w.bounds.x - f.x) <= 8 &&
          Math.abs(w.bounds.y - f.y) <= 8 &&
          Math.abs(w.bounds.width - f.width) <= 8 &&
          Math.abs(w.bounds.height - f.height) <= 8,
      );
      return hit?.windowNumber ?? null;
    })();
    step("main-window-number", { windowNumber: mainWindowNumber });
    const paneParent =
      mainWindowNumber === null ? {} : { windowNumber: mainWindowNumber };
    let projectPaneFrame = null;
    let timelinePaneFrame = null;
    const paneRows = { project: null, timeline: null };
    try {
      const pane = ae.dockedPane({
        pane: { title: "Project", titleMatch: "contains" },
        parent: paneParent,
      });
      const resolution = await pane.identify();
      projectPaneFrame = resolution.pane?.frame ?? resolution.target?.surface?.frame ?? null;
      try {
        paneRows.project = (await pane.rows()).slice(0, 30);
      } catch (error) {
        paneRows.project = { error: String(error).slice(0, 200) };
      }
      step("project-pane", { frame: projectPaneFrame, rows: paneRows.project });
    } catch (error) {
      step("project-pane-error", { error: String(error).slice(0, 300) });
    }
    try {
      const pane = ae.dockedPane({
        pane: { title: "Timeline", titleMatch: "contains" },
        parent: paneParent,
      });
      const resolution = await pane.identify();
      timelinePaneFrame = resolution.pane?.frame ?? resolution.target?.surface?.frame ?? null;
      try {
        paneRows.timeline = (await pane.rows()).slice(0, 30);
      } catch (error) {
        paneRows.timeline = { error: String(error).slice(0, 200) };
      }
      step("timeline-pane", { frame: timelinePaneFrame, rows: paneRows.timeline });
    } catch (error) {
      step("timeline-pane-error", { error: String(error).slice(0, 300) });
    }

    // --- Drag coordinates -------------------------------------------------
    // The #411 run on this same host/screen/workspace measured (main frame
    // [0,38,1710,1074]): project item rows ≈ y 290-440 (row pitch ~21),
    // timeline layer rows ≈ y 870-980 (pitch ~20), panel tab ≈ (56,124).
    // We translate those anchors by our actual main-frame origin so a
    // shifted window still lands on the same relative rows.
    const F = main.frame;
    const ax = (relX) => Math.round(F.x + relX);
    const ay = (relY) => Math.round(F.y + relY);
    const anchors = {
      // #411 absolute → relative-to-frame(0,38)
      projectRow1: { x: 150 - F.x + F.x, y: 301 - 38 },
      projectRow2: { x: 150, y: 322 - 38 },
      timelineRow1: { x: 250, y: 885 - 38 },
      timelineRow3: { x: 250, y: 925 - 38 },
      tab: { x: 56, y: 124 - 38 },
      tabTo: { x: 700, y: 750 - 38 },
    };
    step("anchors", { frame: F, anchors });

    // --- Census probe helpers (mirror the production gates). -----------
    // `strictOwnedAt` = topmost census window at `point` is an owned-pid
    // window whose bounds match the main frame (±8pt) — exactly what
    // `#requireTopmostOwned` demands. Other apps' windows (the foreign
    // AE 2026 instance) and owned aux/floating panels both fail it.
    const mainFrame = main.frame;
    const boundsMatchMain = (b) =>
      b !== null &&
      Math.abs(b.x - mainFrame.x) <= 8 &&
      Math.abs(b.y - mainFrame.y) <= 8 &&
      Math.abs(b.width - mainFrame.width) <= 8 &&
      Math.abs(b.height - mainFrame.height) <= 8;
    const censusTopmost = (point) => {
      const census = censusFn();
      if (!census.available) return { ok: false, reason: "census-unavailable" };
      for (const w of census.windows) {
        if (!w.onScreen || (w.layer ?? 0) < 0 || w.bounds === null) continue;
        const b = w.bounds;
        if (
          point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height
        ) {
          return {
            ok: w.pid === target.pid && boundsMatchMain(b),
            pid: w.pid,
            windowNumber: w.windowNumber ?? null,
            bounds: b,
          };
        }
      }
      return { ok: false, reason: "no-window" };
    };
    const strictOwnedAt = (point) => censusTopmost(point).ok === true;

    // Prefer AX row frames when the pane walk actually vends them.
    const rowFrameFor = (rows, name) => {
      if (!Array.isArray(rows)) return null;
      const hit = rows.find((r) => r && r.frame && typeof r.text === "string" && r.text.includes(name));
      return hit?.frame ?? null;
    };
    const firstProjectItemName = compsBefore[0]?.name ?? null;
    const projRow1Ax = firstProjectItemName === null ? null : rowFrameFor(paneRows.project, firstProjectItemName);
    const timelineRowNames = new Set((layersBefore ?? []).map((l) => l.name));
    const tlRowsWithFrames = Array.isArray(paneRows.timeline)
      ? paneRows.timeline.filter((r) => r && r.frame && timelineRowNames.has(r.text))
      : [];
    step("row-resolution", {
      projectItemName: firstProjectItemName,
      projectRowFrame: projRow1Ax,
      timelineRowsFound: tlRowsWithFrames.length,
    });

    const dragDrop = ae.dragDrop();
    const results = { timelineLayer: null, projectItem: null, tabTearoffProbe: null };

    // Pre-act refusal codes: the gate rejected the attempt BEFORE anything
    // was posted, so the next candidate point is still safe to try. This
    // is the same whitelist the panel-tab loop below already used. Any
    // other code — `indeterminate`, `focus-lost`, `unavailable`, or an
    // unknown code — may mean a partial drag landed: the dragdrop
    // contract forbids resending, so the loop stops and the post-loop
    // DOM re-observation (`layers()`/`comps()`) is the only verdict.
    const PRE_ACT_CODES = new Set([
      "refused",
      "unsupported",
      "unproven",
      "invalid-locator",
      "stale-locator",
    ]);
    const recordAttempts = (result, attempts) => {
      // The ledger holds compact per-candidate summaries (never the
      // result object itself — that would be a circular reference and
      // JSON.stringify would throw). Full results stay in the step
      // records.
      try {
        result.attempts = attempts;
      } catch {
        /* frozen result: attempts live in the step records */
      }
    };
    const attemptSummary = (result) => ({
      verified: result.verified ?? null,
      vehicle: result.vehicle ?? null,
      aborted: result.aborted ?? null,
      dragOperation: result.dragOperation ?? null,
    });

    // --- Op 1: timeline-layer reorder (oracle: comp.layers order). -------
    // Press near the top layer row, release ~4 rows lower. If the AX rows
    // resolved, aim precisely; otherwise use the #411-relative anchor.
    const tlFrom = tlRowsWithFrames.length > 0
      ? { x: Math.round(tlRowsWithFrames[0].frame.x + tlRowsWithFrames[0].frame.width * 0.4), y: Math.round(tlRowsWithFrames[0].frame.y + tlRowsWithFrames[0].frame.height / 2) }
      : { x: ax(anchors.timelineRow1.x), y: ay(anchors.timelineRow1.y) };
    const tlTo = tlRowsWithFrames.length > 1
      ? { x: tlFrom.x, y: Math.round(tlRowsWithFrames[Math.min(4, tlRowsWithFrames.length - 1)].frame.y + tlRowsWithFrames[Math.min(4, tlRowsWithFrames.length - 1)].frame.height / 2) }
      : { x: ax(anchors.timelineRow3.x), y: ay(anchors.timelineRow3.y + 20) };
    step("timeline-drag-points", { from: tlFrom, to: tlTo, axRows: tlRowsWithFrames.length });
    // #411's proven drop was +40px (~2 rows). Probe candidate press
    // points census-side first: the foreign AE 2026 window and owned
    // aux/floating panels occlude parts of the main window, and the
    // production gate refuses any point they cover. Each attempt drops
    // ~2 rows below its own press; a miss reports indeterminate.
    const tlPairs = [];
    for (const dy of [0, -20, 20, -40, 40, -60, 60]) {
      for (const x of [250, 500, 800, 1100, 1400]) {
        const from = { x, y: tlFrom.y + dy };
        const to = { x, y: tlFrom.y + dy + 40 };
        if (strictOwnedAt(from) && strictOwnedAt(to)) {
          tlPairs.push({ from, to });
        }
      }
    }
    step("timeline-candidates", { count: tlPairs.length, pairs: tlPairs.slice(0, 12) });
    const tlAttempts = [];
    for (const [index, pair] of tlPairs.slice(0, 8).entries()) {
      try {
        const result = await dragDrop.dragElement({
          element: "timeline-layer",
          surface,
          from: pair.from,
          to: pair.to,
          steps: 24,
          stepDelayMs: 16,
        });
        // A resolved result means the drag was posted to completion —
        // never resend, verified or not; the flag is the verdict.
        step("timeline-layer-attempt", { attempt: index, from: pair.from, to: pair.to, result });
        tlAttempts.push({ attempt: index, from: pair.from, to: pair.to, result: attemptSummary(result) });
        results.timelineLayer = result;
        break;
      } catch (error) {
        const code = error?.code ?? null;
        const record = {
          attempt: index,
          from: pair.from,
          to: pair.to,
          name: error?.name ?? typeof error,
          code,
          message: String(error?.message ?? error).slice(0, 400),
        };
        tlAttempts.push(record);
        step("timeline-layer-attempt", record);
        results.timelineLayer = { error: record.message, code };
        if (!PRE_ACT_CODES.has(code)) {
          // Post-act or unknown outcome: a partial drag may have landed.
          // Stop here — the layers() re-observation below decides.
          break;
        }
      }
    }
    if (tlAttempts.length > 0 && results.timelineLayer !== null) {
      recordAttempts(results.timelineLayer, tlAttempts);
    }
    if (tlPairs.length === 0) {
      results.timelineLayer = { error: "no census-clean candidate points in the layer-row band", code: "unproven" };
      step("timeline-layer-no-candidates", {});
    }
    await sleep(1000);
    const layersAfter = viewerComp === undefined ? null : await viewerComp.layers();
    step("layers-after", { names: (layersAfter ?? []).map((l) => l.name) });
    step("screenshot-after-timeline", screenshot(join(outDir, "element-drag-427-after-timeline.png")));

    // --- Op 2: project-item reorder (oracle: project.items order). ------
    const pFrom = projRow1Ax !== null
      ? { x: Math.round(projRow1Ax.x + projRow1Ax.width * 0.4), y: Math.round(projRow1Ax.y + projRow1Ax.height / 2) }
      : { x: ax(anchors.projectRow1.x), y: ay(anchors.projectRow1.y) };
    // #411's proven drop was ONE row (+21px) onto the next row — a long
    // drag can overshoot into empty panel space and cancel. Same
    // census-clean candidate probing as the timeline op: owned aux
    // panels occlude the project panel's left columns.
    step("project-drag-points", { from: pFrom });
    const pPairs = [];
    for (const dy of [0, -21, 21, -42, 42, -63, 63]) {
      for (const x of [150, 400, 700, 1000, 1300]) {
        const from = { x, y: pFrom.y + dy };
        const to = { x, y: pFrom.y + dy + 21 };
        if (strictOwnedAt(from) && strictOwnedAt(to)) {
          pPairs.push({ from, to });
        }
      }
    }
    step("project-candidates", { count: pPairs.length, pairs: pPairs.slice(0, 12) });
    const pAttempts = [];
    for (const [index, pair] of pPairs.slice(0, 8).entries()) {
      try {
        const result = await dragDrop.dragElement({
          element: "project-item",
          surface,
          from: pair.from,
          to: pair.to,
          steps: 24,
          stepDelayMs: 16,
        });
        // Same contract as the timeline loop: a posted drag is never
        // resent, and every candidate outcome is on the record.
        step("project-item-attempt", { attempt: index, from: pair.from, to: pair.to, result });
        pAttempts.push({ attempt: index, from: pair.from, to: pair.to, result: attemptSummary(result) });
        results.projectItem = result;
        break;
      } catch (error) {
        const code = error?.code ?? null;
        const record = {
          attempt: index,
          from: pair.from,
          to: pair.to,
          name: error?.name ?? typeof error,
          code,
          message: String(error?.message ?? error).slice(0, 400),
        };
        pAttempts.push(record);
        step("project-item-attempt", record);
        results.projectItem = { error: record.message, code };
        if (!PRE_ACT_CODES.has(code)) {
          break;
        }
      }
    }
    if (pAttempts.length > 0 && results.projectItem !== null) {
      recordAttempts(results.projectItem, pAttempts);
    }
    if (pPairs.length === 0) {
      results.projectItem = { error: "no census-clean candidate points in the project-row band", code: "unproven" };
      step("project-item-no-candidates", {});
    }
    await sleep(1000);
    const compsAfter = await project.comps();
    step("project-comps-after", { count: compsAfter.length, names: compsAfter.map((c) => c.name) });
    step("screenshot-after-project", screenshot(join(outDir, "element-drag-427-after-project.png")));
    step("window-capture-after", captureWindow(join(outDir, "element-drag-427-window-after.png"), main.windowNumber ?? -1));

    // --- Op 3: panel-tab dock→float tear-off via the PRODUCTION op. ----
    // #427 permits `element-drag`/`panel-tab` under the census
    // window-count oracle: a successful tear-off floats a panel and the
    // owned on-screen window count must increase by exactly the delta.
    // Script-side census gates on both ends mirror the controller's own
    // topmost-owned checks for evidence clarity.
    const ownedWindowCount = () => {
      const census = censusFn();
      if (!census.available) return null;
      return census.windows.filter(
        (w) => w.pid === target.pid && w.onScreen && (w.layer ?? 0) >= 0,
      ).length;
    };
    // Script-side gate mirrors the production `#requireTopmostOwned`:
    // topmost must be an OWNED window whose census bounds match the
    // resolved main frame (±8pt) — the comp-viewer window or any aux
    // panel on top refuses, exactly like the controller.
    const tabFrom = { x: ax(anchors.tab.x), y: ay(anchors.tab.y) };
    // Candidate drop points INSIDE the main frame where the topmost
    // census window is the main window itself (the comp-viewer window
    // covers x≈698-1022,y≈720-1428, so those points refuse). A tear-off
    // floats the panel only over a non-dock area; candidates span the
    // plausible non-dock regions. First verified attempt wins.
    const tabToCandidates = [
      { rel: { x: 1200, y: 362 }, note: "right-of-viewer upper" },
      { rel: { x: 660, y: 707 }, note: "left-of-viewer mid" },
      { rel: { x: 300, y: 462 }, note: "left-center" },
      { rel: { x: 800, y: 162 }, note: "top-center" },
      { rel: { x: 1300, y: 562 }, note: "right-lower" },
    ].map((c) => ({ ...c, point: { x: ax(c.rel.x), y: ay(c.rel.y) } }));
    const windowsBefore = ownedWindowCount();
    const tabAttempts = [];
    let tabDone = false;
    for (const candidate of tabToCandidates) {
      const gateFrom = censusTopmost(tabFrom);
      const gateTo = censusTopmost(candidate.point);
      const record = {
        to: candidate.point,
        note: candidate.note,
        gateFromOk: gateFrom.ok,
        gateTo,
      };
      if (!gateFrom.ok || !gateTo.ok) {
        record.skipped = "census gate refused";
        tabAttempts.push(record);
        step("panel-tab-attempt", record);
        continue;
      }
      try {
        const result = await dragDrop.dragElement({
          element: "panel-tab",
          surface,
          from: tabFrom,
          to: candidate.point,
          steps: 24,
          stepDelayMs: 16,
        });
        record.result = result;
        tabAttempts.push(record);
        step("panel-tab-attempt", record);
        if (result.verified === true) {
          results.tabTearoffProbe = result;
          tabDone = true;
          break;
        }
      } catch (error) {
        record.error = String(error?.message ?? error).slice(0, 400);
        record.code = error?.code ?? null;
        tabAttempts.push(record);
        step("panel-tab-attempt", record);
        // Pre-act refusals (nothing posted) leave the tab `from` valid —
        // try the next destination. Anything else may have posted the
        // drag and possibly re-docked the panel, making `from` stale.
        if (!PRE_ACT_CODES.has(error?.code)) {
          tabDone = true;
          break;
        }
      }
    }
    if (!tabDone || results.tabTearoffProbe === null) {
      results.tabTearoffProbe = {
        verified: false,
        posted: false,
        reason: "no candidate destination passed the census gate",
        attempts: tabAttempts,
      };
    } else if (results.tabTearoffProbe.attempts === undefined) {
      results.tabTearoffProbe.attempts = tabAttempts;
    }
    await sleep(2500);
    const windowsAfter = ownedWindowCount();
    results.tabTearoffProbe.windowsBefore =
      results.tabTearoffProbe.windowCountBefore ?? windowsBefore;
    results.tabTearoffProbe.windowsAfter =
      results.tabTearoffProbe.windowCountAfter ?? windowsAfter;
    results.tabTearoffProbe.newOwnedWindow =
      windowsBefore !== null && windowsAfter !== null ? windowsAfter - windowsBefore : null;
    step("tearoff-probe", results.tabTearoffProbe);
    step("screenshot-after-tearoff", screenshot(join(outDir, "element-drag-427-after-tearoff.png")));

    const verifiedCount = [
      results.timelineLayer,
      results.projectItem,
      results.tabTearoffProbe,
    ].filter((r) => r !== null && r.verified === true).length;
    evidence.outcome =
      verifiedCount === 3 ? "verified" :
      verifiedCount >= 1 ? "partial" :
      "failed";
    evidence.results = results;
    // No emit here: the evidence file is written in `finally`, AFTER the
    // owned instance is closed and the postflight census ran — the same
    // ordering poc-drag-alt.mjs uses, so the JSON always carries the
    // close result and the remaining in-scope processes.
  } catch (error) {
    // Never lose the run: an uncaught op failure (bridge timeout, AE
    // busy) still reaches `finally`, which closes the owned instance,
    // runs the postflight census and emits whatever was gathered.
    evidence.outcome = evidence.outcome === "refused" ? "refused" : "failed";
    evidence.reason = `uncaught: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  } finally {
    if (ae !== null) {
      try {
        const close = await ae.close({ unsavedChanges: "discard" });
        step("close", { ok: true, ...close });
      } catch (error) {
        step("close", { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const post = inScopeAEPids(install);
    step("postflight-census", { remainingInScope: post, dialogObservations });
    if (post.length > 0 && evidence.outcome !== "refused") {
      evidence.postflightNote =
        "owned AE did not exit cleanly; remaining in-scope pid(s) reported, not killed";
    }
    emit(evidence, outPath);
  }
}

await main();
