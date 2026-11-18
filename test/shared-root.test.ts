import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectSharedRoot,
  SHARED_TMP_STALE_MS,
} from "../src/platform/darwin/shared-root.js";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 60_000;
const PAST = NOW - 60_000;

function fixture(): { root: string; jobs: string; results: string; logs: string } {
  const root = mkdtempSync(join(tmpdir(), "ae-a8n-shared-"));
  const jobs = join(root, "jobs");
  const results = join(root, "results");
  const logs = join(root, "logs");
  mkdirSync(jobs, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(logs, { recursive: true });
  return { root, jobs, results, logs };
}

function writeJob(jobs: string, id: string, deadline: number | "absent" | "bad"): void {
  const payload =
    deadline === "absent"
      ? { id, command: ["node", "x"] }
      : deadline === "bad"
        ? { id, command: ["node", "x"], deadline: "soon" }
        : { id, command: ["node", "x"], deadline };
  writeFileSync(join(jobs, `${id}.job.json`), JSON.stringify(payload));
  chmodSync(join(jobs, `${id}.job.json`), 0o644);
}

function jobState(root: string, trustedUid: number | null = process.getuid?.() ?? 0, now = NOW) {
  const report = inspectSharedRoot(root, { trustedUid, now });
  expect(report.present).toBe(true);
  return report.jobs.map((job) => ({ name: job.name, state: job.state }));
}

describe("inspectSharedRoot", () => {
  it("reports a missing root as not present", () => {
    const report = inspectSharedRoot(join(tmpdir(), "ae-a8n-no-such-root-xyz"));
    expect(report.present).toBe(false);
    expect(report.jobs).toEqual([]);
  });

  it("classifies a job with a future deadline as pending", () => {
    const { root, jobs } = fixture();
    writeJob(jobs, "a", FUTURE);
    expect(jobState(root)).toEqual([{ name: "a.job.json", state: "pending" }]);
  });

  it("classifies past and missing deadlines as stale", () => {
    const { root, jobs } = fixture();
    writeJob(jobs, "old", PAST);
    writeJob(jobs, "none", "absent");
    writeJob(jobs, "bad", "bad");
    const states = jobState(root);
    expect(states.every((job) => job.state === "stale")).toBe(true);
  });

  it("classifies a job with a result as finished only for a real result file", () => {
    const { root, jobs, results } = fixture();
    writeJob(jobs, "done", FUTURE);
    writeJob(jobs, "tmpOnly", FUTURE);
    writeFileSync(join(results, "done.result.json"), "{}");
    // A publish temporary is not a result: the job is still pending.
    writeFileSync(join(results, "tmpOnly.result.json.1234.abcd1234.tmp"), "{}");
    const states = jobState(root);
    expect(states.find((job) => job.name === "done.job.json")?.state).toBe("finished");
    expect(states.find((job) => job.name === "tmpOnly.job.json")?.state).toBe("pending");
  });

  it("classifies a cancelled job", () => {
    const { root, jobs } = fixture();
    writeJob(jobs, "c", FUTURE);
    writeFileSync(join(jobs, "c.cancel"), "");
    expect(jobState(root).find((job) => job.name === "c.job.json")?.state).toBe("cancelled");
  });

  it("classifies malformed and untrusted jobs distinctly", () => {
    const { root, jobs } = fixture();
    writeFileSync(join(jobs, "broken.job.json"), "not json");
    chmodSync(join(jobs, "broken.job.json"), 0o644);
    writeJob(jobs, "open", FUTURE);
    chmodSync(join(jobs, "open.job.json"), 0o666);
    const states = jobState(root);
    expect(states.find((job) => job.name === "broken.job.json")?.state).toBe("malformed");
    expect(states.find((job) => job.name === "open.job.json")?.state).toBe("untrusted");
  });

  it("refuses symlinks as untrusted", () => {
    const { root, jobs } = fixture();
    const target = join(root, "real.job.json");
    writeFileSync(target, JSON.stringify({ id: "x", deadline: FUTURE }));
    chmodSync(target, 0o644);
    symlinkSync(target, join(jobs, "link.job.json"));
    // jobs/real.job.json sits outside jobs/, so only the symlink is listed.
    const states = jobState(root);
    expect(states).toEqual([{ name: "link.job.json", state: "untrusted" }]);
  });

  it("reports unknown when the publishing account cannot be determined", () => {
    const { root, jobs } = fixture();
    writeJob(jobs, "a", FUTURE);
    const report = inspectSharedRoot(root, { trustedUid: null, now: NOW });
    expect(report.jobs[0]?.state).toBe("unknown");
  });

  it("trusts the banner's trustedUid over the caller's uid when none is injected", () => {
    const { root, jobs, results } = fixture();
    writeJob(jobs, "a", FUTURE);
    const banner = {
      startedAt: new Date(NOW).toISOString(),
      session: { uid: 501, username: "ae", asid: 1, kind: "Aqua" },
      consoleUid: 502,
      trustedUid: process.getuid?.() ?? 0,
      isolated: true,
    };
    writeFileSync(join(results, "agent.json"), JSON.stringify(banner));
    const report = inspectSharedRoot(root, { now: NOW });
    expect(report.banner?.trustedUid).toBe(process.getuid?.() ?? 0);
    expect(report.banner?.isolated).toBe(true);
    expect(report.jobs[0]?.state).toBe("pending");
  });

  it("reports orphan results only against a real job file", () => {
    const { root, jobs, results } = fixture();
    writeJob(jobs, "kept", FUTURE);
    writeFileSync(join(results, "kept.result.json"), "{}");
    writeFileSync(join(results, "orphan.result.json"), "{}");
    // A result whose job exists only as a publish temporary is still an orphan.
    writeFileSync(join(results, "tmpjob.result.json"), "{}");
    writeFileSync(join(jobs, "tmpjob.job.json.1.abcd1234.tmp"), "{}");
    const report = inspectSharedRoot(root, {
      trustedUid: process.getuid?.() ?? 0,
      now: NOW,
    });
    expect([...report.orphanResults].sort()).toEqual(["orphan.result.json", "tmpjob.result.json"]);
    // kept.result.json pairs with a real job: the job is finished, not orphan.
    expect(report.jobs.find((job) => job.name === "kept.job.json")?.state).toBe("finished");
  });

  it("flags only publish temporaries older than the stale window", () => {
    const { root, jobs, results } = fixture();
    writeFileSync(join(jobs, "old.job.json.1.abcd1234.tmp"), "{}");
    writeFileSync(join(jobs, "fresh.job.json.2.abcd1234.tmp"), "{}");
    writeFileSync(join(results, "old.result.json.3.abcd1234.tmp"), "{}");
    const old = new Date(NOW - SHARED_TMP_STALE_MS - 1);
    const fresh = new Date(NOW - 1_000);
    utimesSync(join(jobs, "old.job.json.1.abcd1234.tmp"), old, old);
    utimesSync(join(jobs, "fresh.job.json.2.abcd1234.tmp"), fresh, fresh);
    utimesSync(join(results, "old.result.json.3.abcd1234.tmp"), old, old);
    const report = inspectSharedRoot(root, {
      trustedUid: process.getuid?.() ?? 0,
      now: NOW,
    });
    expect([...report.staleTemporaries].sort()).toEqual([
      "jobs/old.job.json.1.abcd1234.tmp",
      "results/old.result.json.3.abcd1234.tmp",
    ]);
  });

  it("collects non-job artifacts and logs without classifying them", () => {
    const { root, jobs, results, logs } = fixture();
    writeJob(jobs, "a", FUTURE);
    writeFileSync(join(jobs, "a.command"), "#!/bin/sh\n");
    writeFileSync(join(jobs, "a.cmd"), "");
    writeFileSync(join(results, "a.done"), "");
    writeFileSync(join(results, "a.out"), "");
    writeFileSync(join(results, "a.err"), "");
    writeFileSync(join(logs, "a.log"), "");
    const report = inspectSharedRoot(root, {
      trustedUid: process.getuid?.() ?? 0,
      now: NOW,
    });
    const kinds = report.otherArtifacts.map((a) => `${a.dir}/${a.kind}`).sort();
    expect(kinds).toEqual([
      "jobs/cmd",
      "jobs/command",
      "logs/log",
      "results/done",
      "results/stderr",
      "results/stdout",
    ]);
    expect(report.logs).toEqual(["a.log"]);
  });
});
