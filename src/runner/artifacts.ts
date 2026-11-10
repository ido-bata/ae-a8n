/**
 * What a run leaves behind (`specs/isolated-ae/spec.md` §8):
 * `manifest.json`, `report.json`, `trace.jsonl` and `artifacts/`.
 *
 * Every file has a `schemaVersion`. Nothing here records a credential or the
 * caller's environment: the run knows its own id and argv, and a secret is
 * never part of either.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionIdentity, TargetSpec } from "../platform/contract.js";

export const RUN_MANIFEST_SCHEMA = "1.0";
export const RUN_REPORT_SCHEMA = "1.0";
export const RUN_TRACE_SCHEMA = "1.0";

/** The contract's verdict per check (`contracts/cli.md` §8). */
export type RunVerdictVerdict = "pass" | "fail" | "blocked" | "unknown";

export type RunVerdict = {
  readonly id: string;
  readonly verdict: RunVerdictVerdict;
  readonly message: string;
};

export type RunArtifacts = {
  readonly manifest: string;
  readonly report: string;
  readonly trace: string;
  readonly files: readonly string[];
};

export type TraceEvent = {
  readonly at: string;
  readonly event: string;
  readonly detail: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
};

export type CapturedFile = {
  /** Path relative to the run directory, or null when it could not be kept. */
  readonly path: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
};

export type RunManifest = {
  readonly schemaVersion: typeof RUN_MANIFEST_SCHEMA;
  readonly runId: string;
  readonly command: readonly string[];
  readonly target: TargetSpec;
  readonly adapter: string;
  readonly identity: SessionIdentity | null;
  readonly package: { readonly name: string; readonly version: string; readonly commit: string | null };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly commandStartedAt: string | null;
  readonly commandFinishedAt: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: CapturedFile | null;
  readonly stderr: CapturedFile | null;
  readonly environment: Readonly<Record<string, string>>;
};

export type RunReport = {
  readonly schemaVersion: typeof RUN_REPORT_SCHEMA;
  readonly runId: string;
  readonly status: string;
  readonly verdicts: readonly RunVerdict[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly notice?: string;
};

/** A best-effort read-only copy; a missing source is recorded, not guessed. */
export function captureFile(
  source: string,
  destinationName: string,
  artifactsDirectory: string,
): CapturedFile {
  const destination = join(artifactsDirectory, destinationName);
  try {
    copyFileSync(source, destination);
    // Hash the copy's bytes, so the manifest describes what was kept.
    const bytes = readFileSync(destination);
    return {
      path: join("artifacts", destinationName),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  } catch {
    return { path: null, sha256: null, bytes: null };
  }
}

export type ArtifactInput = {
  readonly manifest: RunManifest;
  readonly report: RunReport;
  readonly trace: readonly TraceEvent[];
};

/** Writes the four contract artifacts into `runDirectory` and returns them. */
export function writeRunArtifacts(runDirectory: string, input: ArtifactInput): RunArtifacts {
  mkdirSync(join(runDirectory, "artifacts"), { recursive: true, mode: 0o700 });
  const manifestPath = join(runDirectory, "manifest.json");
  const reportPath = join(runDirectory, "report.json");
  const tracePath = join(runDirectory, "trace.jsonl");
  writeFileSync(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(reportPath, `${JSON.stringify(input.report, null, 2)}\n`, { mode: 0o600 });
  const traceLines = input.trace.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(tracePath, traceLines.length === 0 ? "" : `${traceLines}\n`, { mode: 0o600 });
  const files: string[] = [];
  for (const captured of [input.manifest.stdout, input.manifest.stderr]) {
    if (captured !== null && captured.path !== null) {
      files.push(captured.path);
    }
  }
  return { manifest: manifestPath, report: reportPath, trace: tracePath, files };
}
