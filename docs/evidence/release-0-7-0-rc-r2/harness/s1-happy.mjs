/**
 * RC-S1 — launch → handshake → read-only smoke → project open → render → close.
 * One attempt per invocation: `node s1-happy.mjs <label>`.
 * Public path only: packed-tarball AfterEffects.launch + ae.* API.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";
import {
  AE_2027_INSTALL,
  FIXTURE,
  Steps,
  recordAttempt,
  sessionArtifacts,
  shasumFile,
  writeJson,
} from "./lib.mjs";

const label = process.argv[2] ?? "s1";
const scenarioId = "RC-S1";
const sessionRoot = `/tmp/rc436r2-sessions/${label}`;
const steps = new Steps();
let ae = null;
let verdict = "fail";
let anomaly = null;
const notes = [];
const fixtureHashBefore = shasumFile(FIXTURE.path);

const t0 = Date.now();
try {
  ae = await steps.run(
    "launch+handshake-readiness",
    "AfterEffects.launch resolves within readinessTimeoutMs (180000) with owned session",
    () =>
      AfterEffects.launch({
        sessionRoot,
        installDir: AE_2027_INSTALL,
        readinessTimeoutMs: 180000,
        timeoutMs: 60000,
        recoveryGraceMs: 60000,
      }),
    ["trace:session.launch"],
  );

  // RC-S1 is the OWNED path only: an attached session (a leftover AE 2027
  // already running) proves nothing about launch→owned-close and must
  // never score pass — same false-pass class as run-1 planb-a (#436).
  const own = ae.ownership?.();
  if (own?.kind !== "owned") {
    verdict = "indeterminate";
    notes.push(`launch resolved as ownership=${own?.kind} (${String(own?.evidence).slice(0, 160)}) — not the owned RC-S1 path; scenario not exercised`);
    throw new Error("not an owned session");
  }

  await steps.run("capabilities", "ae.capabilities() returns handshake", async () => {
    const hs = await ae.capabilities();
    return { contractVersion: hs.contractVersion, ownership: hs.target.ownership, caps: hs.availableCapabilities.length };
  });

  await steps.run("version", "ae.version() returns 27.0x78", async () => {
    const v = await ae.version();
    return { version: v, info: ae.info() };
  });

  await steps.run(
    "openProject+state",
    `ae.openProject(${FIXTURE.id}) succeeds; project.info/state report the fixture`,
    async () => {
      const p = await ae.openProject(FIXTURE.path, { unsavedChanges: "discard" });
      const info = await p.info();
      const state = await p.state();
      return { file: info.file, name: info.name, itemCount: info.itemCount, state };
    },
  );

  await steps.run("comps", "fixture comp list contains 'A8N Acceptance'", async () => {
    const comps = await ae.comps();
    return comps.map((c) => c.name ?? c);
  });

  await steps.run(
    "renderFrame",
    "comp.renderFrame(0) writes a PNG artifact",
    async () => {
      const project = await ae.project();
      const comp = await project.comp("A8N Acceptance");
      return comp.renderFrame(0, { prefix: `${label}-frame` });
    },
    ["artifacts:*.png"],
  );

  await steps.run("close", "ae.close({unsavedChanges:'discard'}) quits the owned host", async () => {
    return ae.close({ unsavedChanges: "discard" });
  });
  ae = null;
  verdict = "pass";
} catch (e) {
  if (verdict !== "indeterminate") verdict = "fail";
  notes.push(`scenario error: ${e?.name}: ${String(e?.message ?? e).slice(0, 400)}`);
  try {
    if (ae) {
      const sup = ae.supervisionState?.();
      if (sup) notes.push(`supervision at failure: ${JSON.stringify(sup).slice(0, 600)}`);
    }
  } catch {}
} finally {
  if (ae) {
    try { await ae.close({ unsavedChanges: "discard" }); } catch {}
  }
}

const fixtureHashAfter = shasumFile(FIXTURE.path);
if (fixtureHashAfter !== fixtureHashBefore) {
  verdict = "fail";
  notes.push(`FIXTURE MUTATED: sha256 ${fixtureHashBefore} -> ${fixtureHashAfter}`);
}

const artifacts = sessionArtifacts(sessionRoot);
const cleanup = artifacts.teardown
  ? { verdict: artifacts.teardown.verdict, ref: artifacts.teardownPath }
  : { verdict: "unverifiable", ref: null };

const evidenceRefs = [
  artifacts.tracePath,
  artifacts.attemptLedgerPath,
  artifacts.teardownPath,
].filter(Boolean);

const summaryPath = `/tmp/rc436r2-sessions/${label}-summary.json`;
writeJson(summaryPath, { label, scenarioId, verdict, steps: steps.items, cleanup, sessionRoot });

recordAttempt({
  scenarioId,
  verdict,
  steps: steps.items,
  anomaly,
  cleanup,
  evidenceRefs: [...evidenceRefs, summaryPath],
  notes: notes.join(" | "),
  sessionId: null,
  sessionRoot,
});

console.log(`RC-S1 ${label}: ${verdict} (${Date.now() - t0}ms) cleanup=${cleanup.verdict}`);
if (verdict !== "pass") {
  const last = steps.items.at(-1);
  console.log("last step:", last?.stepId, JSON.stringify(last?.actual)?.slice(0, 300));
}
process.exit(verdict === "pass" ? 0 : 1);
