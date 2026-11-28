/**
 * Terminate an owned After Effects that will not answer — the *separate*
 * authorized path (#340, specs/gui-supervision/spec.md US5, ADR-0005 §5).
 *
 * `rebuild.ts` never signals a process: it only relaunches after
 * disappearance is proven. This module is the other half of that
 * contract — it is the only path that may ask the OS to end the recorded
 * host, and it does so under stricter gates than rebuild:
 *
 *   1. Explicit permission: `permit: "terminate-owned-host"` is required.
 *      There is no default and no implicit consent.
 *   2. Ownership by record: launch provenance must exist — a session that
 *      proved `owned` writes `phase: "ready"`, and since #458 a session
 *      whose driver spawned a host the probe never answered writes
 *      `phase: "spawned"`. Both are driver-authored records of a process
 *      this session started; attached and unknown sessions have neither
 *      and refuse here without anything being signalled. The phase changes
 *      what the record *means* (probe-proven vs spawn-reported), never the
 *      live re-proof below.
 *   3. Live re-verification: a fresh census must still show the recorded
 *      pid+start identity as the same process, with no sibling instance
 *      of the install in scope. An unreadable census refuses — an unknown
 *      OS answer is never a guess.
 *   4. Graceful-first, bounded: the OS's polite request goes first; the
 *      force kill (`SIGKILL` / `taskkill /F`) runs only under explicit
 *      `force: true`, and only for the recorded pid.
 *   5. Disappearance must be *proven* by census before anything is
 *      recorded — `survived` and `unproven` are honest outcomes, never
 *      "probably dead".
 *
 * Only after the proof does the durable supervision record move: the
 * monitor lease is taken over when it is free or expired (the old
 * monitor's handoff), `blocked`/`process-gone` is published — the exact
 * state `rebuild` requires — and the lease is released so the rebuilt
 * session's monitor can acquire it. A live monitor keeps the lease and
 * the document: it owns the record and will observe `process-gone`
 * itself. `quarantined` and `needs-human` are never downgraded — the
 * state machine only refreshes their evidence.
 *
 * Foreign hosts are never touched: the signal addresses the recorded
 * pid, the census re-proves identity immediately before it, and a reused
 * pid under a start-time-less record is ambiguous — refused, because
 * signalling it could kill someone else's process.
 */

import { join, resolve } from "node:path";

import { errorMessage } from "../errors.js";
import { readLaunchProvenance } from "../driver/launch-provenance.js";
import {
  defaultHostTerminate,
  inspectTerminateTarget,
  waitForHostGone,
  type TerminateHostRequest,
} from "../driver/host-terminate.js";
import {
  defaultProcessCensus,
  type ProcessCensus,
} from "../driver/session-rebuild.js";
import type { HostProcess } from "../driver/host-processes.js";
import {
  acquireMonitorLease,
  applySupervisionEvent,
  humanAction,
  initialSupervisionDoc,
  inspectAction,
  inspectMonitorLease,
  nextAction,
  readSupervisionState,
  writeSupervisionState,
  type NextAction,
} from "../supervision/index.js";
import type { SupervisionPhase, SupervisionStateDoc } from "../supervision/types.js";
import { TraceRecorder } from "../trace/trace.js";
import { AfterEffectsError } from "./errors.js";
import { TERMINATE_PERMIT, type TerminateOptions, type TerminateReport } from "./types.js";

const OP = "session.terminate";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function positiveOr(value: unknown, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return value;
}

/**
 * Test seams. Production callers pass nothing; tests inject the census,
 * the terminate action, the clock and the sleeper so the whole
 * verify → signal → prove → record sequence runs against fakes.
 */
export type TerminateDeps = {
  readonly platform?: NodeJS.Platform;
  readonly processes?: ProcessCensus;
  readonly sessionUid?: number;
  readonly terminateHost?: (
    platform: NodeJS.Platform,
    request: TerminateHostRequest,
  ) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    (timer as { unref?: () => void }).unref?.();
  });

type SupervisionRecord =
  | { readonly kind: "recorded"; readonly phase: SupervisionPhase | null }
  | { readonly kind: "deferred-to-monitor"; readonly phase: SupervisionPhase | null }
  | { readonly kind: "lease-ambiguous" }
  | { readonly kind: "state-unreadable"; readonly detail: string };

/**
 * Publish `blocked`/`process-gone` for the proven-dead host, under the
 * monitor lease. The lease is the handoff: a free or expired lease is
 * acquired (takeover of the dead monitor's record is reported by
 * `acquireMonitorLease` itself), the transition is applied and written,
 * and the lease is released — the rebuilt session's monitor then finds
 * a clean slot. A lease held by a live monitor is left alone: that
 * monitor owns the document and observes the same process-gone itself.
 */
function recordProcessGone(
  sessionRoot: string,
  input: { readonly now: Date; readonly evidence: readonly string[] },
): SupervisionRecord {
  const lease = inspectMonitorLease(sessionRoot, { now: input.now });
  if (lease.state === "held") {
    const read = readSupervisionState(sessionRoot);
    return {
      kind: "deferred-to-monitor",
      phase: read.kind === "state" ? read.doc.phase : null,
    };
  }
  if (lease.state === "ambiguous") {
    return { kind: "lease-ambiguous" };
  }

  const acquired = acquireMonitorLease(sessionRoot, {
    ownerId: "ae-a8n-terminate",
    now: input.now,
  });
  if (!acquired.ok) {
    // Lost a race to a live monitor between inspection and acquisition:
    // it owns the document now, exactly like the held case.
    const read = readSupervisionState(sessionRoot);
    return {
      kind: "deferred-to-monitor",
      phase: read.kind === "state" ? read.doc.phase : null,
    };
  }
  try {
    const existing = readSupervisionState(sessionRoot);
    if (existing.kind === "corrupt") {
      return { kind: "state-unreadable", detail: existing.detail };
    }
    const doc: SupervisionStateDoc =
      existing.kind === "state" ? existing.doc : initialSupervisionDoc({ now: input.now });
    const detail =
      "the recorded owned After Effects process is proven gone by terminate " +
      `(${input.evidence.join("; ")})`;
    const applied = applySupervisionEvent(
      doc,
      {
        kind: "blocking-observed",
        blocking: { host: "process-gone", windows: [], detail },
        reason: detail,
      },
      input.now,
    );
    // A refused transition changes nothing — the machine's own rules
    // decide; quarantined/needs-human keep their phase and only refresh
    // evidence, which is exactly the no-unconditional-release rule.
    const next = applied.ok
      ? {
          ...applied.doc,
          evidence: [...applied.doc.evidence, ...input.evidence].slice(-50),
        }
      : doc;
    writeSupervisionState(sessionRoot, next);
    return { kind: "recorded", phase: next.phase };
  } finally {
    acquired.lease.release();
  }
}

/**
 * Terminate the owned host `options.sessionRoot` names, then prove its
 * disappearance. See the module comment for the gate order; every refusal
 * throws `AfterEffectsError` with `code === op` (`"session.terminate"`)
 * before anything is signalled.
 */
export async function terminateSessionHost(
  options: TerminateOptions,
  deps: TerminateDeps = {},
): Promise<TerminateReport> {
  const sessionRoot = resolve(options.sessionRoot);
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const gracefulTimeoutMs = positiveOr(
    options.gracefulTimeoutMs,
    DEFAULT_GRACEFUL_TIMEOUT_MS,
    "gracefulTimeoutMs",
  );
  const deadlineMs = positiveOr(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadlineMs");
  const began = now();
  const trace = new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") });

  function fail(reason: string, nextActions?: readonly NextAction[]): never {
    trace.record(OP, "error", now() - began, {
      error: { name: "AfterEffectsError", message: reason },
    });
    throw new AfterEffectsError(reason, OP, {
      ...(nextActions === undefined ? {} : { nextActions }),
    });
  }

  // The machine-readable guidance every terminate refusal carries (#341):
  // read the evidence first (always permitted), then the answer for the
  // specific refusal — a missing permit is a policy refusal the caller
  // can fix, an unreadable or ambiguous host is for a human.
  const inspectTerminate = inspectAction(
    OP,
    "Read the launch-provenance record and the durable supervision document in the session root, then re-check the host census before deciding whether terminate is provable.",
  );
  const terminateHuman = humanAction(
    OP,
    "requires-human",
    "Terminate is refused until its proofs hold; a human resolves the named blocker or chooses a different path.",
  );

  // 1. Explicit permission. No default, no implicit consent. The hint is
  //    built before the check: inside the refusal branch the permit
  //    reference is narrowed to `never`, which a template cannot print.
  const permitHint = `permit: "${TERMINATE_PERMIT}"`;
  if (options.permit !== TERMINATE_PERMIT) {
    fail(
      `terminate requires explicit permission: pass ${permitHint} ` +
        "to consent to signalling the owned After Effects process",
      [
        inspectTerminate,
        nextAction({
          kind: "automatic",
          allowed: false,
          code: OP,
          reason: "session-policy",
          action:
            `Terminate signals a live process, so it is refused without ` +
            `the explicit ${permitHint} consent; pass it to permit ` +
            "signalling the recorded owned host, or leave the host running.",
        }),
      ],
    );
  }
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new TypeError("force must be a boolean");
  }

  // 2. Ownership by record: a session that spawned or proved an owned host
  //    wrote provenance (`phase: "spawned"` or `"ready"`, #458). Its
  //    absence is the attached/unknown answer — refuse without signalling.
  let provenance: ReturnType<typeof readLaunchProvenance>;
  try {
    provenance = readLaunchProvenance(sessionRoot);
  } catch (error) {
    fail(`launch provenance is unusable: ${errorMessage(error)}`, [
      inspectTerminate,
      humanAction(
        OP,
        "evidence-unavailable",
        "The launch-provenance record cannot be read; a human decides whether the record is kept or removed before any terminate.",
      ),
    ]);
  }
  if (provenance === null) {
    fail(
      `no launch provenance in ${sessionRoot}: this session never proved it ` +
        "owned an After Effects process, so there is no owned host to terminate. " +
        "Attached and unknown sessions are never signalled.",
      [
        inspectTerminate,
        nextAction({
          kind: "automatic",
          allowed: false,
          code: OP,
          reason: "session-policy",
          action:
            "This session never proved ownership of an After Effects " +
            "process, so there is no owned host to terminate; attached " +
            "and unknown hosts are left running by policy.",
        }),
      ],
    );
  }
  if (provenance.host.platform !== platform) {
    fail(
      `the launch record names platform ${provenance.host.platform} but this ` +
        `host is ${platform}; cross-platform terminate is not provable`,
      [inspectTerminate, terminateHuman],
    );
  }

  const sessionUid = deps.sessionUid ?? options.session?.uid ?? currentUid();
  const processes = deps.processes ?? defaultProcessCensus(platform);
  const evidence: string[] = [];
  const terminateHost =
    deps.terminateHost ?? ((p, request) => defaultHostTerminate(p, request));

  const inspect = (): ReturnType<typeof inspectTerminateTarget> => {
    let list: readonly HostProcess[];
    try {
      list = processes();
    } catch (error) {
      return {
        kind: "ambiguous",
        reason: `the After Effects process list could not be read (${errorMessage(error)})`,
      };
    }
    return inspectTerminateTarget({
      platform,
      provenance,
      processes: list,
      sessionUid,
    });
  };

  // 3. Live re-verification, immediately before any signal.
  const before = inspect();
  if (before.kind === "ambiguous") {
    fail(before.reason, [
      inspectTerminate,
      humanAction(
        OP,
        "unsafe-to-automate",
        "The recorded pid cannot be told apart from a possibly reused or sibling process; signalling it could kill a foreign process, so a human resolves the host state first.",
      ),
    ]);
  }
  if (before.kind === "siblings") {
    fail(before.reason, [inspectTerminate, terminateHuman]);
  }

  const pid = provenance.host.pid;
  const report = (
    partial: Omit<TerminateReport, "pid" | "evidence"> & { readonly evidence?: readonly string[] },
  ): TerminateReport => {
    const { evidence: extra, ...rest } = partial;
    const full: TerminateReport = {
      pid,
      evidence: [...evidence, ...(extra ?? [])],
      ...rest,
    };
    trace.record(
      OP,
      full.outcome === "terminated" || full.outcome === "already-gone" ? "ok" : "error",
      now() - began,
      {
        result: {
          outcome: full.outcome,
          method: full.method,
          disappearanceProven: full.disappearanceProven,
          supervision: full.supervision,
          phase: full.phase,
        },
      },
    );
    return full;
  };

  // 4. Already gone: nothing to signal. Still record the proven state so
  //    the rebuild gate sees it.
  if (before.kind === "gone") {
    evidence.push(...before.evidence, "terminate found the recorded host already gone");
    const record = recordProcessGone(sessionRoot, {
      now: new Date(now()),
      evidence,
    });
    return report({
      outcome: "already-gone",
      method: "none",
      disappearanceProven: true,
      supervision: record.kind,
      phase: record.kind === "lease-ambiguous" || record.kind === "state-unreadable" ? null : record.phase,
    });
  }

  evidence.push(...before.evidence);

  // 5. Graceful first: the OS's own polite request, bounded. The force
  //    kill is reachable only under explicit `force: true`.
  const signal = async (mode: "graceful" | "force"): Promise<void> => {
    try {
      await terminateHost(platform, {
        pid,
        mode,
        executable: provenance.host.executable,
      });
      evidence.push(`${mode} terminate request delivered to pid ${pid}`);
    } catch (error) {
      evidence.push(
        `${mode} terminate request to pid ${pid} failed: ${errorMessage(error)}`,
      );
    }
  };

  const remaining = (): number => Math.max(0, deadlineMs - (now() - began));

  await signal("graceful");
  let wait = await waitForHostGone({
    platform,
    provenance,
    processes,
    sessionUid,
    deadlineMs: Math.min(gracefulTimeoutMs, remaining()),
    pollIntervalMs,
    sleep,
    now,
  });

  let method: TerminateReport["method"] = "graceful";
  if (wait.kind !== "gone" && options.force === true && remaining() > 0) {
    method = "forced";
    await signal("force");
    wait = await waitForHostGone({
      platform,
      provenance,
      processes,
      sessionUid,
      deadlineMs: remaining(),
      pollIntervalMs,
      sleep,
      now,
    });
  }

  if (wait.kind === "timeout") {
    evidence.push(wait.detail);
    return report({
      outcome: "survived",
      method,
      disappearanceProven: false,
      supervision: "not-proven",
      phase: null,
    });
  }
  if (wait.kind === "unproven") {
    evidence.push(wait.detail);
    return report({
      outcome: "unproven",
      method,
      disappearanceProven: false,
      supervision: "not-proven",
      phase: null,
    });
  }

  // 6. Disappearance proven: record `blocked`/`process-gone` under the
  //    monitor lease — the handoff rebuild reads.
  evidence.push(...wait.evidence, `pid ${pid} is proven gone`);
  const record = recordProcessGone(sessionRoot, {
    now: new Date(now()),
    evidence,
  });
  return report({
    outcome: "terminated",
    method,
    disappearanceProven: true,
    supervision: record.kind,
    phase:
      record.kind === "lease-ambiguous" || record.kind === "state-unreadable"
        ? null
        : record.phase,
  });
}
