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
 *   <root>/channel.json                     {v:1, token, consentKey?, sessionAeVersion?}  0600
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
 * - Mutating (`requiresConsent`) operations additionally need a §7g
 *   consent proof AND an explicit authorization grant. The grant is
 *   caller-side recorded consent snapshotted at `prepareNativeChannel`
 *   and replaceable/revocable via `updateNativeChannelAuthorization`
 *   (#145/#248 model): `publishNativeRequest` evaluates it BEFORE any
 *   MAC is issued and refuses unapproved mutations as
 *   `ScriptNotSentError` — provably nothing was sent. A valid MAC alone
 *   is never treated as authorization; it proves possession of
 *   `consentKey` and binding to the exact scope fields, nothing more
 *   (see `native-consent.ts` for the honest boundary).
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
import {
  ConsentCanonicalError,
  canonicalJson,
  issueConsentMac,
  nativeOperationRequiresConsent,
} from "./native-consent.js";
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

/**
 * One scoped grant inside a `NativeMutationAuthorization` (#248).
 *
 * A grant names exactly one `requiresConsent` operationId — grants are
 * per-operation, never operation-class-wide, so adding a future
 * mutation to `NATIVE_REQUIRES_CONSENT_OPERATIONS` can never inherit
 * authority from an existing grant: the new op needs its own entry.
 */
export type NativeMutationGrant = {
  /**
   * Exact `requiresConsent` operationId this grant covers — currently
   * only `AEGP_ItemSuite9.AEGP_SetItemComment` (see
   * `NATIVE_REQUIRES_CONSENT_OPERATIONS`). Read-only operations never
   * consult grants, and a grant for a non-consent operationId is
   * rejected at validation time.
   */
  operationId: string;
  /**
   * Instance `target` values this grant is bound to. When present, a
   * mutation request must name one of them — an untargeted request is
   * NOT covered. When absent, any target on this channel is covered,
   * including untargeted (legacy) requests.
   */
  targets?: readonly string[];
  /**
   * Partial deep-match constraint over the request `args` (#248):
   *
   * - objects: every pattern key must exist in the request args and
   *   match recursively; extra request keys are allowed (subset match)
   * - arrays: same length, element-wise recursive match
   * - primitives: strict equality
   * - absent (`undefined`): no args constraint — the grant covers the
   *   operation for ANY args. This is an explicit, documented choice;
   *   a narrow grant should always pin the descriptor fields
   *   (e.g. `projectIndex`, `item.aeRef.itemId`) so one item's grant
   *   cannot mutate another.
   *
   * This is POLICY, distinct from the §7g MAC: the MAC binds whatever
   * args the request carries, but only this pattern decides whether
   * those args were authorized. The pattern must live in the
   * consent-canonical domain (integers only, no lone surrogates, no
   * `undefined`/floats/functions) — anything else is rejected when the
   * authorization is validated.
   */
  args?: unknown;
};

/**
 * Caller-side recorded consent for mutating (`requiresConsent`)
 * native-channel operations (#245, #248; #145 grant model).
 *
 * This is the ae-a8n-owned authorization layer: it decides which
 * (session, operation, target, args) scopes may carry a §7g consent
 * proof at all, and it is evaluated BEFORE any MAC is issued. It is
 * snapshotted when the channel is prepared and can be replaced or
 * revoked while the channel lives via
 * `updateNativeChannelAuthorization` — but requests already published
 * (and their issued MACs) cannot be recalled; revocation only gates
 * FUTURE `publishNativeRequest` calls.
 *
 * Like `LaunchOptions.authorization` it is NOT host-authenticated —
 * it is the policy gate inside the channel's trust boundary; the
 * plug-in only verifies the resulting proof.
 */
export type NativeMutationAuthorization = {
  /**
   * `session.sessionId` values this authorization applies to. When
   * present, a mutation request whose session is not listed is NOT
   * covered — a grant cannot be replayed across sessions. When absent,
   * any session reported on this channel is covered (the channel's
   * single-user scope makes session identity advisory, not a boundary).
   */
  sessionIds?: readonly string[];
  /** Per-operation grant entries; a request is covered when ANY entry
   *  matches its (operationId, target, args) scope. */
  grants: readonly NativeMutationGrant[];
};

export type PrepareNativeChannelOptions = {
  /**
   * Optional `"M.m"` driver-version pin written into `channel.json`.
   * When present the plug-in refuses every request `WRONG_TARGET` unless
   * its observed version matches.
   */
  sessionAeVersion?: string;
  /**
   * Explicit grant covering mutating operations. Absent = the channel
   * authorizes no mutations: `requiresConsent` requests are refused
   * before anything is sent. Read-only requests are unaffected.
   */
  authorization?: NativeMutationAuthorization;
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
  /**
   * The §7g consent MAC key, same secrecy domain as `token` (0600
   * `channel.json`, never written to results/logs). Minted alongside
   * the token; a legacy `channel.json` without one is backfilled.
   */
  consentKey: string;
  inbox: string;
  outbox: string;
  /** True when channel.json already existed (token reused). */
  reused: boolean;
  /** The validated grant snapshot, when one was supplied. */
  authorization?: NativeMutationAuthorization;
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

type ChannelMeta = {
  token: string;
  consentKey: string;
  sessionAeVersion?: string;
};

function readChannelMeta(metaPath: string): ChannelMeta {
  privatePath(metaPath, "the native channel metadata", "file");
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    throw new HostUnavailableError(
      `cannot parse the native channel metadata at ${metaPath}: ${errorMessage(error)}`,
    );
  }
  if (meta.v !== 1 || typeof meta.token !== "string" || !TOKEN_RE.test(meta.token)) {
    throw new HostUnavailableError(`invalid native channel metadata at ${metaPath}`);
  }
  /* A missing or malformed consentKey is backfilled by the caller —
     the plug-in treats it as absent (CONSENT_REQUIRED, fail closed),
     so a legacy channel.json stays usable for read-only ops. */
  const consentKey =
    typeof meta.consentKey === "string" && TOKEN_RE.test(meta.consentKey)
      ? meta.consentKey
      : "";
  const out: ChannelMeta = { token: meta.token, consentKey };
  if (typeof meta.sessionAeVersion === "string") {
    out.sessionAeVersion = meta.sessionAeVersion;
  }
  return out;
}

/**
 * Validate an args-scope pattern (#248). The pattern lives in the
 * consent-canonical domain so it compares against request args in the
 * same value space the §7g MAC binds: integers only, no lone
 * surrogates, and no `undefined` anywhere (canonicalJson would silently
 * drop object keys or turn array holes into `null` — a pattern that
 * means something different than it reads is refused instead).
 * Returns a canonical deep copy so later caller-side mutation cannot
 * widen the grant.
 */
function canonicalArgsPattern(value: unknown, what: string): unknown {
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) {
      throw new TypeError(`${what} contains undefined at ${path}`);
    }
    if (v === null || typeof v === "boolean" || typeof v === "string") {
      return;
    }
    if (typeof v === "number") {
      if (!Number.isInteger(v) || Math.abs(v) > 9007199254740991) {
        throw new TypeError(`${what} contains a non-canonical number at ${path}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((e, i) => walk(e, `${path}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
        walk(e, `${path}.${k}`);
      }
      return;
    }
    throw new TypeError(`${what} contains an unsupported value at ${path}`);
  };
  walk(value, "$");
  try {
    /* canonicalJson is the single source of truth for the canonical
       domain (surrogates, key order); parse its output back so the
       stored pattern is a detached canonical clone. */
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    if (error instanceof ConsentCanonicalError) {
      throw new TypeError(`${what} is not consent-canonical: ${error.message}`);
    }
    throw error;
  }
}

function requireNativeMutationGrant(value: unknown): NativeMutationGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("each authorization.grants entry must be an object");
  }
  const grant = value as Record<string, unknown>;
  for (const key of Object.keys(grant)) {
    if (key !== "operationId" && key !== "targets" && key !== "args") {
      throw new TypeError(
        `authorization.grants[].${key} is not a grant scope; known scopes: operationId, targets, args`,
      );
    }
  }
  const operationId = grant.operationId;
  if (typeof operationId !== "string" || operationId === "") {
    throw new TypeError("authorization.grants[].operationId must be a non-empty string");
  }
  if (!nativeOperationRequiresConsent(operationId)) {
    /* A grant can only ever name a consent-gated operation: read-only
       ops need no grant, and an opId typo fails loudly here instead of
       silently authorizing nothing. A future mutation op joins
       NATIVE_REQUIRES_CONSENT_OPERATIONS together with its own grant
       entries — it can never inherit this grant's authority. */
    throw new TypeError(
      `authorization.grants[].operationId ${JSON.stringify(operationId)} does not require consent`,
    );
  }
  const targets = grant.targets;
  if (
    targets !== undefined &&
    (!Array.isArray(targets) ||
      !targets.every((t) => typeof t === "string" && t !== ""))
  ) {
    throw new TypeError(
      "authorization.grants[].targets must be a list of instance target ids",
    );
  }
  const out: NativeMutationGrant = { operationId };
  if (targets !== undefined) {
    out.targets = [...(targets as string[])];
  }
  if (grant.args !== undefined) {
    out.args = canonicalArgsPattern(grant.args, "authorization.grants[].args");
  }
  return out;
}

/**
 * Validate and snapshot the caller's mutation grant. Anything that
 * cannot be read as an explicit scope list is refused before the
 * channel exists — a grant that cannot be read is not a grant (same
 * rule as `requireAuthorization` for session grants).
 */
function requireNativeMutationAuthorization(
  value: unknown,
): NativeMutationAuthorization | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("authorization must be an object of grant scopes");
  }
  const grant = value as Record<string, unknown>;
  for (const key of Object.keys(grant)) {
    if (key !== "sessionIds" && key !== "grants") {
      throw new TypeError(
        `authorization.${key} is not a grant scope; known scopes: sessionIds, grants`,
      );
    }
  }
  const sessionIds = grant.sessionIds;
  if (
    sessionIds !== undefined &&
    (!Array.isArray(sessionIds) ||
      !sessionIds.every((s) => typeof s === "string" && s !== ""))
  ) {
    throw new TypeError("authorization.sessionIds must be a list of session ids");
  }
  const grants = grant.grants;
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new TypeError(
      "authorization.grants must be a non-empty list of grant entries",
    );
  }
  /* Snapshot: the channel's grant must not follow later mutation of
     the caller's arrays/objects — authorization is fixed when it is
     set, not when it is read again. */
  return {
    ...(sessionIds === undefined
      ? {}
      : { sessionIds: [...(sessionIds as string[])] }),
    grants: grants.map(requireNativeMutationGrant),
  };
}

/**
 * Partial deep-match of an args-scope pattern against request args
 * (#248). See `NativeMutationGrant.args` for the semantics; both sides
 * are compared in the consent-canonical domain (absent args ≡ null).
 */
function grantArgsCover(pattern: unknown, actual: unknown): boolean {
  const a = actual ?? null;
  if (pattern === null || typeof pattern !== "object") {
    return pattern === a;
  }
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(a) &&
      a.length === pattern.length &&
      pattern.every((p, i) => grantArgsCover(p, a[i]))
    );
  }
  if (typeof a !== "object" || a === null || Array.isArray(a)) {
    return false;
  }
  const rec = a as Record<string, unknown>;
  return Object.keys(pattern as Record<string, unknown>).every((k) =>
    Object.prototype.hasOwnProperty.call(rec, k) &&
    grantArgsCover((pattern as Record<string, unknown>)[k], rec[k]),
  );
}

/**
 * Create or validate the channel root and mint/reuse its secrets.
 * Idempotent: `channel.json` is created once (`wx`) and its token and
 * consentKey reused, so a plug-in configured earlier keeps working
 * across sessions. A legacy `channel.json` without a consentKey is
 * backfilled in place (same 0600 privacy) — the plug-in re-reads
 * `channel.json` every tick, so the key takes effect without a
 * restart. The plug-in never creates directories — an unprepared root
 * simply means intake stays dark.
 */
export function prepareNativeChannel(
  root: string,
  options: PrepareNativeChannelOptions = {},
): PreparedNativeChannel {
  if (!isAbsolute(root)) {
    throw new HostUnavailableError(`native channel root must be absolute: ${root}`);
  }
  const authorization = requireNativeMutationAuthorization(options.authorization);
  const resolved = resolve(root);
  ensurePrivateDir(resolved, "the native channel root");
  const inbox = join(resolved, "inbox");
  const outbox = join(resolved, "outbox");
  ensurePrivateDir(inbox, "the native channel inbox");
  ensurePrivateDir(outbox, "the native channel outbox");

  const metaPath = join(resolved, NATIVE_CHANNEL_META);
  let reused = true;
  if (!existsSync(metaPath)) {
    const meta: Record<string, unknown> = {
      v: 1,
      token: randomBytes(32).toString("hex"),
      consentKey: randomBytes(32).toString("hex"),
    };
    if (options.sessionAeVersion !== undefined) {
      meta.sessionAeVersion = options.sessionAeVersion;
    }
    try {
      writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: "wx" });
      reused = false;
    } catch (error) {
      /* A concurrent prepare won the `wx` race: fall through and adopt
         the winner's metadata instead of failing or overwriting it. */
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  let meta = readChannelMeta(metaPath);
  if (meta.consentKey === "") {
    /* Backfill: preserve token and session pin, mint a fresh consent
       key. Atomic replace at 0600; a racing backfill resolves to
       whichever write landed last, and the re-read below adopts the
       on-disk winner. */
    const next: Record<string, unknown> = {
      v: 1,
      token: meta.token,
      consentKey: randomBytes(32).toString("hex"),
    };
    if (meta.sessionAeVersion !== undefined) {
      next.sessionAeVersion = meta.sessionAeVersion;
    }
    const part = `${metaPath}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(part, metaPath);
    meta = readChannelMeta(metaPath);
  }
  const channel: PreparedNativeChannel = {
    root: resolved,
    token: meta.token,
    consentKey: meta.consentKey,
    inbox,
    outbox,
    reused,
  };
  if (authorization !== undefined) {
    channel.authorization = authorization;
  }
  return channel;
}

/**
 * Replace or revoke the channel's mutation grant while it lives (#248).
 * Passing `undefined` revokes all mutation authority (fail closed).
 *
 * Scope of the change: only FUTURE `publishNativeRequest` calls are
 * gated by the new grant. Requests already published — and the §7g
 * MACs already issued for them — cannot be recalled; cancelling an
 * in-flight mutation is not possible through this API (a fresh
 * requestId is the only way to express a new intent).
 *
 * Re-preparing the same root WITHOUT an authorization does not touch
 * an existing `PreparedNativeChannel` object, but the new object it
 * returns carries no grant — callers that re-prepare get fail-closed
 * behavior unless they pass authorization again.
 */
export function updateNativeChannelAuthorization(
  channel: PreparedNativeChannel,
  authorization: NativeMutationAuthorization | undefined,
): void {
  const validated = requireNativeMutationAuthorization(authorization);
  if (validated === undefined) {
    delete channel.authorization;
  } else {
    channel.authorization = validated;
  }
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
 * Whether the channel's grant covers this mutation request (#248).
 * A request is covered when the authorization's `sessionIds` (when
 * present) names the request's session AND at least one grant entry
 * matches on operationId, target scope, and args scope. Grant
 * evaluation is POLICY: the §7g MAC binds the args whatever they are,
 * but only this check decides whether those args were authorized.
 */
function grantCoversMutation(
  authorization: NativeMutationAuthorization | undefined,
  input: NativeRequestInput,
): boolean {
  if (authorization === undefined) {
    return false;
  }
  if (
    authorization.sessionIds !== undefined &&
    !authorization.sessionIds.includes(input.session.sessionId)
  ) {
    return false;
  }
  return authorization.grants.some(
    (grant) =>
      grant.operationId === input.operationId &&
      (grant.targets === undefined ||
        (input.target !== undefined && grant.targets.includes(input.target))) &&
      (grant.args === undefined || grantArgsCover(grant.args, input.args)),
  );
}

/**
 * Publish a request envelope into the channel inbox. Atomic or nothing:
 * the file appears via `.part` + rename at mode 0600, and an existing
 * `<requestId>.request.json` refuses the send (ScriptNotSentError —
 * nothing was sent, so fixing the id and retrying is safe).
 *
 * `requiresConsent` operations additionally pass two gates BEFORE any
 * file is written (#245, #248): the channel's authorization grant must
 * cover the (session, operationId, target, args) scope, and only then
 * is the §7g consent MAC issued over the exact request scope. A MAC is
 * never treated as authorization by itself — grant evaluation comes
 * first, always.
 */
export function publishNativeRequest(
  channel: PreparedNativeChannel,
  input: NativeRequestInput,
): void {
  assertRequestInput(input);
  let consent: { v: 1; mac: string } | undefined;
  if (nativeOperationRequiresConsent(input.operationId)) {
    if (!grantCoversMutation(channel.authorization, input)) {
      throw new ScriptNotSentError(
        `native mutation ${input.operationId}` +
          (input.target === undefined ? "" : ` on target ${input.target}`) +
          " is not covered by the channel authorization grant" +
          " — pass authorization.grants entries (with sessionIds," +
          " targets and args scopes as needed) in prepareNativeChannel" +
          " or updateNativeChannelAuthorization; nothing was sent",
      );
    }
    try {
      consent = {
        v: 1,
        mac: issueConsentMac(channel.consentKey, {
          operationId: input.operationId,
          requestId: input.requestId,
          session: input.session,
          args: input.args,
          ...(input.target === undefined ? {} : { target: input.target }),
        }),
      };
    } catch (error) {
      /* Consent cannot be issued (non-canonical args, bad key shape):
         provably nothing was sent, so ScriptNotSentError keeps the
         not-sent contract — re-issuing under a fixed input is safe. */
      throw new ScriptNotSentError(
        `consent proof cannot be issued for ${input.operationId}: ` +
          `${errorMessage(error)}; nothing was sent`,
      );
    }
  }
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
  if (consent !== undefined) {
    envelope.consent = consent;
  }
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

/**
 * Read-back reconciliation verdicts (trusted-execution.md §8.3).
 *
 * - `state-consistent`: the observed state matches the intended
 *   post-state. This is CONSISTENCY EVIDENCE, never causal proof —
 *   the same state could come from a concurrent actor or a prior
 *   identical mutation. It must not be reported as "the mutation
 *   landed".
 * - `state-inconsistent`: observed state contradicts the intended
 *   post-state. For `AEGP_SetItemComment` the effect is fully
 *   observable through `AEGP_GetItemComment`, so this means the
 *   mutation did not land — still recorded as evidence, and a
 *   concurrent actor could in principle have restored the state.
 * - `unobservable`: no allowlisted read could determine the state
 *   (refusal, failure, or a malformed payload). The outcome stays
 *   quarantined for manual reconciliation — never guessed.
 */
export type NativeCommentReconciliation =
  | { verdict: "state-consistent"; observedComment: string }
  | { verdict: "state-inconsistent"; observedComment: string }
  | { verdict: "unobservable"; detail: string };

export type ReconcileItemCommentOptions = {
  /** Fresh file-name-safe id for the read-back request (never reuse
   *  the mutation's requestId — consent proofs and the plug-in
   *  seen-ring are requestId-bound). */
  requestId: string;
  /** Plug-in-side deadline budget for the read-back request. */
  timeoutMs: number;
  /** Instance binding, when the mutation was target-bound. */
  target?: string;
  /** Result-wait tuning; same semantics as `awaitNativeResult`. */
  awaitOptions?: AwaitNativeResultOptions;
};

/**
 * Reconcile an uncertain `AEGP_ItemSuite9.AEGP_SetItemComment` outcome
 * by reading the item's comment back through the read-only
 * `AEGP_ItemSuite9.AEGP_GetItemComment` getter on the same descriptor
 * (contract §7h / trusted-execution.md §8.3).
 *
 * `scope` carries the same `{projectIndex, item}` descriptor args the
 * mutation used; `expectedComment` is the intended post-state
 * (`""` clears). The read-back is a normal read-only request — it
 * needs no consent grant and works on any prepared channel.
 *
 * A `NativeChannelTimeoutError` from the read-back propagates
 * unchanged: the reconciliation itself is then UNKNOWN and the
 * mutation outcome stays quarantined — never resent, never guessed.
 */
export async function reconcileItemComment(
  channel: PreparedNativeChannel,
  scope: {
    session: NativeRequestInput["session"];
    projectIndex: number;
    item: unknown;
  },
  expectedComment: string,
  options: ReconcileItemCommentOptions,
): Promise<NativeCommentReconciliation> {
  publishNativeRequest(channel, {
    requestId: options.requestId,
    timeoutMs: options.timeoutMs,
    session: scope.session,
    operationId: "AEGP_ItemSuite9.AEGP_GetItemComment",
    args: { projectIndex: scope.projectIndex, item: scope.item },
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  const delivery = await awaitNativeResult(
    channel,
    options.requestId,
    options.timeoutMs,
    options.awaitOptions,
  );
  const result = delivery.result;
  if (result.outcome !== "completed") {
    return {
      verdict: "unobservable",
      detail:
        result.outcome +
        (result.refusalCode === undefined ? "" : `/${result.refusalCode}`),
    };
  }
  const payload = result.result as { comment?: unknown } | undefined;
  if (payload === undefined || typeof payload.comment !== "string") {
    return { verdict: "unobservable", detail: "completed result carried no comment" };
  }
  return payload.comment === expectedComment
    ? { verdict: "state-consistent", observedComment: payload.comment }
    : { verdict: "state-inconsistent", observedComment: payload.comment };
}
