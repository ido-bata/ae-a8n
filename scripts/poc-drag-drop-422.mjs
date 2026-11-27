#!/usr/bin/env node
/**
 * Issue #422 real-host e2e: `ae.dragDrop().dropFile` against an owned
 * AE 2027 launch — the production path, not the #411 PoC vehicle.
 *
 * What it does, in order:
 *   1. refuses to run when the target install already has an in-scope
 *      AE (an owned launch would attach to it — never done here);
 *   2. launches owned AE, resolves the recovery target, lists windows
 *      through `MacGuiRecovery` and builds the `DragDropSurfaceLocator`
 *      for the main window from the live observation;
 *   3. locates the Project panel drop point — first via
 *      `ae.dockedPane({ pane.title contains "Project" })` (records which
 *      channel answered), falling back to a documented main-window
 *      heuristic when the AX pane walk cannot resolve it;
 *   4. vends a fixture PNG through `ae.dragDrop().dropFile` — the whole
 *      press→NSDraggingSession→release runs inside the production
 *      lease + census gates + `project.items` oracle;
 *   5. records the `DragDropResult` verbatim plus `project.state`
 *      before/after, screenshots, and quits the owned instance.
 *
 * `element-drag` is deliberately NOT exercised: the gate refuses it in
 * production (see docs/gui-supervision-safety-gates.md), and forcing it
 * would test the seam, not the shipped behavior.
 *
 * Requires `npm run build` first. Usage:
 *   node scripts/poc-drag-drop-422.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --out docs/evidence/realhost-2026-11-28/drag-drop-422/run.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

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
const { darwinWindowOpsOps, sessionWindowOpsExec } = await import(distWindowOps);
const { ensureDarwinWindowOpsHelpers } = await import(distWindowOpsApi);


function fail(message) {
  console.error(`poc-drag-drop-422: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { install: undefined, out: undefined, sessionRoot: undefined, attachPid: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--session-root") options.sessionRoot = argv[++i];
    else if (arg === "--attach-pid") options.attachPid = Number(argv[++i]);
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

// --- Minimal PNG encoder (8x8 opaque red) — same fixture shape as #411. ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makePng(path) {
  const W = 8, H = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y += 1) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = 0xa8; raw[o + 1] = 0x20; raw[o + 2] = 0x20;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outPath = resolve(options.out);
  const outDir = dirname(outPath);

  const evidence = {
    schema: "a8n.poc-drag-drop-422/v1",
    issue: 422,
    recordedAt: new Date().toISOString(),
    install: options.install,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
    console.log(`step ${name}: ${JSON.stringify(data).slice(0, 300)}`);
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(distInstallPath);
  const install = resolveInstall(process.platform, { installDir: options.install });
  const attachPid = Number.isInteger(options.attachPid) ? options.attachPid : null;
  const preexisting = inScopeAEPids(install).filter((pid) => pid !== attachPid);
  step("preflight", { install: install.executable, preexisting });
  if (preexisting.length > 0) {
    evidence.outcome = "refused";
    evidence.reason =
      `${preexisting.length} in-scope instance(s) already running; ` +
      "an owned launch would attach to them, which this PoC never does";
    emit(evidence, outPath);
    return;
  }

  // --- Fixture + workdir. ---
  const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-dragdrop-422-"));
  const fixturePath = join(workdir, "a8n-dragdrop422-fixture.png");
  makePng(fixturePath);
  step("fixture", { path: fixturePath, size: statSync(fixturePath).size });

  // --- Launch owned AE (built-in host carries project.items). ---
  const launchOptions = {
    installDir: options.install,
    timeoutMs: 300_000,
    readinessTimeoutMs: 240_000,
  };
  if (options.sessionRoot !== undefined) launchOptions.sessionRoot = options.sessionRoot;
  let ae;
  if (attachPid !== null) {
    evidence.outcome = "refused";
    evidence.reason =
      "--attach-pid is not supported by this e2e: dragDrop() requires an " +
      "owned recoveryTarget and an attached session attests neither";
    emit(evidence, outPath);
    return;
  }

  // --- Startup-dialog watchdog -------------------------------------
  // On this host AE 2027 raises a modal "Thor-installed-language(s) will
  // not be honored" BirthPrefs warning (plus a follow-up notice) on
  // launch; while it is up the ExtendScript transport never answers and
  // launch() burns its whole readiness budget. The watchdog presses
  // Return — the dialog's OK — ONLY while the WindowServer census shows
  // a small on-screen dialog-layer window belonging to OUR launched pid
  // (layer >= 8, < 800x600 pt; the main window is layer 0 and far larger).
  // Every dismissal is counted into the evidence; the watchdog never
  // runs while a drag is in flight.
  const appPath = install.executable.replace(/\/Contents\/MacOS\/.*$/, "");
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
  ae = launchOutcome.value;
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

    // Give AE a moment to finish first paint, then activate best-effort.
    await new Promise((r) => setTimeout(r, 5000));
    try {
      execFileSync("/usr/bin/osascript", [
        "-e",
        `tell application "System Events" to set frontmost of ` +
          `(first application process whose unix id is ${target.pid}) to true`,
      ], { timeout: 15_000 });
      step("activate", { ok: true });
    } catch (error) {
      step("activate", { ok: false, error: String(error).slice(0, 200) });
    }

    // --- Window listing → DragDropSurfaceLocator for the main window. ---
    // The controller's observe() runs the compiled `window-ops state`
    // helper (AXUIElement) — System Events sees ZERO windows on AE
    // (#406), so the locator MUST be built from the same channel or the
    // windowIndex will not line up. Poll with real activation until the
    // AX tree vends (it populates after the app has been frontmost).
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

    // Mirrors src/api/drag-drop.ts windowOpsObserve(): listing rows in
    // order, AXFocusedWindow appended when absent, pid-scoped census
    // attribution (exactly one census row of OUR pid may frame-match).
    const observeRows = () => {
      if (surfaceOps === null) {
        throw new Error("window-ops helpers unavailable; no listing channel");
      }
      const listing = surfaceOps.observeWindows();
      const census = censusFn();
      lastCensus = census;
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
        // Pid-scoped attribution — mirrors attributeWindowOpsRow in
        // src/api/drag-drop.ts (4pt frame tolerance, exactly one of OUR
        // pid's census rows may claim the frame).
        let attribution = "unmatched";
        let windowNumber = null;
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
          if (mine.length === 1) {
            attribution = "owned";
            windowNumber = mine[0].windowNumber ?? null;
          }
        }
        return {
          index: i + 1,
          title: info.title,
          subrole: info.subrole,
          role: info.role,
          frame: info.frame,
          windowNumber,
          attribution,
        };
      });
    };

    let rows = [];
    let main = null;
    let lastCensus = null;
    const listDeadline = Date.now() + 120_000;
    while (Date.now() < listDeadline) {
      activateApp();
      maybeDismissDialogs("observe");
      await new Promise((r) => setTimeout(r, 2000));
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
      await new Promise((r) => setTimeout(r, 3000));
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
      subrole: main.subrole ?? null,
      frame: main.frame,
      windows: rows.length,
      attribution: main.attribution ?? null,
      census: lastCensus === null ? null : {
        available: lastCensus.available,
        reason: lastCensus.available ? null : lastCensus.reason,
        pidRows: lastCensus.available
          ? lastCensus.windows
              .filter((w) => w.pid === target.pid)
              .map((w) => ({
                windowNumber: w.windowNumber ?? null,
                onScreen: w.onScreen,
                layer: w.layer ?? null,
                bounds: w.bounds,
              }))
          : [],
      },
    });
    step("screenshot-before", screenshot(join(outDir, "drag-drop-422-before.png")));
    step("window-capture-before", captureWindow(join(outDir, "drag-drop-422-window-before.png"), main.windowNumber ?? -1));

    // --- Drop point: docked-pane "Project" first, heuristic fallback. ---
    const project = await ae.project();
    const stateBefore = await project.state();
    step("project-state-before", stateBefore);

    let dropPoint = null;
    let dropChannel = null;
    let paneFrame = null;
    try {
      const pane = ae.dockedPane({
        pane: { title: "Project", titleMatch: "contains" },
        parent: { windowNumber: main.windowNumber },
      });
      const resolution = await pane.identify();
      const frame = resolution.pane?.frame ?? resolution.target?.surface?.frame ?? null;
      if (frame != null) {
        paneFrame = frame;
        // Empty list area: horizontal center, ~72% down the pane — below
        // the item rows, above the panel's bottom chrome (#411 lesson:
        // drop onto occupied rows reorders instead of importing).
        dropPoint = {
          x: Math.round(frame.x + frame.width / 2),
          y: Math.round(frame.y + frame.height * 0.72),
        };
        dropChannel = "docked-pane";
      }
    } catch (error) {
      step("docked-pane-probe", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (dropPoint === null) {
      // Fallback heuristic, honestly recorded: Standard-workspace AE
      // docks Project in the upper-left; aim inside its lower half.
      const f = main.frame;
      dropPoint = {
        x: Math.round(f.x + Math.min(220, f.width * 0.18)),
        y: Math.round(f.y + f.height * 0.38),
      };
      dropChannel = "main-window-heuristic";
    }
    step("drop-point", { channel: dropChannel, point: dropPoint, paneFrame });

    // --- The op under test. ---
    const dragDrop = ae.dragDrop();
    let result = null;
    let opError = null;
    try {
      result = await dragDrop.dropFile({
        surface,
        file: { path: fixturePath, vend: "fileurl" },
        to: dropPoint,
      });
    } catch (error) {
      opError = {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        code: error?.code ?? null,
      };
    }
    step("drop-file-result", { result, opError });

    // Bounded settle, then post-state.
    await new Promise((r) => setTimeout(r, 1500));
    const stateAfter = await project.state();
    step("project-state-after", stateAfter);
    step("screenshot-after", screenshot(join(outDir, "drag-drop-422-after.png")));
    step("window-capture-after", captureWindow(join(outDir, "drag-drop-422-window-after.png"), main.windowNumber ?? -1));

    evidence.outcome =
      result !== null && result.verified === true ? "verified" :
      result !== null ? "unverified" :
      "failed";
    if (opError !== null) evidence.opError = opError;
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
