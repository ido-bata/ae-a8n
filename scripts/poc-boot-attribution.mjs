#!/usr/bin/env node
/**
 * Issue #339 T001 PoC: how much OS-level attribution of an After Effects
 * process and its windows is provable BEFORE the first ExtendScript
 * response — and what that looks like while a launch is still waiting on
 * the readiness probe (the startup-modal window).
 *
 * This is a real-host experiment, not a shipped feature. Two modes:
 *
 *   observe (default)  read-only census of the After Effects instances of
 *                      one install: pid + start time + executable (ps),
 *                      login session + bundle id (lsappinfo), and WindowServer
 *                      window attribution (CGWindowList). With `--ax` it also
 *                      takes one Accessibility listing per instance through
 *                      `MacGuiRecovery.listWindows()` — the same read-only
 *                      observation `ae.guiState()` performs. Nothing is sent
 *                      to After Effects: no Apple Event, no DoScript, no
 *                      press, no quit.
 *
 *   launch             the owned-launch half of the PoC. It REFUSES unless
 *                      the target install has zero running instances — an
 *                      install with a live After Effects is somebody's
 *                      session, and this script never attaches to or
 *                      disturbs one it did not start. When the census is
 *                      clear it runs `AfterEffects.launch` with a bounded
 *                      readiness timeout while polling the same attribution
 *                      channels every `--poll-ms`, so the timeline shows
 *                      exactly which proofs existed before the probe
 *                      answered (or timed out). A successful session is
 *                      closed (`close()` quits only a proven-owned host);
 *                      a failed launch is left running and reported, never
 *                      killed.
 *
 * Requires `npm run build` first (the probe drives `dist/`).
 *
 * Usage:
 *   node scripts/poc-boot-attribution.mjs [--install <dir>]... [--ax]
 *       [--out <file>]
 *   node scripts/poc-boot-attribution.mjs --mode launch --install <dir>
 *       --yes-launch [--readiness-timeout-ms 120000] [--window-ms 300000]
 *       [--poll-ms 1000] [--ax] [--out <file>]
 *
 * `<dir>` is an install directory or .app bundle, e.g.
 * "/Applications/Adobe After Effects 2026". With no `--install`, the
 * newest discovered install is used.
 *
 * Outcome is one JSON document on stdout (and `--out` when given).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const distIndex = resolve(here, "..", "dist", "index.js");
const distHostProcesses = resolve(here, "..", "dist", "driver", "host-processes.js");

const api = await import(distIndex);
const { psProcesses, sameProcess } = await import(distHostProcesses);

function fail(message) {
  console.error(`poc-boot-attribution: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    mode: "observe",
    installs: [],
    ax: false,
    out: undefined,
    pollMs: 1000,
    windowMs: 300_000,
    readinessTimeoutMs: 120_000,
    yesLaunch: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--install") options.installs.push(argv[++i]);
    else if (arg === "--ax") options.ax = true;
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++i]);
    else if (arg === "--window-ms") options.windowMs = Number(argv[++i]);
    else if (arg === "--readiness-timeout-ms") options.readinessTimeoutMs = Number(argv[++i]);
    else if (arg === "--yes-launch") options.yesLaunch = true;
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.mode !== "observe" && options.mode !== "launch") {
    fail(`--mode must be observe or launch, got ${JSON.stringify(options.mode)}`);
  }
  for (const key of ["pollMs", "windowMs", "readinessTimeoutMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive number`);
    }
  }
  return options;
}

const startedAtIso = new Date().toISOString();

/** Processes of this install's executable owned by `uid` — the transport's own scope. */
function inScopeProcesses(install, uid) {
  return psProcesses().filter(
    (p) => p.executable === install.executable && (p.uid === undefined || p.uid === uid),
  );
}

/** One WindowServer census for the whole run; windows filtered per pid by callers. */
function censusOnce() {
  return api.windowServerCensus(api.execFileCensusRunner());
}

function censusWindowsFor(census, pid) {
  if (!census.available) return { available: false, reason: census.reason, windows: [] };
  return {
    available: true,
    windows: census.windows
      .filter((w) => w.pid === pid)
      .map((w) => ({
        layer: w.layer,
        onScreen: w.onScreen,
        name: w.name,
        owner: w.owner,
        bounds: w.bounds,
      })),
  };
}

/**
 * One Accessibility listing through the same read-only path supervision
 * uses. `verifyProcess` re-proves pid+start so a recycled pid is never
 * observed as the target. Only called with `--ax`; failures are recorded,
 * never retried silently.
 */
function axObservation(session, proc) {
  try {
    const recovery = new api.MacGuiRecovery({
      session,
      pid: proc.pid,
      verifyProcess: () =>
        psProcesses().some((p) => sameProcess(process.platform, p, proc)),
      allowConsoleSession: true,
      stateRoot: mkdtempSync(join(tmpdir(), "ae-a8n-poc-ax-")),
    });
    const state = recovery.listWindows();
    return {
      ok: true,
      frontmost: state.frontmost,
      axWindowCount: state.windows.length,
      axWindows: state.windows.map((w) => ({
        title: w.title,
        role: w.role,
        subrole: w.subrole,
        blocking: api.isBlockingWindow(w),
        pidAttributed: api.isPidAttributedWindow(w),
      })),
      windowServer: state.windowServer,
      axSuspect: state.axSuspect,
      axUnaccountedWindowCount: state.axUnaccountedWindows.length,
      axForeignWindowCount: state.axForeignWindowCount,
      axUnmatchedWindowCount: state.axUnmatchedWindowCount,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The full attribution record for one in-scope process at one moment. */
function describeInstance(install, proc, uid, session, census, ax) {
  const lsapp = api.listAppInstances().find((a) => a.pid === proc.pid) ?? null;
  return {
    pid: proc.pid,
    startedAt: new Date(proc.startedAt).toISOString(),
    startedAtMs: proc.startedAt,
    executable: proc.executable,
    uid: proc.uid ?? null,
    installExecutable: install.executable,
    lsappinfo: lsapp === null ? null : {
      name: lsapp.name,
      bundleId: lsapp.bundleId ?? null,
      asid: lsapp.asid,
      uid: lsapp.uid,
    },
    session: session === null ? null : {
      uid: session.uid,
      username: session.username,
      asid: session.asid,
      kind: session.kind,
    },
    windowServer: censusWindowsFor(census, proc.pid),
    ...(ax ? { ax: axObservation(session, proc) } : {}),
  };
}

function resolveInstalls(options) {
  if (options.installs.length === 0) {
    return [api.resolveInstall(process.platform, {})];
  }
  return options.installs.map((dir) => api.resolveInstall(process.platform, { installDir: dir }));
}

async function observe(options) {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const session = api.readGuiSession(uid);
  const census = censusOnce();
  const installs = resolveInstalls(options);
  const report = {
    schema: "a8n.poc-boot-attribution/v1",
    mode: "observe",
    recordedAt: startedAtIso,
    host: {
      platform: process.platform,
      arch: process.arch,
      user: userInfo().username,
      uid,
      consoleUid: (() => {
        try {
          return Number(execFileSync("stat", ["-f", "%u", "/dev/console"], { encoding: "utf-8" }).trim());
        } catch {
          return null;
        }
      })(),
      session: session === null ? null : {
        uid: session.uid,
        username: session.username,
        asid: session.asid,
        kind: session.kind,
      },
    },
    installs: installs.map((install) => ({
      executable: install.executable,
      versionName: install.versionName,
      instances: inScopeProcesses(install, uid).map((proc) =>
        describeInstance(install, proc, uid, session, census, options.ax),
      ),
    })),
    windowCensusAvailable: census.available,
    windowCensusReason: census.available ? null : census.reason,
    notes: [
      "observe mode is read-only: ps, lsappinfo, CGWindowList census" +
        (options.ax ? ", and one AX listing per instance" : "") +
        ". No Apple Event or DoScript was sent to any After Effects.",
    ],
  };
  return report;
}

async function launch(options) {
  if (!options.yesLaunch) {
    fail("--mode launch requires --yes-launch: it starts a real After Effects");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const session = api.readGuiSession(uid);
  if (session === null || session.kind !== "Aqua") {
    fail(`no Aqua session for uid ${uid}; an owned GUI launch is impossible here`);
  }
  const install = resolveInstalls(options)[0];
  const preexisting = inScopeProcesses(install, uid);
  if (preexisting.length > 0) {
    // Fail closed, exactly like the transport: a live instance of this
    // install belongs to someone else's session. Attaching to it is not
    // this PoC's business.
    const report = {
      schema: "a8n.poc-boot-attribution/v1",
      mode: "launch",
      recordedAt: startedAtIso,
      outcome: "refused",
      reason:
        `${preexisting.length} in-scope instance(s) of ${install.executable} already ` +
        "running; an owned launch would attach to them, which this PoC never does",
      preexisting: preexisting.map((p) => ({ pid: p.pid, startedAt: new Date(p.startedAt).toISOString() })),
    };
    return report;
  }

  const sessionRoot = mkdtempSync(join(tmpdir(), "ae-a8n-poc-339-"));
  const transport = new api.ScriptInvocationTransport({ install });
  const samples = [];
  let settled = null;
  const t0 = Date.now();
  const launchPromise = api.AfterEffects.launch({
    transport,
    sessionRoot,
    readinessTimeoutMs: options.readinessTimeoutMs,
    timeoutMs: options.readinessTimeoutMs,
  }).then(
    (ae) => ({ ok: true, ae }),
    (error) => ({ ok: false, error }),
  );

  const pollDeadline = t0 + options.windowMs;
  while (settled === null || Date.now() < pollDeadline) {
    const now = Date.now();
    const census = censusOnce();
    const scoped = inScopeProcesses(install, uid);
    const pending = transport.pendingLaunch();
    samples.push({
      t: now - t0,
      scopedPids: scoped.map((p) => p.pid),
      pendingLaunch: pending === null ? null : {
        pid: pending.pid,
        startedAt: pending.startedAt === null ? null : new Date(pending.startedAt).toISOString(),
        presentAtLastLookup: pending.presentAtLastLookup,
        session: pending.session,
      },
      hostState: transport.hostState(),
      hostPid: transport.hostPid(),
      windows: scoped.map((p) => ({
        pid: p.pid,
        census: censusWindowsFor(census, p.pid),
      })),
      censusAvailable: census.available,
    });
    settled = await Promise.race([launchPromise, sleep(options.pollMs).then(() => null)]);
    if (settled !== null) {
      // One final sample after settlement, then stop.
      const census2 = censusOnce();
      const scoped2 = inScopeProcesses(install, uid);
      samples.push({
        t: Date.now() - t0,
        settled: true,
        scopedPids: scoped2.map((p) => p.pid),
        hostState: transport.hostState(),
        hostPid: transport.hostPid(),
        windows: scoped2.map((p) => ({ pid: p.pid, census: censusWindowsFor(census2, p.pid) })),
        censusAvailable: census2.available,
      });
      break;
    }
    if (now >= pollDeadline) break;
  }

  const outcome = settled === null
    ? { ok: false, error: "poll window elapsed before the launch settled" }
    : settled.ok
      ? {
          ok: true,
          probe: {
            info: settled.ae.info(),
            version: await settled.ae.version().catch((e) => `unreadable: ${e}`),
          },
        }
      : {
          ok: false,
          errorName: settled.error?.name ?? "Error",
          errorCode: settled.error?.code ?? null,
          errorMessage: settled.error instanceof Error ? settled.error.message : String(settled.error),
        };

  // Post-settle attribution of whatever the launch left behind.
  const census = censusOnce();
  const finalInstances = inScopeProcesses(install, uid).map((proc) =>
    describeInstance(install, proc, uid, session, census, options.ax),
  );

  let closeResult = null;
  if (settled?.ok === true) {
    try {
      closeResult = await settled.ae.close({ unsavedChanges: "discard" });
    } catch (error) {
      closeResult = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    schema: "a8n.poc-boot-attribution/v1",
    mode: "launch",
    recordedAt: startedAtIso,
    install: { executable: install.executable, versionName: install.versionName },
    sessionRoot,
    outcome,
    samples,
    finalInstances,
    closeResult,
    notes: [
      "launch mode only runs when the install census is empty; it never attaches to a foreign instance.",
      "A failed launch is reported and left running — this script never kills or quits an unproven process.",
    ],
  };
}

const options = parseArgs(process.argv.slice(2));
const report = options.mode === "launch" ? await launch(options) : await observe(options);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.out !== undefined) {
  writeFileSync(resolve(options.out), json, "utf-8");
}
process.stdout.write(json);
