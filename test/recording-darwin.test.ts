/**
 * macOS recording backend tests (#382, `specs/gui-evidence/spec.md`
 * §5.2/§5.4/§6.1/§11; E2b of #346).
 *
 * Two layers, both below real capture:
 *
 *   1. `src/evidence/recording-darwin.ts` — tier selection, argv
 *      construction, receipt parsing, `actualScope`/`unhonoredExclusions`
 *      honesty, container probe and pid enumeration, all against fake
 *      spawn/lister/kill seams. `automated test` level.
 *   2. `scripts/isolated-session/screen-record.swift` itself — compiled
 *      with `swiftc` on darwin and exercised ONLY through usage-error
 *      paths (exit 2 before any ScreenCaptureKit object exists). No
 *      test here starts an `SCStream`, requests TCC permission, or
 *      records a single frame.
 *
 * Whether SCStream delivers frames under `runInSession`, TCC prompt
 * behavior in isolated sessions, achievable fps and `.mov`
 * finalize-on-signal are ALL `unverified` — real-host verification is a
 * later lane (spec §10).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MacSession } from "../src/driver/mac-session.js";
import type { PanelTarget } from "../src/panels/types.js";
import type { CaptureScope } from "../src/evidence/types.js";
import {
  darwinRecorderResolver,
  darwinScreenRecorder,
  ensureScreenRecordHelper,
  probeMovFile,
  type DarwinProcessLister,
  type DarwinScreenRecorderOptions,
  type DarwinSpawn,
  type DarwinSpawnedProcess,
} from "../src/evidence/recording-darwin.js";
import type { RecorderStartRequest } from "../src/evidence/recording.js";

const SCRIPT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "isolated-session",
);
const HELPER_SOURCE = join(SCRIPT_DIR, "screen-record.swift");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recording-darwin-"));
  mkdirSync(join(root, "artifacts", "recordings"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SESSION: MacSession = {
  uid: 501,
  username: "isolated",
  asid: 7,
  kind: "Aqua",
};

const PANEL: PanelTarget = {
  pid: 4242,
  resolvedAt: "2026-01-01T00:00:00.000Z",
  surface: {
    kind: "window",
    windowIndex: 1,
    windowNumber: 77,
    locator: { windowNumber: 77 },
    frame: { x: 10, y: 20, width: 300, height: 200 },
    state: { onScreen: true, occluded: "unknown" },
    attribution: "owned",
  },
};

const WINDOW_SCOPE: CaptureScope = { kind: "window", window: PANEL };
const REGION_SCOPE: CaptureScope = {
  kind: "region",
  frame: { x: 5, y: 6, width: 100, height: 50 },
  parent: PANEL,
};
const DISPLAY_SCOPE: CaptureScope = { kind: "display", displayId: "2" };
const SESSION_SCOPE: CaptureScope = { kind: "session", sessionKind: "isolated" };

function request(
  scope: CaptureScope,
  overrides: Partial<RecorderStartRequest> = {},
): RecorderStartRequest {
  return {
    segmentId: "seg-001",
    scope,
    filePath: join(root, "artifacts", "recordings", "seg-001.mov"),
    maxDurationMs: 5_000,
    ...overrides,
  };
}

type SpawnCall = { command: string; args: readonly string[] };

type FakeProcOptions = {
  readonly pid?: number | null;
  /**
   * True when the process is already dead before any wait — the
   * SCStream start-poll's `hasExited()` fast-fail path.
   */
  readonly deadOnArrival?: boolean;
  /**
   * `waitExit` resolves `exited:false` for this many calls first, then
   * `exited:true` — models "alive until SIGTERM, exits on the stop wait".
   */
  readonly exitAfterWaits?: number;
  readonly exitCode?: number | null;
  readonly stderr?: string;
  /** Runs once inside the first waitExit call (e.g. write a final receipt). */
  readonly onWaitExit?: () => void;
};

function fakeProc(options: FakeProcOptions = {}): DarwinSpawnedProcess {
  let waits = 0;
  let waited = false;
  const deadOnArrival = options.deadOnArrival ?? false;
  const exitAfter = options.exitAfterWaits ?? 0;
  return {
    pid: options.pid === undefined ? 4321 : options.pid,
    hasExited: () => deadOnArrival,
    stderrText: () => options.stderr ?? "",
    waitExit: () => {
      waits += 1;
      if (!waited) {
        waited = true;
        options.onWaitExit?.();
      }
      const exited = deadOnArrival || waits > exitAfter;
      return Promise.resolve({
        exited,
        code: exited ? (options.exitCode ?? 0) : null,
        signal: null,
      });
    },
  };
}

/**
 * A spawn seam that records argv and — for the SCStream helper — writes
 * the JSON receipt the helper would write, parsed out of `--receipt`.
 */
function fakeSpawn(
  handler: (call: SpawnCall) => {
    proc?: DarwinSpawnedProcess;
    receipt?: Record<string, unknown>;
    stderr?: string;
  } = () => ({}),
): { spawn: DarwinSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: DarwinSpawn = (command, args) => {
    const call = { command, args };
    calls.push(call);
    const scripted = handler(call);
    const receiptPath = args[args.indexOf("--receipt") + 1];
    if (
      scripted.receipt !== undefined &&
      typeof receiptPath === "string" &&
      receiptPath.length > 0
    ) {
      writeFileSync(receiptPath, JSON.stringify(scripted.receipt));
    }
    return (
      scripted.proc ?? fakeProc({ pid: 4321, exitAfterWaits: 1 })
    );
  };
  return { spawn, calls };
}

function fakeRunSession(
  status = 0,
): {
  runSession: NonNullable<DarwinScreenRecorderOptions["runSession"]>;
  kills: { command: string; args: readonly string[] }[];
} {
  const kills: { command: string; args: readonly string[] }[] = [];
  return {
    kills,
    runSession: (_session, command, args) => {
      kills.push({ command, args });
      return { status, stdout: "", stderr: "", timedOut: false };
    },
  };
}

function fakeLister(
  rows: readonly { pid: number; command: string }[] | null,
): DarwinProcessLister {
  return () => Promise.resolve(rows);
}

function options(
  overrides: Partial<DarwinScreenRecorderOptions> = {},
): DarwinScreenRecorderOptions {
  return {
    session: () => SESSION,
    artifactsDir: join(root, "artifacts"),
    sleep: () => Promise.resolve(),
    stopGraceMs: 10,
    fallbackStartDelayMs: 5,
    ...overrides,
  };
}

/** An executable placeholder the `helperPath` check accepts. */
function fakeHelper(): string {
  const path = join(root, "screen-record-fake");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/* ------------------------------------------------------------------ */
/* ensureScreenRecordHelper                                            */
/* ------------------------------------------------------------------ */

describe("ensureScreenRecordHelper", () => {
  it("accepts a prebuilt executable helperPath", async () => {
    const helperPath = fakeHelper();
    await expect(
      ensureScreenRecordHelper({ helperPath }),
    ).resolves.toEqual({ path: helperPath });
  });

  // Windows has no executable bit — X_OK degenerates to existence, so
  // the refusal is only meaningful on POSIX.
  it.runIf(process.platform !== "win32")(
    "refuses a helperPath that is not executable",
    async () => {
      const path = join(root, "not-exec");
      writeFileSync(path, "nope");
      const result = await ensureScreenRecordHelper({ helperPath: path });
      expect("error" in result).toBe(true);
    },
  );

  it("reports an error when the swift source is absent", async () => {
    const result = await ensureScreenRecordHelper({
      helperSourcePath: join(root, "missing.swift"),
      helperBuildDir: join(root, "build"),
    });
    expect("error" in result).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* SCStream tier — argv and receipts                                   */
/* ------------------------------------------------------------------ */

describe("darwinScreenRecorder SCStream tier", () => {
  function sckitOptions(
    spawn: DarwinSpawn,
    extra: Partial<DarwinScreenRecorderOptions> = {},
  ): DarwinScreenRecorderOptions {
    return options({
      tier: "sckit",
      helperPath: fakeHelper(),
      spawn,
      ...extra,
    });
  }

  const recordingReceipt = {
    status: "recording",
    pid: 4321,
    delivered: "window",
    framesReceived: 0,
  };

  it("maps a window scope to --scope window --window-id", async () => {
    const helper = fakeHelper();
    const { spawn, calls } = fakeSpawn(() => ({
      proc: fakeProc({ pid: 4321 }),
      receipt: recordingReceipt,
    }));
    const recorder = darwinScreenRecorder(
      sckitOptions(spawn, { helperPath: helper }),
    );
    const req = request(WINDOW_SCOPE, { fps: 30 });
    const result = await recorder.start(req);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(calls[0]!.command).toBe(helper);
    expect(args).toContain("--scope");
    expect(args[args.indexOf("--scope") + 1]).toBe("window");
    expect(args[args.indexOf("--window-id") + 1]).toBe("77");
    expect(args).toContain("--out");
    expect(args[args.indexOf("--out") + 1]).toBe(req.filePath);
    expect(args[args.indexOf("--receipt") + 1]).toBe(`${req.filePath}.receipt.json`);
    expect(args[args.indexOf("--max-duration-ms") + 1]).toBe("5000");
    expect(args[args.indexOf("--fps") + 1]).toBe("30");
    expect(result.handle).toEqual({ pid: 4321, filePath: req.filePath });
    expect(result.actualScope?.kind).toBe("window");
    expect(recorder.tool).toBe("screen-record.swift");
  });

  it("degrades a window scope without a window number to a region capture", async () => {
    const noNumber: PanelTarget = {
      ...PANEL,
      surface: { ...PANEL.surface, windowNumber: null },
    };
    const { spawn, calls } = fakeSpawn(() => ({
      receipt: { ...recordingReceipt, delivered: "region" },
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    const result = await recorder.start(
      request({ kind: "window", window: noNumber }),
    );
    const args = calls[0]!.args;
    expect(args[args.indexOf("--scope") + 1]).toBe("region");
    expect(args[args.indexOf("--rect") + 1]).toBe("10,20,300,200");
    // The delivered scope is reported, not assumed: window ask → region delivery.
    expect(result.actualScope?.kind).toBe("region");
  });

  it("maps a region scope to --scope region --rect", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      receipt: { ...recordingReceipt, delivered: "region" },
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    const result = await recorder.start(request(REGION_SCOPE));
    const args = calls[0]!.args;
    expect(args[args.indexOf("--scope") + 1]).toBe("region");
    expect(args[args.indexOf("--rect") + 1]).toBe("5,6,100,50");
    expect(result.actualScope?.kind).toBe("region");
  });

  it("maps a display scope and forwards a numeric display id", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      receipt: { ...recordingReceipt, delivered: "display" },
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    const result = await recorder.start(request(DISPLAY_SCOPE));
    const args = calls[0]!.args;
    expect(args[args.indexOf("--scope") + 1]).toBe("display");
    expect(args[args.indexOf("--display-id") + 1]).toBe("2");
    expect(result.actualScope).toEqual({ kind: "display", displayId: "2" });
  });

  it("reports actualScope display when the helper delivers wider than asked", async () => {
    const { spawn } = fakeSpawn(() => ({
      receipt: { ...recordingReceipt, delivered: "display" },
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    const result = await recorder.start(request(WINDOW_SCOPE));
    expect(result.actualScope).toEqual({ kind: "display" });
  });

  it("fails fast when the helper reports a failed receipt", async () => {
    const { spawn } = fakeSpawn(() => ({
      receipt: { status: "failed", reason: "no display found" },
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    await expect(recorder.start(request(DISPLAY_SCOPE))).rejects.toThrow(
      /no display found/,
    );
  });

  it("fails fast when the helper exits before reporting", async () => {
    const { spawn } = fakeSpawn(() => ({
      proc: fakeProc({ deadOnArrival: true, stderr: "boom" }),
    }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    await expect(recorder.start(request(DISPLAY_SCOPE))).rejects.toThrow(
      /exited before recording started: boom/,
    );
  });

  it("refuses to start without an attested session — before any spawn", async () => {
    const { spawn, calls } = fakeSpawn();
    const recorder = darwinScreenRecorder(
      sckitOptions(spawn, { session: () => null }),
    );
    await expect(recorder.start(request(DISPLAY_SCOPE))).rejects.toThrow(
      /no attested target session/,
    );
    expect(calls).toHaveLength(0);
  });

  it("records exclusions as unhonored on the SCStream tier", async () => {
    const { spawn } = fakeSpawn(() => ({ receipt: recordingReceipt }));
    const recorder = darwinScreenRecorder(sckitOptions(spawn));
    const result = await recorder.start(
      request(DISPLAY_SCOPE, {
        exclude: [{ kind: "window", predicate: "com.example.Secret" }],
      }),
    );
    expect(result.unhonoredExclusions).toHaveLength(1);
    expect(result.unhonoredExclusions?.[0]).toContain("com.example.Secret");
  });
});

/* ------------------------------------------------------------------ */
/* screencapture -V fallback tier                                      */
/* ------------------------------------------------------------------ */

describe("darwinScreenRecorder screencapture fallback tier", () => {
  const FALLBACK = "/fake/screencapture";

  function fallbackOptions(
    spawn: DarwinSpawn,
    extra: Partial<DarwinScreenRecorderOptions> = {},
  ): DarwinScreenRecorderOptions {
    return options({
      tier: "screencapture",
      screencapturePath: FALLBACK,
      spawn,
      ...extra,
    });
  }

  it("runs screencapture -V<ceil seconds> and reports display actualScope", async () => {
    const { spawn, calls } = fakeSpawn();
    const recorder = darwinScreenRecorder(fallbackOptions(spawn));
    const req = request({ kind: "display" }, { maxDurationMs: 4_500 });
    const result = await recorder.start(req);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(FALLBACK);
    expect(calls[0]!.args).toEqual(["-x", "-V5", req.filePath]);
    expect(result.actualScope).toEqual({ kind: "display" });
    expect(result.unhonoredExclusions).toEqual([]);
    expect(recorder.tool).toBe("screencapture");
  });

  it("serves a window ask as whole-display and says so", async () => {
    const { spawn } = fakeSpawn();
    const recorder = darwinScreenRecorder(fallbackOptions(spawn));
    const result = await recorder.start(request(WINDOW_SCOPE));
    expect(result.actualScope).toEqual({ kind: "display" });
    expect(
      result.unhonoredExclusions?.some((u) => u.includes("window scope")),
    ).toBe(true);
  });

  it("flags a display-id ask the fallback cannot honor", async () => {
    const { spawn } = fakeSpawn();
    const recorder = darwinScreenRecorder(fallbackOptions(spawn));
    const result = await recorder.start(request(DISPLAY_SCOPE));
    expect(
      result.unhonoredExclusions?.some((u) => u.includes("display-id:2")),
    ).toBe(true);
  });

  it("routes session scopes to the fallback even when sckit is forced", async () => {
    const { spawn, calls } = fakeSpawn();
    const recorder = darwinScreenRecorder(
      fallbackOptions(spawn, { tier: "sckit", helperPath: fakeHelper() }),
    );
    // session scope + forced sckit → still screencapture (single display filter).
    const result = await recorder.start(request(SESSION_SCOPE));
    expect(calls[0]!.command).toBe(FALLBACK);
    expect(result.actualScope).toEqual({ kind: "display" });
    expect(
      result.unhonoredExclusions?.some((u) => u.includes("session scope")),
    ).toBe(true);
  });

  it("auto tier falls back when the helper cannot be compiled", async () => {
    const { spawn, calls } = fakeSpawn();
    const recorder = darwinScreenRecorder(
      options({
        spawn,
        screencapturePath: FALLBACK,
        helperSourcePath: join(root, "missing.swift"),
        helperBuildDir: join(root, "build"),
      }),
    );
    const result = await recorder.start(request(REGION_SCOPE));
    expect(calls[0]!.command).toBe(FALLBACK);
    expect(result.actualScope).toEqual({ kind: "display" });
    expect(recorder.tool).toBe("screencapture");
  });

  it("forced sckit refuses when the helper is unavailable", async () => {
    const { spawn, calls } = fakeSpawn();
    const recorder = darwinScreenRecorder(
      options({
        tier: "sckit",
        spawn,
        screencapturePath: FALLBACK,
        helperSourcePath: join(root, "missing.swift"),
        helperBuildDir: join(root, "build"),
      }),
    );
    await expect(recorder.start(request(DISPLAY_SCOPE))).rejects.toThrow(
      /SCStream recorder requested but the helper is unavailable/,
    );
    expect(calls).toHaveLength(0);
  });

  it("fails fast when screencapture exits immediately", async () => {
    const { spawn } = fakeSpawn(() => ({
      proc: fakeProc({ deadOnArrival: true, stderr: "no screen" }),
    }));
    const recorder = darwinScreenRecorder(fallbackOptions(spawn));
    await expect(recorder.start(request(DISPLAY_SCOPE))).rejects.toThrow(
      /screencapture -V exited immediately: no screen/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* stop / probe / residue                                              */
/* ------------------------------------------------------------------ */

describe("darwinScreenRecorder stop, probe and residue", () => {
  it("SIGTERMs the helper in-session and reads final stats from the receipt", async () => {
    const req = request(DISPLAY_SCOPE);
    const receiptPath = `${req.filePath}.receipt.json`;
    const { spawn } = fakeSpawn(() => ({
      receipt: {
        status: "recording",
        pid: 4321,
        delivered: "display",
        framesReceived: 60,
        durationSec: 2,
        encodeCpuFraction: 0.25,
      },
      proc: fakeProc({
        pid: 4321,
        onWaitExit: () => {
          // The helper rewrites the receipt on finalize.
          writeFileSync(
            receiptPath,
            JSON.stringify({
              status: "stopped",
              pid: 4321,
              delivered: "display",
              framesReceived: 60,
              durationSec: 2,
              encodeCpuFraction: 0.25,
            }),
          );
        },
      }),
    }));
    const { runSession, kills } = fakeRunSession();
    const recorder = darwinScreenRecorder(
      options({
        tier: "sckit",
        helperPath: fakeHelper(),
        spawn,
        runSession,
      }),
    );
    const started = await recorder.start(req);
    const stopped = await recorder.stop(started.handle);

    expect(stopped.exited).toBe(true);
    expect(kills).toEqual([
      { command: "/bin/kill", args: ["-TERM", "4321"] },
    ]);

    // A structurally valid .mov with ftyp/moov/mdat → playable + stats.
    const mov = Buffer.alloc(256);
    mov.write("ftyp", 4);
    mov.write("moov", 40);
    mov.write("mdat", 80);
    writeFileSync(req.filePath, mov);
    const probe = await recorder.probe(req.filePath);
    expect(probe.exists).toBe(true);
    expect(probe.playable).toBe(true);
    expect(probe.stats).toEqual({
      achievedFps: 30,
      droppedFrames: null,
      encodeCpu: 0.25,
    });
  });

  it("reports an unplayable file honestly when atoms are missing", async () => {
    const probe = await probeMovFile(join(root, "missing.mov"));
    expect(probe.exists).toBe(false);
    expect(probe.playable).toBe(false);

    const partial = join(root, "partial.mov");
    const buf = Buffer.alloc(64);
    buf.write("ftyp", 4); // ftyp but no moov/mdat
    writeFileSync(partial, buf);
    const probe2 = await probeMovFile(partial);
    expect(probe2.exists).toBe(true);
    expect(probe2.playable).toBe(false);
    expect(probe2.detail).toContain("unfinalized");
  });

  it("enumerates only provably-ours recorder pids", async () => {
    const helper = fakeHelper();
    const artifacts = join(root, "artifacts");
    const lister = fakeLister([
      { pid: 6101, command: `${helper} record --out /x.mov` },
      {
        pid: 6102,
        command: `/usr/sbin/screencapture -x -V5 ${artifacts}/recordings/seg-001.mov`,
      },
      { pid: 6103, command: "some other process" },
      { pid: process.pid, command: `${helper} record --out self.mov` },
    ]);
    const recorder = darwinScreenRecorder(
      options({
        tier: "sckit",
        helperPath: helper,
        artifactsDir: artifacts,
        listProcesses: lister,
      }),
    );
    const pids = await recorder.listPids!();
    expect(pids).not.toBeNull();
    expect([...(pids ?? [])].sort()).toEqual([6101, 6102]);
  });

  it("reports null pids when enumeration is impossible", async () => {
    const recorder = darwinScreenRecorder(
      options({ tier: "screencapture", listProcesses: fakeLister(null) }),
    );
    expect(await recorder.listPids!()).toBeNull();
  });

  it("terminate signals the pid through the in-session kill seam", async () => {
    const { runSession, kills } = fakeRunSession();
    const recorder = darwinScreenRecorder(
      options({ runSession, session: () => SESSION }),
    );
    expect(await recorder.terminate!(777)).toBe(true);
    expect(kills).toEqual([{ command: "/bin/kill", args: ["-TERM", "777"] }]);
  });
});

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

describe("darwinRecorderResolver", () => {
  it.runIf(process.platform === "darwin")(
    "returns a resolver on darwin",
    () => {
      const resolver = darwinRecorderResolver(options());
      expect(resolver).not.toBeNull();
      const recorder = resolver!({ kind: "display" });
      expect(recorder).not.toBeNull();
      expect(recorder!.fileExtension).toBe(".mov");
    },
  );
});

/* ------------------------------------------------------------------ */
/* The swift helper itself — compile + usage errors only (darwin)      */
/* ------------------------------------------------------------------ */

describe("screen-record.swift helper", () => {
  it("ships a bounded-lifetime SCStream recorder contract in the header", () => {
    const source = execFileSync("cat", [HELPER_SOURCE], { encoding: "utf-8" });
    expect(source).toContain("swiftc");
    expect(source).toContain("exit(2)");
    expect(source).toContain("SCStream");
    expect(source).toContain("AVAssetWriter");
    expect(source).toContain("maxDurationMs");
  });

  // Compile + argument validation on a real macOS toolchain. Every case
  // below is a usage error: the helper validates ALL arguments before
  // constructing any SCStream/AVAssetWriter, so exit 2 proves rejection
  // happened pre-capture. No invocation here starts a recording.
  it.runIf(process.platform === "darwin")(
    "compiles and rejects invalid arguments before capturing",
    () => {
      const buildDir = mkdtempSync(join(tmpdir(), "a8n-screen-record-build-"));
      try {
        const bin = join(buildDir, "screen-record");
        execFileSync(
          "swiftc",
          ["-O", HELPER_SOURCE, "-o", bin],
          { stdio: "pipe" },
        );
        const run = (args: readonly string[]) =>
          spawnSync(bin, [...args], { encoding: "utf-8" });

        const usageCases: string[][] = [
          [],
          ["bogus"],
          ["record"], // missing --out/--receipt/--max-duration-ms/--scope
          ["record", "--scope", "bogus"],
          ["record", "--scope", "window", "--out", "/tmp/x.mov",
           "--receipt", "/tmp/x.json", "--max-duration-ms", "1000"], // no --window-id
          ["record", "--scope", "region", "--out", "/tmp/x.mov",
           "--receipt", "/tmp/x.json", "--max-duration-ms", "1000"], // no --rect
          ["record", "--scope", "display", "--out", "/tmp/x.mov",
           "--receipt", "/tmp/x.json", "--max-duration-ms", "abc"],
          ["record", "--scope", "display", "--out", "/tmp/x.mov",
           "--receipt", "/tmp/x.json", "--max-duration-ms", "1000",
           "--fps", "999"],
          ["record", "--scope", "display", "--out", "/tmp/x.mov",
           "--receipt", "/tmp/x.json", "--max-duration-ms", "1000",
           "--bogus", "1"],
        ];
        for (const args of usageCases) {
          const result = run(args);
          expect(
            result.status,
            `screen-record ${args.join(" ")} should fail usage`,
          ).toBe(2);
        }
      } finally {
        rmSync(buildDir, { recursive: true, force: true });
      }
    },
    // One swiftc invocation plus nine helper runs; same headroom reason
    // as the input-helper compile test.
    300_000,
  );
});
