/**
 * Recording lifecycle core — `record.start` / `record.stop` (#381, spec
 * `specs/gui-evidence/spec.md` §5.4, §5.6, §7, §8; E2a of program #337 /
 * tracking #346).
 *
 * This is the platform-neutral half of recording: the segment state
 * machine, bounded-duration enforcement, `finally` finalize, container
 * probe, `coversOperations` accounting, recorder-residue reporting and
 * orphan marking — all written into the `ae-a8n.gui-evidence/v1` index.
 * The OS encoders (ScreenCaptureKit #382, Windows.Graphics.Capture #384)
 * are *not* here: they plug in through the `ScreenRecorder` seam, and the
 * in-repo verification uses a fake recorder. Until a real backend
 * registers, `start` refuses honestly rather than pretending to record.
 *
 * Contract points carried from the spec:
 *
 *   - Bounded by contract: `maxDurationMs` defaults to 300 s and is hard
 *     capped at 3600 s. The driver-side deadline is enforced here; the
 *     helper-side bounded lifetime is part of the `ScreenRecorder`
 *     contract (`RecorderStartRequest.maxDurationMs`) so a dead driver
 *     cannot leave a recorder running forever. A deadline hit marks the
 *     segment `incomplete: "deadline-exceeded"` — never retried blind.
 *   - `finally` finalize: `stop`, `finalizeAll` (session teardown /
 *     driver close / cancellation) and process-exit hooks all attempt a
 *     stop. A killed encoder's unplayable file is recorded
 *     (`playable: false` + reason on the artifact), never deleted and
 *     never claimed.
 *   - No residue: after every finalize the backend's surviving recorder
 *     pids are enumerated (`listPids`) and terminated (`terminate`); the
 *     outcome lands on the segment as `recorderResidue`.
 *   - Crash honesty: segments found open in the index at controller
 *     creation belong to a dead session — they are marked `orphaned`
 *     (gap list + `incomplete`) instead of being discovered as growing
 *     files later.
 *   - Gates (spec §5.6): `window`/`region` scopes require an `"owned"`
 *     `PanelTarget` attribution and are serialized on the GUI lease for
 *     the segment's duration (lease-per-segment is the safe default).
 *     `display`/`session` scopes — and *any* scope when the session kind
 *     is not proven `"isolated"` — require recording authorization. The
 *     authorization mechanism itself is a later ticket; this module only
 *     owns the gate and records the refusal.
 *   - Trace: `record.start`/`record.stop` emit trace rows whose
 *     `result.evidenceId` is the segment id, so a consumer can walk
 *     trace → artifact without guessing (spec §5.3 rule 1).
 *
 * Level: `automated test` — file I/O and injected seams only; no OS
 * calls, no After Effects, nothing here has run against a real host.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { errorMessage } from "../errors.js";
import type { TraceRecorder } from "../trace/trace.js";
import {
  indexClockSkew,
  segmentOperationCoverage,
  type EvidenceTraceRow,
} from "./correlate.js";
import { GuiEvidenceIndex } from "./index.js";
import {
  type CaptureLeakage,
  type CaptureScope,
  type EvidenceArtifact,
  type EvidenceExclusion,
  type EvidenceIndexSession,
  type EvidenceSegment,
  type EvidenceSessionKind,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Public contract types                                               */
/* ------------------------------------------------------------------ */

/** Default `maxDurationMs` when the caller does not bound the segment. */
export const RECORDING_DEFAULT_MAX_DURATION_MS = 300_000;
/** Hard cap — a recording never runs longer than this (spec §5.4). */
export const RECORDING_MAX_DURATION_MS_CAP = 3_600_000;

/** The handle `record.start` returns (spec §5.4 `RecordingSession`). */
export type RecordingSession = {
  /** The segment id (`seg-001`, `seg-002`, …) — also the `evidenceId`. */
  readonly id: string;
  readonly t0EpochMs: number;
  readonly t0MonoMs: number | null;
  /** The scope that was asked for. */
  readonly scope: CaptureScope;
  /** The scope the backend actually delivers, when it differs (§5.2). */
  readonly actualScope?: CaptureScope;
};

/** What `record.stop` resolves to: the finalized segment summary. */
export type RecordingStopResult = {
  readonly segment: EvidenceSegment;
  /** The index id trace rows point at — the segment id itself. */
  readonly evidenceId: string;
};

export type RecordStartOptions = {
  /**
   * Segment bound in milliseconds. Defaults to
   * `RECORDING_DEFAULT_MAX_DURATION_MS` (300 s) and is clamped to
   * `RECORDING_MAX_DURATION_MS_CAP` (3600 s) — never unbounded.
   */
  readonly maxDurationMs?: number;
  readonly fps?: number;
  /**
   * Audio is contractually off in v1 (spec §7.3). Passing `true` is
   * refused; `false`/omitted is the only accepted value.
   */
  readonly audio?: false;
  /** Declarative exclusions, recorded verbatim on the segment (§7.2). */
  readonly exclude?: readonly EvidenceExclusion[];
};

/**
 * A lease held for a segment's duration (spec §5.6: window/region
 * recordings serialize on the GUI lease, lease-per-segment safe
 * default). `release` is called exactly once per acquired lease.
 */
export type RecordingLease = {
  release(): void | Promise<void>;
};

/** What the lifecycle asks a recording backend to do. */
export type RecorderStartRequest = {
  readonly segmentId: string;
  readonly scope: CaptureScope;
  /** Absolute path the backend must write the media file to. */
  readonly filePath: string;
  /**
   * The helper-side bounded lifetime in milliseconds — the backend MUST
   * enforce it internally so a dead driver cannot leave a recorder
   * running (spec §5.4 crash honesty; the seam contract #382/#384
   * implement).
   */
  readonly maxDurationMs: number;
  readonly fps?: number;
  readonly exclude?: readonly EvidenceExclusion[];
};

export type RecorderHandle = {
  /** The helper process pid when the backend can name one, else null. */
  readonly pid: number | null;
  readonly filePath: string;
};

export type RecorderStartResult = {
  readonly handle: RecorderHandle;
  /**
   * What the backend can actually deliver when it differs from the
   * request (e.g. a `window` ask honored as whole-display) — recorded as
   * `actualScope`/`leakage`; requested ≠ delivered is always explicit.
   */
  readonly actualScope?: CaptureScope;
  /** Exclusion requests the backend could not honor (§7.2). */
  readonly unhonoredExclusions?: readonly string[];
  /**
   * The tool that actually started, when a backend falls back to a
   * different vehicle mid-`start` (e.g. WGC → declared ffmpeg on
   * Windows, #384). Overrides `ScreenRecorder.tool`/`toolVersion` on the
   * artifact's `provenance` so the record names what ran, not what was
   * asked for. Absent = the recorder's own identity stands.
   */
  readonly tool?: string;
  readonly toolVersion?: string;
};

export type RecorderStopResult = {
  /** Whether the helper exited inside the stop grace period. */
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly error?: string;
};

/** Container probe result (spec §5.4 finalize verification). */
export type RecorderFileProbe = {
  readonly exists: boolean;
  readonly bytes: number | null;
  /**
   * `true` playable, `false` unplayable (e.g. a killed encoder's
   * half-written file), `null` when playability could not be determined.
   */
  readonly playable: boolean | null;
  /** Why the file is unplayable/undetermined, when known. */
  readonly detail?: string;
  /** Backend-reported capture statistics (spec §11), when available. */
  readonly stats?: {
    readonly achievedFps?: number | null;
    readonly droppedFrames?: number | null;
    readonly encodeCpu?: number | null;
  };
};

/**
 * The pluggable recorder seam. OS backends (#382 ScreenCaptureKit,
 * #384 WGC) implement this; tests use a fake. Every method is called
 * only by `RecordingController` — callers never see it.
 */
export type ScreenRecorder = {
  /** Tool identity recorded in artifact `provenance` (e.g. "screen-record.swift"). */
  readonly tool: string;
  readonly toolVersion?: string;
  /** File extension including the dot, e.g. ".mov". */
  readonly fileExtension: string;
  start(request: RecorderStartRequest): Promise<RecorderStartResult>;
  stop(handle: RecorderHandle): Promise<RecorderStopResult>;
  /** Container probe: exists / nonzero / playable verdict. */
  probe(filePath: string): Promise<RecorderFileProbe>;
  /**
   * Pids of this backend's surviving recorder processes, or `null` when
   * enumeration is impossible. Optional: absent means "cannot enumerate"
   * and residue reports `"unknown"` — never a silent `"none"`.
   */
  listPids?(): Promise<readonly number[] | null>;
  /**
   * Terminate one surviving recorder pid. Resolves `true` when the
   * termination was signalled; `false`/throw means it could not be proven.
   */
  terminate?(pid: number): Promise<boolean>;
};

/** Resolves the recorder backend for a scope; `null` = none available. */
export type RecorderResolver = (scope: CaptureScope) => ScreenRecorder | null;

export type RecordingAuthorizationRequest = {
  readonly scope: CaptureScope;
  readonly sessionKind: EvidenceSessionKind;
};

/**
 * The §5.6 authorization gate seam. Return `null` when the scope is
 * authorized, or a human-readable refusal reason. When the seam is absent
 * the controller fails closed: anything requiring authorization is
 * refused. The authorization *mechanism* (token issuance/validation) is
 * a later ticket — this seam is only the gate.
 */
export type RecordingAuthorizer = (
  request: RecordingAuthorizationRequest,
) => string | null;

export type RecordingControllerOptions = {
  /** `<sessionRoot>/artifacts` — the index and `recordings/` live under it. */
  readonly artifactsDir: string;
  /** Proven session identity written onto the index. */
  readonly session: EvidenceIndexSession;
  /** One backend for all scopes, or a per-scope resolver. */
  readonly recorder: ScreenRecorder | RecorderResolver;
  /** Trace recorder `record.start`/`record.stop` rows are written to. */
  readonly trace?: Pick<TraceRecorder, "record">;
  /**
   * Trace rows for `coversOperations`, as `seq`/`ts`/`op`/`requestId`.
   * Defaults to none — coverage then reflects only audit-claimed ids.
   */
  readonly listTraceRows?: () => readonly EvidenceTraceRow[];
  /**
   * GUI-lease seam for `window`/`region` segments (spec §5.6
   * lease-per-segment). Absent → window/region starts are refused: a
   * recorder that cannot be serialized against mutations must not run.
   */
  readonly acquireLease?: (
    segmentId: string,
    scope: CaptureScope,
  ) => Promise<RecordingLease | undefined> | RecordingLease | undefined;
  readonly authorizeRecording?: RecordingAuthorizer;
  /** sha256+bytes of a finalized file; defaults to a streaming hash. */
  readonly hashFile?: (
    path: string,
  ) => Promise<{ readonly sha256: string; readonly bytes: number | null }>;
  /** Epoch-ms clock; defaults to `Date.now`. Test seam. */
  readonly now?: () => number;
  /** Monotonic-ms clock; defaults to `performance.now`. Test seam. */
  readonly monoNow?: () => number;
};

/** Error codes `record.start`/`record.stop` can surface. */
export type RecordingErrorCode =
  | "invalid"
  | "unsupported"
  | "unavailable"
  | "unauthorized"
  | "not-found"
  | "closed";

export class RecordingError extends Error {
  readonly code: RecordingErrorCode;
  constructor(code: RecordingErrorCode, message: string) {
    super(message);
    this.name = "RecordingError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

type LiveSegment = {
  readonly id: string;
  readonly scope: CaptureScope;
  readonly actualScope?: CaptureScope;
  readonly recorder: ScreenRecorder;
  readonly handle: RecorderHandle;
  /** Tool identity `start` reported, when it overrode the recorder's. */
  readonly tool?: string;
  readonly toolVersion?: string;
  /** Path relative to `artifactsDir`, e.g. `recordings/seg-001.mov`. */
  readonly file: string;
  readonly absPath: string;
  readonly t0EpochMs: number;
  readonly t0MonoMs: number | null;
  readonly maxDurationMs: number;
  readonly fps?: number;
  readonly exclude?: readonly EvidenceExclusion[];
  readonly lease?: RecordingLease;
  readonly timer: NodeJS.Timeout;
  /** Set by the deadline path before it calls `stop`. */
  forcedIncomplete?: string;
  /** In-flight finalize — concurrent `stop` calls share it. */
  stopping?: Promise<RecordingStopResult>;
};

const SCOPE_KINDS = new Set(["window", "region", "display", "session"]);

function isCaptureScope(value: unknown): value is CaptureScope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    SCOPE_KINDS.has((value as { kind: string }).kind)
  );
}

function leakageFor(scope: CaptureScope): CaptureLeakage {
  switch (scope.kind) {
    case "window":
      return "window";
    case "region":
      return "region";
    case "display":
      return "full-display";
    case "session":
      return "full-session";
  }
}

/**
 * The §5.6 authorization requirement: `display`/`session` scopes always
 * need it; every scope needs it when the session kind is not proven
 * `"isolated"` (console/attached shared sessions, and `"unknown"` —
 * fail-closed).
 */
export function recordingRequiresAuthorization(
  scope: CaptureScope,
  sessionKind: EvidenceSessionKind,
): boolean {
  return (
    scope.kind === "display" ||
    scope.kind === "session" ||
    sessionKind !== "isolated"
  );
}

/**
 * The owned-attribution gate for `window`/`region` scopes (spec §5.2):
 * recording a `foreign`/`unmatched`/`unproven` surface is refused exactly
 * like a mutation would be. A `region` without an owned `parent`
 * `PanelTarget` is unproven and refused.
 */
export function recordingAttributionRefusal(scope: CaptureScope): string | null {
  if (scope.kind === "window") {
    const attribution = scope.window.surface.attribution;
    return attribution === "owned"
      ? null
      : `window scope requires an "owned" panel attribution; got "${attribution}"`;
  }
  if (scope.kind === "region") {
    const parent = scope.parent;
    if (parent === undefined) {
      return 'region scope requires a parent PanelTarget with "owned" attribution; none was given';
    }
    const attribution = parent.surface.attribution;
    return attribution === "owned"
      ? null
      : `region scope requires an "owned" panel attribution; got "${attribution}"`;
  }
  return null;
}

async function hashFileStreaming(
  path: string,
): Promise<{ sha256: string; bytes: number | null }> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/* ------------------------------------------------------------------ */
/* RecordingController                                                 */
/* ------------------------------------------------------------------ */

/**
 * One session's recording lifecycle: bounded segments, finalize,
 * residue accounting and orphan reconciliation, all persisted into the
 * session's `GuiEvidenceIndex`. Construct once per session; call
 * `finalizeAll` on teardown/close/cancellation.
 */
export class RecordingController {
  readonly #options: RecordingControllerOptions;
  readonly #index: GuiEvidenceIndex;
  readonly #sessions = new Map<string, LiveSegment>();
  readonly #recordersUsed = new Set<ScreenRecorder>();
  #nextSegmentSeq = 1;
  #closed = false;

  constructor(options: RecordingControllerOptions) {
    this.#options = options;
    // Load-or-create, then let the *current* session identity win the
    // scalar fields (a resumed session re-proves pid/start identity).
    const loaded = GuiEvidenceIndex.load(options.artifactsDir);
    this.#index =
      loaded === null
        ? GuiEvidenceIndex.create(options.session)
        : loaded.mergeFrom(GuiEvidenceIndex.create(options.session));
    for (const segment of this.#index.document.segments) {
      const match = /^seg-(\d+)$/.exec(segment.id);
      if (match !== null) {
        this.#nextSegmentSeq = Math.max(this.#nextSegmentSeq, Number(match[1]) + 1);
      }
    }
    this.#reconcileOrphans();
  }

  /** The underlying index handle (mutations should go through the lifecycle). */
  get index(): GuiEvidenceIndex {
    return this.#index;
  }

  /** Ids of segments currently recording. */
  get activeSegmentIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * `record.start(scope, options)` — validates, gates, leases, starts the
   * backend and writes the open segment into the index. Throws
   * `RecordingError`; every refusal is also recorded as an
   * `unrecorded`/`uncapturable` gap and a `record.start` trace row.
   */
  async start(scope: CaptureScope, options: RecordStartOptions = {}): Promise<RecordingSession> {
    this.#assertOpen("start");
    const began = this.#now();
    try {
      const session = await this.#start(scope, options);
      this.#trace("record.start", "ok", began, {
        args: { scope: scope.kind },
        result: {
          evidenceId: session.id,
          scope: session.scope.kind,
          ...(session.actualScope === undefined
            ? {}
            : { actualScope: session.actualScope.kind }),
        },
      });
      return session;
    } catch (error) {
      this.#trace("record.start", "error", began, {
        args: { scope: isCaptureScope(scope) ? scope.kind : "invalid" },
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: errorMessage(error),
        },
      });
      throw error;
    }
  }

  async #start(scope: CaptureScope, options: RecordStartOptions): Promise<RecordingSession> {
    if (!isCaptureScope(scope)) {
      throw new RecordingError(
        "invalid",
        `unknown capture scope: ${JSON.stringify(scope)}`,
      );
    }
    // `audio` is typed `false`; a JS caller can still pass `true`, so the
    // runtime check is a truthiness test, not a literal comparison.
    if (options.audio) {
      throw new RecordingError(
        "invalid",
        "audio is not supported: v1 records no audio (spec §7.3)",
      );
    }
    const maxDurationMs = this.#boundedDuration(options.maxDurationMs);
    const fps = options.fps;
    if (fps !== undefined && (!Number.isFinite(fps) || fps <= 0)) {
      throw new RecordingError("invalid", "fps must be a positive number");
    }
    const exclude = options.exclude === undefined ? undefined : [...options.exclude];

    // Gate 1 — owned attribution for window/region scopes (§5.2/§5.6).
    const attributionRefusal = recordingAttributionRefusal(scope);
    if (attributionRefusal !== null) {
      throw this.#refuse("unavailable", "unrecorded", attributionRefusal);
    }

    // Gate 2 — recording authorization (§5.6). Absent seam = refuse.
    // The authorizer returns `null` when authorized and a refusal reason
    // otherwise — `??` would conflate the two, so branch explicitly.
    if (
      recordingRequiresAuthorization(scope, this.#options.session.sessionKind)
    ) {
      const authorizer = this.#options.authorizeRecording;
      if (authorizer === undefined) {
        throw this.#refuse(
          "unauthorized",
          "unrecorded",
          "record.start refused: recording authorization is required for " +
            "this scope/session kind but no authorization mechanism is " +
            "configured (authorization issuance is a later ticket); the " +
            "start is refused",
        );
      }
      const refusal = authorizer({
        scope,
        sessionKind: this.#options.session.sessionKind,
      });
      if (refusal !== null) {
        throw this.#refuse(
          "unauthorized",
          "unrecorded",
          `record.start refused: ${refusal}`,
        );
      }
    }

    // Gate 3 — window/region segments serialize on the GUI lease
    // (lease-per-segment, spec §5.6). No seam = cannot serialize = refuse.
    const needsLease = scope.kind === "window" || scope.kind === "region";
    if (needsLease && this.#options.acquireLease === undefined) {
      throw this.#refuse(
        "unavailable",
        "unrecorded",
        "record.start refused: window/region recording requires the GUI " +
          "lease (lease-per-segment) but no lease seam is configured",
      );
    }

    // Gate 4 — a recorder backend must exist for this scope.
    const recorder = this.#resolveRecorder(scope);
    if (recorder === null) {
      throw this.#refuse(
        "unsupported",
        "unrecorded",
        `record.start refused: no recorder backend is available for ` +
          `${scope.kind} scope on this platform (OS helpers land in later tickets)`,
      );
    }

    const segmentId = `seg-${String(this.#nextSegmentSeq).padStart(3, "0")}`;
    this.#nextSegmentSeq += 1;
    const extension = recorder.fileExtension.startsWith(".")
      ? recorder.fileExtension
      : `.${recorder.fileExtension}`;
    const file = join("recordings", `${segmentId}${extension}`);
    const absPath = join(this.#options.artifactsDir, file);

    // The lease is taken before the recorder starts so a refused
    // acquisition never leaves a running encoder behind.
    let lease: RecordingLease | undefined;
    if (needsLease) {
      try {
        lease = await this.#options.acquireLease?.(segmentId, scope);
      } catch (error) {
        throw this.#refuse(
          "unavailable",
          "unrecorded",
          `record.start refused: GUI lease could not be acquired: ${errorMessage(error)}`,
        );
      }
      if (lease === undefined) {
        throw this.#refuse(
          "unavailable",
          "unrecorded",
          "record.start refused: GUI lease seam returned no lease",
        );
      }
    }

    await mkdir(join(this.#options.artifactsDir, "recordings"), { recursive: true });

    let started: RecorderStartResult;
    try {
      started = await recorder.start({
        segmentId,
        scope,
        filePath: absPath,
        maxDurationMs,
        ...(fps === undefined ? {} : { fps }),
        ...(exclude === undefined ? {} : { exclude }),
      });
    } catch (error) {
      await this.#releaseLease(lease);
      this.#index.noteUncapturable(
        `recording ${segmentId}: recorder.start failed: ${errorMessage(error)}`,
      );
      this.#saveIndex();
      throw new RecordingError(
        "unavailable",
        `recorder.start failed for ${segmentId}: ${errorMessage(error)}`,
      );
    }

    for (const reason of started.unhonoredExclusions ?? []) {
      this.#index.noteUncapturable(
        `recording ${segmentId}: exclusion not honored: ${reason}`,
      );
    }

    const t0EpochMs = this.#now();
    const t0MonoMs = this.#monoNow();
    const live: LiveSegment = {
      id: segmentId,
      scope,
      ...(started.actualScope === undefined
        ? {}
        : { actualScope: started.actualScope }),
      recorder,
      handle: started.handle,
      ...(started.tool === undefined ? {} : { tool: started.tool }),
      ...(started.toolVersion === undefined
        ? {}
        : { toolVersion: started.toolVersion }),
      file,
      absPath,
      t0EpochMs,
      t0MonoMs,
      maxDurationMs,
      ...(fps === undefined ? {} : { fps }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(lease === undefined ? {} : { lease }),
      timer: setTimeout(() => {
        this.#onDeadline(live);
      }, maxDurationMs),
    };
    live.timer.unref?.();
    this.#sessions.set(segmentId, live);
    this.#recordersUsed.add(recorder);

    // Persist the open segment immediately: a crash from here on leaves
    // an open segment the *next* session marks orphaned — never a
    // silently growing file.
    this.#index.addSegment({
      id: segmentId,
      scope,
      ...(started.actualScope === undefined
        ? {}
        : { actualScope: started.actualScope }),
      t0EpochMs,
      t0MonoMs,
      endEpochMs: null,
      durationMs: null,
      file,
      playable: null,
      coversOperations: null,
      operationIds: [],
      ...(exclude === undefined ? {} : { exclude }),
    });
    this.#saveIndex();

    return {
      id: segmentId,
      t0EpochMs,
      t0MonoMs,
      scope,
      ...(started.actualScope === undefined
        ? {}
        : { actualScope: started.actualScope }),
    };
  }

  /**
   * `record.stop(id)` — stops the backend, probes the container,
   * computes coverage, releases the lease and finalizes the segment +
   * artifact into the index. Idempotent per segment: a second call
   * shares the in-flight finalize.
   */
  stop(id: string): Promise<RecordingStopResult> {
    const live = this.#sessions.get(id);
    if (live === undefined) {
      return Promise.reject(
        new RecordingError("not-found", `no open recording segment "${id}"`),
      );
    }
    if (live.stopping !== undefined) {
      return live.stopping;
    }
    const began = this.#now();
    const finalize = this.#finalize(live).then(
      (result) => {
        this.#trace("record.stop", "ok", began, {
          args: { segmentId: id },
          result: {
            evidenceId: result.evidenceId,
            playable: result.segment.playable,
            ...(result.segment.incomplete === undefined
              ? {}
              : { incomplete: result.segment.incomplete }),
          },
        });
        return result;
      },
      (error: unknown) => {
        this.#trace("record.stop", "error", began, {
          args: { segmentId: id },
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: errorMessage(error),
          },
        });
        throw error;
      },
    );
    live.stopping = finalize;
    return finalize;
  }

  /**
   * Session teardown / driver close / cancellation / exit hook: every
   * open segment gets a stop attempt, then a residue sweep terminates
   * any recorder pid still alive. Never throws — finalize problems are
   * recorded on the segments and gaps, not propagated into teardown.
   */
  async finalizeAll(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const live = [...this.#sessions.values()];
    for (const segment of live) {
      try {
        await this.stop(segment.id);
      } catch {
        // #finalize records its own failures; a stop that still rejects
        // must not abort the teardown of the remaining segments.
      }
    }
    // Final residue sweep: pids belonging to no live segment must not
    // survive the session.
    for (const recorder of this.#recordersUsed) {
      const survivors = await this.#survivingPids(recorder);
      if (survivors === null || survivors.length === 0) {
        continue;
      }
      let allTerminated = recorder.terminate !== undefined;
      for (const pid of survivors) {
        try {
          if (
            recorder.terminate === undefined ||
            !(await recorder.terminate(pid))
          ) {
            allTerminated = false;
          }
        } catch {
          allTerminated = false;
        }
      }
      this.#index.noteUnrecorded(
        `recorder residue at teardown: ${survivors.length} surviving ` +
          `pid(s) [${survivors.join(", ")}] ` +
          `${allTerminated ? "terminated" : "could not be proven terminated"}`,
      );
    }
    this.#saveIndex();
  }

  /* ---------------- internal ---------------- */

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #monoNow(): number {
    return this.#options.monoNow?.() ?? performance.now();
  }

  #assertOpen(op: string): void {
    if (this.#closed) {
      throw new RecordingError(
        "closed",
        `record.${op} refused: the recording controller is finalized`,
      );
    }
  }

  #resolveRecorder(scope: CaptureScope): ScreenRecorder | null {
    const recorder = this.#options.recorder;
    return typeof recorder === "function" ? recorder(scope) : recorder;
  }

  #boundedDuration(value: number | undefined): number {
    if (value === undefined) {
      return RECORDING_DEFAULT_MAX_DURATION_MS;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RecordingError("invalid", "maxDurationMs must be a positive number");
    }
    return Math.min(value, RECORDING_MAX_DURATION_MS_CAP);
  }

  /** A gate refusal: recorded as a gap, then thrown. */
  #refuse(
    code: RecordingErrorCode,
    list: "unrecorded" | "uncapturable",
    reason: string,
  ): RecordingError {
    if (list === "unrecorded") {
      this.#index.noteUnrecorded(reason);
    } else {
      this.#index.noteUncapturable(reason);
    }
    this.#saveIndex();
    return new RecordingError(code, reason);
  }

  #trace(
    op: string,
    status: "ok" | "error",
    began: number,
    detail: {
      args?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { name: string; message: string };
    },
  ): void {
    try {
      this.#options.trace?.record(op, status, this.#now() - began, detail);
    } catch {
      // A trace failure must never break the lifecycle it describes.
    }
  }

  #saveIndex(): void {
    this.#index.save(this.#options.artifactsDir);
  }

  async #releaseLease(lease: RecordingLease | undefined): Promise<void> {
    if (lease === undefined) {
      return;
    }
    try {
      await lease.release();
    } catch {
      // Lease release failure is recorded by the lease owner; a stuck
      // release must not block finalize.
    }
  }

  #listRows(): readonly EvidenceTraceRow[] {
    try {
      return this.#options.listTraceRows?.() ?? [];
    } catch {
      return [];
    }
  }

  async #probe(
    recorder: ScreenRecorder,
    absPath: string,
  ): Promise<RecorderFileProbe> {
    try {
      const probe = await recorder.probe(absPath);
      return {
        ...probe,
        // A missing file is definitionally unplayable — never null.
        playable: probe.exists ? probe.playable : false,
      };
    } catch (error) {
      return {
        exists: false,
        bytes: null,
        playable: null,
        detail: `container probe failed: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * Recorder pids still alive for `recorder`, excluding pids owned by
   * *other* live segments of this controller (`self` is the segment
   * being finalized — its own pid is a legitimate survivor candidate).
   * `null` = the backend cannot enumerate.
   */
  async #survivingPids(
    recorder: ScreenRecorder,
    self?: LiveSegment,
  ): Promise<readonly number[] | null> {
    if (recorder.listPids === undefined) {
      return null;
    }
    let pids: readonly number[] | null;
    try {
      pids = await recorder.listPids();
    } catch {
      return null;
    }
    if (pids === null) {
      return null;
    }
    const otherLive = new Set<number>();
    for (const segment of this.#sessions.values()) {
      if (segment === self || segment.recorder !== recorder) {
        continue;
      }
      if (segment.handle.pid !== null) {
        otherLive.add(segment.handle.pid);
      }
    }
    return pids.filter((pid) => !otherLive.has(pid));
  }

  /**
   * `recorderResidue` for one finalized segment: `"none"` when no
   * surviving pid remains, `"terminated"` when survivors were signalled,
   * `"unknown"` when enumeration or termination could not be proven.
   */
  async #residue(live: LiveSegment): Promise<"none" | "terminated" | "unknown"> {
    const survivors = await this.#survivingPids(live.recorder, live);
    if (survivors === null) {
      return "unknown";
    }
    if (survivors.length === 0) {
      return "none";
    }
    if (live.recorder.terminate === undefined) {
      return "unknown";
    }
    let all = true;
    for (const pid of survivors) {
      try {
        if (!(await live.recorder.terminate(pid))) {
          all = false;
        }
      } catch {
        all = false;
      }
    }
    return all ? "terminated" : "unknown";
  }

  #onDeadline(live: LiveSegment): void {
    // Route through `stop` so the deadline finalize emits the same
    // `record.stop` trace row and shares the in-flight promise. The
    // segment is marked incomplete — never retried.
    live.forcedIncomplete = "deadline-exceeded";
    void this.stop(live.id).catch(() => {
      // `stop` already traced the failure; the timer path must not
      // produce an unhandled rejection.
    });
  }

  /**
   * The finalize path shared by `stop`, the deadline timer and
   * `finalizeAll`: stop the backend, probe the container, compute
   * coverage, release the lease, write segment + artifact, save. An
   * unexpected failure degrades to an honest `incomplete` record rather
   * than rejecting — a finalize that cannot complete must still leave
   * evidence of what happened.
   */
  async #finalize(live: LiveSegment): Promise<RecordingStopResult> {
    try {
      return await this.#finalizeInner(live);
    } catch (error) {
      return this.#finalizeDegraded(live, errorMessage(error));
    }
  }

  async #finalizeInner(live: LiveSegment): Promise<RecordingStopResult> {
    clearTimeout(live.timer);
    const endEpochMs = this.#now();
    const endMonoMs = this.#monoNow();

    let stopFailed: string | undefined;
    try {
      const stopped = await live.recorder.stop(live.handle);
      if (!stopped.exited) {
        stopFailed =
          stopped.error ??
          `recorder pid ${live.handle.pid ?? "?"} did not exit`;
      }
    } catch (error) {
      stopFailed = errorMessage(error);
    }

    const probe = await this.#probe(live.recorder, live.absPath);
    await this.#releaseLease(live.lease);

    const incomplete =
      live.forcedIncomplete ??
      (stopFailed === undefined ? undefined : "stop-failed");
    const playable = probe.playable;
    const rows = this.#listRows();
    const coverage = segmentOperationCoverage(
      {
        t0EpochMs: live.t0EpochMs,
        endEpochMs,
        operationIds: [],
      },
      rows,
      {
        playable,
        ...(incomplete === undefined ? {} : { incomplete }),
      },
    );
    const residue = await this.#residue(live);

    // sha256 + bytes of the media file, when it exists. A hashing
    // failure is recorded, never omitted and never fatal.
    let sha256: string | null = null;
    let sha256Error: string | undefined;
    let bytes = probe.bytes;
    if (probe.exists) {
      try {
        const hashed = await (this.#options.hashFile ?? hashFileStreaming)(
          live.absPath,
        );
        sha256 = hashed.sha256;
        bytes = hashed.bytes ?? bytes;
      } catch (error) {
        sha256Error = `sha256 failed: ${errorMessage(error)}`;
      }
    } else {
      sha256Error = "no media file was produced";
    }

    const actualScope = live.actualScope;
    const unavailableReason = !probe.exists
      ? (probe.detail ?? "no media file was produced")
      : playable === false
        ? (probe.detail ??
          (stopFailed !== undefined
            ? `recorder did not finalize cleanly: ${stopFailed}`
            : "container probe reported the file unplayable"))
        : undefined;

    const artifact: EvidenceArtifact = {
      id: live.id,
      kind: "screen-recording",
      role: "original",
      path: live.file,
      sha256,
      ...(sha256Error === undefined ? {} : { sha256Error }),
      bytes,
      session: this.#hostRef(),
      scope: live.scope,
      ...(actualScope === undefined ? {} : { actualScope }),
      leakage: leakageFor(actualScope ?? live.scope),
      time: {
        capturedAt: new Date(endEpochMs).toISOString(),
        t0EpochMs: live.t0EpochMs,
        t0MonoMs: live.t0MonoMs,
        durationMs: Math.max(0, endEpochMs - live.t0EpochMs),
        endEpochMs,
      },
      provenance: {
        producer: "os-capture",
        tool: live.tool ?? live.recorder.tool,
        ...((live.toolVersion ?? live.recorder.toolVersion) === undefined
          ? {}
          : { toolVersion: live.toolVersion ?? live.recorder.toolVersion }),
      },
      operationIds: coverage.operationIds,
      ...(unavailableReason === undefined
        ? {}
        : { unavailable: { reason: unavailableReason } }),
    };

    const segment: EvidenceSegment = {
      id: live.id,
      scope: live.scope,
      ...(actualScope === undefined ? {} : { actualScope }),
      t0EpochMs: live.t0EpochMs,
      t0MonoMs: live.t0MonoMs,
      endEpochMs,
      durationMs: Math.max(0, endEpochMs - live.t0EpochMs),
      file: probe.exists ? live.file : null,
      playable,
      ...(incomplete === undefined ? {} : { incomplete }),
      coversOperations: coverage.coversOperations,
      operationIds: coverage.operationIds,
      recorderResidue: residue,
      ...(live.exclude === undefined ? {} : { exclude: live.exclude }),
    };

    if (probe.stats !== undefined) {
      const existing = this.#index.document.captureStats ?? {};
      this.#index.setCaptureStats({
        ...existing,
        ...(live.fps === undefined ? {} : { requestedFps: live.fps }),
        ...(probe.stats.achievedFps === undefined
          ? {}
          : { achievedFps: probe.stats.achievedFps }),
        ...(probe.stats.droppedFrames === undefined
          ? {}
          : { droppedFrames: probe.stats.droppedFrames }),
        ...(probe.stats.encodeCpu === undefined
          ? {}
          : { encodeCpu: probe.stats.encodeCpu }),
      });
    }
    this.#index.setClockSkew(
      indexClockSkew(
        { epochMs: live.t0EpochMs, monoMs: live.t0MonoMs },
        { epochMs: endEpochMs, monoMs: endMonoMs },
      ),
    );
    this.#index.addSegment(segment);
    this.#index.addArtifact(artifact);
    this.#sessions.delete(live.id);
    this.#saveIndex();

    if (stopFailed !== undefined) {
      this.#index.noteUncapturable(
        `recording ${live.id}: recorder stop incomplete: ${stopFailed}`,
      );
      this.#saveIndex();
    }

    return { segment, evidenceId: live.id };
  }

  /**
   * Last-resort finalize when `#finalizeInner` itself failed: still
   * writes a closed segment marked `incomplete: "finalize-failed"` so
   * the index never keeps a phantom-open recording, releases the lease,
   * and reports residue as `"unknown"` (nothing could be proven).
   */
  async #finalizeDegraded(
    live: LiveSegment,
    reason: string,
  ): Promise<RecordingStopResult> {
    clearTimeout(live.timer);
    await this.#releaseLease(live.lease);
    const endEpochMs = this.#now();
    const segment: EvidenceSegment = {
      id: live.id,
      scope: live.scope,
      ...(live.actualScope === undefined ? {} : { actualScope: live.actualScope }),
      t0EpochMs: live.t0EpochMs,
      t0MonoMs: live.t0MonoMs,
      endEpochMs,
      durationMs: Math.max(0, endEpochMs - live.t0EpochMs),
      file: null,
      playable: null,
      incomplete: "finalize-failed",
      coversOperations: null,
      operationIds: [],
      recorderResidue: "unknown",
      ...(live.exclude === undefined ? {} : { exclude: live.exclude }),
    };
    this.#index.addSegment(segment);
    this.#index.addArtifact({
      id: live.id,
      kind: "screen-recording",
      role: "original",
      path: live.file,
      sha256: null,
      sha256Error: `finalize failed before hashing: ${reason}`,
      bytes: null,
      session: this.#hostRef(),
      scope: live.scope,
      ...(live.actualScope === undefined ? {} : { actualScope: live.actualScope }),
      leakage: leakageFor(live.actualScope ?? live.scope),
      time: {
        capturedAt: new Date(endEpochMs).toISOString(),
        t0EpochMs: live.t0EpochMs,
        t0MonoMs: live.t0MonoMs,
        durationMs: Math.max(0, endEpochMs - live.t0EpochMs),
        endEpochMs,
      },
      provenance: {
        producer: "os-capture",
        tool: live.tool ?? live.recorder.tool,
        ...((live.toolVersion ?? live.recorder.toolVersion) === undefined
          ? {}
          : { toolVersion: live.toolVersion ?? live.recorder.toolVersion }),
      },
      operationIds: [],
      unavailable: { reason: `finalize failed: ${reason}` },
    });
    this.#sessions.delete(live.id);
    this.#index.noteUncapturable(`recording ${live.id}: finalize failed: ${reason}`);
    this.#saveIndex();
    return { segment, evidenceId: live.id };
  }

  #hostRef(): EvidenceArtifact["session"] {
    const session = this.#options.session;
    return {
      pid: session.pid,
      processStartIdentity: session.processStartIdentity,
      sessionId: session.sessionId,
      sessionKind: session.sessionKind,
    };
  }

  /**
   * Segments found open in the loaded index belong to a session that is
   * gone (this controller only tracks its own live segments): mark them
   * orphaned — gap list plus `incomplete` — per spec §5.4 crash honesty.
   */
  #reconcileOrphans(): void {
    let changed = false;
    for (const segment of this.#index.document.segments) {
      if (segment.endEpochMs !== null) {
        continue;
      }
      this.#index.noteOrphaned(segment.id);
      this.#index.addSegment({
        ...segment,
        incomplete: segment.incomplete ?? "orphaned",
      });
      changed = true;
    }
    if (changed) {
      this.#saveIndex();
    }
  }
}
