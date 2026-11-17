/**
 * The consumer-acceptance surface (#130) is only useful if the pieces that
 * make it reproducible stay wired together: the doc must name the procedure,
 * the consumers, and the verification-level format; the smoke script must
 * exist and keep its skip-never-fake contract; CI must actually run it.
 *
 * These are static checks on purpose — the behavioural proof is
 * `scripts/check-consumer-smoke.js` itself, which CI executes.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

const doc = read("docs/consumer-acceptance.md");
const script = read("scripts/check-consumer-smoke.js");
const dispatcherScript = read("scripts/check-dispatcher-acceptance.js");
const rcDoc = read("docs/evidence/release-0-2-0-rc/README.md");
const example = read("examples/smoke.ts");
const workflow = read(".github/workflows/ci.yml");

describe("docs/consumer-acceptance.md", () => {
  it("names both downstream consumers and their tracking issues", () => {
    expect(doc).toContain("ae-test");
    expect(doc).toContain("ido-bata/ae-test/issues/19");
    expect(doc).toContain("Aulymo");
    expect(doc).toContain("rebuildup/Aulymo_v04/issues/332");
    expect(doc).toContain("rebuildup/Aulymo_v04/issues/333");
  });

  it("records the three deliverables consumers need", () => {
    expect(doc).toContain("package bytes");
    expect(doc).toContain("capability handshake");
    expect(doc).toContain("diagnostics");
  });

  it("keeps the verification-level recording format honest", () => {
    expect(doc).toContain("verification level");
    expect(doc).toContain("verified on real host");
    expect(doc).toContain("fake/mock only");
    // The no-fake-green rule must be stated, not implied.
    expect(doc).toMatch(/stable \/ latest|stable\/latest|latest.*公開しない|公開しない/);
  });

  it("lists consumer acceptance gaps without implementing them here", () => {
    expect(doc).toMatch(/実装しない|do not implement|ticket 候補/);
  });
});

describe("scripts/check-consumer-smoke.js", () => {
  it("installs the packed tarball into a clean project, not this repo", () => {
    expect(script).toContain("npm pack");
    expect(script).toContain("mkdtempSync");
    expect(script).toContain('"install"');
  });

  it("drives the launch → version → project → close smoke", () => {
    expect(script).toContain("AfterEffects.launch");
    expect(script).toContain("ae.version()");
    expect(script).toContain("ae.project()");
    expect(script).toContain("ae.close()");
    expect(script).toContain("ae.capabilities()");
    expect(script).toContain("ae.diagnostics()");
  });

  it("skips — never fakes — the real-host steps without After Effects", () => {
    expect(script).toContain("AfterEffectsNotInstalledError");
    expect(script).toContain("RESULT: skipped");
    expect(script).toContain("A8N_SMOKE_SKIP_REAL_HOST");
  });
});

describe("scripts/check-dispatcher-acceptance.js (#148)", () => {
  it("packs and clean-installs the candidate like the consumer smoke", () => {
    expect(dispatcherScript).toContain("npmCommand");
    expect(dispatcherScript).toContain('"pack"');
    expect(dispatcherScript).toContain("mkdtempSync");
    expect(dispatcherScript).toContain('"install"');
  });

  it("builds the extension fixture through the packed CLI", () => {
    expect(dispatcherScript).toContain("extension");
    expect(dispatcherScript).toContain("build");
    expect(dispatcherScript).toContain("acceptance.ping");
  });

  it("covers the dispatcher scenarios in a fake lane and a human-gated real lane", () => {
    for (const needle of [
      "capabilities()",
      "addTextLayer",
      "renderFrame",
      "ae.call",
      "dispatcherInstance",
      "HostNotOwnedError",
      "TimeoutError",
      "quitCount",
      "in-ae-dispatcher",
    ]) {
      expect(dispatcherScript).toContain(needle);
    }
    // The real lane must wait for a human activation and report blocked,
    // never a pass, when no heartbeat arrives.
    expect(dispatcherScript).toContain("RESULT: blocked");
    expect(dispatcherScript).toContain("A8N_ACCEPTANCE_WAIT_MS");
    expect(dispatcherScript).toContain("A8N_ACCEPTANCE_SKIP_REAL");
    // Fake-lane evidence is labelled, not passed off as real-host.
    expect(dispatcherScript).toContain("fake/mock only");
    expect(dispatcherScript).toContain("RESULT: real-host pass");
  });

  it("binds human activation and consumer operations to one channel (#155)", () => {
    // The real lane accepts a durable --channel-dir and a --prepare-only
    // stage, reuses a fresh heartbeat instead of asking for a second
    // activation, and always drives the channel it prepared itself.
    for (const needle of [
      '"--channel-dir"',
      '"--prepare-only"',
      "CHANNEL_DIR ??",
      "PREPARE_ONLY",
      "already answering on this channel",
      "do not run activate.jsx again",
    ]) {
      expect(dispatcherScript).toContain(needle);
    }
  });

  it("reports a machine-readable result where blocked can never read as pass", () => {
    // Every probe ends with an A8N_RESULT json line; the wrapper emits one
    // for the whole run and maps blocked to exit 3, fail to exit 1.
    expect(dispatcherScript).toContain("A8N_RESULT ");
    expect(dispatcherScript).toContain('"blocked"');
    expect(dispatcherScript).toContain("process.exitCode = 3");
    expect(dispatcherScript).toContain("probeResult");
    // The documented verdict set must match what the probe can emit.
    for (const status of ["pass", "fail", "blocked", "prepared", "skipped"]) {
      expect(dispatcherScript).toContain(`"${status}"`);
    }
  });
});

describe("the documented real-lane procedure matches the harness (#155)", () => {
  it("consumer-acceptance.md names the same channel contract and result format", () => {
    for (const needle of [
      "--channel-dir",
      "--prepare-only",
      "A8N_RESULT",
      "同一 channel",
      "二重 activation",
    ]) {
      expect(doc).toContain(needle);
    }
  });

  it("the RC evidence procedure only uses flags the script accepts", () => {
    // Every invocation of the harness in the frozen RC doc must parse: the
    // flags it shows are exactly the ones check-dispatcher-acceptance.js
    // implements. This is what keeps the written procedure and the real
    // lane from drifting apart again.
    const invocations = rcDoc.match(/node scripts\/check-dispatcher-acceptance\.js[^\n]*/g) ?? [];
    expect(invocations.length).toBeGreaterThan(0);
    const allowed = new Set(["--project", "--channel-dir", "--prepare-only"]);
    for (const line of invocations) {
      const tokens = line.split(/\s+/).slice(1);
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === undefined || !token.startsWith("--")) continue;
        expect(allowed.has(token)).toBe(true);
        // --project and --channel-dir take a value; --prepare-only does not.
        if (token === "--project" || token === "--channel-dir") i += 1;
      }
    }
    // The procedure must route activation through the harness's own channel,
    // not through a separately prepared default channel.
    expect(rcDoc).toContain("--channel-dir");
    expect(rcDoc).toContain("A8N_RESULT");
    expect(rcDoc).not.toContain("dispatcher prepare");
  });
});

describe("examples/smoke.ts", () => {
  it("is the read-only consumer smoke and degrades without AE", () => {
    expect(example).toContain("AfterEffects.launch");
    expect(example).toContain("AfterEffectsNotInstalledError");
    expect(example).toContain("resolveInstall");
    expect(example).toContain("skipped");
  });
});

describe("CI wiring", () => {
  it("runs the consumer smoke on both check and windows jobs", () => {
    const runs = workflow.match(/node scripts\/check-consumer-smoke\.js/g) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });

  it("runs the dispatcher acceptance fake lane on both check and windows jobs", () => {
    const runs = workflow.match(/node scripts\/check-dispatcher-acceptance\.js/g) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // CI must not attempt the real lane: it needs a human activation.
    expect(workflow.match(/A8N_ACCEPTANCE_SKIP_REAL/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
