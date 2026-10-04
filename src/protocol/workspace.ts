/**
 * On-disk layout of one driver session.
 *
 * The driver writes requests into `inbox/`, the host writes results into
 * `outbox/`, and every file is published by rename so a reader never observes
 * a half-written envelope.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProtocolError, type RequestEnvelope } from "./envelope.js";
import { PROTOCOL_VERSION } from "./envelope.js";

export const REQUEST_POLL_INTERVAL_MS = 10;
export const REQUEST_POLL_MAX_INTERVAL_MS = 100;

export type SessionPaths = {
  readonly root: string;
  readonly inbox: string;
  readonly outbox: string;
  readonly artifacts: string;
  readonly trace: string;
  readonly staging: string;
};

export function createSessionPaths(root: string): SessionPaths {
  const paths: SessionPaths = {
    root,
    inbox: join(root, "inbox"),
    outbox: join(root, "outbox"),
    artifacts: join(root, "artifacts"),
    trace: join(root, "trace.jsonl"),
    staging: join(root, "staging"),
  };
  for (const dir of [
    paths.root,
    paths.inbox,
    paths.outbox,
    paths.artifacts,
    paths.staging,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function disposeSession(paths: SessionPaths): void {
  rmSync(paths.root, { recursive: true, force: true });
}

function writeAtomically(target: string, contents: string): void {
  // Same-directory staging keeps the rename on one filesystem, which is what
  // makes it atomic. ExtendScript's File.rename cannot overwrite, so the
  // target is removed first; readers only ever look up ids that are unique.
  const staging = `${target}.part`;
  writeFileSync(staging, contents, "utf-8");
  rmSync(target, { force: true });
  renameSync(staging, target);
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function nextRequestId(): string {
  return randomUUID();
}

export function writeRequest(paths: SessionPaths, request: RequestEnvelope): string {
  const path = join(paths.inbox, `${request.id}.request.json`);
  writeAtomically(path, JSON.stringify(request));
  return path;
}

/**
 * Returns the parsed result file, or `null` if the host has not written one yet.
 *
 * The return type is `unknown`, not `ResultEnvelope`, because the contents are
 * **not** validated here — `parseResultEnvelope` does that. Typing this as an
 * envelope would let a caller skip the one check the bridge protocol exists to
 * provide, and `unknown` already subsumes `null`, so the null case is carried
 * by this contract rather than by the type.
 */
export function readResultIfPresent(paths: SessionPaths, id: string): unknown {
  const path = join(paths.outbox, `${id}.result.json`);
  const raw = readIfPresent(path);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProtocolError(
      `result file for ${id} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parsed;
}

export function writeSessionManifest(
  paths: SessionPaths,
  manifest: Record<string, unknown>,
): void {
  writeAtomically(
    join(paths.root, "a8n-session.json"),
    JSON.stringify({ v: PROTOCOL_VERSION, ...manifest }, null, 2),
  );
}
