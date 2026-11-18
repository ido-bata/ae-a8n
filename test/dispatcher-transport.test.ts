/**
 * Contract tests for the opt-in in-AE dispatcher transport (#127).
 *
 * Two peers are exercised, both fake:
 *
 * - `DispatcherTransport` itself, against hand-written channel files — the
 *   Node side of the contract (prepare, privacy, bridging, one-in-flight,
 *   never-resend).
 * - The *real* `host/a8n-host.js` dispatcher mode, evaluated by the in-repo
 *   ES3 runtime against `FakeApplication` — claim/validate/publish, stale
 *   and duplicate requests, double activation — with the tick driven by
 *   hand, exactly where `app.scheduleTask` would fire it.
 *
 * Nothing here touches a real After Effects: every result is `fake/mock
 * only` evidence.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as acorn from "acorn";

import { AfterEffects, HostNotOwnedError } from "../src/index.js";
import { ExtensionMethodNotFoundError } from "../src/api/index.js";
import { buildHostScript } from "../src/extensions/manifest.js";
import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import {
  DispatcherTransport,
  DISPATCHER_TRANSPORT_KIND,
  aeScriptsVersion,
  aeVersionParts,
  defaultDispatcherChannelDir,
  dispatcherStartupDir,
} from "../src/driver/dispatcher-transport.js";
import { writeBootstrapScript } from "../src/driver/bootstrap.js";
import { ScriptNotSentError } from "../src/driver/transport.js";
import { buildCapabilityHandshake } from "../src/api/capabilities.js";
import {
  createSessionPaths,
  nextRequestId,
  probeResult,
  writeRequest,
} from "../src/protocol/workspace.js";
import type { RequestEnvelope } from "../src/protocol/envelope.js";
import { TraceRecorder } from "../src/trace/trace.js";
import { runHostScript } from "../src/testing/fake-ae/es3-runtime.js";
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
} from "../src/testing/fake-ae/object-model.js";

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function channelDir(): string {
  return tmpDir("a8n-dispatcher-channel-");
}

function sessionRoot(): string {
  return tmpDir("a8n-dispatcher-session-");
}

function makeTransport(dir: string, extra: Record<string, unknown> = {}): DispatcherTransport {
  return new DispatcherTransport({
    channelDir: dir,
    pumpIntervalMs: 10,
    lateResultMs: 10_000,
    ...extra,
  });
}

function channelToken(dir: string): string {
  const meta = JSON.parse(readFileSync(join(dir, "channel.json"), "utf-8")) as { token: string };
  return meta.token;
}

/* ------------------------------------------- fake AE peer (real host code) */

type FakePeer = {
  readonly app: FakeApplication;
  readonly engineGlobal: Record<string, unknown>;
  /** The script context global — where `__a8n` and its extension table live. */
  readonly globals: Record<string, unknown>;
  readonly tick: () => void;
};

/**
 * Runs the generated `activate.jsx` against the fake AE engine, exactly as
 * File > Scripts > Run Script File would. Returns the tick the scheduler
 * would call; tests fire it by hand.
 */
function activateFakeDispatcher(
  dir: string,
  version = "26.0.0",
): { peer: FakePeer; outcome: ReturnType<typeof runHostScript> } {
  const app = new FakeApplication();
  app.version = version;
  if (app.project.numItems === 0) {
    app.project.load(createDefaultComp(), null);
  }
  const engineGlobal: Record<string, unknown> = {};
  const outcome = runHostScript(join(dir, "activate.jsx"), createFakeGlobals(app), {
    engineGlobal,
  });
  const tick = engineGlobal["__a8nDispatcherTick"];
  return {
    peer: {
      app,
      engineGlobal,
      globals: outcome.globals,
      tick: typeof tick === "function" ? (tick as () => void) : () => {},
    },
    outcome,
  };
}

function writeChannelRequest(
  dir: string,
  request: Record<string, unknown>,
  options: { readonly mtime?: Date; readonly name?: string } = {},
): string {
  const id = typeof request["id"] === "string" ? request["id"] : nextRequestId();
  const name = options.name ?? `${id}.request.json`;
  const path = join(dir, "inbox", name);
  writeFileSync(path, JSON.stringify({ ...request, id }), { mode: 0o600 });
  if (options.mtime !== undefined) {
    utimesSync(path, options.mtime, options.mtime);
  }
  return path;
}

function validRequest(dir: string, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: nextRequestId(),
    token: channelToken(dir),
    method,
    params,
    timeoutMs: 30_000,
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  // nothing shared between tests; each builds its own dirs
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("channel preparation", () => {
  it("creates a private channel with token, assets and an ES3 activation script", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();

    expect((await transport.available()) === false).toBe(true); // prepared but silent
    if (process.platform !== "win32") {
      // POSIX privacy is mode bits; on Windows the same property is the
      // icacls ACL verdict, exercised for real by every prepare() here.
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(dir, "inbox"))).toBe(true);
    expect(existsSync(join(dir, "outbox"))).toBe(true);
    expect(existsSync(join(dir, "a8n-host.js"))).toBe(true);
    expect(existsSync(join(dir, "a8n-json.js"))).toBe(true);

    const activate = readFileSync(transport.activateScriptPath, "utf-8");
    expect(() => acorn.parse(activate, { ecmaVersion: 3 })).not.toThrow();
    expect(activate).toContain("dispatcher");
    expect(activate).toContain("a8n-host.js");
    // The token is embedded so the dispatcher can authenticate requests.
    expect(activate).toContain(channelToken(dir));

    // Idempotent: a second prepare keeps the same token.
    await transport.prepare();
    expect(channelToken(dir)).toMatch(/^[a-f0-9]{64}$/);
  });

  // POSIX mode bits have no Windows meaning; there the ACL verdict decides,
  // and windows-acl.test.ts covers the verdict itself.
  it.skipIf(process.platform === "win32")(
    "refuses a channel directory accessible to group/other",
    async () => {
      const dir = channelDir();
      chmodSync(dir, 0o777);
      const transport = makeTransport(dir);
      await expect(transport.prepare()).rejects.toThrow(/accessible to group\/other/);
    },
  );

  it("refuses a symlinked channel directory", async () => {
    const real = channelDir();
    const link = join(tmpDir("a8n-dispatcher-link-"), "link");
    symlinkSync(real, link, "dir");
    const transport = makeTransport(link);
    await expect(transport.prepare()).rejects.toThrow(/symlink/);
  });
});

describe("dispatcher host script (real ES3, fake AE)", () => {
  it("activates once, refuses a second dispatcher, and answers app.info", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();

    const { peer, outcome } = activateFakeDispatcher(dir);
    expect(outcome.success, outcome.success ? "" : outcome.error.message).toBe(true);
    expect(peer.app.scheduledTasks).toHaveLength(1);
    expect(peer.app.scheduledTasks[0]?.repeat).toBe(true);
    expect(peer.engineGlobal["__a8nDispatcherTask"]).toBeDefined();

    // state.json heartbeat exists straight after activation.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as {
      token: string;
      instance: string;
      aeVersion: string;
    };
    expect(state.token).toBe(channelToken(dir));
    expect(state.aeVersion).toBe("26.0.0");

    // A second activation in the same AE is refused.
    const second = runHostScript(join(dir, "activate.jsx"), createFakeGlobals(peer.app), {
      engineGlobal: peer.engineGlobal,
    });
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.message).toMatch(/already active/);
    }

    // A valid request round-trips through the real dispatch table.
    const request = validRequest(dir, "app.info");
    const requestId = String(request["id"]);
    writeChannelRequest(dir, request);
    peer.tick();
    const resultPath = join(dir, "outbox", `${requestId}.result.json`);
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      v: number;
      id: string;
      ok: boolean;
      result?: { version?: string };
    };
    expect(result.ok).toBe(true);
    expect(result.id).toBe(request["id"]);
    expect(result.result?.version).toBe("26.0.0");
    // Claimed request file is gone: it can never be replayed.
    expect(readdirSync(join(dir, "inbox")).filter((n) => n.includes(".request.json"))).toHaveLength(0);
    expect(readdirSync(join(dir, "inbox")).filter((n) => n.endsWith(".claimed"))).toHaveLength(0);
  });

  it("refuses stale, duplicate-id, bad-token and unknown-method requests without executing them", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { peer, outcome } = activateFakeDispatcher(dir);
    expect(outcome.success).toBe(true);

    const before = peer.app.project.numItems;

    // Stale: deadline long past — must be refused, never executed.
    const stale = validRequest(dir, "project.createComp", {
      name: "StaleComp",
      width: 16,
      height: 16,
      duration: 1,
      frameRate: 24,
    });
    stale["timeoutMs"] = 1_000;
    const staleId = stale["id"] as string;
    writeChannelRequest(dir, stale, { mtime: new Date(Date.now() - 60_000) });

    // Id mismatch: file name and envelope id disagree.
    const mismatch = validRequest(dir, "project.createComp", {
      name: "MismatchComp",
      width: 16,
      height: 16,
      duration: 1,
      frameRate: 24,
    });
    const mismatchFileId = nextRequestId();
    writeChannelRequest(dir, mismatch, { name: `${mismatchFileId}.request.json` });

    // Wrong token.
    const badToken = validRequest(dir, "project.createComp", {
      name: "TokenComp",
      width: 16,
      height: 16,
      duration: 1,
      frameRate: 24,
    });
    badToken["token"] = "0".repeat(64);
    const badTokenId = badToken["id"] as string;
    writeChannelRequest(dir, badToken);

    // Unknown method.
    const unknown = validRequest(dir, "bogus.method");
    const unknownId = unknown["id"] as string;
    writeChannelRequest(dir, unknown);

    // One request per tick: fire until the inbox drains.
    for (let i = 0; i < 8; i++) {
      peer.tick();
    }

    const read = (id: string) =>
      JSON.parse(readFileSync(join(dir, "outbox", `${id}.result.json`), "utf-8")) as {
        ok: boolean;
        error?: { name?: string; message?: string };
      };

    const staleResult = read(staleId);
    expect(staleResult.ok).toBe(false);
    expect(staleResult.error?.name).toBe("StaleRequestError");

    const mismatchResult = read(mismatchFileId);
    expect(mismatchResult.ok).toBe(false);
    expect(mismatchResult.error?.name).toBe("RequestRefusedError");

    const tokenResult = read(badTokenId);
    expect(tokenResult.ok).toBe(false);
    expect(tokenResult.error?.name).toBe("RequestRefusedError");

    const unknownResult = read(unknownId);
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.error?.message).toMatch(/unknown method/);

    // Nothing executed: no comp was created.
    expect(peer.app.project.numItems).toBe(before);
  });
});

describe("Node-side transport contract", () => {
  function stagedCall(session: string, method = "app.info"): { entry: string; id: string } {
    const paths = createSessionPaths(session);
    const id = nextRequestId();
    const request: RequestEnvelope = { v: 1, id, method, params: {}, timeoutMs: 5_000 };
    writeRequest(paths, request);
    const entry = join(session, "staging", `${id}.entry.jsx`);
    writeBootstrapScript({
      entryPath: entry,
      hostScriptPath: join(session, "host.js"),
      requestPath: join(paths.inbox, `${id}.request.json`),
      resultPath: join(paths.outbox, `${id}.result.json`),
      id,
    });
    return { entry, id };
  }

  it("bridges a fake responder's result into the session outbox", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { entry, id } = stagedCall(session);

    await transport.invoke(entry);
    // The request reached the channel with the token injected.
    const channelRequest = JSON.parse(
      readFileSync(join(dir, "inbox", `${id}.request.json`), "utf-8"),
    ) as Record<string, unknown>;
    expect(channelRequest["token"]).toBe(channelToken(dir));
    expect(channelRequest["method"]).toBe("app.info");

    // Fake responder: answer directly in the channel outbox.
    writeFileSync(
      join(dir, "outbox", `${id}.result.json`),
      JSON.stringify({ v: 1, id, ok: true, durationMs: 3, result: { version: "26.0.0" } }),
    );
    await waitFor(
      () => existsSync(join(session, "outbox", `${id}.result.json`)),
      "bridged result",
    );
    const probe = probeResult(createSessionPaths(session), id);
    expect(probe.state).toBe("read");
  });

  it("refuses a second invoke while one is in flight", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const first = stagedCall(session);
    const second = stagedCall(session);

    await transport.invoke(first.entry);
    await expect(transport.invoke(second.entry)).rejects.toBeInstanceOf(ScriptNotSentError);
    // The refused request never reached the channel.
    expect(readdirSync(join(dir, "inbox")).filter((n) => n.endsWith(".request.json"))).toHaveLength(1);
    await transport.close();
  });

  it("ignores a result that does not name the pending request", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { entry, id } = stagedCall(session);
    await transport.invoke(entry);

    // A foreign result for a different id must not be delivered.
    writeFileSync(
      join(dir, "outbox", `${nextRequestId()}.result.json`),
      JSON.stringify({ v: 1, id: nextRequestId(), ok: true, durationMs: 1, result: null }),
    );
    writeFileSync(
      join(dir, "outbox", `${id}.result.json`),
      JSON.stringify({ v: 1, id: "not-the-request", ok: true, durationMs: 1, result: null }),
    );
    await sleep(120);
    expect(existsSync(join(session, "outbox", `${id}.result.json`))).toBe(false);
    await transport.close();
  });
});

describe("driver integration: timeout is UNKNOWN and never resent", () => {
  it("times out without a dispatcher and leaves exactly one unclaimed request", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    // No dispatcher was activated: prepare only.
    await transport.prepare();
    // launch() must refuse while the heartbeat is absent.
    await expect(transport.launch()).rejects.toThrow(/no dispatcher is answering/);

    // Drive a call anyway through the driver to observe the timeout path.
    const trace = new TraceRecorder({ file: join(session, "trace.jsonl") });
    const driver = new AeDriver({ transport, sessionRoot: session, trace });
    const call = driver.call("app.info", {}, { timeoutMs: 300 }).then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(
      () => readdirSync(join(dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "channel request",
    );
    const error = await call;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).hostCondition).toBe("unknown");

    // Exactly one request file, still unclaimed, still present: no resend.
    const inbox = readdirSync(join(dir, "inbox")).filter((n) => n.endsWith(".request.json"));
    expect(inbox).toHaveLength(1);
    await transport.close();
  });

  it("runs a full driver session against the fake-AE dispatcher", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { peer } = activateFakeDispatcher(dir);
    expect(peer.app.scheduledTasks.length).toBeGreaterThan(0);

    const trace = new TraceRecorder({ file: join(session, "trace.jsonl") });
    const driver = new AeDriver({ transport, sessionRoot: session, trace });

    // driver.start() probes app.info; tick whenever a request lands.
    const started = driver.start();
    await waitFor(
      () => readdirSync(join(dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "probe request",
    );
    peer.tick();
    const info = await started;
    expect(info.version).toBe("26.0.0");

    const comp = driver.call<{ name: string }>(
      "project.createComp",
      { name: "DispatcherComp", width: 32, height: 32, duration: 2, frameRate: 24 },
      { timeoutMs: 5_000 },
    );
    await waitFor(
      () => readdirSync(join(dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "comp request",
    );
    peer.tick();
    await expect(comp).resolves.toMatchObject({ name: "DispatcherComp" });

    // Ownership is honestly "attached": stop leaves the fake AE running.
    const stopped = await driver.stop();
    expect(stopped.quit).toBe(false);
    expect(peer.app.quitCount).toBe(0);
    await transport.close();
  });
});

describe("public API selection and capabilities honesty", () => {
  it("accepts the named opt-in selection and refuses unknown ones", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    // Opted in but not activated: launch must fail with activation guidance,
    // proving the dispatcher path was taken (the script transport would
    // instead have tried to find an AE install).
    await expect(
      AfterEffects.launch({ sessionRoot: session, transport: "in-ae-dispatcher" }),
    ).rejects.toThrow(/Run Script File|dispatcher/i);

    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: { kind: "in-ae-dispatcher", channelDir: dir },
      }),
    ).rejects.toThrow(/dispatcher|activate/i);

    await expect(
      AfterEffects.launch({ sessionRoot: session, transport: "bogus" as never }),
    ).rejects.toThrow(/unknown transport selection/);

    // A session target cannot be honored: the channel is per-OS-user, so
    // the selection refuses rather than silently running as this user.
    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: "in-ae-dispatcher",
        session: { uid: 501 },
      }),
    ).rejects.toThrow(/cannot address another login session/);
  });

  it("validates the install/version target pins on the dispatcher selection", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const base = { kind: "in-ae-dispatcher", channelDir: dir } as const;

    // installDir and aeVersion are alternative pins, never both.
    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: { ...base, installDir: "/nonexistent-ae", aeVersion: "26.5" },
      }),
    ).rejects.toThrow(/alternative pins/);

    // A version that is not a version is refused before any channel work.
    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: { ...base, aeVersion: "not-a-version" },
      }),
    ).rejects.toThrow(/usable AE version/);

    // An install dir that cannot yield a version fails closed on every
    // platform (macOS reads the bundle plist; elsewhere there is no probe).
    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: { ...base, installDir: "/nonexistent-ae" },
      }),
    ).rejects.toThrow(/usable AE version/);
  });

  it("refuses through the public selection when the answering AE version differs", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    await new DispatcherTransport({ channelDir: dir }).prepare();
    activateFakeDispatcher(dir); // heartbeat reports aeVersion 26.0.0

    // The version check runs inside transport.launch(), before any request
    // is written — no ticking needed for the refusal.
    await expect(
      AfterEffects.launch({
        sessionRoot: session,
        transport: { kind: "in-ae-dispatcher", channelDir: dir, aeVersion: "27.0" },
      }),
    ).rejects.toThrow(/not the pinned|different After Effects version/);
  });

  it("reports execution mode and capped verification under the dispatcher", () => {
    const response = buildCapabilityHandshake({
      ae: { version: "26.0.0" },
      transportKind: DISPATCHER_TRANSPORT_KIND,
      attestation: {
        pid: null,
        ownedProcess: null,
        platform: { os: "darwin", arch: "unknown" },
        executionMode: "local",
        sessionUid: null,
        sessionAsid: null,
      },
      ownership: { kind: "attached", evidence: "test" },
      extensionMethods: [],
      hostNonce: "test-nonce",
      generatedAt: "2026-11-16T00:00:00.000Z",
    });
    expect(response.host.transport).toBe(DISPATCHER_TRANSPORT_KIND);
    expect(response.host.executionMode).toBe("local");
    // #138/#129 handshake fields: the dispatcher attests no pid, session or
    // GUI-delivery guarantee, so every session/execution field stays null
    // (unproven) rather than borrowing the controller's account.
    expect(response.host.session).toEqual({ uid: null, asid: null, user: null });
    expect(response.execution).toEqual({
      mode: "local",
      stability: "stable",
      requiresGuiDelivery: null,
      refusesConsoleTarget: null,
    });
    expect(response.target.nonInterference).toBe("unproven");
    expect(response.target.ownership).toBe("unknown");
    expect(response.target.ownershipKind).toBe("attached");
    expect(response.target.quitPolicy).toBe("owned-only");
    // No capability may claim real-host verification through this transport.
    for (const capability of response.availableCapabilities) {
      expect(capability.verification).not.toBe("verified-real-host");
      expect(capability.proofLevel).not.toBe("verified-real-host");
    }
    expect(response.diagnostics.map((d) => d.code)).toContain("dispatcher-transport-unverified");
  });
});

describe("startup placement helpers", () => {
  it("computes the per-user Scripts/Startup directory per platform", () => {
    expect(
      dispatcherStartupDir({ aeVersion: "26.5.0", platform: "darwin", homeDir: "/home/u" }),
    ).toBe("/home/u/Library/Preferences/Adobe/After Effects/26.5/Scripts/Startup");
    // `join` is platform-correct on the host it runs on; compare segment-wise.
    expect(
      dispatcherStartupDir({
        aeVersion: "27.0",
        platform: "win32",
        homeDir: "C:\\Users\\u",
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      }).split(/[\\/]/),
    ).toEqual([
      "C:\\Users\\u\\AppData\\Roaming".split(/[\\/]/)[0],
      ..."Users/u/AppData/Roaming/Adobe/After Effects/27.0/Scripts/Startup".split("/"),
    ]);
    expect(aeScriptsVersion("26.5.3")).toBe("26.5");
    expect(() => aeScriptsVersion("abc")).toThrow();
  });

  it("installs and removes only its own Startup entry", async () => {
    const dir = channelDir();
    const home = tmpDir("a8n-dispatcher-home-");
    const transport = new DispatcherTransport({ channelDir: dir, homeDir: home, platform: "darwin" });
    await transport.prepare();

    const installed = await transport.installStartupScript({ aeVersion: "26.5" });
    // The Startup dir is computed with the *target* platform's separators
    // (posix for the darwin seam); only the filename is host-joined.
    const expectedDir = dispatcherStartupDir({
      aeVersion: "26.5",
      platform: "darwin",
      homeDir: home,
    });
    expect(installed).toBe(join(expectedDir, "a8n-dispatcher.jsx"));
    // Separator-agnostic: the dir part is posix-joined for the darwin seam,
    // but the host-joined filename uses the host separator.
    expect(installed.replace(/\\/g, "/")).toContain("After Effects/26.5/Scripts/Startup");
    expect(readFileSync(installed, "utf-8")).toContain("ae-a8n in-AE dispatcher activation");

    // A foreign file at the same path is refused, not clobbered.
    writeFileSync(installed, "// someone else's script\n", "utf-8");
    await expect(transport.installStartupScript({ aeVersion: "26.5" })).rejects.toThrow(/not an ae-a8n/);
    expect(() => transport.uninstallStartupScript({ aeVersion: "26.5" })).toThrow(/not an ae-a8n/);
    expect(readFileSync(installed, "utf-8")).toContain("someone else's script");

    // Ours again: clear the foreign file, reinstall, then remove.
    rmSync(installed);
    await transport.installStartupScript({ aeVersion: "26.5" });
    expect(transport.uninstallStartupScript({ aeVersion: "26.5" })).toBe(installed);
    expect(existsSync(installed)).toBe(false);
    expect(transport.uninstallStartupScript({ aeVersion: "26.5" })).toBeNull();
  });

  it("derives the AE version from a macOS bundle's Info.plist", async () => {
    const dir = channelDir();
    const app = join(dir, "Adobe After Effects 2026.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      "<key>CFBundleShortVersionString</key>\n<string>26.5.3</string>\n",
      "utf-8",
    );
    const transport = new DispatcherTransport({ channelDir: dir, platform: "darwin" });
    await transport.prepare();
    expect(transport.resolveAeVersion({ installDir: app })).toBe("26.5");
    // A real host path: host separators, so compare with host join.
    expect(defaultDispatcherChannelDir("/home/u")).toBe(
      join("/home/u", ".ae-a8n", "dispatcher"),
    );
  });
});

describe("target binding and reconnect pinning (#145)", () => {
  function stageCall(session: string): { entry: string; id: string } {
    const paths = createSessionPaths(session);
    const id = nextRequestId();
    const request: RequestEnvelope = { v: 1, id, method: "app.info", params: {}, timeoutMs: 5_000 };
    writeRequest(paths, request);
    const entry = join(session, "staging", `${id}.entry.jsx`);
    writeBootstrapScript({
      entryPath: entry,
      hostScriptPath: join(session, "host.js"),
      requestPath: join(paths.inbox, `${id}.request.json`),
      resultPath: join(paths.outbox, `${id}.result.json`),
      id,
    });
    return { entry, id };
  }

  function heartbeatInstance(dir: string): string {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as { instance: string };
    return state.instance;
  }

  it("binds the answering instance at launch and addresses every request to it", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    activateFakeDispatcher(dir);
    const instance = heartbeatInstance(dir);

    await transport.launch();
    expect(transport.boundInstance()).toBe(instance);

    const { entry, id } = stageCall(session);
    await transport.invoke(entry);
    const channelRequest = JSON.parse(
      readFileSync(join(dir, "inbox", `${id}.request.json`), "utf-8"),
    ) as Record<string, unknown>;
    expect(channelRequest["target"]).toBe(instance);
    await transport.close();
  });

  it("refuses to launch when the answering instance is not the pinned one", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();
    activateFakeDispatcher(dir);
    const instance = heartbeatInstance(dir);

    await expect(
      makeTransport(dir, { expectedInstance: "a-different-instance" }).launch(),
    ).rejects.toThrow(/not the pinned/);

    const pinned = makeTransport(dir, { expectedInstance: instance });
    await pinned.launch();
    expect(pinned.boundInstance()).toBe(instance);
    await pinned.close();
    await transport.close();
  });

  it("pins the answering AE version and refuses a different one", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();
    activateFakeDispatcher(dir); // heartbeat reports aeVersion 26.0.0

    // The heartbeat reports three components, so the pin is checked at
    // that precision: a different minor AND a different patch both refuse.
    await expect(
      makeTransport(dir, { expectedAeVersion: "27.0" }).launch(),
    ).rejects.toThrow(/not the pinned|different After Effects version/);
    await expect(
      makeTransport(dir, { expectedAeVersion: "26.0.1" }).launch(),
    ).rejects.toThrow(/not the pinned|different After Effects version/);

    // A coarser pin is verified only to the precision it names.
    const pinned = makeTransport(dir, { expectedAeVersion: "26.0" });
    await pinned.launch();
    await pinned.close();
    await transport.close();
  });

  it("accepts a heartbeat version with a real-host build suffix", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();
    // Real `app.version` on AE 26.5 reports "26.0.0x9"-style strings: the
    // build suffix is not a version component and must not fail parsing.
    activateFakeDispatcher(dir, "26.0.0x9");

    const pinned = makeTransport(dir, { expectedAeVersion: "26.0" });
    await pinned.launch();
    await pinned.close();
    await transport.close();
  });

  it("parses AE version components at their leading digit run", () => {
    expect(aeVersionParts("26.5.3x9")).toEqual([26, 5, 3]);
    expect(aeVersionParts("26.5")).toEqual([26, 5]);
    expect(() => aeVersionParts("26.x.5")).toThrow(/cannot parse AE version/);
    expect(() => aeVersionParts("26")).toThrow(/cannot parse AE version/);
  });

  it("refuses to deliver once the answering instance changes", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    activateFakeDispatcher(dir);
    await transport.launch();
    const bound = transport.boundInstance();
    expect(bound).not.toBeNull();

    // The dispatcher was restarted: the heartbeat now names another AE.
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...state, instance: "restarted-instance" }), "utf-8");

    const { entry, id } = stageCall(session);
    await expect(transport.invoke(entry)).rejects.toBeInstanceOf(ScriptNotSentError);
    await expect(transport.invoke(entry)).rejects.toThrow(/not the .* this session bound to/);
    // Nothing was written for the wrong target.
    expect(existsSync(join(dir, "inbox", `${id}.request.json`))).toBe(false);
    await transport.close();
  });
});

describe("dispatcher host target filter (real ES3, fake AE)", () => {
  it("claims only requests addressed to it; foreign and untargeted requests behave correctly", async () => {
    const dir = channelDir();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { peer, outcome } = activateFakeDispatcher(dir);
    expect(outcome.success).toBe(true);
    const instance = (
      JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as { instance: string }
    ).instance;
    const compsBefore = peer.app.project.numItems;

    const compParams = { name: "BoundComp", width: 16, height: 16, duration: 1, frameRate: 24 };
    // Addressed to a different dispatcher instance: must be left untouched.
    const foreign = validRequest(dir, "project.createComp", compParams);
    foreign["target"] = "another-instance";
    const foreignId = foreign["id"] as string;
    writeChannelRequest(dir, foreign);

    // Addressed to this instance: runs.
    const mine = validRequest(dir, "project.createComp", { ...compParams, name: "MineComp" });
    mine["target"] = instance;
    const mineId = mine["id"] as string;
    writeChannelRequest(dir, mine);

    // No target at all (older writer): still runs — the filter only refuses
    // a *named different* instance.
    const untargeted = validRequest(dir, "app.info");
    const untargetedId = untargeted["id"] as string;
    writeChannelRequest(dir, untargeted);

    for (let i = 0; i < 8; i++) {
      peer.tick();
    }

    // The foreign request is still sitting unclaimed for its real target.
    expect(existsSync(join(dir, "inbox", `${foreignId}.request.json`))).toBe(true);
    expect(existsSync(join(dir, "outbox", `${foreignId}.result.json`))).toBe(false);

    const read = (id: string) =>
      JSON.parse(readFileSync(join(dir, "outbox", `${id}.result.json`), "utf-8")) as { ok: boolean };
    expect(read(mineId).ok).toBe(true);
    expect(read(untargetedId).ok).toBe(true);

    // Exactly one comp was created: the foreign request never executed.
    expect(peer.app.project.numItems).toBe(compsBefore + 1);
    await transport.close();
  });
});

describe("static extensions through the dispatcher (#146)", () => {
  const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const HOST_SOURCE = readFileSync(join(PACKAGE_ROOT, "host", "a8n-host.js"), "utf-8");
  const ECHO = {
    name: "aulymo.echo",
    source: "function (params) { return params.value; }",
  };

  function buildExtensionHost(
    methods: readonly { name: string; source: string }[],
  ): { path: string; sha256: string } {
    const built = buildHostScript(HOST_SOURCE, methods);
    if (!built.ok) {
      throw new Error(built.detail);
    }
    const path = join(tmpDir("a8n-extbuild-"), "host.generated.js");
    writeFileSync(path, built.source, "utf-8");
    return { path, sha256: built.sha256 };
  }

  /**
   * Activates the fake-AE dispatcher on `dir` and launches the public API
   * against it, ticking the scheduler whenever a channel request lands.
   */
  async function launchAgainstDispatcher(options: {
    readonly dir: string;
    readonly session: string;
    readonly hostScript?: string;
    readonly authorization?: { extensionMethods: boolean };
  }): Promise<{ ae: AfterEffects; peer: FakePeer }> {
    // prepare() stages the effective host script into the channel; the
    // activation below evals exactly those bytes, as a human's Run Script
    // File would. The API's own transport re-prepares idempotently.
    await new DispatcherTransport({
      channelDir: options.dir,
      ...(options.hostScript === undefined ? {} : { hostScriptPath: options.hostScript }),
    }).prepare();
    const { peer } = activateFakeDispatcher(options.dir);
    const launching = AfterEffects.launch({
      sessionRoot: options.session,
      transport: { kind: "in-ae-dispatcher", channelDir: options.dir },
      ...(options.hostScript === undefined ? {} : { hostScript: options.hostScript }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    });
    await waitFor(
      () => readdirSync(join(options.dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "launch probe request",
    );
    peer.tick();
    return { ae: await launching, peer };
  }

  it("stages the effective host script and records its manifest in channel.json", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    const transport = new DispatcherTransport({ channelDir: dir, hostScriptPath: built.path });
    await transport.prepare();

    // The channel runs the generated bytes verbatim — the same file a real
    // AE would evalFile — not the shipped host.
    expect(readFileSync(join(dir, "a8n-host.js"), "utf-8")).toBe(
      readFileSync(built.path, "utf-8"),
    );

    const meta = JSON.parse(readFileSync(join(dir, "channel.json"), "utf-8")) as {
      token: string;
      hostScript?: { sha256: string; methods: string[]; registration: string | null };
    };
    expect(meta.hostScript?.sha256).toBe(built.sha256);
    expect(meta.hostScript?.methods).toEqual(["aulymo.echo"]);
    expect(meta.hostScript?.registration).toMatch(/^[0-9a-f]{64}$/u);
    // The token survived: restaging never rotates the channel secret.
    expect(meta.token).toBe(channelToken(dir));
  });

  it("exposes only what AE registered, answers ae.call, and refuses the rest", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const built = buildExtensionHost([ECHO]);
    const { ae, peer } = await launchAgainstDispatcher({
      dir,
      session,
      hostScript: built.path,
      authorization: { extensionMethods: true },
    });

    // The heartbeat is the evidence: it reports what the dispatcher
    // registered at activation, and that — not the staged file — is what
    // the API exposes.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as {
      extensionMethods?: string[];
      extensionsRegistration?: string | null;
    };
    expect(state.extensionMethods).toEqual(["aulymo.echo"]);
    expect(state.extensionsRegistration).toMatch(/^[0-9a-f]{64}$/u);
    expect(ae.extensionMethods()).toEqual(["aulymo.echo"]);

    const call = ae.call("aulymo.echo", { value: "hello" });
    await waitFor(
      () => readdirSync(join(dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "extension request",
    );
    peer.tick();
    await expect(call).resolves.toBe("hello");

    // An unregistered name is refused before anything reaches the channel.
    const inboxBefore = readdirSync(join(dir, "inbox")).length;
    await expect(ae.call("aulymo.nope")).rejects.toBeInstanceOf(ExtensionMethodNotFoundError);
    expect(readdirSync(join(dir, "inbox"))).toHaveLength(inboxBefore);

    // Attached ownership still cannot quit the host.
    const stopped = await ae.close();
    expect(stopped.quit).toBe(false);
    expect(peer.app.quitCount).toBe(0);
  });

  it("refuses an extension call without the extensionMethods grant", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    // Staged and registered, but no grant: matching hashes are identity
    // evidence, never execution authority.
    const { ae } = await launchAgainstDispatcher({ dir, session: sessionRoot(), hostScript: built.path });
    await expect(ae.call("aulymo.echo", { value: 1 })).rejects.toBeInstanceOf(HostNotOwnedError);
    await ae.close();
  });

  it("refuses to bind when the staged source differs from the activated one", async () => {
    const dir = channelDir();
    const hostA = buildExtensionHost([
      { name: "aulymo.echo", source: "function (params) { return 1; }" },
    ]);
    const transportA = new DispatcherTransport({ channelDir: dir, hostScriptPath: hostA.path });
    await transportA.prepare();
    activateFakeDispatcher(dir); // dispatcher A is running inside this "AE"

    // A second session stages a different build: same method name, new body.
    // Names alone cannot tell them apart — the registration fingerprint can.
    const hostB = buildExtensionHost([
      { name: "aulymo.echo", source: "function (params) { return 2; }" },
    ]);
    const transportB = new DispatcherTransport({ channelDir: dir, hostScriptPath: hostB.path });
    await transportB.prepare(); // restages channel + channel.json; A keeps running
    await expect(transportB.launch()).rejects.toThrow(/different extension set[\s\S]*reactivate/i);

    // A real reactivation — a new AE process running activate.jsx again —
    // picks up the staged B and binds.
    activateFakeDispatcher(dir);
    await expect(transportB.launch()).resolves.toBeUndefined();
    expect(transportB.boundExtensions()?.methods).toEqual(["aulymo.echo"]);
    expect(transportB.boundExtensions()?.registration).not.toBeNull();
  });

  it("refuses a dispatcher whose heartbeat predates extension reporting", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    const transport = new DispatcherTransport({ channelDir: dir, hostScriptPath: built.path });
    await transport.prepare();
    // A dispatcher activated by a pre-#146 host writes a heartbeat with no
    // extension fields at all; it cannot prove it runs the staged build.
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        v: 1,
        token: channelToken(dir),
        instance: "iold",
        aeVersion: "26.0.0",
        activatedAt: Date.now(),
        lastTick: Date.now(),
        pollMs: 250,
      }),
      "utf-8",
    );
    await expect(transport.launch()).rejects.toThrow(/different extension set/);
  });

  it("keeps answering with the activation-time extension snapshot after the table mutates", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    const { ae, peer } = await launchAgainstDispatcher({
      dir,
      session: sessionRoot(),
      hostScript: built.path,
      authorization: { extensionMethods: true },
    });

    // Another script inside the same AE mutates the live table: it injects
    // a name and replaces the registered function. The dispatcher captured
    // its function table once at activation (#146), so neither change is
    // adopted — the heartbeat still reports the fixed set.
    const extensions = (peer.globals["__a8n"] as { extensions: Record<string, unknown> })
      .extensions;
    extensions["aulymo.injected"] = () => "pwned";
    extensions["aulymo.echo"] = () => "replaced";

    const call = ae.call("aulymo.echo", { value: "still-original" });
    await waitFor(
      () => readdirSync(join(dir, "inbox")).some((n) => n.endsWith(".request.json")),
      "extension request",
    );
    peer.tick();
    // The activation-time function answered, not the replacement.
    await expect(call).resolves.toBe("still-original");

    // And the API still refuses the injected name before it reaches the
    // channel — the heartbeat-reported set is the bound set.
    const inboxBefore = readdirSync(join(dir, "inbox")).length;
    await expect(ae.call("aulymo.injected")).rejects.toBeInstanceOf(
      ExtensionMethodNotFoundError,
    );
    expect(readdirSync(join(dir, "inbox"))).toHaveLength(inboxBefore);

    await ae.close();
  });

  it("refuses calls once the heartbeat reports a different extension set", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    const { ae } = await launchAgainstDispatcher({
      dir,
      session: sessionRoot(),
      hostScript: built.path,
      authorization: { extensionMethods: true },
    });

    // Same instance, different extension set: the state file was replaced
    // underneath the session. The next call must be refused before the
    // request is written, not answered against an unproven set.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    state["extensionMethods"] = ["aulymo.other"];
    writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");

    const inboxBefore = readdirSync(join(dir, "inbox")).length;
    await expect(ae.call("aulymo.echo", { value: 1 })).rejects.toThrow(
      /extension set[\s\S]*not sent|not sent[\s\S]*reactivate/i,
    );
    expect(readdirSync(join(dir, "inbox"))).toHaveLength(inboxBefore);
    await ae.close();
  });

  it("treats a malformed extensionMethods heartbeat as no heartbeat", async () => {
    const dir = channelDir();
    const built = buildExtensionHost([ECHO]);
    const transport = new DispatcherTransport({ channelDir: dir, hostScriptPath: built.path });
    await transport.prepare();
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        v: 1,
        token: channelToken(dir),
        instance: "i1",
        aeVersion: "26.0.0",
        activatedAt: Date.now(),
        lastTick: Date.now(),
        pollMs: 250,
        // Filtering this to ["aulymo.echo"] could make a wrong set compare
        // equal — a present-but-malformed field invalidates the heartbeat.
        extensionMethods: ["aulymo.echo", 123],
        extensionsRegistration: null,
      }),
      "utf-8",
    );
    await expect(transport.launch()).rejects.toThrow(/no fresh|heartbeat/i);
  });
});

describe("result envelope and pump edge cases (#227)", () => {
  function stagedCall(session: string, method = "app.info"): { entry: string; id: string } {
    const paths = createSessionPaths(session);
    const id = nextRequestId();
    const request: RequestEnvelope = { v: 1, id, method, params: {}, timeoutMs: 5_000 };
    writeRequest(paths, request);
    const entry = join(session, "staging", `${id}.entry.jsx`);
    writeBootstrapScript({
      entryPath: entry,
      hostScriptPath: join(session, "host.js"),
      requestPath: join(paths.inbox, `${id}.request.json`),
      resultPath: join(paths.outbox, `${id}.result.json`),
      id,
    });
    return { entry, id };
  }

  it("refuses a result envelope with an unknown protocol version", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { entry, id } = stagedCall(session);
    await transport.invoke(entry);

    // Correct id, wrong envelope version: not this protocol's result.
    writeFileSync(
      join(dir, "outbox", `${id}.result.json`),
      JSON.stringify({ v: 2, id, ok: true, durationMs: 1, result: { smuggled: true } }),
    );
    await sleep(120);
    expect(existsSync(join(session, "outbox", `${id}.result.json`))).toBe(false);
    // The file stays as evidence; the pump does not consume what it cannot read.
    expect(existsSync(join(dir, "outbox", `${id}.result.json`))).toBe(true);
    await transport.close();
  });

  it("skips a malformed result file and keeps waiting for a valid one", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { entry, id } = stagedCall(session);
    await transport.invoke(entry);

    writeFileSync(join(dir, "outbox", `${id}.result.json`), "{not json");
    await sleep(120);
    expect(existsSync(join(session, "outbox", `${id}.result.json`))).toBe(false);

    // A later, well-formed result for the same request is still delivered.
    writeFileSync(
      join(dir, "outbox", `${id}.result.json`),
      JSON.stringify({ v: 1, id, ok: true, durationMs: 2, result: { late: "but valid" } }),
    );
    await waitFor(
      () => existsSync(join(session, "outbox", `${id}.result.json`)),
      "result after malformed file",
    );
    await transport.close();
  });

  it("drops a result that arrives after the late-result window", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir, { lateResultMs: 60 });
    await transport.prepare();
    const { entry, id } = stagedCall(session);
    await transport.invoke(entry);

    // Let the pending entry expire, then deliver a correct result: it must
    // not be bridged — the caller already saw UNKNOWN.
    await sleep(200);
    writeFileSync(
      join(dir, "outbox", `${id}.result.json`),
      JSON.stringify({ v: 1, id, ok: true, durationMs: 1, result: { too: "late" } }),
    );
    await sleep(120);
    expect(existsSync(join(session, "outbox", `${id}.result.json`))).toBe(false);
    await transport.close();
  });

  it.skipIf(process.platform === "win32")("keeps the channel result and retries when publishing to the session fails", async () => {
    const dir = channelDir();
    const session = sessionRoot();
    const transport = makeTransport(dir);
    await transport.prepare();
    const { entry, id } = stagedCall(session);
    await transport.invoke(entry);

    const outbox = join(session, "outbox");
    chmodSync(outbox, 0o500);
    try {
      writeFileSync(
        join(dir, "outbox", `${id}.result.json`),
        JSON.stringify({ v: 1, id, ok: true, durationMs: 1, result: { retry: true } }),
      );
      await sleep(150);
      // Publish failed: nothing in the session outbox, and the channel
      // result is kept (not consumed, not deleted) for the next pump.
      expect(existsSync(join(outbox, `${id}.result.json`))).toBe(false);
      expect(existsSync(join(dir, "outbox", `${id}.result.json`))).toBe(true);
    } finally {
      chmodSync(outbox, 0o700);
    }
    await waitFor(
      () => existsSync(join(outbox, `${id}.result.json`)),
      "result bridged after permissions restored",
    );
    await transport.close();
  });
});
