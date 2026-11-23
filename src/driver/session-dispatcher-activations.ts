/**
 * Session → dispatcher-channel activation record (#313).
 *
 * `AfterEffects.activateDispatcher()` delivers the in-AE dispatcher
 * activation script into the After Effects *process* the session owns —
 * the dispatcher it starts dies with that process. A verified rebuild
 * (#286) launches a new process, so it must know which dispatcher
 * channels the crashed session had activated in order to re-stage them.
 *
 * The durable evidence already exists per channel — `provenance.json`
 * names the host pid an activation was proven to run in (#294) — but a
 * channel directory is only discoverable if the caller named it. This
 * file is the session-side index: every successful `activateDispatcher()`
 * records the channel directory it activated, so a later rebuild can
 * enumerate them instead of guessing (the default channel alone would
 * silently miss a custom `channelDir`).
 *
 * The record is an index, not proof: rebuild still re-reads each
 * channel's own provenance and re-verifies the pid binding before
 * re-activating. A missing file means "no recorded activations" (sessions
 * from before this record existed, or none at all); a corrupt file is
 * reported as such — never silently treated as "none".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../errors.js";

export const SESSION_DISPATCHER_ACTIVATIONS_SCHEMA =
  "a8n.session-dispatcher-activations/v1";
export const SESSION_DISPATCHER_ACTIVATIONS_FILE = "dispatcher-activations.json";

export function sessionDispatcherActivationsPath(sessionRoot: string): string {
  return join(sessionRoot, SESSION_DISPATCHER_ACTIVATIONS_FILE);
}

type ActivationEntry = {
  readonly channelDir: string;
  readonly recordedAt: string;
};

type ActivationsDoc = {
  readonly schema: typeof SESSION_DISPATCHER_ACTIVATIONS_SCHEMA;
  readonly activations: readonly ActivationEntry[];
};

export type SessionDispatcherActivations =
  /** No record file: nothing was ever recorded for this session. */
  | { readonly kind: "absent" }
  /** The channel directories this session activated a dispatcher in. */
  | { readonly kind: "ok"; readonly channelDirs: readonly string[] }
  /** The file exists but cannot be trusted; callers must report, not guess. */
  | { readonly kind: "corrupt"; readonly detail: string };

function readEntries(sessionRoot: string):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly entries: readonly ActivationEntry[] }
  | { readonly kind: "corrupt"; readonly detail: string } {
  const path = sessionDispatcherActivationsPath(sessionRoot);
  if (!existsSync(path)) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return {
      kind: "corrupt",
      detail: `not readable JSON: ${errorMessage(error)}`,
    };
  }
  const doc = parsed as Partial<ActivationsDoc> | null;
  if (
    doc === null ||
    typeof doc !== "object" ||
    doc.schema !== SESSION_DISPATCHER_ACTIVATIONS_SCHEMA ||
    !Array.isArray(doc.activations)
  ) {
    return {
      kind: "corrupt",
      detail: `does not match ${SESSION_DISPATCHER_ACTIVATIONS_SCHEMA}`,
    };
  }
  const entries: ActivationEntry[] = [];
  for (const entry of doc.activations) {
    const e = entry as Partial<ActivationEntry> | null;
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.channelDir !== "string" ||
      e.channelDir.length === 0 ||
      typeof e.recordedAt !== "string"
    ) {
      return {
        kind: "corrupt",
        detail: "an activation entry is missing channelDir or recordedAt",
      };
    }
    entries.push({ channelDir: e.channelDir, recordedAt: e.recordedAt });
  }
  return { kind: "ok", entries };
}

/**
 * Records that this session activated the dispatcher on `channelDir`.
 * Idempotent per directory — re-activating the same channel refreshes its
 * `recordedAt` rather than duplicating the entry. Written atomically like
 * every other session record. A corrupt existing file is replaced by a
 * fresh document: the per-channel `provenance.json` files remain the
 * evidence of record, so losing the index degrades discovery, not proof.
 */
export function recordSessionDispatcherActivation(
  sessionRoot: string,
  channelDir: string,
): void {
  const current = readEntries(sessionRoot);
  const kept =
    current.kind === "ok"
      ? current.entries.filter((entry) => entry.channelDir !== channelDir)
      : [];
  const entries: ActivationEntry[] = [
    ...kept,
    { channelDir, recordedAt: new Date().toISOString() },
  ];
  const doc: ActivationsDoc = {
    schema: SESSION_DISPATCHER_ACTIVATIONS_SCHEMA,
    activations: entries,
  };
  const path = sessionDispatcherActivationsPath(sessionRoot);
  mkdirSync(sessionRoot, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Reads the recorded activations. Channel directories are returned
 * deduplicated in record order. Absent is a normal answer; corrupt is
 * reported with its detail so the caller can fail honest rather than
 * assume no dispatcher needs re-staging.
 */
export function readSessionDispatcherActivations(
  sessionRoot: string,
): SessionDispatcherActivations {
  const current = readEntries(sessionRoot);
  if (current.kind !== "ok") {
    return current;
  }
  const channelDirs: string[] = [];
  for (const entry of current.entries) {
    if (!channelDirs.includes(entry.channelDir)) {
      channelDirs.push(entry.channelDir);
    }
  }
  return { kind: "ok", channelDirs };
}
