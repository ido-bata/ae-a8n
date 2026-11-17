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
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as acorn from "acorn";

import { AfterEffects } from "../src/index.js";
import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import {
  DispatcherTransport,
  DISPATCHER_TRANSPORT_KIND,
  aeScriptsVersion,
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
  readonly tick: () => void;
};

/**
 * Runs the generated `activate.jsx` against the fake AE engine, exactly as
 * File > Scripts > Run Script File would. Returns the tick the scheduler
 * would call; tests fire it by hand.
 */
function activateFakeDispatcher(dir: string): { peer: FakePeer; outcome: ReturnType<typeof runHostScript> } {
  const app = new FakeApplication();
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
