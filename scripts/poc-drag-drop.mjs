#!/usr/bin/env node
/**
 * Issue #369 real-host PoC: can a CGEvent-driven press-drag-release —
 * and, for files, an NSDraggingSession-vended drop — actually land a
 * drop on After Effects (Project panel / element targets)?
 *
 * This is a real-host experiment, not a shipped feature. It mirrors
 * scripts/poc-panel-mutation.mjs: it REFUSES to run when the target
 * install already has an in-scope After Effects process — it never
 * attaches to or disturbs an instance it did not start. Foreign AE
 * processes (e.g. a second installed version driven by other automation)
 * are recorded read-only and never signalled.
 *
 * What is gated vs bypassed, exactly:
 *
 *   - No production mutation path exists for drag-drop yet (that is the
 *     implementation half of #369, out of scope for this PoC). The PoC
 *     therefore drives the OS directly: scripts/poc-drag.swift posts the
 *     mouse/drag events, exactly like a future `mutate-gui` op would,
 *     but WITHOUT the lease/gate chain — the gate does not exist yet.
 *     This is acceptable for a PoC because the target AE instance is
 *     owned (launched by this script, verified by pid), the coordinates
 *     come from a fresh WindowServer census, and the fixture file lives
 *     in a private temp dir.
 *   - Setup inside AE (project/comp/solid creation) goes through ExtendScript
 *     via the extension host script — setup only, never drop evidence.
 *   - The drop oracle is `app.project` / `comp.layer` readback through the
 *     same host channel, plus before/after screenshots.
 *
 * Requires `npm run build` first (drives `dist/`) and `swiftc` for the
 * drag helper (compiled into the PoC workdir at run time).
 *
 * Usage:
 *   node scripts/poc-drag-drop.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --mode file --from 500,900 --to 300,300 \
 *     --out docs/evidence/realhost-<date>/drag-drop-poc.json
 *
 *   --probe skips the drag entirely: launch, activate, census, screenshot,
 *   readback, quit. Use it to pick --from/--to coordinates.
 *
 * Outcome is one JSON document on stdout (and `--out` when given).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distIndex = resolve(root, "dist", "index.js");
const distHostProcesses = resolve(root, "dist", "driver", "host-processes.js");
const distInstallPath = resolve(root, "dist", "driver", "install-path.js");
const cli = resolve(root, "dist", "cli.js");

const api = await import(distIndex);
const { AfterEffects, windowServerCensus, execFileCensusRunner } = api;
const { psProcesses } = await import(distHostProcesses);

function fail(message) {
  console.error(`poc-drag-drop: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    install: undefined,
    out: undefined,
    mode: "file",
    from: undefined,
    to: undefined,
    attempts: undefined,
    sessionRoot: undefined,
    probe: false,
    settleMs: 1200,
    steps: 24,
    stepDelayMs: 16,
    readinessTimeoutMs: 240_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--from") options.from = argv[++i];
    else if (arg === "--to") options.to = argv[++i];
    else if (arg === "--attempts") options.attempts = argv[++i];
    else if (arg === "--session-root") options.sessionRoot = argv[++i];
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--steps") options.steps = Number(argv[++i]);
    else if (arg === "--step-delay-ms") options.stepDelayMs = Number(argv[++i]);
    else if (arg === "--readiness-timeout-ms") options.readinessTimeoutMs = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) {
    fail("--install <dir> is required (this PoC never guesses an install)");
  }
  if (!["file", "drag"].includes(options.mode)) {
    fail("--mode expects file or drag");
  }
  if (!options.probe) {
    if (typeof options.from !== "string" ||
        !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(options.from)) {
      fail("--from X,Y is required unless --probe");
    }
    const pointOk = (v) => typeof v === "string" && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(v);
    const hasTo = pointOk(options.to);
    const hasAttempts = typeof options.attempts === "string" &&
      options.attempts.split(";").every(pointOk);
    if (!hasTo && !hasAttempts) {
      fail("--to X,Y or --attempts X,Y;X,Y;... is required unless --probe");
    }
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    fail("--settle-ms must be a non-negative number");
  }
  if (!Number.isFinite(options.readinessTimeoutMs) || options.readinessTimeoutMs <= 0) {
    fail("--readiness-timeout-ms must be a positive number");
  }
  return options;
}

function parsePoint(text) {
  const [x, y] = text.split(",").map(Number);
  return { x, y };
}

function inScopeAEPids(install) {
  return psProcesses()
    .filter((p) => p.executable === install.executable)
    .map((p) => p.pid);
}

/** All processes whose executable path mentions After Effects — read-only census. */
function aeCensus() {
  return psProcesses()
    .filter((p) => typeof p.executable === "string" && p.executable.includes("After Effects"))
    .map((p) => ({ pid: p.pid, executable: p.executable }));
}

// --- Minimal PNG encoder (8x8 opaque red) for the file-drop fixture. ---
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
  const W = 8;
  const H = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y += 1) {
    const row = y * (1 + W * 3);
    raw[row] = 0; // filter: none
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

// Path A of aux-window clearing: try AXMinimized on every window of the
// OWNED pid. #406 showed AE's main window is not AX-enumerable; this
// script reports what System Events actually sees (count + geometry) so
// the evidence records whether aux panels are reachable at all. It only
// ever touches windows of the pid we launched.
const AX_MINIMIZE_SCRIPT = `on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    set out to ""
    try
      set ws to windows of p
    on error errMsg
      return "WINDOWS-ERROR " & errMsg
    end try
    set out to out & "count=" & (count of ws) & linefeed
    repeat with w in ws
      try
        set pos to position of w
        set sz to size of w
        set nm to ""
        try
          set nm to name of w
        end try
        set out to out & "win pos=" & (pos as text) & " size=" & (sz as text) & " name=" & nm & linefeed
        if (item 1 of sz) <= 800 and (item 2 of sz) <= 700 then
          try
            set value of attribute "AXMinimized" of w to true
            set out to out & "  -> minimized" & linefeed
          on error errMsg
            set out to out & "  -> minimize-error " & errMsg & linefeed
          end try
        end if
      on error errMsg
        set out to out & "win-error " & errMsg & linefeed
      end try
    end repeat
    return out
  end tell
end run
`;

function screenshot(path) {
  try {
    execFileSync("/usr/sbin/screencapture", ["-x", path], { timeout: 30_000 });
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function captureWindow(path, windowNumber) {
  try {
    execFileSync("/usr/sbin/screencapture", [
      "-x", "-o", "-l", String(windowNumber), path,
    ], { timeout: 30_000 });
    return { ok: true, path, windowNumber };
  } catch (error) {
    return {
      ok: false,
      windowNumber,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.out ? dirname(resolve(options.out)) : undefined;
  const evidence = {
    schema: "a8n.poc-drag-drop/v1",
    issue: 369,
    recordedAt: new Date().toISOString(),
    install: options.install,
    mode: options.mode,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(distInstallPath);
  const install = resolveInstall(process.platform, { installDir: options.install });
  const preexisting = inScopeAEPids(install);
  step("preflight", {
    install: install.executable,
    preexisting,
    aeCensus: aeCensus(),
  });
  if (preexisting.length > 0) {
    evidence.outcome = "refused";
    evidence.reason =
      `${preexisting.length} in-scope instance(s) of ${install.executable} already ` +
      "running; an owned launch would attach to them, which this PoC never does";
    emit(evidence, options.out);
    return;
  }

  // --- Workdir: extension host script, compiled drag helper, fixture. ---
  const workdir = mkdtempSync(join(tmpdir(), "ae-a8n-drag-poc-"));
  const hostScript = join(workdir, "a8n-drag-poc-host.jsx");
  execFileSync(
    process.execPath,
    [cli, "extension", "build", "--extension", join(here, "poc-drag-extension.mjs"), "--out", hostScript],
    { stdio: "pipe" },
  );
  step("extension-build", { hostScript });

  const dragBin = join(workdir, "poc-drag");
  try {
    execFileSync("swiftc", ["-O", join(here, "poc-drag.swift"), "-o", dragBin], {
      stdio: "pipe",
      timeout: 180_000,
    });
    step("drag-helper-build", { dragBin });
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = `swiftc failed: ${error instanceof Error ? error.message : String(error)}`;
    emit(evidence, options.out);
    return;
  }

  const fixturePath = join(workdir, "a8n-poc-fixture.png");
  makePng(fixturePath);
  step("fixture", { path: fixturePath });

  const launchOptions = {
    installDir: options.install,
    hostScript,
    timeoutMs: 300_000,
    readinessTimeoutMs: options.readinessTimeoutMs,
  };
  if (options.sessionRoot !== undefined) {
    launchOptions.sessionRoot = options.sessionRoot;
  }
  const ae = await AfterEffects.launch(launchOptions);
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
      // losing the cleanup record (same defect class as #432).
      throw new Error("recoveryTarget() is null; no owned pid/session attested");
    }
    step("recovery-target", { pid: target.pid });

    const ensureProject = await ae.call("poc.ensureProject", {});
    step("ensure-project", { inAe: ensureProject });
    const compBefore = await ae.call("poc.ensureComp", { name: "PoC Comp" });
    step("ensure-comp", { inAe: compBefore });

    // Activate the owned AE so it is the drop target's frontmost app.
    const bundlePath = join(options.install, install.versionName);
    try {
      execFileSync("/usr/bin/open", [bundlePath], { timeout: 15_000 });
      step("activate-open", { ok: true, bundlePath });
    } catch (error) {
      step("activate-open", {
        ok: false,
        bundlePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const activatePath = join(workdir, "axactivate.scpt");
    writeFileSync(activatePath, AX_ACTIVATE_SCRIPT, "utf-8");
    step("activate-frontmost", runOsascript(activatePath, [String(target.pid)]));
    await new Promise((r) => setTimeout(r, options.settleMs + 1500));

    // Window census: find the owned AE's on-screen window(s). AE panels
    // are NOT AX-enumerable (issue #406), so the census frame is the only
    // geometry oracle — drop coordinates are derived from it plus
    // empirical offsets recorded in this evidence.
    const census = windowServerCensus(execFileCensusRunner());
    /**
     * Z-order oracle: CGWindowListCopyWindowInfo returns on-screen windows
     * front-to-back, so the FIRST window whose bounds contain the point is
     * what a real drop would hit. Returns {pid, owner, windowNumber} or
     * null. Used to prove the drop target is the OWNED AE — never a
     * foreign instance sharing the same screen rect.
     */
    const topmostAt = (x, y) => {
      // Fresh census per call: z-order changes as windows come and go.
      const fresh = windowServerCensus(execFileCensusRunner());
      if (!fresh.available) return { error: "census unavailable" };
      for (const w of fresh.windows) {
        if (w.onScreen !== true || w.bounds === null) continue;
        // Desktop-level surfaces carry hugely negative `layer` values and
        // cover the whole screen; they sort before real app windows, so an
        // unfiltered first-match always returns them (same fix as
        // poc-drag-alt.mjs). Real app windows are layer >= 0.
        if (typeof w.layer === "number" && w.layer < 0) continue;
        const b = w.bounds;
        if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
          return { pid: w.pid, owner: w.owner, windowNumber: w.windowNumber ?? null };
        }
      }
      return null;
    };
    const aeWindows = census.available
      ? census.windows.filter((w) => w.pid === target.pid)
      : [];
    const onScreen = aeWindows.filter((w) => w.onScreen === true && w.bounds !== null);
    onScreen.sort((a, b) =>
      (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
    step("window-census", {
      censusAvailable: census.available,
      allForPid: aeWindows,
      largestOnScreen: onScreen[0] ?? null,
    });

    const itemsBefore = await ae.call("poc.projectItems", {});
    step("project-items-before", { inAe: itemsBefore });
    const layersBefore = await ae.call("poc.compLayers", { name: "PoC Comp" });
    step("comp-layers-before", { inAe: layersBefore });

    if (outDir) {
      step("screenshot-before", screenshot(join(outDir, "drag-before.png")));
      // Per-window captures (`screencapture -l` by CGWindowID): AE panels
      // are AX-invisible, so these images + OCR are the only way to learn
      // what each census window actually is.
      for (const w of onScreen) {
        if (typeof w.windowNumber !== "number") continue;
        step(`window-capture-${w.windowNumber}`, captureWindow(
          join(outDir, `window-${w.windowNumber}.png`), w.windowNumber,
        ));
      }
    } else {
      step("screenshot-before", { skipped: "no --out dir" });
    }

    if (options.probe) {
      evidence.outcome = "probe-complete";
    } else {
      // Auxiliary floating panels (measured: "ty-plus" CEP windows,
      // 640x504 each) tile over the main window and cover the Project
      // panel, so every drop lands on a panel instead of AE chrome. AE
      // panels are AX-invisible (#406) and windowOps needs AX, so the
      // only way to clear them is a real click on each window's close
      // button — verified by the z-ordered census before EVERY click so
      // a foreign window can never be hit. Only small on-screen windows
      // owned by OUR pid are touched; the main window is never a target.
      const auxResults = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const auxWindowsOf = () => {
        const fresh = windowServerCensus(execFileCensusRunner());
        if (!fresh.available) return { error: "census unavailable" };
        const ours = fresh.windows.filter(
          (w) => w.pid === target.pid && w.onScreen === true && w.bounds !== null,
        );
        const main = ours.reduce(
          (a, b) => ((a === null ? -1 : a.bounds.width * a.bounds.height) >=
            (b.bounds.width * b.bounds.height) ? a : b),
          null,
        );
        return {
          aux: ours.filter((w) =>
            w !== main && w.bounds.width <= 800 && w.bounds.height <= 700),
        };
      };

      // Path A: AX minimize. #406 showed AE's MAIN window is not
      // AX-enumerable, but the ty-plus aux windows may still be — cheap
      // to test, and AXMinimized is the cleanest possible close.
      const axMinPath = join(workdir, "axmin.scpt");
      writeFileSync(axMinPath, AX_MINIMIZE_SCRIPT, "utf-8");
      auxResults.push({
        path: "ax-minimize",
        ...runOsascript(axMinPath, [String(target.pid)]),
      });
      await sleep(800);

      // Path B (fallback): MOVE each remaining aux window DOWN by ~520pt
      // via a title-strip drag, parking it mostly off the bottom edge.
      // Every aux window top is >=161 and the Project panel content ends
      // around y~640, so +520 clears the panel entirely while the title
      // strip (y~681+) stays grabbable for verification. A uniform
      // downward shift also cannot cover OTHER windows' title points
      // (moved windows only occupy y>=~660, unmoved titles are y<=~620),
      // so rounds monotonically expose more windows. A Cmd+M minimize
      // was rejected: CEP/ScriptUI panels are often non-activating, so
      // the keystroke would land on the still-key MAIN window. Moves are
      // pure pointer traffic and every one is census-verified.
      runOsascript(activatePath, [String(target.pid)]);
      await sleep(600);
      const MOVE_DY = 520;
      for (let round = 0; round < 6; round += 1) {
        const { aux, error } = auxWindowsOf();
        if (error !== undefined) {
          auxResults.push({ round, path: "census", error });
          break;
        }
        if (aux.length === 0) {
          auxResults.push({ round, remainingAux: 0 });
          break;
        }
        let movedThisRound = 0;
        for (const w of aux) {
          const b = w.bounds;
          // Already parked low enough? Then it cannot cover the Project
          // panel — leave it and stop retrying it.
          if (b.y >= 660) continue;
          const record = {
            round,
            windowNumber: w.windowNumber,
            boundsBefore: b,
            moved: false,
          };
          const fx = b.x + b.width / 2;
          // Try two title-strip heights: ty-plus chrome looked ~40-50pt
          // tall in the window captures, so 20pt may be too high.
          for (const titleDy of [20, 36]) {
            const fy = b.y + titleDy;
            const top = topmostAt(fx, fy);
            if (top === null || top.windowNumber !== w.windowNumber) {
              record.skipped = "window not topmost at title point";
              break;
            }
            const res = spawnSync(dragBin, [
              "drag",
              "--from", `${fx},${fy}`,
              "--to", `${fx},${fy + MOVE_DY}`,
              "--steps", "16",
              "--step-delay-ms", "20",
            ], { encoding: "utf-8", timeout: 30_000 });
            record.dragExit = res.status;
            await sleep(500);
            const after = windowServerCensus(execFileCensusRunner());
            const now = after.available
              ? after.windows.find((x) => x.windowNumber === w.windowNumber)
              : undefined;
            record.boundsAfter = now?.bounds ?? null;
            record.moved = now?.bounds != null && now.bounds.y > b.y + 100;
            if (record.moved) {
              movedThisRound += 1;
              break;
            }
          }
          auxResults.push(record);
        }
        if (movedThisRound === 0) break; // no progress possible
      }
      step("close-aux-windows", { results: auxResults });

      const from = parsePoint(options.from);
      // --attempts is a ";"-separated drop-target scan: each target gets
      // one drag, readback after each, stop at the first observed landing.
      // Used to discover panel geometry empirically when AX cannot see it.
      const targets = options.attempts !== undefined
        ? options.attempts.split(";").map(parsePoint)
        : [parsePoint(options.to)];
      const attemptResults = [];
      let landed = false;
      for (const [index, to] of targets.entries()) {
        if (landed) break;
        // Safety gate per attempt: re-activate the owned AE and prove via
        // z-ordered census that the point belongs to OUR window before a
        // single event is posted. A foreign topmost window → skip, never
        // drag onto it.
        runOsascript(activatePath, [String(target.pid)]);
        await new Promise((r) => setTimeout(r, 400));
        const top = topmostAt(to.x, to.y);
        const topIsOurs = top !== null && top.pid === target.pid;
        if (!topIsOurs) {
          attemptResults.push({
            index,
            to,
            skipped: "foreign-or-no topmost window at target",
            topmost: top,
          });
          step(`drag-attempt-${index}`, attemptResults[attemptResults.length - 1]);
          continue;
        }
        const dragArgs = [
          options.mode === "file" ? "filedrag" : "drag",
          ...(options.mode === "file" ? ["--file", fixturePath] : []),
          "--from", `${from.x},${from.y}`,
          "--to", `${to.x},${to.y}`,
          "--steps", String(options.steps),
          "--step-delay-ms", String(options.stepDelayMs),
        ];
        let dragResult;
        try {
          const res = spawnSync(dragBin, dragArgs, {
            encoding: "utf-8",
            timeout: 120_000,
          });
          if (res.status === 0) {
            dragResult = {
              ok: true,
              receipt: JSON.parse(res.stdout.trim()),
              stderr: res.stderr?.trim() || undefined,
            };
          } else {
            dragResult = {
              ok: false,
              exitStatus: res.status,
              error: res.error?.message ?? `exit ${res.status}`,
              stdout: res.stdout,
              stderr: res.stderr,
            };
          }
        } catch (error) {
          dragResult = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await new Promise((r) => setTimeout(r, options.settleMs + 800));
        const itemsNow = await ae.call("poc.projectItems", {});
        const layersNow = await ae.call("poc.compLayers", { name: "PoC Comp" });
        const names = itemsNow && Array.isArray(itemsNow.items)
          ? itemsNow.items.map((it) => it.name) : [];
        const hit = names.some(
          (n) => typeof n === "string" && n.includes("a8n-poc-fixture"),
        );
        const layerDelta =
          JSON.stringify(layersNow?.layers) !== JSON.stringify(layersBefore?.layers);
        attemptResults.push({
          index,
          to,
          topmost: top,
          drag: dragResult,
          projectItemCount: itemsNow?.count ?? null,
          fixturePresent: hit,
          layerOrderChanged: layerDelta,
        });
        step(`drag-attempt-${index}`, attemptResults[attemptResults.length - 1]);
        // Stop at the first OBSERVED effect — a project-item import or a
        // layer-order/layer-count change both mean the drop reached AE.
        landed = hit || layerDelta;
      }
      const itemsAfter = await ae.call("poc.projectItems", {});
      step("project-items-after", { inAe: itemsAfter });
      const layersAfter = await ae.call("poc.compLayers", { name: "PoC Comp" });
      step("comp-layers-after", { inAe: layersAfter });
      if (outDir) {
        step("screenshot-after", screenshot(join(outDir, "drag-after.png")));
      }

      // Honest verdict inputs: did the fixture appear as a project item?
      const afterItems = itemsAfter && Array.isArray(itemsAfter.items)
        ? itemsAfter.items : [];
      const beforeNames = new Set(
        (itemsBefore?.items ?? []).map((it) => it.name),
      );
      const newItems = afterItems.filter((it) => !beforeNames.has(it.name));
      evidence.observations = {
        attempts: attemptResults,
        fixtureImported: landed,
        newProjectItems: newItems,
        projectItemCountBefore: itemsBefore?.count ?? null,
        projectItemCountAfter: itemsAfter?.count ?? null,
        layerOrderChanged:
          JSON.stringify(layersBefore?.layers) !== JSON.stringify(layersAfter?.layers),
      };
      evidence.outcome = "completed";
    }
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.errorStack = error instanceof Error ? error.stack : undefined;
  } finally {
    try {
      // The PoC project is created by this script (ensureComp) and is
      // disposable: discard unsaved changes so close() can quit the owned
      // host. This is safe ONLY because launch() proved ownership — an
      // attached session would refuse here by design.
      const closed = await ae.close({ unsavedChanges: "discard" });
      step("close", { closed });
    } catch (error) {
      step("close", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Post-flight census: the owned AE must be gone; foreign instances are
  // reported but never touched.
  const post = inScopeAEPids(install);
  step("postflight-census", {
    remainingInScope: post,
    aeCensus: aeCensus(),
  });
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
