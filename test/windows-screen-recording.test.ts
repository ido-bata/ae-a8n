/**
 * Windows screen-recording backend — `ScreenRecorder` seam coverage
 * for #384 (`specs/gui-evidence/spec.md` §6.2, E3).
 *
 * Level: `automated test` — the spawn seam, NDJSON verdicts, scope
 * mapping, mp4 probe and ffmpeg fallback are all driven by fakes. The
 * embedded PowerShell+C# WGC helper itself has NEVER compiled or run —
 * no Windows host exists in this repo's evidence — so nothing here
 * claims the helper works; it claims the backend reports honestly.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecorderStartRequest } from "../src/evidence/recording.js";
import type { CaptureScope } from "../src/evidence/types.js";
import type { PanelTarget } from "../src/panels/types.js";
import {
  WindowsScreenRecorder,
  windowsScreenRecorderResolver,
  type WindowsRecorderChild,
  type WindowsRecorderSpawn,
} from "../src/platform/windows/recording.js";
import { windowsWgcHelperScript } from "../src/platform/windows/record-script.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-winrec-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ---------------- fake child process ---------------- */

class FakeChild extends EventEmitter implements WindowsRecorderChild {
  readonly pid: number | null;
  readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly stdinWrites: string[] = [];
  readonly stdin = {
    write: (chunk: string, cb?: () => void) => {
      this.stdinWrites.push(chunk);
      cb?.();
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  killed = false;

  constructor(pid: number | null = 4321) {
    super();
    this.pid = pid;
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.on("exit", (code: number | null, signal: string | null) =>
      listener(code, signal),
    );
  }

  onError(listener: (error: Error) => void): void {
    this.on("error", listener);
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }

  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

type SpawnCall = { program: string; args: readonly string[] };
type OnSpawn = (child: FakeChild, index: number) => void;

/**
 * Fake spawn. Scripted child output is emitted on the tick AFTER spawn
 * returns — the backend attaches its stdout/exit listeners synchronously
 * in the same call, so a `setImmediate` here can never race them (the
 * helper `.ps1` write is async, but spawn itself is the sync point).
 */
function fakeSpawn(
  children: FakeChild[],
  calls: SpawnCall[],
  onSpawn?: OnSpawn,
): WindowsRecorderSpawn {
  return (program, args) => {
    calls.push({ program, args: [...args] });
    const child = children.shift();
    if (child === undefined) {
      throw new Error("fake spawn exhausted");
    }
    const index = calls.length - 1;
    setImmediate(() => onSpawn?.(child, index));
    return child;
  };
}

/* ---------------- scopes ---------------- */

const PANEL: PanelTarget = {
  pid: 4242,
  resolvedAt: "2026-01-01T00:00:00.000Z",
  surface: {
    kind: "window",
    windowIndex: 1,
    windowNumber: 0x1a2b,
    locator: { windowNumber: 0x1a2b },
    frame: { x: 0, y: 0, width: 100, height: 100 },
    state: { onScreen: true, occluded: "unknown" },
    attribution: "owned",
  },
};

function request(
  scope: CaptureScope,
  filePath: string,
  overrides: Partial<RecorderStartRequest> = {},
): RecorderStartRequest {
  return {
    segmentId: "seg-001",
    scope,
    filePath,
    maxDurationMs: 5_000,
    ...overrides,
  };
}

function recorderWith(
  spawnProcess: WindowsRecorderSpawn,
  options: ConstructorParameters<typeof WindowsScreenRecorder>[0] = {},
): WindowsScreenRecorder {
  return new WindowsScreenRecorder({
    helperDir: root,
    spawnProcess,
    startTimeoutMs: 2_000,
    stopGraceMs: 200,
    ...options,
  });
}

/* ---------------- tests ---------------- */

describe("windowsWgcHelperScript", () => {
  it("is a static parameter-driven script (no caller interpolation)", () => {
    const script = windowsWgcHelperScript();
    expect(script).toContain("param(");
    expect(script).toContain("Windows.Graphics.Capture");
    expect(script).toContain("IMFSinkWriter");
    expect(script).toContain("GraphicsCaptureItemInterop");
    // The Win10 1903 floor and honest unsupported verdicts are present.
    expect(script).toContain("18362");
    expect(script).toContain("window-not-capturable");
  });
});

describe("WindowsScreenRecorder scope mapping", () => {
  it("refuses region scope through the resolver (no vehicle)", () => {
    const resolver = windowsScreenRecorderResolver({ helperDir: root });
    const region: CaptureScope = {
      kind: "region",
      frame: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(resolver(region)).toBeNull();
    expect(resolver({ kind: "session", sessionKind: "isolated" })).not.toBeNull();
    expect(resolver({ kind: "display" })).not.toBeNull();
    expect(resolver({ kind: "window", window: PANEL })).not.toBeNull();
  });

  it("maps window scope to WGC HWND mode with the surface window number", async () => {
    const child = new FakeChild();
    const calls: SpawnCall[] = [];
    const recorder = recorderWith(
      fakeSpawn([child], calls, (c) =>
        c.emitStdout('{"type":"recording","mode":"window","width":100,"height":100,"fps":30}\n'),
      ),
    );
    const filePath = join(root, "seg-001.mp4");
    const started = await recorder.start(
      request({ kind: "window", window: PANEL }, filePath),
    );
    expect(started.handle.pid).toBe(4321);
    expect(started.actualScope).toBeUndefined();
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-Mode") + 1]).toBe("window");
    expect(args[args.indexOf("-Hwnd") + 1]).toBe(String(0x1a2b));
    expect(args[args.indexOf("-Output") + 1]).toBe(filePath);
    expect(args[args.indexOf("-MaxDurationMs") + 1]).toBe("5000");
    // Helper-side bounded lifetime is always passed through.
    expect(args).toContain("-StopFile");
  });

  it("refuses window scope without an HWND — no display substitution", async () => {
    const recorder = recorderWith(fakeSpawn([], []));
    const noHwnd: PanelTarget = {
      ...PANEL,
      surface: { ...PANEL.surface, windowNumber: null },
    };
    await expect(
      recorder.start(request({ kind: "window", window: noHwnd }, join(root, "a.mp4"))),
    ).rejects.toThrow(/window number|HWND/);
  });

  it("maps session scope to the primary monitor and reports actualScope display", async () => {
    const child = new FakeChild();
    const calls: SpawnCall[] = [];
    const recorder = recorderWith(
      fakeSpawn([child], calls, (c) =>
        c.emitStdout('{"type":"recording","mode":"monitor"}\n'),
      ),
    );
    const started = await recorder.start(
      request({ kind: "session", sessionKind: "isolated" }, join(root, "s.mp4")),
    );
    expect(started.actualScope).toEqual({ kind: "display" });
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-Mode") + 1]).toBe("monitor");
    expect(args[args.indexOf("-MonitorIndex") + 1]).toBe("-1");
  });

  it("maps display scope displayId to a monitor index", async () => {
    const child = new FakeChild();
    const calls: SpawnCall[] = [];
    const recorder = recorderWith(
      fakeSpawn([child], calls, (c) =>
        c.emitStdout('{"type":"recording","mode":"monitor"}\n'),
      ),
    );
    await recorder.start(
      request({ kind: "display", displayId: "2" }, join(root, "d.mp4")),
    );
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-MonitorIndex") + 1]).toBe("2");
  });

  it("rejects a non-numeric displayId", async () => {
    const recorder = recorderWith(fakeSpawn([], []));
    await expect(
      recorder.start(
        request({ kind: "display", displayId: "main" }, join(root, "d.mp4")),
      ),
    ).rejects.toThrow(/monitor index/);
  });

  it("reports every exclusion as unhonored (WGC cannot exclude)", async () => {
    const child = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) =>
        c.emitStdout('{"type":"recording","mode":"monitor"}\n'),
      ),
    );
    const started = await recorder.start(
      request({ kind: "display" }, join(root, "e.mp4"), {
        exclude: [{ kind: "window", predicate: "hwnd:99" }],
      }),
    );
    expect(started.unhonoredExclusions).toHaveLength(1);
    expect(started.unhonoredExclusions?.[0]).toContain("window");
  });
});

describe("WindowsScreenRecorder WGC verdicts", () => {
  it("surfaces a window-not-capturable error verdict as a thrown refusal", async () => {
    const child = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) => {
        c.emitStdout(
          '{"type":"error","code":"window-not-capturable","message":"protected content"}\n',
        );
        c.exit(3);
      }),
    );
    await expect(
      recorder.start(request({ kind: "window", window: PANEL }, join(root, "w.mp4"))),
    ).rejects.toThrow(/protected content/);
    expect(child.killed).toBe(true);
  });

  it("surfaces unsupported (pre-1903 / missing winmd) as a thrown refusal", async () => {
    const child = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) => {
        c.emitStdout('{"type":"error","code":"unsupported","message":"build too old"}\n');
        c.exit(2);
      }),
    );
    await expect(
      recorder.start(
        request({ kind: "session", sessionKind: "isolated" }, join(root, "u.mp4")),
      ),
    ).rejects.toThrow(/build too old/);
  });

  it("fails closed when the helper exits without a verdict", async () => {
    const child = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) => c.exit(1)),
    );
    await expect(
      recorder.start(request({ kind: "display" }, join(root, "x.mp4"))),
    ).rejects.toThrow(/exited before reporting/);
  });
});

describe("WindowsScreenRecorder stop/probe", () => {
  function minimalMp4WithMoov(): Buffer {
    // ftyp box + free box + moov box — enough for the box walker.
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(24, 0);
    buf.write("ftyp", 4, "latin1");
    buf.writeUInt32BE(8, 24);
    buf.write("free", 28, "latin1");
    buf.writeUInt32BE(8, 32);
    buf.write("moov", 36, "latin1");
    return buf;
  }

  it("stop touches the stop file, waits for exit and reports stats on probe", async () => {
    const child = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) =>
        c.emitStdout('{"type":"recording","mode":"monitor"}\n'),
      ),
    );
    const filePath = join(root, "seg.mp4");
    const started = await recorder.start(request({ kind: "display" }, filePath));

    writeFileSync(filePath, minimalMp4WithMoov());
    const stopPromise = recorder.stop(started.handle);
    // The helper finalizes then emits its stopped verdict and exits.
    setImmediate(() => {
      child.emitStdout('{"type":"stopped","frames":150,"elapsedMs":5000,"stopReason":"requested"}\n');
      child.exit(0);
    });
    const stopped = await stopPromise;
    expect(stopped.exited).toBe(true);
    expect(stopped.exitCode).toBe(0);
    expect(existsSync(`${filePath}.stop`)).toBe(false);

    const probe = await recorder.probe(filePath);
    expect(probe.exists).toBe(true);
    expect(probe.playable).toBe(true);
    expect(probe.stats?.achievedFps).toBeCloseTo(30, 5);
  });

  it("probe reports unplayable when moov is absent (killed encoder)", async () => {
    const recorder = recorderWith(fakeSpawn([], []));
    const filePath = join(root, "dead.mp4");
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(64, 0);
    buf.write("mdat", 4, "latin1"); // mdat to EOF, no moov
    writeFileSync(filePath, buf);
    const probe = await recorder.probe(filePath);
    expect(probe.playable).toBe(false);
    expect(probe.detail).toContain("moov");
  });

  it("probe reports missing file honestly", async () => {
    const recorder = recorderWith(fakeSpawn([], []));
    const probe = await recorder.probe(join(root, "nope.mp4"));
    expect(probe.exists).toBe(false);
    expect(probe.playable).toBe(false);
  });

  it("listPids/terminate track live children for residue accounting", async () => {
    const child = new FakeChild(777);
    const recorder = recorderWith(
      fakeSpawn([child], [], (c) =>
        c.emitStdout('{"type":"recording","mode":"monitor"}\n'),
      ),
    );
    await recorder.start(request({ kind: "display" }, join(root, "p.mp4")));
    expect(await recorder.listPids()).toEqual([777]);
    expect(await recorder.terminate(777)).toBe(true);
    expect(child.killed).toBe(true);
  });
});

describe("WindowsScreenRecorder ffmpeg fallback", () => {
  it("is not used unless declared", async () => {
    const wgc = new FakeChild();
    const calls: SpawnCall[] = [];
    const recorder = recorderWith(
      fakeSpawn([wgc], calls, (c) => {
        c.emitStdout('{"type":"error","code":"unsupported","message":"no winmd"}\n');
        c.exit(2);
      }),
      {
        ffmpegFallback: false,
        probeFfmpegVersion: () => Promise.resolve("7.0"),
      },
    );
    await expect(
      recorder.start(
        request({ kind: "session", sessionKind: "isolated" }, join(root, "f.mp4")),
      ),
    ).rejects.toThrow(/no winmd/);
    // Only the powershell spawn happened — no ffmpeg attempt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.program).toBe("powershell.exe");
  });

  it("falls back to ffmpeg for session scope on environment failure, recording tool+version", async () => {
    const wgc = new FakeChild(111);
    const ff = new FakeChild(222);
    const calls: SpawnCall[] = [];
    const filePath = join(root, "fb.mp4");
    const recorder = recorderWith(
      fakeSpawn([wgc, ff], calls, (c, index) => {
        if (index === 0) {
          c.emitStdout('{"type":"error","code":"compile-failed","message":"csc missing"}\n');
          c.exit(2);
        } else {
          // ffmpeg "starts" once it has written a playable-looking file.
          setImmediate(() => {
            const minimal = Buffer.alloc(64);
            minimal.writeUInt32BE(24, 0);
            minimal.write("ftyp", 4, "latin1");
            minimal.writeUInt32BE(8, 32);
            minimal.write("moov", 36, "latin1");
            writeFileSync(filePath, minimal);
          });
        }
      }),
      {
        ffmpegFallback: true,
        probeFfmpegVersion: () => Promise.resolve("7.1.1"),
      },
    );
    const started = await recorder.start(
      request({ kind: "session", sessionKind: "isolated" }, filePath),
    );
    expect(started.tool).toBe("ffmpeg");
    expect(started.toolVersion).toBe("7.1.1");
    expect(calls[1]?.program).toBe("ffmpeg");
    expect(calls[1]?.args).toContain("gdigrab");
    expect(calls[1]?.args).toContain("desktop");
    // Audio is contractually off.
    expect(calls[1]?.args).toContain("-an");

    // stop writes 'q' to stdin for a graceful finalize.
    const stopPromise = recorder.stop(started.handle);
    setImmediate(() => ff.exit(0));
    const stopped = await stopPromise;
    expect(stopped.exited).toBe(true);
    expect(ff.stdinWrites).toContain("q");
  });

  it("never falls back for window scope — even an environment failure stays a refusal", async () => {
    const wgc = new FakeChild();
    const calls: SpawnCall[] = [];
    const recorder = recorderWith(
      fakeSpawn([wgc], calls, (c) => {
        c.emitStdout('{"type":"error","code":"unsupported","message":"no WGC"}\n');
        c.exit(2);
      }),
      {
        ffmpegFallback: true,
        probeFfmpegVersion: () => Promise.resolve("7.1"),
      },
    );
    await expect(
      recorder.start(
        request({ kind: "window", window: PANEL }, join(root, "wn.mp4")),
      ),
    ).rejects.toThrow(/no WGC/);
    // gdigrab cannot honor an HWND scope — one spawn, no substitution.
    expect(calls).toHaveLength(1);
  });

  it("reports unavailable when ffmpeg is declared but not installed", async () => {
    const wgc = new FakeChild();
    const recorder = recorderWith(
      fakeSpawn([wgc], [], (c) => {
        c.emitStdout('{"type":"error","code":"unsupported","message":"old OS"}\n');
        c.exit(2);
      }),
      {
        ffmpegFallback: true,
        probeFfmpegVersion: () => Promise.reject(new Error("ENOENT")),
      },
    );
    await expect(
      recorder.start(
        request({ kind: "session", sessionKind: "isolated" }, join(root, "nf.mp4")),
      ),
    ).rejects.toThrow(/ffmpeg fallback is not installed/);
  });
});
