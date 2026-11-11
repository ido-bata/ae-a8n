import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_CODES,
  SEVERITIES,
  aggregateDiagnosticStatus,
  diagnostic,
  type DiagnosticCheck,
  type DiagnosticCode,
} from "../src/doctor/diagnostics.js";
import { NODE_FLOOR_MAJOR } from "../src/doctor/index.js";
import type { PlatformAdapter, TargetSpec } from "../src/platform/contract.js";

const TARGET: TargetSpec = {
  name: "ae-test",
  isolation: "session",
  user: "ae-test",
  host: null,
};

const CONTRACT = new URL("../specs/isolated-ae/contracts/cli.md", import.meta.url);

function contractRows(): Array<{ code: string; severity: string }> {
  const text = readFileSync(CONTRACT, "utf8");
  const rows: Array<{ code: string; severity: string }> = [];
  for (const match of text.matchAll(/^\| `(A8N-[A-Z]+-\d{3})` \| (info|warning|blocker) \|/gm)) {
    const code = match[1];
    const severity = match[2];
    if (code !== undefined && severity !== undefined) {
      rows.push({ code, severity });
    }
  }
  return rows;
}

describe("diagnostic registry", () => {
  it("matches the reviewed contract one-for-one", () => {
    const rows = contractRows();
    const fromContract = rows.map((row) => row.code).sort();
    const fromRegistry = Object.keys(DIAGNOSTIC_CODES).sort();
    expect(fromContract).toEqual(fromRegistry);
  });

  it("keeps every severity equal to the contract", () => {
    for (const row of contractRows()) {
      const registered = DIAGNOSTIC_CODES[row.code as DiagnosticCode];
      expect(registered.severity, row.code).toBe(row.severity);
    }
  });

  it("uses the documented code format and a non-empty title", () => {
    for (const [code, entry] of Object.entries(DIAGNOSTIC_CODES)) {
      expect(code).toMatch(/^A8N-(ENV|SESSION|PERM|AE|JOB|SEC|EXT|RELEASE)-\d{3}$/);
      expect(SEVERITIES).toContain(entry.severity);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it("builds a check from the registry, not from the caller", () => {
    const check = diagnostic("A8N-AE-001", {
      detail: "two AfterFX.exe processes",
      remedy: "Quit After Effects in the test session.",
      remedyKind: "human",
    });
    expect(check.severity).toBe("blocker");
    expect(check.title).toBe(DIAGNOSTIC_CODES["A8N-AE-001"].title);
    expect(check.evidence).toEqual({});
  });

  it("keeps evidence when it is given", () => {
    const check = diagnostic("A8N-SESSION-002", {
      detail: "no Aqua session",
      remedy: "Log the account in once.",
      remedyKind: "human",
      evidence: { uid: 502, asid: null },
    });
    expect(check.evidence).toEqual({ uid: 502, asid: null });
  });
});

describe("the Node floor", () => {
  it("is the floor package.json declares", () => {
    // The constant is a copy; nothing else ties it to the published metadata.
    // A bump to `engines.node` without this constant would make `doctor`
    // enforce a version the package does not require (or one it does not run
    // on) and no test would notice.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const declared = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? "");
    expect(declared?.[1], `engines.node is ${String(pkg.engines?.node)}`).toBe("22");
    expect(NODE_FLOOR_MAJOR).toBe(22);
  });

  it("names the machine whose version it measured", async () => {
    // `doctor` measures the process running it. For a remote target that is
    // the controller, not the host, and a remedy that says "this machine"
    // would send the operator to the wrong one.
    const original = Object.getOwnPropertyDescriptor(process, "version");
    Object.defineProperty(process, "version", { value: "v12.0.0", configurable: true });
    try {
      const { runDoctor } = await import("../src/doctor/index.js");
      const adapter = { probe: () => Promise.resolve({ checks: [] }) } as unknown as PlatformAdapter;
      const result = await runDoctor(adapter, { ...TARGET, host: "WIN-AE-01" });
      const check = result.checks.find((entry) => entry.code === "A8N-ENV-002");
      expect(check?.detail).toMatch(/Node v12\.0\.0 on the controller \(.+\)/);
      expect(check?.detail).not.toContain("WIN-AE-01");
      expect(check?.evidence).toMatchObject({ node: "v12.0.0", floor: NODE_FLOOR_MAJOR });
    } finally {
      if (original === undefined) {
        delete (process as { version?: string }).version;
      } else {
        Object.defineProperty(process, "version", original);
      }
    }
  });
});

describe("diagnostic status", () => {
  const warning: DiagnosticCheck = diagnostic("A8N-ENV-004", {
    detail: "two installs",
    remedy: "Pass installDir.",
    remedyKind: "human",
  });
  const blocker: DiagnosticCheck = diagnostic("A8N-ENV-003", {
    detail: "no install",
    remedy: "Install After Effects.",
    remedyKind: "human",
  });

  it("is ok with no checks", () => {
    expect(aggregateDiagnosticStatus([])).toBe("ok");
  });

  it("is ok with warnings only", () => {
    expect(aggregateDiagnosticStatus([warning])).toBe("ok");
  });

  it("is blocked when any check is a blocker", () => {
    expect(aggregateDiagnosticStatus([warning, blocker])).toBe("blocked");
  });
});
