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
 *     against a real After Effects. The probe prepares the channel — staging
 *     the consumer extension host script built by the packed CLI — prints
 *     the `activate.jsx` path, and waits for a human to run it via
 *     File > Scripts > Run Script File. No heartbeat within the wait
 *     budget is `blocked`, not a pass.
 *
 * Channel lifecycle (#155): the real lane's channel is the unit that binds
 * human activation to consumer operations — the `activate.jsx` a human runs
 * and the `AfterEffects.launch` the probe performs must name the same
 * channelDir and the same staged host script. By default the lane uses a
 * fresh temporary channel per run; `--channel-dir <abs>` reuses a durable
 * one instead, which is what makes re-runs work: `prepare()` is idempotent
 * (the channel token is created once), so a dispatcher activated earlier
 * keeps answering and a second activation is never needed. `--prepare-only`
 * stops after staging and printing the activation instructions, so the
 * human can activate before the scenario run. A channel that already has a
 * fresh heartbeat is reused as-is — the lane never asks for a second
 * activation on it. The staged host script lives inside the channel
 * (`a8n-host.js`), so what After Effects runs is fixed at `prepare()` time;
 * rebuilding the fixture later does not change a running dispatcher.
 * Cleanup is the operator's: remove the channel directory when done
 * (`rm -rf <channelDir>`); the default temporary channel is left for the OS
 * tmp cleaner. Point `--channel-dir` at a dedicated directory — never at a
 * channel another consumer uses — because the lane connects to whatever
 * dispatcher answers there (the extension-set check still refuses a
 * dispatcher running different staged bytes).
 *
 * Result contract: every probe prints a final `A8N_RESULT <json>` line and
 * exits 0 (pass / prepared / skipped), 1 (a scenario failed) or 3 (blocked —
 * no heartbeat inside the wait budget). The wrapper prints one
 * `A8N_RESULT {"fake":…,"real":…}` on every terminal path — including
 * harness-level failures, where the affected lane reads "fail" or
 * "unknown" — and exits 3 when the real lane is blocked. Exit code 0
 * therefore never means "real-host verified" on its own: `real:"skipped"`
 * and `real:"blocked"` are explicit in the JSON, and only `real:"pass"` is
 * real-host evidence.
 *
 * The extension fixture is a consumer-side module built by the packed CLI
 * (`ae-a8n extension build`), exactly as a downstream consumer would.
 *
 * Usage:
 *   node scripts/check-dispatcher-acceptance.js [--project <abs .aep>]
 *         [--channel-dir <abs dir>] [--prepare-only]
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
let channelDir = null;
let prepareOnly = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--project") {
    projectPath = args[i + 1];
    i += 1;
  } else if (args[i] === "--channel-dir") {
    channelDir = args[i + 1];
    i += 1;
  } else if (args[i] === "--prepare-only") {
    prepareOnly = true;
  } else {
    console.error(
      `::error::unknown argument ${args[i]}; usage: node scripts/check-dispatcher-acceptance.js [--project <path>] [--channel-dir <dir>] [--prepare-only]`,
    );
    process.exit(1);
  }
}
if (projectPath !== null && !isAbsolute(projectPath)) {
  console.error("::error::--project must be an absolute path");
  process.exit(1);
}
if (channelDir !== null && !isAbsolute(channelDir)) {
  console.error("::error::--channel-dir must be an absolute path");
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  return execFileSync(command, cmdArgs, { encoding: "utf-8", ...options });
}

/* The lane verdicts the wrapper reports: "pass" | "fail" | "blocked" |
 * "prepared" | "skipped" | "unknown". Only "pass" is real-host evidence;
 * the final A8N_RESULT line is the machine-readable contract callers must
 * read — exit code 0 alone never means the real lane was verified. */
const EXPECTED_PROBE_EXIT = { pass: 0, prepared: 0, skipped: 0, blocked: 3, fail: 1 };

let fakeStatus = "unknown";
let realStatus = "skipped";
let harnessFailed = false;
let workdir = null;
let tarball = null;

try {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

  console.log(`packing ${manifest.name}@${manifest.version}…`);
  // Same rule as check-consumer-smoke.js: npm runs as `node <npm-cli.js>`,
  // never through a shell (scripts/npm-cli.js).
  const npm = npmCommand();
  const tarballName = run(npm.command, [...npm.args, "pack", "--silent"], { cwd: PACKAGE_ROOT })
    .trim()
    .split("\n")
    .at(-1);
  tarball = join(PACKAGE_ROOT, tarballName);

  workdir = mkdtempSync(join(tmpdir(), "a8n-dispatcher-acceptance-"));
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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const CHANNEL_DIR = ${JSON.stringify(channelDir)};
const PREPARE_ONLY = ${JSON.stringify(prepareOnly)};
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
async function runScenarios(ae) {
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

  return { instance };
}

/* Isolation checks shared by both lanes: an unauthorized session is refused,
 * a wrong instance pin never launches, and the reported pin reconnects to
 * the same dispatcher instance. */
async function runIsolationChecks({ channelDir, instance }) {
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

  if (typeof instance === "string" && instance.length > 0) {
    const ae3 = await AfterEffects.launch({
      transport: { kind: "in-ae-dispatcher", channelDir, instance },
      hostScript: HOST_SCRIPT,
      sessionRoot: tmp("a8n-acc-session4-"),
      authorization: { extensionMethods: true },
    });
    await check("pinned reconnect reaches the same instance", async () => {
      const hs3 = await ae3.capabilities();
      assert(
        hs3.target.dispatcherInstance === instance,
        "reconnect bound a different instance",
      );
    });
    await ae3.close();
  }
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
  // The main session stays open for every scenario and is closed last, with
  // the edits we made discarded — the fixture project on disk is never
  // written.
  let boundInstance = null;
  await check("handshake, edit, render, extension call, undeclared refusal", async () => {
    boundInstance = (await runScenarios(ae)).instance;
  });

  // Sessions below need the dispatcher answering.
  await runIsolationChecks({ channelDir, instance: boundInstance });

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

/* Prints the machine-readable lane result. It must stay the last stdout
 * line: the wrapper and operators parse the A8N_RESULT json rather than
 * exit codes or prose. Exactly one line per lane run — emit once, after
 * every override (e.g. a failed close) has been applied. */
function emitResult(lane, status, extra = {}) {
  console.log(
    "A8N_RESULT " +
      JSON.stringify({ lane, status, failures, ...extra }),
  );
}

function activationInstructions(transport, channelDir) {
  console.log("real lane: activate the dispatcher inside After Effects:");
  console.log("  File > Scripts > Run Script File");
  console.log("  " + transport.activateScriptPath);
  console.log("channel: " + channelDir);
  console.log(
    "rules: run activate.jsx once per After Effects process — never twice on " +
      "the same AE, and never on a second AE while this channel is in use; " +
      "the channel identifies one dispatcher instance.",
  );
}

async function realLane() {
  // CHANNEL_DIR reuses a durable channel across runs (prepare() is
  // idempotent: the token survives, the staged host script is refreshed);
  // without it each run gets a fresh temporary channel.
  const channelDir = CHANNEL_DIR ?? join(tmp("a8n-acc-channel-"), "channel");
  const sessionRoot = tmp("a8n-acc-session-");
  const transport = new DispatcherTransport({ channelDir, hostScriptPath: HOST_SCRIPT });
  await transport.prepare();

  if (PREPARE_ONLY) {
    activationInstructions(transport, channelDir);
    console.log(
      "real lane: --prepare-only — channel staged, activation left to the " +
        "human. Re-run without --prepare-only once the heartbeat is fresh.",
    );
    emitResult("real", "prepared", { channelDir });
    return 0;
  }

  let status = transport.status();
  if (status.heartbeat && status.heartbeat.fresh) {
    // A dispatcher is already answering this channel — almost always a
    // previous run's activation. Reuse it; asking for a second activation
    // would be wrong (the host refuses doubles anyway) and connecting to a
    // *different* instance is what the pin checks below guard against.
    console.log(
      "dispatcher already answering on this channel (instance " +
        status.heartbeat.instance +
        ", ae " + status.heartbeat.aeVersion +
        ") — reusing it; do not run activate.jsx again.",
    );
  } else {
    activationInstructions(transport, channelDir);
    console.log("waiting up to " + WAIT_MS + "ms for a heartbeat…");
    const deadline = Date.now() + WAIT_MS;
    while (!(status.heartbeat && status.heartbeat.fresh)) {
      if (Date.now() > deadline) {
        console.log("RESULT: blocked — no dispatcher heartbeat within the wait budget (human activation did not happen or AE is not running)");
        emitResult("real", "blocked", { channelDir });
        return 3;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      status = transport.status();
    }
  }
  console.log("dispatcher heartbeat fresh (instance " + status.heartbeat.instance + ")");

  const ae = await AfterEffects.launch({
    transport,
    sessionRoot,
    authorization: { extensionMethods: true },
  });
  // The lane verdict is computed inside try and can still be overridden by
  // the close check in finally; A8N_RESULT is emitted exactly once, after.
  let laneStatus = "fail";
  let laneExtra = { channelDir };
  try {
    if (PROJECT !== null) {
      await ae.openProject(PROJECT);
    }
    let boundInstance = null;
    await check("handshake, edit, render, extension call, undeclared refusal", async () => {
      boundInstance = (await runScenarios(ae)).instance;
    });
    // The same isolation checks as the fake lane: unauthorized refusal,
    // wrong-pin refusal, pinned reconnect. UNKNOWN non-resend stays
    // fake-lane-only — a human cannot be asked to stop the dispatcher.
    await runIsolationChecks({ channelDir, instance: boundInstance });

    console.log("real lane results:");
    for (const line of results) console.log("  " + line);
    laneStatus = failures === 0 ? "pass" : "fail";
    laneExtra = { channelDir, instance: boundInstance };
    console.log(failures === 0 ? "RESULT: real-host pass" : "RESULT: real-host FAIL");
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
      laneStatus = "fail";
      laneExtra = { channelDir, reason: "close quit an attached host" };
    }
  }
  emitResult("real", laneStatus, laneExtra);
  return laneStatus === "pass" ? 0 : 1;
}

const mode = process.argv[2];
if (mode === "fake") {
  const fakeFailures = await fakeLane();
  emitResult("fake", fakeFailures === 0 ? "pass" : "fail");
  process.exitCode = fakeFailures === 0 ? 0 : 1;
} else if (mode === "real") {
  if (PROJECT === null && !PREPARE_ONLY) {
    console.log("RESULT: skipped — the real lane needs --project <abs .aep> (an explicit disposable fixture; editing and rendering must not touch whatever project happens to be open)");
    console.log('A8N_RESULT {"lane":"real","status":"skipped","reason":"no --project fixture"}');
    process.exitCode = 0;
  } else {
    process.exitCode = await realLane();
  }
} else {
  console.error("usage: acceptance.mjs fake|real");
  process.exitCode = 2;
}
`,
    "utf-8",
  );

  function runProbe(mode) {
    try {
      const output = run(process.execPath, [probePath, mode], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, status: 0, output: String(output) };
    } catch (error) {
      return {
        ok: false,
        status: typeof error.status === "number" ? error.status : 1,
        output: `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /* The probe's last `A8N_RESULT <json>` line is the lane's machine-readable
   * verdict; prose and exit codes only back it up. */
  function probeResult(output) {
    const line = output
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("A8N_RESULT "))
      .at(-1);
    if (line === undefined) return null;
    try {
      return JSON.parse(line.slice("A8N_RESULT ".length));
    } catch {
      return null;
    }
  }

  // --- Fake lane: always runs; evidence is fake/mock only. ----------------

  console.log("\nfake lane (packed package + fake AE host)…");
  const fake = runProbe("fake");
  console.log(fake.output.trim());
  const fakeVerdict = probeResult(fake.output);
  fakeStatus =
    fake.ok && fakeVerdict !== null && fakeVerdict.status === "pass" ? "pass" : "fail";
  if (fakeStatus !== "pass") {
    console.log("fake lane failed — the real lane is not attempted on a broken candidate.");
  }

  // --- Real lane: needs an explicit fixture project and a human to
  //     activate the dispatcher inside After Effects. ----------------------

  const skipReal = process.env.A8N_ACCEPTANCE_SKIP_REAL === "1";
  if (fakeStatus !== "pass") {
    // realStatus stays "skipped": the lane never ran.
  } else if (skipReal) {
    console.log("\nreal lane: skipped (A8N_ACCEPTANCE_SKIP_REAL=1)");
  } else if (projectPath === null && !prepareOnly) {
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
    const verdict = probeResult(real.output);
    const status =
      verdict !== null && typeof verdict.status === "string" ? verdict.status : null;
    // A verdict only counts when the probe's exit status agrees with the
    // documented mapping — a "pass" line from a crashed probe is a fail.
    realStatus =
      status !== null && EXPECTED_PROBE_EXIT[status] === real.status ? status : "fail";
    if (realStatus === "pass") {
      console.log("\nconsumer dispatcher acceptance passed against a real After Effects.");
    } else if (realStatus === "blocked") {
      console.log(
        "\nconsumer dispatcher acceptance: real lane blocked — no dispatcher " +
          "heartbeat inside the wait budget. That is unverified, not a pass; " +
          "re-run once a human has activated the printed activate.jsx.",
      );
    } else {
      console.log(
        "\nconsumer dispatcher acceptance: fake lane verified from a clean " +
          `install; real lane ${realStatus} (verification level: ` +
          "fake/mock only for the dispatcher scenarios — not real-host evidence).",
      );
    }
  }
} catch (error) {
  harnessFailed = true;
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
  if (tarball !== null) rmSync(tarball, { force: true });
  // The wrapper's own A8N_RESULT is the last line on every terminal path —
  // pass, fail, blocked, skipped, or a harness-level failure above.
  console.log("A8N_RESULT " + JSON.stringify({ fake: fakeStatus, real: realStatus }));
  if (
    harnessFailed ||
    fakeStatus !== "pass" ||
    realStatus === "fail" ||
    realStatus === "unknown"
  ) {
    process.exitCode = 1;
  } else if (realStatus === "blocked") {
    // Blocked is not a pass and not a harness failure: exit 3 matches the
    // CLI's blocked code so automation cannot mistake it for success.
    process.exitCode = 3;
  }
}
