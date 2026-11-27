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
import { execFileSync } from "node:child_process";
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
    probe: false,
    settleMs: 1200,
    steps: 24,
    stepDelayMs: 16,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--install") options.install = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--from") options.from = argv[++i];
    else if (arg === "--to") options.to = argv[++i];
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--settle-ms") options.settleMs = Number(argv[++i]);
    else if (arg === "--steps") options.steps = Number(argv[++i]);
    else if (arg === "--step-delay-ms") options.stepDelayMs = Number(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.install === undefined) {
    fail("--install <dir> is required (this PoC never guesses an install)");
  }
  if (!["file", "drag"].includes(options.mode)) {
    fail("--mode expects file or drag");
  }
  if (!options.probe) {
    for (const key of ["from", "to"]) {
      const v = options[key];
      if (typeof v !== "string" || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(v)) {
        fail(`--${key} X,Y is required unless --probe`);
      }
    }
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    fail("--settle-ms must be a non-negative number");
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

  const artifactDir = outDir ? join(outDir, "drag-artifacts") : join(workdir, "artifacts");

  const ae = await AfterEffects.launch({
    installDir: options.install,
    hostScript,
    timeoutMs: 300_000,
    readinessTimeoutMs: 240_000,
  });
  step("launch", { pid: ae.recoveryTarget()?.pid ?? null, info: ae.info() });

  try {
    const target = ae.recoveryTarget();
    if (target === null) {
      evidence.outcome = "failed";
      evidence.reason = "recoveryTarget() is null; no owned pid/session attested";
      emit(evidence, options.out);
      return;
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
    } else {
      step("screenshot-before", { skipped: "no --out dir" });
    }

    if (options.probe) {
      evidence.outcome = "probe-complete";
    } else {
      const from = parsePoint(options.from);
      const to = parsePoint(options.to);
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
        const stdout = execFileSync(dragBin, dragArgs, {
          encoding: "utf-8",
          timeout: 120_000,
        });
        dragResult = { ok: true, receipt: JSON.parse(stdout.trim()) };
      } catch (error) {
        dragResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stdout: error && typeof error === "object" && "stdout" in error
            ? String(error.stdout) : undefined,
          stderr: error && typeof error === "object" && "stderr" in error
            ? String(error.stderr) : undefined,
        };
      }
      step("drag", { args: dragArgs, result: dragResult });
      await new Promise((r) => setTimeout(r, options.settleMs + 1500));

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
      const beforeItems = itemsBefore && Array.isArray(itemsBefore.items)
        ? itemsBefore.items : [];
      const landed = afterItems.some(
        (it) => it.name === "a8n-poc-fixture.png" ||
               it.name === "a8n-poc-fixture" ||
               (typeof it.name === "string" && it.name.includes("a8n-poc-fixture")),
      );
      const beforeNames = new Set(beforeItems.map((it) => it.name));
      const newItems = afterItems.filter((it) => !beforeNames.has(it.name));
      evidence.observations = {
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
      const closed = await ae.close();
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
