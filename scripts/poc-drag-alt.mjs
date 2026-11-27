#!/usr/bin/env node
/**
 * Issue #411 real-host PoC: drag-drop ALTERNATIVE paths, stage 2 of #369.
 *
 * #369 proved synthetic NSDraggingSession(.fileURL)+CGEvent file drops are
 * refused by AE 2027's Project panel (39/39, operation:"none"). That verdict
 * is scoped to that vehicle/target/OS. This script tests the remaining
 * hypotheses from the issue:
 *
 *   1. in-app element drag — plain CGEvent press-drag-release of an
 *      AE-internal element (Project panel item reorder, Timeline layer
 *      reorder). No pasteboard is involved at all: AE itself starts the
 *      drag session on mouse-down+move. If this lands, "AE refuses
 *      CGEvent drags entirely" is falsified and only the file-drop
 *      vehicle is unsupported.
 *   2. file drop via an enriched pasteboard — `--vend legacy` additionally
 *      advertises NSFilenamesPboardType + public.utf8-plain-text, the
 *      flavors Finder vends. A real-Finder-source positive control needs a
 *      human hand on the mouse; that is recorded honestly as unverified.
 *   3. hover/dwell — `--dwell-ms` keeps the cursor parked on the drop
 *      point before mouse-up.
 *
 * Plan-file driven: --plan plan.json is an array of ops executed in order
 * against ONE owned AE launch:
 *
 *   {"op":"activate"}
 *   {"op":"sleep","ms":800}
 *   {"op":"screenshot","name":"before.png"}
 *   {"op":"census"}
 *   {"op":"auxclear"}
 *   {"op":"axwalk","name":"ax-main.json"}
 *   {"op":"readback","name":"project","what":"project"}
 *   {"op":"readback","name":"layers","what":"layers"}
 *   {"op":"drag","name":"...","from":"x,y","to":"x,y",
 *    "steps":24,"stepDelayMs":16,"dwellMs":0,"tap":"session",
 *    "gate":true,"oracle":"project"}
 *   {"op":"filedrag","name":"...","file":"path","vend":"legacy",
 *    "from":"x,y","to":"x,y","dwellMs":800,"gate":true,"oracle":"project"}
 *   {"op":"click","name":"...","at":"x,y","tap":"session","gate":true}
 *   {"op":"key","name":"...","code":46,"flags":"cmd"}
 *
 * `oracle` snapshots project items + comp layers before/after the op and
 * records order/count/name deltas — the drop/reorder oracle.
 *
 * Safety (same contract as poc-drag-drop.mjs): refuses to run when the
 * target install already has an in-scope AE; every gated op re-proves via
 * z-ordered WindowServer census that the event endpoints belong to the
 * OWNED pid; a foreign AE appearing/changing mid-run aborts the plan;
 * foreign processes are never signalled.
 *
 * Requires `npm run build` first. Usage:
 *   node scripts/poc-drag-alt.mjs \
 *     --install "/Applications/Adobe After Effects 2027" \
 *     --plan plan.json --out docs/evidence/realhost-2026-11-27/x.json
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  console.error(`poc-drag-alt: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { install: undefined, plan: undefined, out: undefined, sessionRoot: undefined, helpersDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--plan") options.plan = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--session-root") options.sessionRoot = argv[++i];
    else if (arg === "--helpers-dir") options.helpersDir = argv[++i];
    else if (arg === "--attach-pid") options.attachPid = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) fail("--install <dir> is required");
  if (options.plan === undefined) fail("--plan <file.json> is required");
  return options;
}

function parsePoint(text) {
  if (typeof text !== "string") return null;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(text.trim());
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function inScopeAEPids(install) {
  return psProcesses()
    .filter((p) => p.executable === install.executable)
    .map((p) => p.pid);
}

/** All AE-ish processes, read-only census (any install/version). */
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

function runOsascript(scriptPath, args) {
  try {
    const out = execFileSync("/usr/bin/osascript", [scriptPath, ...args], {
      encoding: "utf-8", timeout: 60_000,
    });
    return { ok: true, output: out.trim() };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const planPath = resolve(options.plan);
  const plan = JSON.parse(readFileSync(planPath, "utf-8"));
  if (!Array.isArray(plan)) fail("--plan must be a JSON array of ops");
  const outDir = options.out ? dirname(resolve(options.out)) : undefined;

  const evidence = {
    schema: "a8n.poc-drag-alt/v1",
    issue: 411,
    recordedAt: new Date().toISOString(),
    install: options.install,
    plan: planPath,
    steps: [],
  };
  const step = (name, data) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  };

  // --- Pre-flight: refuse if the target install already runs AE. ---
  const { resolveInstall } = await import(distInstallPath);
  const install = resolveInstall(process.platform, { installDir: options.install });
  // --attach-pid continues an experiment on an already-running instance of
  // THIS install (e.g. resuming after a transient script-queue stall). The
  // pinned pid is the expected preexisting instance, not a refusal cause.
  const attachPid = Number.isInteger(options.attachPid) ? options.attachPid : null;
  const preexisting = inScopeAEPids(install).filter((pid) => pid !== attachPid);
  // Foreign = a foreign AE MAIN process: basename exactly "After Effects"
  // outside our install dir. Helper churn (crashpad_handler,
  // dynamiclinkmanager, TeamProjectsLocalHub respawning under either
  // install) is normal OS noise — measured: foreign AE 2026's helpers
  // changed pids mid-run and aborted a plan that never touched them.
  const installRoot = resolve(options.install);
  const isForeign = (p) => {
    if (typeof p.executable !== "string" || !p.executable.includes("After Effects")) {
      return false;
    }
    const base = p.executable.split("/").pop();
    if (base !== "After Effects") return false;
    return !resolve(p.executable).startsWith(installRoot);
  };
  const foreignAtStart = aeCensus().filter(isForeign);
  step("preflight", {
    install: install.executable,
    preexisting,
    aeCensus: aeCensus(),
    foreignBaseline: foreignAtStart,
  });
  if (preexisting.length > 0) {
    evidence.outcome = "refused";
    evidence.reason =
      `${preexisting.length} in-scope instance(s) already running; ` +
      "an owned launch would attach to them, which this PoC never does";
    emit(evidence, options.out);
    return;
  }

  // --- Workdir: extension host script + compiled helpers + fixture. ---
  // --helpers-dir caches the swiftc products across runs (each compile is
  // ~25 s; the foreign-AE drift window makes short setups valuable).
  const workdir = options.helpersDir !== undefined
    ? resolve(options.helpersDir)
    : mkdtempSync(join(tmpdir(), "ae-a8n-drag-alt-"));
  if (options.helpersDir !== undefined) {
    try { execFileSync("mkdir", ["-p", workdir]); } catch { /* exists */ }
  }
  const hostScript = join(workdir, "a8n-drag-alt-host.jsx");
  execFileSync(
    process.execPath,
    [cli, "extension", "build", "--extension", join(here, "poc-drag-alt-extension.mjs"), "--out", hostScript],
    { stdio: "pipe" },
  );
  step("extension-build", { hostScript });

  const dragBin = join(workdir, "poc-drag");
  const axwalkBin = join(workdir, "poc-axwalk");
  const needsBuild = (bin, src) =>
    !existsSync(bin) || statSync(src).mtimeMs > statSync(bin).mtimeMs;
  try {
    const jobs = [];
    if (needsBuild(dragBin, join(here, "poc-drag.swift"))) {
      jobs.push(["poc-drag.swift", dragBin]);
    }
    if (needsBuild(axwalkBin, join(here, "poc-axwalk.swift"))) {
      jobs.push(["poc-axwalk.swift", axwalkBin]);
    }
    for (const [src, bin] of jobs) {
      execFileSync("swiftc", ["-O", join(here, src), "-o", bin], { stdio: "pipe", timeout: 180_000 });
    }
    step("helper-build", { dragBin, axwalkBin, compiled: jobs.map((j) => j[0]) });
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
    readinessTimeoutMs: 240_000,
  };
  if (options.sessionRoot !== undefined) launchOptions.sessionRoot = options.sessionRoot;
  let ae;
  if (attachPid !== null) {
    // Attach-only continuation: no launch path exists on this lane, and
    // the attached session's ownership stays "attached" — close() will
    // detach, never quit. extensionMethods grant lets the poc.* calls run.
    ae = await AfterEffects.attach({
      installDir: options.install,
      hostScript,
      timeoutMs: 300_000,
      readinessTimeoutMs: 240_000,
      target: { pid: attachPid },
      authorization: { extensionMethods: true },
      ...(options.sessionRoot !== undefined ? { sessionRoot: options.sessionRoot } : {}),
    });
    step("attach", { pid: attachPid, info: ae.info() });
  } else {
    ae = await AfterEffects.launch(launchOptions);
    step("launch", { pid: ae.recoveryTarget()?.pid ?? null, info: ae.info() });
  }

  const foreignBaselinePids = new Set(foreignAtStart.map((p) => p.pid));
  let aborted = null;
  let halted = null;

  try {
    // Attached sessions have no recoveryTarget (ownership is "attached",
    // not "owned"); the pinned pid is the attested target for gating.
    const target = ae.recoveryTarget() ?? (attachPid !== null ? { pid: attachPid } : null);
    if (target === null) {
      evidence.outcome = "failed";
      evidence.reason = "recoveryTarget() is null; no owned pid/session attested";
      emit(evidence, options.out);
      return;
    }
    step("recovery-target", { pid: target.pid });

    // --- Shared oracles -------------------------------------------------
    const snapshot = async () => {
      const items = await ae.call("poc.projectItems", {});
      const layers = await ae.call("poc.compLayers", { name: "PoC Comp" });
      const itemNames = items && Array.isArray(items.items)
        ? items.items.map((it) => it.name) : [];
      const layerNames = layers && Array.isArray(layers.layers)
        ? layers.layers.map((l) => l.name) : [];
      return { itemNames, layerNames, items, layers };
    };
    const diffSnapshot = (before, after) => ({
      projectOrderChanged:
        JSON.stringify(before.itemNames) !== JSON.stringify(after.itemNames),
      projectCountChanged: before.itemNames.length !== after.itemNames.length,
      layerOrderChanged:
        JSON.stringify(before.layerNames) !== JSON.stringify(after.layerNames),
      layerCountChanged: before.layerNames.length !== after.layerNames.length,
      fixturePresent: after.itemNames.some(
        (n) => typeof n === "string" && n.includes("a8n-poc-fixture"),
      ),
      beforeItems: before.itemNames,
      afterItems: after.itemNames,
      beforeLayers: before.layerNames,
      afterLayers: after.layerNames,
    });

    // --- Census / gating helpers ----------------------------------------
    // Desktop-level surfaces (壁紙/Finder-desk/WindowManager window tiles)
    // carry hugely negative `layer` values and cover the whole screen;
    // they sort BEFORE real app windows in the census, so an unfiltered
    // first-match always returns them (measured: every gate failed on
    // pid 654/680). Real app windows are layer >= 0 (floating panels
    // higher); filter those out before the first-match.
    const topmostAt = (x, y) => {
      const fresh = windowServerCensus(execFileCensusRunner());
      if (!fresh.available) return { error: "census unavailable" };
      const matches = [];
      for (const w of fresh.windows) {
        if (w.onScreen !== true || w.bounds === null) continue;
        if (typeof w.layer === "number" && w.layer < 0) continue;
        const b = w.bounds;
        if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
          matches.push({ pid: w.pid, owner: w.owner, windowNumber: w.windowNumber ?? null, layer: w.layer ?? null });
        }
      }
      return { topmost: matches[0] ?? null, allMatches: matches };
    };
    // The owned main window = largest on-screen window of our pid.
    const mainWindowNumber = () => {
      const fresh = windowServerCensus(execFileCensusRunner());
      if (!fresh.available) return null;
      const ours = fresh.windows.filter(
        (w) => w.pid === target.pid && w.onScreen === true && w.bounds !== null);
      if (ours.length === 0) return null;
      ours.sort((a, b) =>
        (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
      return ours[0].windowNumber ?? null;
    };
    const activatePath = join(workdir, "axactivate.scpt");
    writeFileSync(activatePath, AX_ACTIVATE_SCRIPT, "utf-8");
    const activate = async () => {
      try {
        execFileSync("/usr/bin/open", [join(options.install, install.versionName)], { timeout: 15_000 });
      } catch { /* open is best-effort; osascript below is authoritative */ }
      return runOsascript(activatePath, [String(target.pid)]);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Foreign-AE drift check: the baseline foreign set must not change.
    // A NEW foreign AE process or a changed pid set aborts the plan.
    const foreignDrift = () => {
      const now = new Set(aeCensus().filter(isForeign).map((p) => p.pid));
      for (const pid of now) {
        if (!foreignBaselinePids.has(pid)) return `new foreign AE pid ${pid} appeared`;
      }
      // A baseline foreign AE EXITING is not drift: fewer foreign processes
      // cannot confuse the topmost gate (measured: AE 2026 pid 15113 quit
      // mid-run and its disappearance skipped every remaining filedrag).
      return null;
    };

    // Move small aux windows (ty-plus CEP panels) down off the Project
    // panel, same proven approach as #369: census-verified title-strip
    // drags only, owned pid only.
    const moveAuxDown = async (label) => {
      const results = [];
      const MOVE_DY = 520;
      for (let round = 0; round < 6; round += 1) {
        const drift = foreignDrift();
        if (drift) { results.push({ round, aborted: drift }); break; }
        const fresh = windowServerCensus(execFileCensusRunner());
        if (!fresh.available) { results.push({ round, error: "census unavailable" }); break; }
        const ours = fresh.windows.filter(
          (w) => w.pid === target.pid && w.onScreen === true && w.bounds !== null);
        const main = ours.reduce(
          (a, b) => ((a === null ? -1 : a.bounds.width * a.bounds.height) >=
            (b.bounds.width * b.bounds.height) ? a : b), null);
        const aux = ours.filter((w) =>
          w !== main && w.bounds.width <= 800 && w.bounds.height <= 700 && w.bounds.y < 660);
        if (aux.length === 0) { results.push({ round, remainingAux: 0 }); break; }
        let moved = 0;
        for (const w of aux) {
          const b = w.bounds;
          const record = { round, windowNumber: w.windowNumber, boundsBefore: b, moved: false };
          const fx = b.x + b.width / 2;
          for (const titleDy of [20, 36]) {
            const fy = b.y + titleDy;
            const top = topmostAt(fx, fy).topmost;
            if (top === null || top.windowNumber !== w.windowNumber) {
              record.skipped = "window not topmost at title point";
              break;
            }
            const res = spawnSync(dragBin, [
              "drag", "--from", `${fx},${fy}`, "--to", `${fx},${fy + MOVE_DY}`,
              "--steps", "16", "--step-delay-ms", "20",
            ], { encoding: "utf-8", timeout: 30_000 });
            record.dragExit = res.status;
            await sleep(500);
            const after = windowServerCensus(execFileCensusRunner());
            const now = after.available
              ? after.windows.find((x) => x.windowNumber === w.windowNumber) : undefined;
            record.boundsAfter = now?.bounds ?? null;
            record.moved = now?.bounds != null && now.bounds.y > b.y + 100;
            if (record.moved) { moved += 1; break; }
          }
          results.push(record);
        }
        if (moved === 0) break;
      }
      step(`aux-clear-${label}`, { results });
      return results;
    };

    // --- Setup: project + comp + comp viewer ------------------------------
    step("ensure-project", { inAe: await ae.call("poc.ensureProject", {}) });
    step("ensure-comp", { inAe: await ae.call("poc.ensureComp", { name: "PoC Comp" }) });
    step("open-comp-viewer", { inAe: await ae.call("poc.openCompInViewer", { name: "PoC Comp" }) });
    await activate();
    await sleep(2500);

    // --- Plan execution ----------------------------------------------------
    let lastSnapshot = await snapshot();
    step("snapshot-initial", {
      items: lastSnapshot.itemNames, layers: lastSnapshot.layerNames,
    });

    for (const [index, op] of plan.entries()) {
      if (aborted !== null || halted !== null) {
        step(`op-${index}-skipped`, { op: op.op, name: op.name ?? null, reason: aborted ?? halted });
        continue;
      }
      // Drift skips only the EVENT-POSTING op being evaluated (pointer/
      // key/auxclear): the per-op topmost gate remains the confusion
      // guard, and foreign AE 2026 instances are short-lived — a permanent
      // abort wasted whole runs when drift cleared seconds later. Observe
      // ops always run, annotated with the drift note.
      const EVENT_OPS = new Set(["drag", "filedrag", "click", "key", "auxclear"]);
      const drift = foreignDrift();
      const driftNote = drift !== null ? { foreignDrift: drift } : {};
      const opname = `${op.op}${op.name ? `:${op.name}` : ""}`;
      if (drift !== null && EVENT_OPS.has(op.op)) {
        step(`op-${index}-skipped-foreign-drift`, { op: opname, reason: drift });
        continue;
      }

      if (op.op === "activate") {
        step(`op-${index}`, { op: opname, ...await activate() });
        await sleep(op.settleMs ?? 800);
      } else if (op.op === "wait-visible") {
        // Poll the census until the owned main window reports onScreen —
        // `open`+frontmost can leave AE on another Space for tens of
        // seconds (measured: needed a second activate). Re-activates each
        // poll so a stuck space-switch self-heals. Times out honestly.
        const timeoutMs = Number(op.timeoutMs ?? 45_000);
        const pollMs = 1500;
        const deadline = Date.now() + timeoutMs;
        let last = null;
        let visible = false;
        while (Date.now() < deadline) {
          await activate();
          await sleep(pollMs);
          const fresh = windowServerCensus(execFileCensusRunner());
          if (fresh.available) {
            const ours = fresh.windows.filter((w) => w.pid === target.pid);
            const main = ours.reduce(
              (a, b) => ((a === null ? -1 : (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0)) >=
                ((b.bounds?.width ?? 0) * (b.bounds?.height ?? 0)) ? a : b), null);
            last = { ownedCount: ours.length, mainOnScreen: main?.onScreen ?? null,
                     mainBounds: main?.bounds ?? null };
            if (main?.onScreen === true) { visible = true; break; }
          }
        }
        step(`op-${index}`, { op: opname, visible, last, waitedMs: timeoutMs - (deadline - Date.now()) });
        if (!visible) aborted = "owned AE window never became onScreen";
      } else if (op.op === "frontmost") {
        // Report who WindowServer/LaunchServices thinks is frontmost.
        let lsapp = null;
        try {
          lsapp = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf-8", timeout: 10_000 }).trim();
        } catch (e) { lsapp = `lsappinfo failed: ${e.message}`; }
        step(`op-${index}`, { op: opname, lsappinfoFront: lsapp });
      } else if (op.op === "sleep") {
        await sleep(Number(op.ms ?? 500));
        step(`op-${index}`, { op: opname, slept: op.ms ?? 500 });
      } else if (op.op === "screenshot") {
        const name = op.name ?? `shot-${index}.png`;
        const res = outDir
          ? screenshot(join(outDir, name))
          : { skipped: "no --out dir" };
        step(`op-${index}`, { op: opname, name, ...res });
      } else if (op.op === "auxclear") {
        await activate();
        await sleep(600);
        await moveAuxDown(String(index));
        step(`op-${index}`, { op: opname, done: true });
      } else if (op.op === "census") {
        const fresh = windowServerCensus(execFileCensusRunner());
        step(`op-${index}`, {
          op: opname,
          available: fresh.available,
          reason: fresh.reason ?? null,
          onScreen: fresh.available
            ? fresh.windows.filter((w) => w.onScreen === true)
                .map((w) => ({
                  pid: w.pid, owner: w.owner, windowNumber: w.windowNumber,
                  bounds: w.bounds, layer: w.layer ?? null,
                }))
            : [],
          // Owned-pid windows regardless of onScreen — distinguishes
          // "AE has no windows" from "AE is on another Space/minimized".
          ownedAll: fresh.available
            ? fresh.windows.filter((w) => w.pid === target.pid)
                .map((w) => ({
                  windowNumber: w.windowNumber, owner: w.owner,
                  bounds: w.bounds, onScreen: w.onScreen, layer: w.layer ?? null,
                }))
            : [],
        });
      } else if (op.op === "axwalk") {
        const name = op.name ?? `ax-${index}.json`;
        const res = spawnSync(axwalkBin, [
          "--pid", String(target.pid),
          "--depth", String(op.depth ?? 14),
          "--max-nodes", String(op.maxNodes ?? 4000),
          ...(op.allWindows ? ["--all-windows"] : []),
        ], { encoding: "utf-8", timeout: 120_000 });
        const rec = {
          op: opname, name, exit: res.status,
          stderr: res.stderr?.trim() || undefined,
        };
        if (res.status === 0 && outDir) {
          writeFileSync(join(outDir, name), res.stdout, "utf-8");
          try {
            const doc = JSON.parse(res.stdout);
            rec.nodeCount = doc.nodes?.length ?? 0;
            rec.roots = doc.roots ?? null;
          } catch { rec.parseError = true; }
        } else if (res.status === 0) {
          rec.stdoutBytes = res.stdout.length;
        }
        step(`op-${index}`, rec);
      } else if (op.op === "readback") {
        const what = op.what ?? "both";
        const items = what !== "layers" ? await ae.call("poc.projectItems", {}) : null;
        const layers = what !== "project" ? await ae.call("poc.compLayers", { name: "PoC Comp" }) : null;
        const snap = await snapshot();
        lastSnapshot = snap;
        step(`op-${index}`, {
          op: opname,
          items: items?.items ?? null,
          layers: layers?.layers ?? null,
          itemNames: snap.itemNames,
          layerNames: snap.layerNames,
        });
      } else if (op.op === "drag" || op.op === "filedrag" || op.op === "click" || op.op === "key") {
        const record = { op: opname, raw: op, ...driftNote };
        // Oracle "before" snapshot.
        let before = null;
        if (op.oracle && op.oracle !== "none") before = await snapshot();

        // Ensure-front retry: the console session is shared, so other apps
        // may hold the visible space. Re-activate until the gated points are
        // provably on our window (or timeout → gate fails honestly).
        if (op.gate !== false && (op.op === "drag" || op.op === "filedrag" || op.op === "click" || op.op === "key")) {
          const deadline = Date.now() + (op.ensureFrontMs ?? 30000);
          let frontOk = false;
          while (Date.now() < deadline) {
            await activate();
            await sleep(1200);
            // Probe: drag/click need `from` or `at`, filedrag needs `to`,
            // key needs focus only (census check is enough).
            const probePts = [];
            if (op.op === "drag" || op.op === "click") {
              if (op.from) probePts.push(parsePoint(op.from));
              if (op.at) probePts.push(parsePoint(op.at));
            }
            if (op.op === "drag" || op.op === "filedrag") {
              if (op.to) probePts.push(parsePoint(op.to));
            }
            if (op.op === "key") { frontOk = true; break; }
            const mainNum = mainWindowNumber();
            frontOk = probePts.length > 0 && probePts.every((pt) => {
              if (pt === null) return false;
              const probe = topmostAt(pt.x, pt.y);
              const top = probe.topmost;
              if (top === null || top.pid !== target.pid) return false;
              if (op.requireMainWindow !== false && mainNum !== null && top.windowNumber !== mainNum) return false;
              return true;
            });
            if (frontOk) break;
          }
          record.ensureFront = frontOk ? "ok" : "timeout";
          await sleep(400);
        }

        // Gate: every event endpoint that lands on the AE window must be
        // provably ours. `drag` gates both endpoints; `filedrag` gates only
        // `to` (its `from` hosts OUR helper window by design); `click`
        // gates `at`; `key` gates nothing (focus is AE's own).
        if (op.gate !== false) {
          const points = [];
          if (op.op === "drag" || op.op === "click") {
            if (op.from) points.push(["from", parsePoint(op.from)]);
            if (op.at) points.push(["at", parsePoint(op.at)]);
          }
          if (op.op === "drag" || op.op === "filedrag") {
            if (op.to) points.push(["to", parsePoint(op.to)]);
          }
          let gateFail = null;
          const topRecords = [];
          for (const [label, pt] of points) {
            if (pt === null) { gateFail = `${label} unparseable`; break; }
            const probe = topmostAt(pt.x, pt.y);
            const top = probe.topmost;
            topRecords.push({ label, point: pt, topmost: top, allMatches: probe.allMatches });
            // For `drag`/`click` the FROM/AT point must be ours too —
            // pressing on a foreign window would mutate it. For AE-internal
            // targets we additionally require the MAIN window (largest
            // owned) to be topmost: an aux panel covering the point would
            // swallow the drag without reaching the intended surface.
            const mustBeOurs = op.op !== "filedrag" || label === "to";
            if (mustBeOurs && (top === null || top.pid !== target.pid)) {
              gateFail = `${label} not owned (topmost=${JSON.stringify(top)})`;
              break;
            }
            if (mustBeOurs && op.requireMainWindow !== false) {
              const mainNum = mainWindowNumber();
              if (mainNum !== null && top.windowNumber !== mainNum) {
                gateFail = `${label} covered by non-main owned window ${top.windowNumber} (main=${mainNum})`;
                break;
              }
            }
          }
          record.gate = { points: topRecords, pass: gateFail === null, fail: gateFail };
          if (gateFail !== null) {
            record.skipped = gateFail;
            step(`op-${index}`, record);
            continue;
          }
        }

        // Aux panels can cover the target: run the aux-clear move-down
        // before gated pointer ops when the plan asks for it.
        if (op.clearAux === true) await moveAuxDown(String(index));

        let argv;
        if (op.op === "drag") {
          argv = ["drag",
            "--from", String(op.from), "--to", String(op.to),
            "--steps", String(op.steps ?? 24),
            "--step-delay-ms", String(op.stepDelayMs ?? 16),
            "--dwell-ms", String(op.dwellMs ?? 0),
            "--tap", op.tap ?? "session"];
        } else if (op.op === "filedrag") {
          argv = ["filedrag",
            "--file", String(op.file ?? fixturePath),
            "--vend", op.vend ?? "fileurl",
            "--from", String(op.from), "--to", String(op.to),
            "--steps", String(op.steps ?? 24),
            "--step-delay-ms", String(op.stepDelayMs ?? 16),
            "--dwell-ms", String(op.dwellMs ?? 0)];
        } else if (op.op === "click") {
          argv = ["click", "--at", String(op.at), "--tap", op.tap ?? "session"];
        } else {
          argv = ["key", "--code", String(op.code), "--flags", op.flags ?? ""];
        }

        await activate();
        await sleep(400);
        const res = spawnSync(dragBin, argv, { encoding: "utf-8", timeout: 120_000 });
        record.argv = argv;
        record.exit = res.status;
        record.stdout = res.stdout?.trim() || undefined;
        record.stderr = res.stderr?.trim() || undefined;
        try { record.receipt = JSON.parse(res.stdout.trim()); } catch { /* not json */ }

        await sleep(Number(op.settleMs ?? 1200) + 800);
        if (op.oracle && op.oracle !== "none") {
          const after = await snapshot();
          lastSnapshot = after;
          record.oracle = diffSnapshot(before, after);
          record.oracleWanted = op.oracle;
          // stopOnOracle: halt the plan once ANY oracle delta is observed,
          // so a later attempt cannot silently undo an earlier success.
          if (op.stopOnOracle === true) {
            const o = record.oracle;
            const hit = o.projectOrderChanged || o.projectCountChanged ||
              o.layerOrderChanged || o.layerCountChanged || o.fixturePresent;
            if (hit) halted = `oracle observed effect at op ${index} (${opname})`;
          }
        }
        step(`op-${index}`, record);
      } else {
        step(`op-${index}`, { op: opname, skipped: "unknown op" });
      }
    }

    if (outDir) {
      const fresh = windowServerCensus(execFileCensusRunner());
      const ours = fresh.available
        ? fresh.windows.filter((w) => w.pid === target.pid && w.onScreen === true && w.bounds !== null)
        : [];
      ours.sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
      step("screenshot-final", screenshot(join(outDir, "drag-alt-final.png")));
      for (const w of ours.slice(0, 12)) {
        if (typeof w.windowNumber !== "number") continue;
        step(`window-capture-${w.windowNumber}`, captureWindow(
          join(outDir, `alt-window-${w.windowNumber}.png`), w.windowNumber));
      }
    }
    evidence.finalSnapshot = {
      items: lastSnapshot.itemNames,
      layers: lastSnapshot.layerNames,
    };
    evidence.aborted = aborted;
    evidence.halted = halted;
    evidence.outcome = aborted !== null ? "aborted-foreign-drift" : (halted !== null ? "halted-oracle" : "completed");
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.errorStack = error instanceof Error ? error.stack : undefined;
  } finally {
    try {
      const closed = await ae.close({ unsavedChanges: "discard" });
      step("close", { closed });
    } catch (error) {
      step("close", { error: error instanceof Error ? error.message : String(error) });
    }
    if (attachPid !== null) {
      // An attached session can never quit its host; this instance was
      // launched by an earlier owned run of this PoC, so leaving it would
      // strand an in-scope AE. SIGTERM first, SIGKILL fallback.
      try {
        process.kill(attachPid, "SIGTERM");
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try { process.kill(attachPid, 0); } catch { break; }
          await new Promise((r) => setTimeout(r, 500));
        }
        try { process.kill(attachPid, 0); process.kill(attachPid, "SIGKILL"); } catch { /* gone */ }
        step("attach-quit", { pid: attachPid, sigterm: true });
      } catch (error) {
        step("attach-quit", { pid: attachPid, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const post = inScopeAEPids(install);
  step("postflight-census", { remainingInScope: post, aeCensus: aeCensus() });
  if (evidence.outcome === "completed" && post.length > 0) {
    evidence.postflightNote =
      "owned AE did not exit cleanly; remaining in-scope pid(s) reported, not killed";
  }
  emit(evidence, options.out);
}

function emit(evidence, out) {
  const json = JSON.stringify(evidence, null, 2);
  if (out !== undefined) writeFileSync(resolve(out), json + "\n", "utf-8");
  console.log(json);
}

await main();
