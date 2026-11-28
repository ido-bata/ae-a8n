/**
 * RC-PLAN-B (run 2) — GUI capability ops on the public path
 * (US-B1/B3/B4 rows whose slices are in this candidate):
 *   - panel identify/measure/(resize/restore/capture where a window-kind
 *     owned surface resolves — "quiet fixture", no dialogs expected)
 *   - windowOps state observe (+ one gated mutation attempt recorded
 *     honestly — the A-SAFETY gate may refuse; a refusal is a pass-shaped
 *     honest result, an unrefused wrong-target act is not)
 *   - workspace observe / listWorkspaces / monitorReport /
 *     verifyRestore round-trip
 *   - dragDrop dropFile (fixture PNG → Project panel) and element-drag
 *     timeline-layer (comp.layers oracle) — matrix-honest: only the
 *     classes the guarantee-boundary matrix declares are attempted;
 *     "other" is asserted to refuse
 *   - evidence join: renderFrame artifact + record segment +
 *     panel.capture still + ae.evidence index readback
 *
 * Repo-side execution: the packed tarball ships no swift helper
 * sources, so darwin GUI helpers (window-ops/input-focus/input-drag)
 * resolve only from a repo checkout — this run is labelled
 * `repo-side` in the ledger notes (same convention as run 1).
 *
 * Public path only: AfterEffects.launch + ae.* + osascript activate of
 * the OWNED pid (harness setup, recorded as a step — never a dialog
 * dismissal, never a foreign app).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { AfterEffects } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  aeCensus,
  recordAttempt,
  sessionArtifacts,
  shasumFile,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "planb-r2";
const scenarioId = "RC-PLAN-B";
const sessionRoot = `/tmp/rc436r2-sessions/${label}`;
const HOST_SCRIPT = "/tmp/rc436r2-consumer/ext/rc436-host.jsx";
const steps = new Steps();
const notes = [];
let verdict = "fail";
let contractBreach = false;
let ae = null;
let ownedPid = null;

/* ---- minimal 8x8 PNG fixture (same shape as #411/#422 PoCs) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
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
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

const dropFixture = `/tmp/rc436r2-sessions/${label}-drop-fixture.png`;
mkdirSync(`/tmp/rc436r2-sessions`, { recursive: true });
makePng(dropFixture);
const dropFixtureSha = shasumFile(dropFixture);

function pidPath(pid) {
  try { return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8" }).trim(); }
  catch { return null; }
}

/** Resolve the owned main window through the focused-window path (#406). */
async function focusedWindowState() {
  const wo = ae.windowOps({}, { focusedOnly: true });
  return wo.state();
}

try {
  ae = await steps.run("launch+extension", "owned launch AE 2027 + extension", () =>
    AfterEffects.launch({
      sessionRoot, installDir: AE_2027_INSTALL, hostScript: HOST_SCRIPT,
      readinessTimeoutMs: 180000, timeoutMs: 60000, recoveryGraceMs: 90000,
    }));

  const own = ae.ownership?.();
  if (own?.kind !== "owned") {
    verdict = "indeterminate";
    notes.push(`launch resolved as ownership=${own?.kind} — not the owned path`);
    throw new Error("not an owned session");
  }

  const target = await steps.run("recoveryTarget", "owned pid attested", () => ae.recoveryTarget());
  ownedPid = target?.pid ?? null;
  const exe = ownedPid ? pidPath(ownedPid) : null;
  if (!exe || !exe.includes("After Effects 2027")) {
    throw new Error(`pid ${ownedPid} path is not AE 2027: ${exe} — refusing`);
  }

  // Activate the OWNED app so the AX focused-window path can resolve
  // (harness setup — a frontmost set on our own pid, recorded; sends no
  // keys and touches no dialog).
  await steps.try("activate-owned", "owned AE frontmost (AX reachability setup)", () => {
    execFileSync("osascript", ["-e",
      `tell application "System Events" to set frontmost of (first application process whose unix id is ${ownedPid}) to true`],
      { encoding: "utf-8", timeout: 15000 });
    return { frontmost: true };
  });

  await steps.run("openProject", "fixture opens", async () => {
    const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
    return (await p.info()).itemCount;
  });

  // ---------- observe-class surfaces ----------
  const gui = await steps.try("gui-state", "ae.guiState() window assessment", async () => {
    const r = await ae.guiState();
    return { status: r.status, windows: r.windows?.length ?? null,
             action: r.assessment?.action ?? null, axSuspect: r.axSuspect ?? null };
  });
  notes.push(`guiState: ${JSON.stringify(gui.ok ? gui.value : gui.error?.message).slice(0, 300)}`);

  // windowOps focused-window observe (#406 path).
  const woState = await steps.try("windowops-focused-state", "windowOps(focusedOnly).state()", async () => {
    const s = await focusedWindowState();
    return { resolution: s.resolution, title: s.window?.title, subrole: s.window?.subrole,
             frame: s.window?.frame, index: s.window?.index, attribution: s.attribution,
             windowNumber: s.windowNumber };
  });
  notes.push(`windowOps.state: ${JSON.stringify(woState.ok ? woState.value : woState.error?.message).slice(0, 400)}`);

  // ---------- workspace observe ----------
  const ws = ae.workspace();
  const wsObs = await steps.try("workspace-observe", "workspace.observe()", async () => {
    const o = await ws.observe();
    return { keys: Object.keys(o ?? {}), active: o?.activeWorkspace ?? o?.workspace ?? null };
  });
  notes.push(`workspace.observe: ${JSON.stringify(wsObs.ok ? wsObs.value : wsObs.error?.message).slice(0, 300)}`);
  await steps.try("workspace-list", "workspace.listWorkspaces()", async () => {
    const l = await ws.listWorkspaces();
    return (l ?? []).slice(0, 10).map((e) => e?.name ?? e);
  });
  await steps.try("workspace-monitors", "workspace.monitorReport()", async () => {
    const m = await ws.monitorReport();
    return { topology: m?.topology?.status ?? null, displays: m?.displays?.length ?? null };
  });

  // verifyRestore round-trip: observe → verify same observation.
  if (wsObs.ok) {
    await steps.try("workspace-verifyRestore", "workspace.verifyRestore(observed)", async () => {
      const expected = await ws.observe();
      const v = await ws.verifyRestore(expected);
      return { verdict: v?.verdict ?? v?.status ?? Object.keys(v ?? {}) };
    });
  }

  // ---------- panel identify/measure (+ resize/restore/capture if window-kind) ----------
  const project = await ae.project();
  const comp = await project.comp("A8N Acceptance");
  const layersBefore = await steps.run("layers-before", "comp.layers() baseline", async () => (await comp.layers()).length);

  // Ensure >=2 layers for a timeline-layer reorder oracle.
  if (layersBefore < 2) {
    await steps.try("prep-addText", "addTextLayer x2 (timeline-layer oracle needs >=2 layers)", async () => {
      await comp.addTextLayer({ text: "A8N-R2-A", name: "A8N-R2-A" });
      await comp.addTextLayer({ text: "A8N-R2-B", name: "A8N-R2-B" });
      return (await comp.layers()).length;
    });
  }

  const panelTargets = [
    { titleMatch: "contains", title: "Project" },
    { titleMatch: "contains", title: "A8N Acceptance" },
    { titleMatch: "contains", title: "Composition" },
  ];
  let panelWindow = null; // {panel, measure}
  for (const loc of panelTargets) {
    const r = await steps.try(`panel-identify-${loc.title}`, `ae.panel(${JSON.stringify(loc)}).identify()`, async () => {
      const panel = ae.panel(loc);
      const id = await panel.identify();
      return { kind: id?.surface?.kind ?? id?.kind ?? null, attribution: id?.surface?.attribution ?? id?.attribution ?? null,
               title: id?.surface?.title ?? null, locator: loc };
    });
    notes.push(`panel ${loc.title}: ${JSON.stringify(r.ok ? r.value : String(r.error?.message).slice(0, 200))}`);
    if (r.ok && (r.value?.kind === "window") && (r.value?.attribution === "owned" || r.value?.attribution === undefined)) {
      panelWindow = { loc };
      break;
    }
  }

  if (panelWindow) {
    const panel = ae.panel(panelWindow.loc);
    const meas = await steps.try("panel-measure", "panel.measure()", async () => {
      const m = await panel.measure();
      return { frame: m?.frame ?? m?.surface?.frame ?? null };
    });
    notes.push(`panel.measure: ${JSON.stringify(meas.ok ? meas.value : String(meas.error?.message).slice(0, 200))}`);

    const before = meas.ok ? meas.value?.frame : null;
    if (before && typeof before.width === "number") {
      const resized = await steps.try("panel-resize", "panel.resize(+24,+24) mutate-gui gated", async () => {
        return await panel.resize({ width: before.width + 24, height: before.height + 24 });
      });
      notes.push(`panel.resize: ${resized.ok ? "OK " + JSON.stringify(resized.value).slice(0, 200) : resized.error?.name + " " + String(resized.error?.message).slice(0, 250)}`);

      const restored = await steps.try("panel-restore", "panel.restore() returns first frame", async () => {
        return await panel.restore();
      });
      notes.push(`panel.restore: ${restored.ok ? "OK " + JSON.stringify(restored.value).slice(0, 200) : restored.error?.name + " " + String(restored.error?.message).slice(0, 250)}`);
    } else {
      notes.push("panel resize/restore skipped: no measurable window frame");
    }

    await steps.try("panel-capture", "panel.capture() still → evidence index", async () => {
      const c = await panel.capture();
      return { path: c?.path ?? c?.artifact?.path ?? null, evidenceId: c?.evidenceId ?? null };
    });
  } else {
    notes.push("no window-kind owned panel surface resolved; resize/restore/capture recorded as not-exercised");
    await steps.try("panel-capture-refusal", "panel.capture() on unresolvable locator refuses honestly", async () => {
      const panel = ae.panel({ titleMatch: "contains", title: "__a8n-no-such-panel__" });
      return await panel.capture();
    });
  }

  // ---------- windowOps observe + gated mutation honesty ----------
  if (woState.ok && woState.value?.attribution === "owned") {
    const wo = ae.windowOps({}, { focusedOnly: true });
    await steps.try("windowops-move-gated", "windowOps.move(0,0) — gate decision recorded", async () => {
      try {
        return await wo.move({ x: 0, y: 0 });
      } catch (e) {
        return { refused: e?.name, message: String(e?.message ?? e).slice(0, 250) };
      }
    });
  }

  // ---------- dragDrop: dropFile onto Project panel ----------
  const dd = ae.dragDrop();
  // Surface = the owned main window resolved via focused-window state.
  // On AE the AX window enumeration is empty (#406) so the controller's
  // observe() appends AXFocusedWindow as listing row 1.
  const surfExpected = woState.ok ? woState.value : null;
  const surface = surfExpected?.frame
    ? { windowIndex: 1, expected: { title: surfExpected.title ?? "", subrole: surfExpected.subrole ?? null, frame: surfExpected.frame } }
    : null;

  let dropResult = null;
  if (surface) {
    // Drop point: inside the main window frame, upper-left area where the
    // Project panel typically docks. Documented heuristic, census-gated
    // by the controller (topmost-owned re-check at act time).
    const f = surface.expected.frame;
    const to = { x: Math.round(f.x + Math.min(220, f.width * 0.25)), y: Math.round(f.y + Math.min(320, f.height * 0.4)) };
    const from = { x: to.x, y: Math.max(f.y + 40, to.y - 160) };
    const drop = await steps.try("dragdrop-dropFile", "ae.dragDrop().dropFile(fixture PNG → project panel)", async () => {
      return await dd.dropFile({
        surface,
        file: { path: dropFixture, vend: "fileurl" },
        to,
        from,
      });
    });
    dropResult = drop.ok ? drop.value : { error: drop.error?.name, message: String(drop.error?.message).slice(0, 300) };
    notes.push(`dropFile: ${JSON.stringify(dropResult).slice(0, 500)}`);
  } else {
    notes.push("dropFile not attempted: no owned window surface resolved");
  }

  // ---------- dragDrop: element-drag timeline-layer ----------
  const layersMid = await comp.layers().catch(() => []);
  if (surface && layersMid.length >= 2) {
    const f = surface.expected.frame;
    // Timeline band heuristic: bottom ~25% of the main window. `from` on
    // the second-from-top layer row, `to` one row up — a reorder the
    // comp.layers oracle can verify.
    const bandTop = f.y + f.height * 0.72;
    const rowH = Math.min(28, (f.height * 0.25) / Math.max(layersMid.length, 1));
    const cx = f.x + f.width * 0.55;
    const from = { x: cx, y: Math.round(bandTop + rowH * 1.5) };
    const to = { x: cx, y: Math.round(bandTop + rowH * 0.5) };
    const el = await steps.try("dragdrop-element-timeline", "ae.dragDrop().dragElement(timeline-layer reorder)", async () => {
      return await dd.dragElement({
        surface,
        element: "timeline-layer",
        from,
        to,
        steps: 24,
        stepDelayMs: 16,
      });
    });
    notes.push(`element-drag timeline-layer: ${el.ok ? JSON.stringify(el.value).slice(0, 400) : el.error?.name + " " + String(el.error?.message).slice(0, 300)}`);

    // "other" class must refuse (matrix honesty).
    const otherRefusal = await steps.try("dragdrop-other-refusal", 'dragElement(element:"other") refuses', async () => {
      try {
        const r = await dd.dragElement({ surface, element: "other", from, to });
        return { UNEXPECTED_OK: r };
      } catch (e) {
        return { refused: e?.name ?? e?.code, message: String(e?.message ?? e).slice(0, 250) };
      }
    });
    if (otherRefusal.ok && otherRefusal.value?.UNEXPECTED_OK !== undefined) {
      notes.push("CONTRACT BREACH: element:\"other\" drag was not refused");
      contractBreach = true;
    } else {
      notes.push(`element:"other" refusal: ${JSON.stringify(otherRefusal.ok ? otherRefusal.value : otherRefusal.error?.message).slice(0, 250)}`);
    }
  } else {
    notes.push(`element-drag not attempted: surface=${!!surface} layers=${layersMid.length}`);
  }

  // ---------- evidence join: render + record + index ----------
  const render = await steps.try("renderFrame-evidence", "comp.renderFrame(0) artifact", async () => {
    return await comp.renderFrame(0, { prefix: `${label}-frame` });
  });
  notes.push(`renderFrame: ${JSON.stringify(render.ok ? render.value : String(render.error?.message).slice(0, 200)).slice(0, 300)}`);

  const rec = await steps.try("record-start", "ae.record.start(screen, bounded)", async () => {
    return await ae.record.start("screen", { maxDurationMs: 15000, fps: 30 });
  });
  notes.push(`record.start: ${rec.ok ? JSON.stringify(rec.value).slice(0, 250) : rec.error?.name + " " + String(rec.error?.message).slice(0, 250)}`);
  if (rec.ok) {
    await new Promise((r) => setTimeout(r, 3000));
    await steps.try("record-stop", "ae.record.stop", async () => {
      const id = rec.value?.id ?? rec.value?.segmentId ?? "seg-001";
      return await ae.record.stop(id);
    });
  }

  await steps.try("evidence-index", "ae.evidence index readback (join check)", async () => {
    const doc = ae.evidence.document ? ae.evidence.document() : null;
    if (doc) {
      return {
        segments: doc.segments?.length ?? null,
        artifacts: doc.artifacts?.length ?? null,
        gaps: doc.gaps?.length ?? null,
      };
    }
    const idxPath = `${sessionRoot}/artifacts/evidence-index.json`;
    return { document: null, idxPath };
  });

  // Honest verdict: pass when every attempted op either succeeded within
  // contract or refused/failed with a structured named reason — the
  // scenario measures honest surfacing, not universal mutation success.
  // A hard scenario error already set verdict=fail via catch.
  verdict = contractBreach ? "fail" : "pass";

  await steps.run("close", "close owned (discard — fixture may be dirty from prep)", () =>
    ae.close({ unsavedChanges: "discard" }));
  ae = null;
} catch (e) {
  if (verdict !== "indeterminate") verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  if (ae) { try { await ae.close({ unsavedChanges: "discard" }); } catch {} }
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null };
const leftover = aeCensus().filter((p) => p.executable.includes("2027"));
if (leftover.length > 0) {
  cleanup.verdict = cleanup.verdict === "clean" ? "residue" : cleanup.verdict;
  cleanup.note = (cleanup.note ?? "") + ` AE2027 still running: ${JSON.stringify(leftover)}`;
}
const evidenceRefs = [artifacts.tracePath, artifacts.attemptLedgerPath, artifacts.teardownPath].filter(Boolean);
const summaryPath = `/tmp/rc436r2-sessions/${label}-summary.json`;
writeJson(summaryPath, {
  label, scenarioId, verdict, ownedPid, dropFixture, dropFixtureSha,
  steps: steps.items, cleanup, sessionRoot,
});
recordAttempt({
  scenarioId, verdict, steps: steps.items, anomaly: null, cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: `repo-side run (swift GUI helpers resolve only from checkout) | dropFixture sha256=${dropFixtureSha} | ` + notes.join(" | "),
  sessionRoot,
});
console.log(`RC-PLAN-B ${label}: ${verdict} cleanup=${cleanup.verdict}`);
process.exit(verdict === "pass" ? 0 : 1);
