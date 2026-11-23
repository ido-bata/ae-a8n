/**
 * `ae-a8n supervise status` (#287): the CLI reads the same durable
 * supervision document every consumer reads, and its exit code is the
 * supervision answer — never a fabricated healthy one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import { applySupervisionEvent, initialSupervisionDoc } from "../src/supervision/machine.js";
import { writeSupervisionState } from "../src/supervision/state.js";
import type { CliEnvelope } from "../src/cli/envelope.js";

const roots: string[] = [];
function sessionRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-supervise-cli-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      writeOut: (text: string) => void out.push(text),
      writeErr: (text: string) => void err.push(text),
    },
  };
}

function blockedDoc(now: Date) {
  const result = applySupervisionEvent(
    initialSupervisionDoc({ now }),
    {
      kind: "blocking-observed",
      blocking: {
        host: "none",
        windows: [
          {
            title: "Script Error",
            role: "AXWindow",
            subrole: null,
            texts: ["line 3"],
            buttons: ["OK"],
            blocking: true,
            tier: "unknown",
            dialogClass: null,
            code: "A8N-SEC-001",
          },
        ],
        detail: "1 blocking window(s): Script Error",
      },
      reason: "fixture",
      deadlineMs: 60_000,
    },
    now,
  );
  if (!result.ok) throw new Error("fixture");
  return result.doc;
}

describe("ae-a8n supervise status", () => {
  it("reports unavailable for an absent state file — never a clean bill", async () => {
    const dir = sessionRoot();
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir, "--json"], deps);
    expect(code).toBe(6);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("unknown");
    expect((envelope.facts as { status: string }).status).toBe("unavailable");
    void out;
  });

  it("reports a blocked phase with exit 3 and the window evidence", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, blockedDoc(new Date()));
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir, "--json"], deps);
    expect(code).toBe(3);
    const envelope = JSON.parse(out.join("")) as CliEnvelope;
    expect(envelope.status).toBe("blocked");
    const facts = envelope.facts as { status: string; doc: { phase: string; blocking: { detail: string } } };
    expect(facts.status).toBe("observed");
    expect(facts.doc.phase).toBe("blocked");
    expect(facts.doc.blocking.detail).toContain("Script Error");
    expect(envelope.nextActions.length).toBeGreaterThan(0);
  });

  it("reports running with exit 0", async () => {
    const dir = sessionRoot();
    writeSupervisionState(dir, initialSupervisionDoc({ now: new Date() }));
    const { out, deps } = capture();
    const code = await runCli(["supervise", "status", "--session-root", dir], deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: running");
  });

  it("rejects a missing --session-root as usage", async () => {
    const { err, deps } = capture();
    const code = await runCli(["supervise", "status"], deps);
    expect(code).toBe(2);
    expect(err.join("")).toContain("--session-root");
  });
});
