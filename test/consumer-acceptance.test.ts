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
});
