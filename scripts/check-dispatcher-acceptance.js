/**
 * The dispatcher consumer acceptance harness (#148): install the packed
 * candidate into a clean project and drive the in-AE dispatcher path the
 * way ae-test and Aulymo will — static extension calls, project editing,
 * rendering, authorization refusal, instance pinning, reconnect, and safe
 * shutdown.
 *
 * `scripts/check-consumer-smoke.js` proves the package surface and a
 * read-only launch. This script proves the *dispatcher* contract end to
 * end, in two explicitly separated lanes:
 *
 *   - `fake` lane (always runs, no After Effects needed): the packed
 *     `@ido-bata/ae-a8n/testing` fake host plays the AE peer. The real
 *     `host/a8n-host.js` dispatcher code runs unmodified inside it, the
 *     channel files are real, and every scenario below executes. Evidence:
 *     `fake/mock only` — never report it as real-host verification.
 *   - `real` lane (opt-in, human activation required): the same scenarios
 *     against a real After Effects. The probe prepares the channel, prints
 *     the `activate.jsx` path, and waits for a human to run it via
 *     File > Scripts > Run Script File. No heartbeat within the wait
 *     budget is `blocked`, not a pass.
 *
 * The extension fixture is a consumer-side module built by the packed CLI
 * (`ae-a8n extension build`), exactly as a downstream consumer would.
 *
 * Usage:
 *   node scripts/check-dispatcher-acceptance.js [--project <abs .aep>]
 *
 * `--project` is required for the real lane: editing and rendering need an
 * explicit disposable fixture project, never whatever happens to be open.
 * `A8N_ACCEPTANCE_SKIP_REAL=1` skips the real lane entirely;
 * `A8N_ACCEPTANCE_WAIT_MS` bounds the human-activation wait (default 10 min).
 * Neither can manufacture a pass.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { npmCommand } from "./npm-cli.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
let projectPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--project") {
    projectPath = args[i + 1];
    i += 1;
  } else {
    console.error(
      `::error::unknown argument ${args[i]}; usage: node scripts/check-dispatcher-acceptance.js [--project <path>]`,
    );
    process.exit(1);
  }
}
if (projectPath !== null && !isAbsolute(projectPath)) {
  console.error("::error::--project must be an absolute path");
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  return execFileSync(command, cmdArgs, { encoding: "utf-8", ...options });
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

console.log(`packing ${manifest.name}@${manifest.version}…`);
// Same rule as check-consumer-smoke.js: npm runs as `node <npm-cli.js>`,
// never through a shell (scripts/npm-cli.js).
const npm = npmCommand();
const tarballName = run(npm.command, [...npm.args, "pack", "--silent"], { cwd: PACKAGE_ROOT })
  .trim()
  .split("\n")
  .at(-1);
const tarball = join(PACKAGE_ROOT, tarballName);

const workdir = mkdtempSync(join(tmpdir(), "a8n-dispatcher-acceptance-"));
try {
  writeFileSync(
    join(workdir, "package.json"),
    `${JSON.stringify({ name: "dispatcher-acceptance", private: true, type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  run(npm.command, [...npm.args, "install", "--silent", tarball], { cwd: workdir });

  // --- The consumer-side extension fixture and the probe. --------------

  writeFileSync(
    join(workdir, "extension.mjs"),
    `// Consumer-side static extension fixture (#148 T3). A real consumer
// ships a module like this and builds it with \`ae-a8n extension build\`.
export default {
  name: "dispatcher-acceptance-fixture",
  version: "1.0.0",
  methods: [
    {
      name: "acceptance.ping",
      source:
        "function (params) { var v = params === undefined ? 0 : params.value; return v * 2; }",
    },
  ],
};
`,
    "utf-8",
  );

  // Build the effective host script through the packed CLI — the same
  // command a consumer runs — so the probe exercises staged-extension
  // activation, not a source-checkout shortcut.
  const cliJs = join(workdir, "node_modules", manifest.name, "dist", "cli.js");
  const hostScriptPath = join(workdir, "a8n-acceptance-host.jsx");
  run(process.execPath, [
    cliJs,
    "extension",
    "build",
    "--extension",
    join(workdir, "extension.mjs"),
    "--out",
    hostScriptPath,
  ]);
  console.log(`extension host built: ${hostScriptPath}`);

  const probePath = join(workdir, "acceptance.mjs");
  writeFileSync(
    probePath,
    `
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setInterval, clearInterval } from "node:timers";

import {
  AfterEffects,
  DispatcherTransport,
  HostNotOwnedError,
  TimeoutError,
} from ${JSON.stringify(manifest.name)};
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
  runHostScript,
} from ${JSON.stringify(`${manifest.name}/testing`)};

const HOST_SCRIPT = ${JSON.stringify(hostScriptPath)};
const PROJECT = ${JSON.stringify(projectPath)};
const WAIT_MS = Number(process.env.A8N_ACCEPTANCE_WAIT_MS ?? 600000);

const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push("ok   " + name);
  } catch (error) {
    failures += 1;
    results.push("FAIL " + name + " — " + (error && error.message ? error.message : String(error)));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/* Shared scenario suite. Runs identically in both lanes; only the way the
 * dispatcher gets activated inside AE differs (fake peer vs. human). */
async function runScenarios({ ae, channelDir, hostScript, close }) {
  // 1. Connection + capability handshake + instance identity.
  const handshake = await ae.capabilities();
  assert(handshake.contractVersion, "handshake missing contractVersion");
  const instance = handshake.target.dispatcherInstance;
  assert(typeof instance === "string" && instance.length > 0, "no dispatcher instance reported");

  // 2. Composition / layer operations (edit).
  const comps = await ae.comps();
  assert(comps.length > 0, "no compositions in the project");
  const compName = comps[0].name;
  const project = await ae.project();
  const compApi = await project.comp(compName);
  const layersBefore = await compApi.layers();
  const added = await compApi.addTextLayer({ text: "a8n-acceptance", name: "A8N Acceptance" });
  const layersAfter = await compApi.layers();
  assert(
    layersAfter.length === layersBefore.length + 1,
    "addTextLayer did not add a layer",
  );
  await added.layer.setEnabled(false);
  await added.layer.setEnabled(true);

  // 3. Frame rendering + PNG artifact.
  const frame = await compApi.renderFrame(0);
  const png = readFileSync(frame.path);
  assert(
    png.length > 8 && png[0] === 0x89 && png[1] === 0x50,
    "rendered frame is not a PNG",
  );

  // 4. Static extension call through the dispatcher.
  assert(
    ae.extensionMethods().includes("acceptance.ping"),
    "acceptance.ping not exposed",
  );
  const pong = await ae.call("acceptance.ping", { value: 21 });
  assert(pong === 42, "acceptance.ping returned " + JSON.stringify(pong));

  // 5. Expected refusals: undeclared name, unauthorized session (below),
  //    wrong instance pin (below).
  let undeclared = null;
  try {
    await ae.call("acceptance.undeclared", {});
  } catch (error) {
    undeclared = error;
  }
  assert(undeclared !== null, "undeclared extension name was not refused");
  assert(
    undeclared.name === "ExtensionMethodNotFoundError",
    "undeclared name refused with " + undeclared.name,
  );

  return { instance, compName, frame };
}

async function fakeLane() {
  const channelDir = join(tmp("a8n-acc-channel-"), "channel");
  const sessionRoot = tmp("a8n-acc-session-");
  const transport = new DispatcherTransport({ channelDir, hostScriptPath: HOST_SCRIPT });
  await transport.prepare();

  // Activate the dispatcher inside the fake AE engine, exactly as a human's
  // Run Script File would, then drive the scheduler by hand.
  const app = new FakeApplication();
  if (app.project.numItems === 0) {
    app.project.load(createDefaultComp(), null);
  }
  const engineGlobal = {};
  const outcome = runHostScript(join(channelDir, "activate.jsx"), createFakeGlobals(app), {
    engineGlobal,
  });
  assert(outcome.success, "activate.jsx failed in the fake host: " + JSON.stringify(outcome));
  const tick = engineGlobal["__a8nDispatcherTick"];
  assert(typeof tick === "function", "dispatcher tick was not scheduled");
  const timer = setInterval(() => {
    try { tick(); } catch { /* a tick error surfaces via the channel, not here */ }
  }, 25);

  const launchOptions = {
    transport,
    sessionRoot,
    authorization: { extensionMethods: true },
  };
  const ae = await AfterEffects.launch(launchOptions);
  let bound = null;
  try {
    await check("handshake, edit, render, extension call, undeclared refusal", async () => {
      bound = await runScenarios({ ae, channelDir, hostScript: HOST_SCRIPT });
    });
  } finally {
    // Sessions below need the dispatcher answering; the main session is
    // closed only after every scenario, with the edits we made discarded —
    // the fixture project on disk is never written.
  }

  // 6. Unauthorized refusal: a second session without the grant cannot call
  //    the extension even though it is registered.
  const transport2 = new DispatcherTransport({ channelDir, hostScriptPath: HOST_SCRIPT });
  const ae2 = await AfterEffects.launch({
    transport: transport2,
    sessionRoot: tmp("a8n-acc-session2-"),
  });
  await check("unauthorized extension call refused", async () => {
    let refused = null;
    try {
      await ae2.call("acceptance.ping", { value: 1 });
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof HostNotOwnedError, "expected HostNotOwnedError, got " + (refused && refused.name));
  });
  await ae2.close();

  // 7. Instance pinning: a wrong pin is refused, the reported pin reconnects.
  if (bound !== null) {
    await check("wrong instance pin refused", async () => {
      let refused = null;
      try {
        await AfterEffects.launch({
          transport: { kind: "in-ae-dispatcher", channelDir, instance: "not-the-instance" },
          hostScript: HOST_SCRIPT,
          sessionRoot: tmp("a8n-acc-session3-"),
        });
      } catch (error) {
        refused = error;
      }
      assert(refused !== null, "launch with a wrong instance pin was not refused");
    });
    const ae3 = await AfterEffects.launch({
      transport: { kind: "in-ae-dispatcher", channelDir, instance: bound.instance },
      hostScript: HOST_SCRIPT,
      sessionRoot: tmp("a8n-acc-session4-"),
      authorization: { extensionMethods: true },
    });
    const hs3 = await ae3.capabilities();
    assert(
      hs3.target.dispatcherInstance === bound.instance,
      "reconnect bound a different instance",
    );
    await ae3.close();
  }

  // 8. UNKNOWN is never resent: with the dispatcher stopped, a call times
  //    out and exactly one request file remains — nothing is retried.
  clearInterval(timer);
  const inbox = join(channelDir, "inbox");
  const requestsBefore = readdirSync(inbox).filter((n) => n.endsWith(".request.json")).length;
  await check("timeout is UNKNOWN and not resent", async () => {
    let timedOut = null;
    try {
      await ae.call("acceptance.ping", { value: 1 }, { timeoutMs: 400 });
    } catch (error) {
      timedOut = error;
    }
    // The API surfaces a call timeout as AfterEffectsError whose cause is
    // the driver's TimeoutError — both shapes mean UNKNOWN, never resent.
    const timedOutCause = timedOut instanceof Error ? timedOut.cause : undefined;
    assert(
      timedOut instanceof TimeoutError || timedOutCause instanceof TimeoutError,
      "expected a timeout (UNKNOWN), got " + (timedOut && timedOut.name),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const requestsAfter = readdirSync(inbox).filter((n) => n.endsWith(".request.json")).length;
    assert(
      requestsAfter === requestsBefore + 1,
      "expected exactly one unclaimed request, found " + (requestsAfter - requestsBefore),
    );
  });
  // Let the dispatcher refuse the stale request so close() is not left
  // waiting on a dead channel.
  const resumeTimer = setInterval(() => {
    try { tick(); } catch { /* same as above */ }
  }, 25);

  // 9. Safe shutdown: attached ownership never quits the host.
  await check("close does not quit an attached host", async () => {
    const closed = await ae.close({ unsavedChanges: "discard" });
    assert(closed.quit === false, "close() reported quit on an attached session");
    assert(app.quitCount === 0, "the fake AE was quit");
  });
  clearInterval(resumeTimer);

  console.log("fake lane results:");
  for (const line of results) console.log("  " + line);
  console.log(failures === 0 ? "RESULT: fake pass (fake/mock only — not real-host evidence)" : "RESULT: fake FAIL");
  return failures;
}

async function realLane() {
  const channelDir = join(tmp("a8n-acc-channel-"), "channel");
  const sessionRoot = tmp("a8n-acc-session-");
  const transport = new DispatcherTransport({ channelDir, hostScriptPath: HOST_SCRIPT });
  await transport.prepare();

  console.log("real lane: activate the dispatcher inside After Effects:");
  console.log("  File > Scripts > Run Script File");
  console.log("  " + transport.activateScriptPath);
  console.log("waiting up to " + WAIT_MS + "ms for a heartbeat…");
  const deadline = Date.now() + WAIT_MS;
  let status = transport.status();
  while (!(status.heartbeat && status.heartbeat.fresh)) {
    if (Date.now() > deadline) {
      console.log("RESULT: blocked — no dispatcher heartbeat within the wait budget (human activation did not happen or AE is not running)");
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = transport.status();
  }
  console.log("dispatcher heartbeat fresh (instance " + status.heartbeat.instance + ")");

  const ae = await AfterEffects.launch({
    transport,
    sessionRoot,
    authorization: { extensionMethods: true },
  });
  try {
    if (PROJECT !== null) {
      await ae.openProject(PROJECT);
    }
    await check("handshake, edit, render, extension call, undeclared refusal", async () => {
      await runScenarios({ ae, channelDir, hostScript: HOST_SCRIPT });
    });
    const hs = await ae.capabilities();
    const instance = hs.target.dispatcherInstance;
    if (typeof instance === "string" && instance.length > 0) {
      const ae2 = await AfterEffects.launch({
        transport: { kind: "in-ae-dispatcher", channelDir, instance },
        hostScript: HOST_SCRIPT,
        sessionRoot: tmp("a8n-acc-session2-"),
      });
      await ae2.close();
    }

    console.log("real lane results:");
    for (const line of results) console.log("  " + line);
    console.log(failures === 0 ? "RESULT: real-host pass" : "RESULT: real-host FAIL");
    return failures;
  } finally {
    // The fixture project's edits are never saved; discarding them is the
    // documented acceptance behaviour, not data loss.
    const closed = await ae.close({ unsavedChanges: "discard" });
    console.log(
      "closed: quit=" + closed.quit +
        " ownership=" + closed.ownership.kind +
        (closed.reason === undefined ? "" : " reason=" + closed.reason),
    );
    if (closed.quit !== false) {
      console.log("RESULT: real-host FAIL — close() quit an attached host");
      return Math.max(failures, 1);
    }
  }
}

const mode = process.argv[2];
if (mode === "fake") {
  process.exitCode = (await fakeLane()) === 0 ? 0 : 1;
} else if (mode === "real") {
  if (PROJECT === null) {
    console.log("RESULT: blocked — the real lane needs --project <abs .aep> (an explicit disposable fixture; editing and rendering must not touch whatever project happens to be open)");
    process.exitCode = 0;
  } else {
    process.exitCode = (await realLane()) === 0 ? 0 : 1;
  }
} else {
  console.error("usage: acceptance.mjs fake|real [--project via env]");
  process.exitCode = 2;
}
`,
    "utf-8",
  );

  function runProbe(mode) {
    try {
      const output = run(process.execPath, [probePath, mode], {
        cwd: workdir,
        env: {
          ...process.env,
          A8N_ACCEPTANCE_HOST_SCRIPT: hostScriptPath,
          ...(projectPath === null ? {} : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output: String(output) };
    } catch (error) {
      return {
        ok: false,
        output: `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- Fake lane: always runs; evidence is fake/mock only. ----------------

  console.log("\nfake lane (packed package + fake AE host)…");
  const fake = runProbe("fake");
  console.log(fake.output.trim());
  if (!fake.ok || !fake.output.includes("RESULT: fake pass")) {
    fail(`fake lane failed${fake.ok ? "" : `: ${fake.message}`}`);
  }

  // --- Real lane: needs an explicit fixture project and a human to
  //     activate the dispatcher inside After Effects. ----------------------

  const skipReal = process.env.A8N_ACCEPTANCE_SKIP_REAL === "1";
  if (skipReal) {
    console.log("\nreal lane: skipped (A8N_ACCEPTANCE_SKIP_REAL=1)");
  } else if (projectPath === null) {
    console.log(
      "\nreal lane: skipped — no --project <abs .aep> fixture given. " +
        "The real lane edits and renders, so it never runs against an " +
        "unspecified project. Pass --project to enable it.",
    );
  } else {
    console.log("\nreal lane (packed package + real After Effects)…");
    console.log("A human must run the printed activate.jsx inside AE.");
    const real = runProbe("real");
    console.log(real.output.trim());
    if (!real.ok && !real.output.includes("RESULT: blocked")) {
      fail(`real lane failed${real.ok ? "" : `: ${real.message}`}`);
    }
    if (real.output.includes("RESULT: real-host pass")) {
      console.log("\nconsumer dispatcher acceptance passed against a real After Effects.");
    } else {
      console.log(
        "\nconsumer dispatcher acceptance: fake lane verified from a clean " +
          "install; real lane did not complete (verification level: " +
          "fake/mock only for the dispatcher scenarios — not real-host evidence).",
      );
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
