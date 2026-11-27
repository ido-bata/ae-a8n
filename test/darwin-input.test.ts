/**
 * macOS input helper tests (#372, `specs/ime-input/spec.md` §5–§7).
 *
 * Two layers, both below real delivery:
 *
 *   1. `src/input/darwin.ts` — argv construction, argument validation,
 *      receipt parsing, clipboard stash bookkeeping and the focus/IME
 *      ports, all against a fake exec seam. `automated test` level.
 *   2. The swift helpers themselves — compiled with `swiftc` and run
 *      ONLY through usage-error and read-only paths on darwin. Nothing
 *      here posts a real event: every invocation that could post is
 *      rejected by argument validation before the first CGEvent, which
 *      is exactly what the validation cases assert (exit 2, no post).
 *
 * Real delivery — whether a CGEvent reaches a focused After Effects —
 * is `unverified` by design; that is a separate real-host ticket.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DARWIN_INPUT_HELPERS,
  DarwinInputError,
  darwinClipboardOps,
  darwinFocusOps,
  darwinImeAvailability,
  darwinImeOps,
  darwinInputOps,
  darwinInputPoster,
  type DarwinInputExec,
  type DarwinInputHelper,
} from "../src/input/darwin.js";

const SCRIPT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "isolated-session",
);

// MARK: - fake exec

type Call = { helper: DarwinInputHelper; args: readonly string[] };

function fakeExec(
  handler: (helper: DarwinInputHelper, args: readonly string[]) => {
    status: number;
    stdout: string;
    stderr: string;
  } = () => ({ status: 0, stdout: "{}", stderr: "" }),
): { exec: DarwinInputExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: DarwinInputExec = (helper, args) => {
    calls.push({ helper, args: [...args] });
    return handler(helper, args);
  };
  return { exec, calls };
}

const okJson = (body: string) => ({ status: 0, stdout: body, stderr: "" });

// MARK: - poster argv construction

describe("darwinInputPoster argv construction", () => {
  it("posts key down/up through input-post with the session tap by default", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    poster.keyDown("a", ["cmd", "shift"]);
    poster.keyUp("return");
    expect(calls).toEqual([
      {
        helper: "input-post",
        args: ["key", "down", "--key", "a", "--tap", "session", "--mods", "cmd,shift"],
      },
      { helper: "input-post", args: ["key", "up", "--key", "return", "--tap", "session"] },
    ]);
  });

  it("honours the hid tap option and dedupes modifiers", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec, { tap: "hid" });
    poster.keyDown("left", ["opt", "opt", "ctrl"]);
    expect(calls[0]?.args).toEqual([
      "key",
      "down",
      "--key",
      "left",
      "--tap",
      "hid",
      "--mods",
      "opt,ctrl",
    ]);
  });

  it("routes type-sequential and post-text to the right actions", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    poster.typeSequential!("abc");
    poster.postText!("bulk");
    expect(calls[0]).toEqual({
      helper: "input-post",
      args: ["type", "--text", "abc", "--tap", "session"],
    });
    expect(calls[1]).toEqual({
      helper: "input-post",
      args: ["post-text", "--text", "bulk", "--tap", "session"],
    });
  });

  it("routes clipboard-write and ime-select to their helpers", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    poster.clipboardWrite!("clip");
    poster.imeSelect!("com.example.ime");
    expect(calls[0]).toEqual({
      helper: "input-clipboard",
      args: ["write", "--text", "clip"],
    });
    expect(calls[1]).toEqual({
      helper: "input-source",
      args: ["select", "--mode", "com.example.ime"],
    });
  });

  it("exposes no mouse channel — unimplemented helpers refuse at preflight", () => {
    const { exec } = fakeExec();
    const poster = darwinInputPoster(exec);
    expect("mouse" in poster).toBe(false);
  });
});

// MARK: - argument validation (before any exec)

describe("darwin input argument validation", () => {
  it("rejects empty/whitespace keys and modifiers without calling exec", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    expect(() => poster.keyDown("")).toThrow(DarwinInputError);
    expect(() => poster.keyDown("bad key")).toThrow(DarwinInputError);
    expect(() => poster.keyDown("a", ["not a mod"])).toThrow(DarwinInputError);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty, oversized and control-character text", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    expect(() => poster.typeSequential!("")).toThrow(DarwinInputError);
    expect(() => poster.postText!("x".repeat(100_001))).toThrow(DarwinInputError);
    expect(() => poster.clipboardWrite!("a\nb")).toThrow(DarwinInputError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty ime mode", () => {
    const { exec, calls } = fakeExec();
    const poster = darwinInputPoster(exec);
    expect(() => poster.imeSelect!("")).toThrow(DarwinInputError);
    expect(calls).toHaveLength(0);
  });
});

// MARK: - exec failure propagation

describe("darwin input exec failures", () => {
  it("throws DarwinInputError carrying stderr on non-zero exit", () => {
    const { exec } = fakeExec(() => ({ status: 2, stdout: "", stderr: "usage: nope\n" }));
    const poster = darwinInputPoster(exec);
    try {
      poster.keyDown("a");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DarwinInputError);
      const err = error as DarwinInputError;
      expect(err.helper).toBe("input-post");
      expect(err.exitStatus).toBe(2);
      expect(err.message).toContain("usage: nope");
    }
  });
});

// MARK: - clipboard ops

describe("darwinClipboardOps", () => {
  const SNAPSHOT_JSON = JSON.stringify({
    flavors: ["public.utf8-plain-text"],
    sha256: "deadbeef",
    bytes: 42,
    items: 1,
    unreadable: 0,
  });

  it("snapshots via the helper and returns only the record fields", async () => {
    const { exec, calls } = fakeExec(() => okJson(SNAPSHOT_JSON));
    const dir = mkdtempSync(join(tmpdir(), "a8n-clip-test-"));
    try {
      const ops = darwinClipboardOps(exec, { stashDir: dir });
      const snap = await ops.snapshot();
      expect(snap).toEqual({
        flavors: ["public.utf8-plain-text"],
        sha256: "deadbeef",
        bytes: 42,
      });
      expect(calls[0]?.helper).toBe("input-clipboard");
      expect(calls[0]?.args[0]).toBe("snapshot");
      expect(calls[0]?.args[1]).toBe("--stash");
      expect(String(calls[0]?.args[2])).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores through the stashed path and forgets the digest", async () => {
    const { exec, calls } = fakeExec((_helper, args) =>
      args[0] === "snapshot" ? okJson(SNAPSHOT_JSON) : okJson('{"ok":true,"items":1}'),
    );
    const dir = mkdtempSync(join(tmpdir(), "a8n-clip-test-"));
    try {
      const ops = darwinClipboardOps(exec, { stashDir: dir });
      const snap = await ops.snapshot();
      await ops.restore(snap);
      const restore = calls.find((c) => c.args[0] === "restore");
      expect(restore?.helper).toBe("input-clipboard");
      expect(restore?.args[1]).toBe("--stash");
      // A second restore of the same digest must refuse — the stash was consumed.
      expect(() => ops.restore(snap)).toThrow(DarwinInputError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to restore a snapshot it never took", () => {
    const { exec } = fakeExec();
    const dir = mkdtempSync(join(tmpdir(), "a8n-clip-test-"));
    try {
      const ops = darwinClipboardOps(exec, { stashDir: dir });
      expect(() =>
        ops.restore({ flavors: [], sha256: "unknown", bytes: 0 }),
      ).toThrow(/refusing to restore blind/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// MARK: - IME ops

describe("darwinImeOps", () => {
  it("reads the current mode and restores by re-selecting it", async () => {
    const { exec, calls } = fakeExec((_helper, args) =>
      args[0] === "current"
        ? okJson('{"mode":"com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese"}')
        : okJson('{"ok":true}'),
    );
    const ops = darwinImeOps(exec);
    expect(await ops.currentMode()).toEqual({
      mode: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
    });
    await ops.restore("com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese");
    expect(calls.at(-1)).toEqual({
      helper: "input-source",
      args: ["select", "--mode", "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese"],
    });
  });

  it("reports mode:null honestly and treats restore(null) as a no-op", async () => {
    const { exec, calls } = fakeExec(() => okJson('{"mode":null}'));
    const ops = darwinImeOps(exec);
    expect(await ops.currentMode()).toEqual({ mode: null });
    await ops.restore(null);
    expect(calls).toHaveLength(1); // only the `current` call
  });
});

describe("darwinImeAvailability", () => {
  it("reports available when a Japanese input source is installed", () => {
    const { exec } = fakeExec(() =>
      okJson(
        JSON.stringify({
          sources: [
            { id: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese", name: "Japanese", type: "Keyboard Input Method" },
            { id: "com.apple.keylayout.US", name: "U.S.", type: "Keyboard Layout" },
          ],
        }),
      ),
    );
    expect(darwinImeAvailability(exec).state).toBe("available");
  });

  it("reports unavailable — a valid answer — when none is installed", () => {
    const { exec } = fakeExec(() =>
      okJson(
        JSON.stringify({
          sources: [{ id: "com.apple.keylayout.US", name: "U.S.", type: "Keyboard Layout" }],
        }),
      ),
    );
    const probe = darwinImeAvailability(exec);
    expect(probe.state).toBe("unavailable");
    expect(probe.detail).toContain("no keyboard input methods");
  });
});

// MARK: - focus ops

describe("darwinFocusOps", () => {
  it("parses the focus-holder receipt into a FocusHolder", () => {
    const { exec, calls } = fakeExec(() =>
      okJson(
        JSON.stringify({
          pid: 4242,
          app: "After Effects",
          element: "AXWindow[0]/AXTextField[1]",
          focusedWindowIndex: 0,
          observedAt: "2026-01-01T00:00:00Z",
        }),
      ),
    );
    const ops = darwinFocusOps(exec);
    expect(ops.readFocusHolder()).toEqual({
      pid: 4242,
      element: "AXWindow[0]/AXTextField[1]",
      app: "After Effects",
      observedAt: "2026-01-01T00:00:00Z",
    });
    expect(calls[0]).toEqual({ helper: "input-focus", args: ["read"] });
  });

  it("returns null when the helper cannot name a holder", () => {
    const { exec } = fakeExec(() => okJson('{"pid":null,"reason":"none"}'));
    expect(darwinFocusOps(exec).readFocusHolder()).toBeNull();
  });

  it("requestFocus refuses — readback only in this slice", () => {
    const { exec } = fakeExec();
    const ops = darwinFocusOps(exec);
    expect(() =>
      ops.requestFocus({ pid: 1, element: null }),
    ).toThrow(/not implemented on darwin/);
  });
});

// MARK: - bundle

describe("darwinInputOps", () => {
  it("wires all four ports over one exec", () => {
    const { exec, calls } = fakeExec((helper, args) =>
      helper === "input-focus"
        ? okJson('{"pid":null}')
        : helper === "input-source" && args[0] === "current"
          ? okJson('{"mode":null}')
          : okJson("{}"),
    );
    const ops = darwinInputOps(exec, { stashDir: mkdtempSync(join(tmpdir(), "a8n-ops-")) });
    ops.poster.keyDown("a");
    ops.focus.readFocusHolder();
    expect(calls.map((c) => c.helper)).toEqual(["input-post", "input-focus"]);
  });
});

// MARK: - helper sources and real compile/validation (darwin only)

describe("isolated-session input helpers", () => {
  it("ships all four helpers with their contracts in the header", () => {
    for (const name of DARWIN_INPUT_HELPERS) {
      const source = readFileSync(join(SCRIPT_DIR, `${name}.swift`), "utf-8");
      expect(source).toContain("swiftc");
      expect(source).toContain("exit(2)"); // usage errors before any side effect
    }
    const post = readFileSync(join(SCRIPT_DIR, "input-post.swift"), "utf-8");
    expect(post).toContain("postToPid");
    expect(post).toContain("imePassThrough\\\":\\\"unverified");
    const clipboard = readFileSync(join(SCRIPT_DIR, "input-clipboard.swift"), "utf-8");
    expect(clipboard).toContain("NSPasteboard");
    const source = readFileSync(join(SCRIPT_DIR, "input-source.swift"), "utf-8");
    expect(source).toContain("TISSelectInputSource");
    const focus = readFileSync(join(SCRIPT_DIR, "input-focus.swift"), "utf-8");
    expect(focus).toContain("kAXFocusedUIElementAttribute");
    expect(focus).toContain("kAXFocusedWindowAttribute");
  });

  // Compile + argument-validation on a real macOS toolchain. Every case
  // below is a usage error: the helpers validate ALL arguments before
  // constructing or posting any CGEvent, so exit 2 proves rejection
  // happened pre-post. The read-only subcommands (input-source
  // current/list, input-focus read) are the only ones executed
  // successfully — they mutate nothing.
  it.runIf(process.platform === "darwin")(
    "compiles and rejects invalid arguments without posting",
    () => {
      const buildDir = mkdtempSync(join(tmpdir(), "a8n-input-build-"));
      try {
        const bins = new Map<DarwinInputHelper, string>();
        for (const name of DARWIN_INPUT_HELPERS) {
          const bin = join(buildDir, name);
          execFileSync("swiftc", [join(SCRIPT_DIR, `${name}.swift`), "-o", bin], {
            stdio: "pipe",
          });
          bins.set(name, bin);
        }

        const run = (helper: DarwinInputHelper, args: readonly string[]) =>
          spawnSync(bins.get(helper)!, [...args], { encoding: "utf-8" });

        // Usage errors: non-zero exit, usage on stderr, nothing posted.
        const usageCases: [DarwinInputHelper, string[]][] = [
          ["input-post", []],
          ["input-post", ["key", "press"]],
          ["input-post", ["key", "press", "--key", "not-a-real-key-name"]],
          ["input-post", ["key", "press", "--key", "a", "--mods", "bogus"]],
          ["input-post", ["to-pid", "abc", "key", "press", "--key", "a"]],
          ["input-post", ["type"]],
          ["input-post", ["post-text"]],
          ["input-clipboard", []],
          ["input-clipboard", ["bogus"]],
          ["input-clipboard", ["write"]],
          ["input-source", []],
          ["input-source", ["bogus"]],
          ["input-source", ["select"]],
          ["input-focus", []],
          ["input-focus", ["bogus"]],
          ["input-focus", ["read", "--pid", "abc"]],
        ];
        for (const [helper, args] of usageCases) {
          const result = run(helper, args);
          expect(result.status, `${helper} ${args.join(" ")} should fail usage`).not.toBe(0);
          expect(result.status).toBe(2);
        }

        // Read-only paths produce parseable JSON and mutate nothing.
        const current = run("input-source", ["current"]);
        expect(current.status).toBe(0);
        const currentJson = JSON.parse(current.stdout) as { mode: string | null };
        expect("mode" in currentJson).toBe(true);

        const list = run("input-source", ["list"]);
        expect(list.status).toBe(0);
        const listJson = JSON.parse(list.stdout) as { sources: unknown[] };
        expect(Array.isArray(listJson.sources)).toBe(true);

        const focus = run("input-focus", ["read"]);
        expect(focus.status).toBe(0);
        const focusJson = JSON.parse(focus.stdout) as { pid: number | null };
        expect(focusJson.pid === null || typeof focusJson.pid === "number").toBe(true);
      } finally {
        rmSync(buildDir, { recursive: true, force: true });
      }
    },
    // Four swiftc invocations plus sixteen helper runs; a loaded machine
    // needs real headroom (same reason the osacompile test carries 30s).
    300_000,
  );
});
