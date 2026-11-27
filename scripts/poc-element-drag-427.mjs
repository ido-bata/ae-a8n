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
 *      → segmented CGEvent drag with per-segment re-check → oracle;
 *   5. records every result verbatim plus screenshots and quits the
 *      owned instance. Any uncaught failure still emits the evidence
 *      file before the owned instance is closed.
 *
 * Requires `npm run build` first. Usage:
 *   node scripts/poc-element-drag-427.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-2026-11-28/element-drag-427/run.json
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
  const options = { install: undefined, out: undefined, sessionRoot: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--session-root") options.sessionRoot = argv[++i];
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) fail("--install <dir> is required");
  if (options.out === undefined) fail("--out <file.json> is required");
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
  const launchOptions = {
    installDir: options.install,
    timeoutMs: 300_000,
    readinessTimeoutMs: 240_000,
  };
  if (options.sessionRoot !== undefined) launchOptions.sessionRoot = options.sessionRoot;

  // --- Startup-dialog watchdog (same shape as poc-drag-drop-422). ---
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
  const pressReturn = () => {
    try {
      execFileSync("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to key code 36',
      ], { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  };
  const dialogPid = () => inScopeAEPids(install)[0] ?? null;
  const dialogWindowsFor = (pid) => {
    const census = windowServerCensus(execFileCensusRunner());
    if (!census.available) return [];
    return census.windows.filter(
      (w) =>
        w.pid === pid &&
        w.onScreen &&
        (w.layer ?? 0) >= 8 &&
        w.bounds !== null &&
        w.bounds.width < 800 &&
        w.bounds.height < 600,
    );
  };
  let dialogDismissals = 0;
  const maybeDismissDialogs = (tag) => {
    const pid = dialogPid();
    if (pid === null) return 0;
    const dialogs = dialogWindowsFor(pid);
    if (dialogs.length === 0) return 0;
    activateApp();
    let n = 0;
    for (let i = 0; i < dialogs.length; i += 1) {
      if (pressReturn()) n += 1;
    }
    dialogDismissals += n;
    if (n > 0) step(`dialog-dismiss-${tag}`, { pid, windows: dialogs.length, pressed: n });
    return n;
  };

  let launchSettled = false;
  const launchPromise = AfterEffects.launch(launchOptions).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  launchPromise.then(() => {
    launchSettled = true;
  });
  const watchdog = setInterval(() => {
    if (!launchSettled) maybeDismissDialogs("launch");
  }, 2000);
  const launchOutcome = await launchPromise;
  clearInterval(watchdog);
  if (!launchOutcome.ok) {
    step("launch-error", {
      message:
        launchOutcome.error instanceof Error
          ? launchOutcome.error.message
          : String(launchOutcome.error),
    });
    evidence.outcome = "failed";
    evidence.reason = "AfterEffects.launch did not complete";
    evidence.dialogDismissals = dialogDismissals;
    emit(evidence, outPath);
    return;
  }
  const ae = launchOutcome.value;
  step("launch", {
    pid: ae.recoveryTarget()?.pid ?? null,
    info: ae.info(),
    dialogDismissals,
  });

  try {
    const target = ae.recoveryTarget();
    if (target === null) {
      evidence.outcome = "failed";
      evidence.reason = "recoveryTarget() is null; no owned pid/session attested";
      emit(evidence, outPath);
      return;
    }
    step("recovery-target", { pid: target.pid, sessionKind: target.session.kind });

    await sleep(5000);
    activateApp();
    maybeDismissDialogs("post-launch");

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

    let rows = [];
    let main = null;
    const listDeadline = Date.now() + 120_000;
    while (Date.now() < listDeadline) {
      activateApp();
      maybeDismissDialogs("observe");
      await sleep(2000);
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
      emit(evidence, outPath);
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
    for (const [index, pair] of tlPairs.slice(0, 8).entries()) {
      const attempt = {
        element: "timeline-layer",
        surface,
        from: pair.from,
        to: pair.to,
        steps: 24,
        stepDelayMs: 16,
      };
      try {
        results.timelineLayer = await dragDrop.dragElement(attempt);
        step("timeline-layer-result", { attempt: index, from: pair.from, result: results.timelineLayer });
        break;
      } catch (error) {
        step("timeline-layer-attempt-error", {
          attempt: index,
          from: pair.from,
          name: error?.name ?? typeof error,
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 400),
        });
        if (index === Math.min(7, tlPairs.length - 1)) {
          results.timelineLayer = { error: String(error?.message ?? error).slice(0, 400), code: error?.code ?? null };
        }
      }
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
    for (const [index, pair] of pPairs.slice(0, 8).entries()) {
      const attempt = {
        element: "project-item",
        surface,
        from: pair.from,
        to: pair.to,
        steps: 24,
        stepDelayMs: 16,
      };
      try {
        results.projectItem = await dragDrop.dragElement(attempt);
        step("project-item-result", { attempt: index, from: pair.from, result: results.projectItem });
        break;
      } catch (error) {
        step("project-item-attempt-error", {
          attempt: index,
          from: pair.from,
          name: error?.name ?? typeof error,
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 400),
        });
        if (index === Math.min(7, pPairs.length - 1)) {
          results.projectItem = { error: String(error?.message ?? error).slice(0, 400), code: error?.code ?? null };
        }
      }
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
        const preAct = new Set([
          "refused",
          "unsupported",
          "unproven",
          "invalid-locator",
          "stale-locator",
        ]);
        if (!preAct.has(error?.code)) {
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
    emit(evidence, outPath);
  } catch (error) {
    // Never lose the run: an uncaught op failure (bridge timeout, AE
    // busy) still emits whatever evidence was gathered before the
    // owned instance is closed in `finally`.
    evidence.outcome = evidence.outcome === "refused" ? "refused" : "failed";
    evidence.reason = `uncaught: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    emit(evidence, outPath);
  } finally {
    try {
      const close = await ae.close({ unsavedChanges: "discard" });
      step("close", { ok: true, ...close });
    } catch (error) {
      step("close", { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

await main();
