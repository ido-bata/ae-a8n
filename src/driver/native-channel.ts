/**
 * NativeProbe intake channel client — ae-devtools `native-channel/v1`
 * (ae-a8n #238, devtools #267 Slice B).
 *
 * The devtools NativeProbe plug-in (a C++ AEGP plug-in, not ExtendScript)
 * exposes an opt-in, off-by-default read-only request intake inside its
 * registered idle hook. This module is the owning-runtime side of that
 * file channel: it prepares the private channel directory, publishes
 * request envelopes, reads the plug-in heartbeat, and collects typed
 * results. It is a *verification lane*, not a dispatch grant — the
 * plug-in-side allowlist and the public dispatchable gate stay in
 * ae-devtools, and `verifiedOnRealHost` / `externalDispatchVerified`
 * remain false until authorized real-host evidence exists (devtools
 * #223).
 *
 * Channel layout (devtools `native-channel.md` §2):
 *
 *   <root>/channel.json                     {v:1, token, sessionAeVersion?}  0600
 *   <root>/inbox/<requestId>.request.json                        0600, atomic publish
 *   <root>/outbox/<requestId>.result.json                        0600, atomic publish (plug-in side)
 *   <root>/state.json                     plug-in heartbeat       0600
 *
 * Semantics mirrored from the plug-in contract:
 *
 * - The channel is private to the OS user. POSIX proves it with mode
 *   bits (`mode & 077 == 0`, no symlinks); Windows uses the same icacls
 *   ACL verdicts as the in-AE dispatcher channel. Unproven privacy is
 *   refused, never assumed.
 * - The token is a shared secret that filters accidental writers. It is
 *   compared verbatim by the plug-in and is never written to results or
 *   logs on either side.
 * - A request file is claimed once by the plug-in (rename to
 *   `<requestId>.claimed`) and never replayed. `unknown` is never emitted
 *   by the plug-in: a crash or publish failure leaves the caller to time
 *   out UNKNOWN. Only `not-sent` may be re-issued, and only as a *new*
 *   request.
 * - Request deadlines are `file mtime + timeoutMs`, computed plug-in
 *   side. The client waits `timeoutMs` plus a grace window so a late
 *   `STALE_REQUEST`/`refused` verdict is still collected; past that the
 *   caller reports UNKNOWN and must not resend.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { errorMessage } from "../errors.js";
import {
  channelAclVerdict,
  icaclsCommand,
  keyFileAclVerdict,
  ownerQualifiers,
  parseIcacls,
} from "../platform/windows/acl.js";
import { HostUnavailableError } from "./driver.js";
import { ScriptNotSentError } from "./transport.js";

export const NATIVE_CHANNEL_META = "channel.json";
export const NATIVE_CHANNEL_STATE = "state.json";
export const NATIVE_REQUEST_SUFFIX = ".request.json";
export const NATIVE_RESULT_SUFFIX = ".result.json";
export const NATIVE_CLAIMED_SUFFIX = ".claimed";

/** Inner envelope schema — the semantic contract the channel carries. */
export const NATIVE_DISPATCH_SCHEMA = "ae-devtools/native-dispatch/v1";

/**
 * File-name-safe request id, identical to the plug-in's narrowing of the
 * semantic envelope's "non-empty string" (native-channel.md §3).
 */
export const NATIVE_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Plug-in-side bounds on `timeoutMs` (native-channel.md §3). */
export const NATIVE_TIMEOUT_MAX_MS = 3_600_000;

/** Outcome vocabulary of `native-dispatch/v1`, mirrored for result checks. */
export const NATIVE_DISPATCH_OUTCOMES = [
  "completed",
  "refused",
  "failed",
  "unknown",
  "not-sent",
] as const;
export type NativeDispatchOutcome = (typeof NATIVE_DISPATCH_OUTCOMES)[number];

const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_FILE_BYTES = 64 * 1024;

/** The validated `native-dispatch/v1` result payload inside the wrapper. */
export type NativeDispatchResult = {
  schema: typeof NATIVE_DISPATCH_SCHEMA;
  requestId: string;
  outcome: NativeDispatchOutcome;
  refusalCode?: string;
  result?: unknown;
  mayHaveMutated?: boolean;
  opCalls?: string[];
  detail?: string;
};

/** Session-binding attestation the plug-in writes beside the result. */
export type NativeHostAttestation = {
  plugin: string;
  pluginId: number;
  aeVersion: string;
};

/** A collected result: the typed dispatch result plus who answered. */
export type NativeResultDelivery = {
  instance: string;
  host: NativeHostAttestation;
  result: NativeDispatchResult;
};

/** `state.json` heartbeat written by the plug-in on its idle ticks. */
export type NativeChannelState = {
  instance: string;
  pluginId: number;
  /** Epoch milliseconds of the last heartbeat write. */
  lastTick: number;
  aeVersion?: string;
  allowlist: string[];
};

export type NativeRequestInput = {
  /** File-name-safe id; must match NATIVE_REQUEST_ID_RE. */
  requestId: string;
  /** Plug-in-side deadline budget: file mtime + timeoutMs. */
  timeoutMs: number;
  /** Instance binding; must equal the heartbeat's `instance` when set. */
  target?: string;
  session: {
    sessionId: string;
    aeVersion: string;
    sdkRelease?: { identifier: string; distribution: string };
  };
  operationId: string;
  args?: unknown;
  authorizationRef?: string;
};

export type PrepareNativeChannelOptions = {
  /**
   * Optional `"M.m"` driver-version pin written into `channel.json`.
   * When present the plug-in refuses every request `WRONG_TARGET` unless
   * its observed version matches.
   */
  sessionAeVersion?: string;
};

export type AwaitNativeResultOptions = {
  /**
   * Extra wait after `timeoutMs` so a verdict the plug-in publishes at
   * the deadline edge (e.g. `STALE_REQUEST`) is still collected.
   * Default 60s — the idle hook cadence is host-controlled.
   */
  graceMs?: number;
  /** Poll interval while waiting. Default 100ms. */
  pollMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The wait deadline passed with no valid result file. This is the
 * client's UNKNOWN: the request may or may not have run, it must never
 * be resent, and only a fresh requestId may be used for a new attempt.
 */
export class NativeChannelTimeoutError extends Error {
  readonly requestId: string;
  readonly waitedMs: number;

  constructor(requestId: string, waitedMs: number) {
    super(
      `no native-channel result for request ${requestId} within ${waitedMs}ms; ` +
        "the outcome is UNKNOWN and the request must not be resent",
    );
    this.name = "NativeChannelTimeoutError";
    this.requestId = requestId;
    this.waitedMs = waitedMs;
  }
}

export function defaultNativeChannelDir(home: string = homedir()): string {
  return join(home, ".ae-a8n", "native");
}

export type PreparedNativeChannel = {
  root: string;
  token: string;
  inbox: string;
  outbox: string;
  /** True when channel.json already existed (token reused). */
  reused: boolean;
};

function privatePath(path: string, what: string, kind: "dir" | "file"): void {
  const info = lstatSync(path);
  const shapeOk = kind === "file" ? info.isFile() : info.isDirectory();
  if (!shapeOk || info.isSymbolicLink()) {
    throw new HostUnavailableError(
      `${what} must be a real ${kind === "file" ? "file" : "directory"}, not a symlink: ${path}`,
    );
  }
  if (process.platform === "win32") {
    checkWindowsAcl(path, kind === "file");
    return;
  }
  if ((info.mode & 0o077) !== 0) {
    throw new HostUnavailableError(
      `${what} is accessible to group/other (${(info.mode & 0o777).toString(8)}); ` +
        `the native channel must be private — chmod 700 ${path}`,
    );
  }
}

/** Same icacls verdicts the in-AE dispatcher channel uses (#127). */
function checkWindowsAcl(path: string, file: boolean): void {
  let output: string;
  try {
    output = execFileSync(icaclsCommand(path)[0] as string, [path], {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new HostUnavailableError(
      `cannot verify the Windows ACL of ${path}: ${errorMessage(error)}; ` +
        "the native channel is refused rather than assumed private",
    );
  }
  const entries = parseIcacls(output, path);
  if (entries === null) {
    throw new HostUnavailableError(`cannot parse the icacls output for ${path}`);
  }
  let username: string | null = null;
  try {
    username = userInfo().username;
  } catch {
    username = null;
  }
  const verdict = file
    ? keyFileAclVerdict(entries, username, ownerQualifiers())
    : channelAclVerdict(entries, username === null ? null : [username], ownerQualifiers());
  if (!verdict.ok) {
    throw new HostUnavailableError(`native channel refused: ${verdict.detail}`);
  }
}

function ensurePrivateDir(path: string, what: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  privatePath(path, what, "dir");
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
  }
}

/**
 * Create or validate the channel root and mint/reuse its token.
 * Idempotent: `channel.json` is created once (`wx`) and its token reused,
 * so a plug-in configured earlier keeps working across sessions.
 * The plug-in never creates directories — an unprepared root simply
 * means intake stays dark.
 */
export function prepareNativeChannel(
  root: string,
  options: PrepareNativeChannelOptions = {},
): PreparedNativeChannel {
  if (!isAbsolute(root)) {
    throw new HostUnavailableError(`native channel root must be absolute: ${root}`);
  }
  const resolved = resolve(root);
  ensurePrivateDir(resolved, "the native channel root");
  const inbox = join(resolved, "inbox");
  const outbox = join(resolved, "outbox");
  ensurePrivateDir(inbox, "the native channel inbox");
  ensurePrivateDir(outbox, "the native channel outbox");

  const metaPath = join(resolved, NATIVE_CHANNEL_META);
  let token: string;
  let reused = true;
  if (!existsSync(metaPath)) {
    token = randomBytes(32).toString("hex");
    const meta: Record<string, unknown> = { v: 1, token };
    if (options.sessionAeVersion !== undefined) {
      meta.sessionAeVersion = options.sessionAeVersion;
    }
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: "wx" });
    reused = false;
  } else {
    privatePath(metaPath, "the native channel metadata", "file");
    let meta: { v?: unknown; token?: unknown };
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8")) as typeof meta;
    } catch (error) {
      throw new HostUnavailableError(
        `cannot parse the native channel metadata at ${metaPath}: ${errorMessage(error)}`,
      );
    }
    if (meta.v !== 1 || typeof meta.token !== "string" || !TOKEN_RE.test(meta.token)) {
      throw new HostUnavailableError(`invalid native channel metadata at ${metaPath}`);
    }
    token = meta.token;
  }
  return { root: resolved, token, inbox, outbox, reused };
}

/**
 * Read the plug-in heartbeat. Returns null when no fresh, well-formed
 * `state.json` exists — absence is information, not an error. The caller
 * decides freshness from `lastTick` (epoch ms).
 */
export function readNativeChannelState(root: string): NativeChannelState | null {
  const statePath = join(root, NATIVE_CHANNEL_STATE);
  if (!existsSync(statePath)) {
    return null;
  }
  let raw: string;
  try {
    const info = statSync(statePath);
    if (!info.isFile() || info.size > MAX_JSON_FILE_BYTES) {
      return null;
    }
    raw = readFileSync(statePath, "utf-8");
  } catch {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    doc.v !== 1 ||
    typeof doc.instance !== "string" ||
    doc.instance === "" ||
    typeof doc.pluginId !== "number" ||
    typeof doc.lastTick !== "number" ||
    !Array.isArray(doc.allowlist) ||
    !doc.allowlist.every((op) => typeof op === "string")
  ) {
    return null;
  }
  const state: NativeChannelState = {
    instance: doc.instance,
    pluginId: doc.pluginId,
    lastTick: doc.lastTick,
    allowlist: doc.allowlist,
  };
  if (typeof doc.aeVersion === "string") {
    state.aeVersion = doc.aeVersion;
  }
  return state;
}

function assertRequestInput(input: NativeRequestInput): void {
  if (!NATIVE_REQUEST_ID_RE.test(input.requestId)) {
    throw new ScriptNotSentError(
      `requestId must match ${NATIVE_REQUEST_ID_RE} for the file channel: ${JSON.stringify(input.requestId)}`,
    );
  }
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs < 0 ||
    input.timeoutMs > NATIVE_TIMEOUT_MAX_MS
  ) {
    throw new ScriptNotSentError(
      `timeoutMs must be finite and within [0, ${NATIVE_TIMEOUT_MAX_MS}]: ${input.timeoutMs}`,
    );
  }
  if (
    input.session === undefined ||
    typeof input.session.sessionId !== "string" ||
    input.session.sessionId === "" ||
    typeof input.session.aeVersion !== "string" ||
    input.session.aeVersion === ""
  ) {
    throw new ScriptNotSentError("the dispatch session pin is incomplete");
  }
  if (typeof input.operationId !== "string" || input.operationId === "") {
    throw new ScriptNotSentError("operationId must be a non-empty string");
  }
}

/**
 * Publish a request envelope into the channel inbox. Atomic or nothing:
 * the file appears via `.part` + rename at mode 0600, and an existing
 * `<requestId>.request.json` refuses the send (ScriptNotSentError —
 * nothing was sent, so fixing the id and retrying is safe).
 */
export function publishNativeRequest(
  channel: PreparedNativeChannel,
  input: NativeRequestInput,
): void {
  assertRequestInput(input);
  const target = join(channel.inbox, `${input.requestId}${NATIVE_REQUEST_SUFFIX}`);
  if (existsSync(target)) {
    throw new ScriptNotSentError(
      `a native channel request for ${input.requestId} already exists`,
    );
  }
  const inner: Record<string, unknown> = {
    schema: NATIVE_DISPATCH_SCHEMA,
    requestId: input.requestId,
    session: input.session,
    operationId: input.operationId,
  };
  if (input.args !== undefined) {
    inner.args = input.args;
  }
  if (input.authorizationRef !== undefined) {
    inner.authorizationRef = input.authorizationRef;
  }
  const envelope: Record<string, unknown> = {
    v: 1,
    token: channel.token,
    timeoutMs: input.timeoutMs,
    request: inner,
  };
  if (input.target !== undefined) {
    envelope.target = input.target;
  }
  /* Serialize BEFORE any file is created: an unserializable args value
     (circular structure, BigInt, throwing getter) must surface as
     ScriptNotSentError — nothing was sent, so re-issuing under a fixed
     input is safe. A raw TypeError would leave callers unable to tell
     "provably not sent" from "maybe sent". */
  let body: string;
  try {
    body = `${JSON.stringify(envelope)}\n`;
  } catch (err) {
    throw new ScriptNotSentError(
      `request envelope is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const part = `${target}.part`;
  writeFileSync(part, body, { mode: 0o600 });
  renameSync(part, target);
}

function readResultFile(path: string): unknown {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_JSON_FILE_BYTES) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Structural check of the result wrapper. A malformed or mismatched file
 * is left in the outbox as evidence and the wait continues — delivering
 * a guess would be worse than reporting UNKNOWN.
 */
function validateResultEnvelope(
  value: unknown,
  requestId: string,
): NativeResultDelivery | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const doc = value as Record<string, unknown>;
  if (doc.v !== 1) {
    return null;
  }
  const host = doc.host as Record<string, unknown> | undefined;
  const result = doc.result as Record<string, unknown> | undefined;
  if (
    typeof doc.instance !== "string" ||
    doc.instance === "" ||
    host === undefined ||
    typeof host !== "object" ||
    typeof host.plugin !== "string" ||
    typeof host.pluginId !== "number" ||
    typeof host.aeVersion !== "string" ||
    result === undefined ||
    typeof result !== "object"
  ) {
    return null;
  }
  if (
    result.schema !== NATIVE_DISPATCH_SCHEMA ||
    result.requestId !== requestId ||
    typeof result.outcome !== "string" ||
    !(NATIVE_DISPATCH_OUTCOMES as readonly string[]).includes(result.outcome)
  ) {
    return null;
  }
  // Mirror the semantic validator's required-field rules closely enough
  // that a delivered result is never internally inconsistent.
  if (result.outcome === "refused" && typeof result.refusalCode !== "string") {
    return null;
  }
  if (result.outcome === "completed" && result.result === undefined) {
    return null;
  }
  if (
    (result.outcome === "unknown" || result.outcome === "failed") &&
    typeof result.mayHaveMutated !== "boolean"
  ) {
    return null;
  }
  const delivery: NativeResultDelivery = {
    instance: doc.instance,
    host: {
      plugin: host.plugin,
      pluginId: host.pluginId,
      aeVersion: host.aeVersion,
    },
    result: result as unknown as NativeDispatchResult,
  };
  return delivery;
}

/**
 * Wait for the result of a published request. Resolves with the typed
 * delivery on any plug-in verdict (`completed`, `refused`, `failed`,
 * `not-sent`); throws `NativeChannelTimeoutError` — the client's
 * UNKNOWN — when nothing valid arrives within `timeoutMs + graceMs`.
 * The result file is left in the outbox as evidence.
 */
export async function awaitNativeResult(
  channel: PreparedNativeChannel,
  requestId: string,
  timeoutMs: number,
  options: AwaitNativeResultOptions = {},
): Promise<NativeResultDelivery> {
  const graceMs = options.graceMs ?? 60_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const waitedMs = timeoutMs + graceMs;
  const deadline = now() + waitedMs;
  const resultPath = join(channel.outbox, `${requestId}${NATIVE_RESULT_SUFFIX}`);
  for (;;) {
    if (existsSync(resultPath)) {
      const delivery = validateResultEnvelope(readResultFile(resultPath), requestId);
      if (delivery !== null) {
        return delivery;
      }
      // Malformed or foreign: evidence stays, keep waiting.
    }
    if (now() >= deadline) {
      throw new NativeChannelTimeoutError(requestId, waitedMs);
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/**
 * Path of a leftover claim artifact. The plug-in renames
 * `<requestId>.request.json` to `<requestId>.claimed` on claim and only
 * removes it after a verdict is published; a surviving file means an
 * interrupted request — evidence to inspect, never to replay.
 */
export function claimedRequestPath(
  channel: PreparedNativeChannel,
  requestId: string,
): string {
  return join(channel.inbox, `${requestId}${NATIVE_CLAIMED_SUFFIX}`);
}

/** Diagnostic helper: whether a claimed artifact exists for an id. */
export function hasClaimedRequest(
  channel: PreparedNativeChannel,
  requestId: string,
): boolean {
  return existsSync(claimedRequestPath(channel, requestId));
}
