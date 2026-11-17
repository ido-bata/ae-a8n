/**
 * The opt-in in-AE dispatcher transport (#127, ADR-0003 candidate).
 *
 * Instead of delivering every request with an Apple Event / `DoScriptFile`
 * / `AfterFX.exe -r`, this transport writes the request envelope into a
 * private per-user channel directory. An ExtendScript dispatcher that a
 * human activated inside After Effects (`host/a8n-host.js` dispatcher mode)
 * polls that channel with `app.scheduleTask` and answers the same named
 * operations. No per-call OS automation, no GUI foregrounding.
 *
 * What this transport is NOT:
 *
 * - It never launches or quits After Effects. The host must already be
 *   running with the dispatcher activated; `launch()` only prepares the
 *   channel and refuses while no dispatcher heartbeat is fresh.
 * - It cannot prove which After Effects process the dispatcher lives in.
 *   Ownership is always "attached"; `ae.call`, `hostEnvironment` and
 *   owned-only teardown refuse, exactly as for any unattested host.
 * - The channel is private to the OS user (0700 / verified ACLs), which
 *   stops other users — it is NOT same-user authentication. The token
 *   filters accidental writers, not a malicious process running as the
 *   same user (ADR-0003 trust boundary).
 * - A timeout is UNKNOWN and is never resent: the request file stays
 *   claimed-or-unclaimed exactly once, and the driver never retries.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { es3StringLiteral, toPosixPath } from "./bootstrap.js";
import { HostUnavailableError } from "./driver.js";
import { readExtensionManifest } from "../extensions/manifest.js";
import {
  channelAclVerdict,
  icaclsCommand,
  keyFileAclVerdict,
  ownerQualifiers,
  parseIcacls,
} from "../platform/windows/acl.js";
import type {
  HostAttestation,
  HostOwnership,
  HostState,
  HostTransport,
  InvokeOptions,
} from "./transport.js";
import { DISPATCHER_TRANSPORT_KIND, ScriptNotSentError } from "./transport.js";

export { DISPATCHER_TRANSPORT_KIND };

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_DIR = join(PACKAGE_ROOT, "host");

/** Per-user channel root when the caller does not name one. */
export function defaultDispatcherChannelDir(home: string = homedir()): string {
  return join(home, ".ae-a8n", "dispatcher");
}

export type DispatcherTransportOptions = {
  /** Channel directory. Must be absolute; created private (0700) if absent. */
  readonly channelDir?: string;
  /**
   * Test seam: the platform the *target* AE runs on — Startup placement,
   * version probing, attestation. It does not change filesystem privacy
   * checks, which always follow the real host (`process.platform`): mode
   * bits mean nothing on Windows and `icacls` does not exist on POSIX.
   */
  readonly platform?: NodeJS.Platform;
  /** Test seam: home directory for the default channel and ACL owner checks. */
  readonly homeDir?: string;
  /** Test seam: environment for the Windows ACL owner qualifiers. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: the clock, for heartbeat freshness. */
  readonly now?: () => number;
  /**
   * How stale `state.json`'s `lastTick` may be before the dispatcher
   * counts as not answering. The host rewrites it every ~2 s at the
   * default poll interval; 10 s tolerates a busy AE without calling a
   * dead dispatcher alive.
   */
  readonly heartbeatStaleMs?: number;
  /** How often the result pump checks the channel outbox. */
  readonly pumpIntervalMs?: number;
  /**
   * How long a delivered-late result is still bridged into the session
   * outbox after the caller's deadline. Covers the driver's post-timeout
   * recovery grace; after it the pending entry is dropped.
   */
  readonly lateResultMs?: number;
  /**
   * Pin the session to one dispatcher instance (#145). When set, `launch()`
   * refuses unless the answering dispatcher's heartbeat `instance` equals
   * it — a reconnect can prove it reached the same After Effects engine it
   * meant to, and a different one is refused rather than operated.
   */
  readonly expectedInstance?: string;
  /**
   * The effective host script the dispatcher must run (#146): a file built
   * by `ae-a8n extension build`, or absent for the shipped host. `prepare()`
   * stages it into the channel and records its sha256 and declared
   * extension manifest in `channel.json`; `launch()` refuses while the
   * answering dispatcher's heartbeat reports a different registered set.
   */
  readonly hostScriptPath?: string;
};

/** What `state.json` says about the activated dispatcher. */
export type DispatcherHeartbeat = {
  readonly v: number;
  readonly token: string;
  readonly instance: string;
  readonly aeVersion: string;
  readonly activatedAt: number;
  readonly lastTick: number;
  readonly pollMs: number;
  /**
   * Extension method names the dispatcher actually registered at activation
   * (#146), sorted. Absent in heartbeats written before the field existed;
   * {@link DispatcherTransport} normalises a missing value to `[]`, which a
   * staged extension set then mismatches — an old dispatcher cannot prove
   * it runs the staged extensions, so it is refused rather than trusted.
   */
  readonly extensionMethods?: readonly string[];
  /**
   * The registration fingerprint the activated host script declared, or
   * null when it was not built by `ae-a8n extension build`. Identity
   * evidence for staged-vs-active comparison — never proof that After
   * Effects approved the code.
   */
  readonly extensionsRegistration?: string | null;
};

/** The staged host script's identity, recorded in `channel.json`. */
export type StagedHostManifest = {
  readonly sha256: string;
  readonly methods: readonly string[];
  readonly registration: string | null;
};

const CHANNEL_META = "channel.json";
const STATE_FILE = "state.json";
const ACTIVATE_SCRIPT = "activate.jsx";
const STARTUP_SCRIPT_NAME = "a8n-dispatcher.jsx";
const REQUEST_SUFFIX = ".request.json";
const RESULT_SUFFIX = ".result.json";
const TOKEN_RE = /^[a-f0-9]{64}$/;
const REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Outbox deliveries older than this are swept on prepare. */
const RESULT_MAX_AGE_MS = 60 * 60 * 1000;
/** Inbox leftovers older than this are swept on prepare. */
const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First two version components, as AE's per-user Scripts folders are named. */
export function aeScriptsVersion(aeVersion: string): string {
  const parts = aeVersion.trim().split(".");
  if (parts.length < 2 || !/^\d+$/.test(parts[0] ?? "") || !/^\d+$/.test(parts[1] ?? "")) {
    throw new Error(`cannot derive the Scripts folder version from ${JSON.stringify(aeVersion)}`);
  }
  return `${parts[0]}.${parts[1]}`;
}

/**
 * The per-user `Scripts/Startup` directory AE reads for `aeVersion`
 * (e.g. "26.5"), as the G0 probe established (`scripts/startup-probe.mjs`).
 * This is a path computation only — whether AE 2026/2027 actually executes
 * a Startup entry is the still-open G0 question, marked unproven.
 */
export function dispatcherStartupDir(options: {
  readonly aeVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const version = aeScriptsVersion(options.aeVersion);
  if (platform === "darwin") {
    // The result names a path on the *target* platform: join with that
    // platform's separators, not the host's — a Windows host computing a
    // macOS path must still produce `~/Library/Preferences/...`.
    return posix.join(
      home,
      "Library",
      "Preferences",
      "Adobe",
      "After Effects",
      version,
      "Scripts",
      "Startup",
    );
  }
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "Adobe", "After Effects", version, "Scripts", "Startup");
  }
  throw new Error(`no per-user Scripts/Startup location is known for platform ${platform}`);
}

/** The `CFBundleShortVersionString` of an AE .app bundle, "26.x[.y]". */
export function aeVersionFromMacBundle(appPath: string): string {
  const plist = join(appPath, "Contents", "Info.plist");
  const text = readFileSync(plist, "utf-8");
  const short = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(text)?.[1];
  if (short === undefined) {
    throw new Error(`cannot read CFBundleShortVersionString from ${plist}`);
  }
  return aeScriptsVersion(short);
}

/** Resolves the .app bundle path from an install dir or a direct .app path. */
export function macBundlePath(installDir: string): string {
  return installDir.endsWith(".app") ? installDir : join(installDir, `${basename(installDir)}.app`);
}

type PendingDelivery = {
  readonly id: string;
  /** Where the session expects the result envelope. */
  readonly resultPath: string;
  /** Drop the pending entry after this; a later result is not bridged. */
  readonly dropAt: number;
};

export class DispatcherTransport implements HostTransport {
  readonly kind = DISPATCHER_TRANSPORT_KIND;
  /**
   * The dispatcher enforces the session marker through the same `dispatch`
   * table (`session.adopt` / `session.require`), so the driver may use it.
   */
  readonly verifiesDestination = true;

  readonly #platform: NodeJS.Platform;
  readonly #homeDir: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #heartbeatStaleMs: number;
  readonly #pumpIntervalMs: number;
  readonly #lateResultMs: number;
  readonly #channelDir: string;
  readonly #expectedInstance: string | undefined;
  readonly #hostScriptPath: string | undefined;

  #prepared = false;
  #token: string | null = null;
  #closed = false;
  #inFlight: string | null = null;
  #pump: ReturnType<typeof setInterval> | null = null;
  /**
   * The dispatcher `instance` this session bound to at launch (#145).
   * Requests carry it as `target`; a heartbeat that starts naming a
   * different instance means the answering After Effects changed, and
   * further calls are refused rather than delivered to the wrong engine.
   */
  #boundInstance: string | null = null;
  /**
   * The extension set the answering dispatcher reported at `launch()`
   * (#146) — what is actually registered inside After Effects, which
   * `launch()` proved equals the staged manifest. Null until then.
   */
  #boundExtensions: { readonly methods: readonly string[]; readonly registration: string | null } | null = null;
  /** The staged host script's identity, computed by `prepare()` (#146). */
  #stagedHost: StagedHostManifest | null = null;
  readonly #pending = new Map<string, PendingDelivery>();

  constructor(options: DispatcherTransportOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#homeDir = options.homeDir ?? homedir();
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => Date.now());
    this.#heartbeatStaleMs = options.heartbeatStaleMs ?? 10_000;
    this.#pumpIntervalMs = options.pumpIntervalMs ?? 50;
    this.#lateResultMs = options.lateResultMs ?? 120_000;
    this.#channelDir = resolve(options.channelDir ?? defaultDispatcherChannelDir(this.#homeDir));
    this.#expectedInstance = options.expectedInstance;
    this.#hostScriptPath =
      options.hostScriptPath === undefined ? undefined : resolve(options.hostScriptPath);
  }

  get channelDir(): string {
    return this.#channelDir;
  }

  get inboxDir(): string {
    return join(this.#channelDir, "inbox");
  }

  get outboxDir(): string {
    return join(this.#channelDir, "outbox");
  }

  get activateScriptPath(): string {
    return join(this.#channelDir, ACTIVATE_SCRIPT);
  }

  /* ------------------------------------------------------------ channel */

  #inbox(): string {
    return this.inboxDir;
  }

  #outbox(): string {
    return this.outboxDir;
  }

  /**
   * Every channel path must be a real file or directory — never a symlink —
   * on every platform: a link would let the privacy checks pass on one tree
   * while requests and the token live in another. After the shape check,
   * POSIX proves privacy with mode bits and Windows with the ACL verdict.
   */
  #checkPrivate(path: string, what: string, kind: "dir" | "file" = "dir"): void {
    const info = lstatSync(path);
    const shapeOk = kind === "file" ? info.isFile() : info.isDirectory();
    if (!shapeOk || info.isSymbolicLink()) {
      throw new HostUnavailableError(
        `${what} must be a real ${kind === "file" ? "file" : "directory"}, not a symlink: ${path}`,
      );
    }
    // Privacy is a property of the real filesystem, so it follows
    // `process.platform` — never the target-platform seam: a darwin-seamed
    // transport on a Windows host still gets the icacls ACL verdict, and a
    // win32-seamed one on POSIX still gets mode bits.
    if (process.platform === "win32") {
      this.#checkWindowsAcl(path, kind === "file");
      return;
    }
    if ((info.mode & 0o077) !== 0) {
      throw new HostUnavailableError(
        `${what} is accessible to group/other (${(info.mode & 0o777).toString(8)}); ` +
          `the in-AE channel must be private — chmod 700 ${path}`,
      );
    }
  }

  /**
   * Windows counterpart of the POSIX mode check: `icacls` is the OS's own
   * account of the ACL. The channel must not be writable by shared accounts
   * (a writer forges requests), and `channel.json` — which carries the
   * token — must be readable only by its owner. A machine where `icacls`
   * cannot answer is refused: unproven privacy is not privacy.
   */
  #checkWindowsAcl(path: string, file: boolean): void {
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
        `cannot verify the Windows ACL of ${path}: ${messageOf(error)}; ` +
          "the in-AE channel is refused rather than assumed private",
      );
    }
    const entries = parseIcacls(output, path);
    if (entries === null) {
      throw new HostUnavailableError(`cannot parse the icacls output for ${path}`);
    }
    // The in-AE dispatcher is activated by hand inside an After Effects
    // running as this OS user, and the Node side writes as the same user:
    // the trusted writer set is exactly this account. Anything else that
    // can write the channel could inject requests, so an unnameable
    // account refuses rather than narrowing the set.
    let username: string | null = null;
    try {
      username = userInfo().username;
    } catch {
      username = null;
    }
    const verdict = file
      ? keyFileAclVerdict(entries, username, ownerQualifiers(this.#env))
      : channelAclVerdict(
          entries,
          username === null ? null : [username],
          ownerQualifiers(this.#env),
        );
    if (!verdict.ok) {
      throw new HostUnavailableError(`in-AE channel refused: ${verdict.detail}`);
    }
  }

  /**
   * Creates or validates the channel and refreshes the shipped assets.
   * Idempotent: `channel.json` (the token) is created once and reused, so a
   * dispatcher activated earlier keeps working across sessions.
   */
  async prepare(): Promise<void> {
    if (this.#prepared) {
      return;
    }
    const channel = this.#channelDir;
    if (!existsSync(channel)) {
      mkdirSync(channel, { recursive: true, mode: 0o700 });
    }
    this.#checkPrivate(channel, "the in-AE dispatcher channel");
    if (process.platform !== "win32") {
      chmodSync(channel, 0o700);
    }
    for (const dir of [this.#inbox(), this.#outbox()]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { mode: 0o700 });
      }
      this.#checkPrivate(dir, `channel directory ${dir}`);
    }

    // The dispatcher runs the *effective* host script — the consumer's
    // extension build when one was supplied, the shipped host otherwise —
    // verbatim from inside the channel, beside the codec it loads (#146).
    // Staging is not adoption: what After Effects actually registered is
    // reported by the heartbeat and checked at launch().
    this.#stageHostScript(channel);
    copyFileSync(join(HOST_DIR, "a8n-json.js"), join(channel, "a8n-json.js"));

    const metaPath = join(channel, CHANNEL_META);
    let meta: { v?: unknown; token?: unknown; createdAt?: unknown; hostScript?: unknown };
    if (!existsSync(metaPath)) {
      const token = randomBytes(32).toString("hex");
      meta = { v: 1, token, createdAt: this.#now(), hostScript: this.#stagedHost };
      await writeFile(metaPath, `${JSON.stringify(meta)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } else {
      meta = JSON.parse(await readFile(metaPath, "utf-8")) as typeof meta;
    }
    this.#checkPrivate(metaPath, "the channel metadata", "file");
    if (typeof meta.token !== "string" || !TOKEN_RE.test(meta.token)) {
      throw new HostUnavailableError(`invalid channel metadata at ${metaPath}`);
    }
    this.#token = meta.token;
    // The staged manifest is refreshed whenever the effective host script
    // changes; the token and creation time are never rewritten.
    if (JSON.stringify(meta.hostScript ?? null) !== JSON.stringify(this.#stagedHost)) {
      meta.hostScript = this.#stagedHost;
      await writeFile(metaPath, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    }

    await this.#writeActivateScript();
    this.#sweepChannel();
    this.#prepared = true;
  }

  /**
   * Copies the effective host script into the channel as `a8n-host.js` —
   * the file `activate.jsx` evals — and records what it declares (#146).
   * The shipped host is the default; a consumer's `extension build` output
   * is staged byte-for-byte, so the same bytes run against a real After
   * Effects and the in-repo fake host. The manifest is identity evidence
   * for the launch-time staged-vs-active check; the sha256 proves which
   * bytes were staged, never that After Effects approved them.
   */
  #stageHostScript(channel: string): void {
    const target = join(channel, "a8n-host.js");
    if (this.#hostScriptPath === undefined) {
      const shipped = join(HOST_DIR, "a8n-host.js");
      copyFileSync(shipped, target);
      const source = readFileSync(shipped);
      this.#stagedHost = {
        sha256: createHash("sha256").update(source).digest("hex"),
        methods: [],
        registration: null,
      };
      return;
    }
    let source: Buffer;
    try {
      source = readFileSync(this.#hostScriptPath);
    } catch (error) {
      throw new HostUnavailableError(
        `host script not found: ${this.#hostScriptPath} (${messageOf(error)})`,
      );
    }
    writeFileSync(target, source);
    const manifest = readExtensionManifest(source.toString("utf-8"));
    this.#stagedHost = {
      sha256: createHash("sha256").update(source).digest("hex"),
      methods: manifest === null ? [] : [...manifest.methods],
      registration: manifest === null ? null : manifest.registration,
    };
  }

  async #writeActivateScript(): Promise<void> {
    if (this.#token === null) {
      throw new Error("channel is not prepared");
    }
    const source = [
      "// ae-a8n in-AE dispatcher activation. Generated by @ido-bata/ae-a8n; do not edit.",
      "// Run once per After Effects process: File > Scripts > Run Script File,",
      "// or install into the per-user Scripts/Startup folder (see docs).",
      "var __a8n = {",
      "  dispatcher: {",
      `    root: ${es3StringLiteral(toPosixPath(this.#channelDir))},`,
      `    token: ${es3StringLiteral(this.#token)}`,
      "  }",
      "};",
      `$.evalFile(new File(${es3StringLiteral(toPosixPath(join(this.#channelDir, "a8n-host.js")))}));`,
      "",
    ].join("\n");
    await writeFile(this.activateScriptPath, source, { mode: 0o600 });
  }

  /**
   * Removes channel leftovers no caller can still be waiting for: expired
   * unclaimed requests, ancient claims, and unread results. Anything younger
   * stays — an UNKNOWN request is never deleted by the side that sent it.
   */
  #sweepChannel(): void {
    const now = this.#now();
    for (const dir of [this.#inbox(), this.#outbox()]) {
      if (!existsSync(dir)) {
        continue;
      }
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try {
          const age = now - statSync(path).mtimeMs;
          if (name.endsWith(REQUEST_SUFFIX)) {
            // A request is safe to drop only when its own deadline has passed.
            try {
              const request = JSON.parse(readFileSync(path, "utf-8")) as {
                timeoutMs?: unknown;
              };
              const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : 0;
              if (age > timeoutMs + 5_000 || age > INBOX_MAX_AGE_MS) {
                rmSync(path, { force: true });
              }
            } catch {
              if (age > INBOX_MAX_AGE_MS) {
                rmSync(path, { force: true });
              }
            }
          } else if (name.endsWith(".claimed") || name.endsWith(RESULT_SUFFIX)) {
            const horizon = name.endsWith(RESULT_SUFFIX) ? RESULT_MAX_AGE_MS : INBOX_MAX_AGE_MS;
            if (age > horizon) {
              rmSync(path, { force: true });
            }
          }
        } catch {
          // A file that cannot be stat'ed is left alone.
        }
      }
    }
  }

  /* ------------------------------------------------------------ heartbeat */

  #readHeartbeat(): DispatcherHeartbeat | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.#channelDir, STATE_FILE), "utf-8")) as Partial<DispatcherHeartbeat>;
      if (
        raw.v !== 1 ||
        typeof raw.token !== "string" ||
        raw.token !== this.#token ||
        typeof raw.lastTick !== "number" ||
        typeof raw.instance !== "string"
      ) {
        return null;
      }
      const beat = raw as DispatcherHeartbeat;
      return {
        ...beat,
        // Heartbeats written before #146 carry neither field; they normalise
        // to "no extensions, no registration", which a staged extension set
        // then mismatches at launch() rather than being trusted.
        extensionMethods: Array.isArray(beat.extensionMethods)
          ? beat.extensionMethods.filter((name): name is string => typeof name === "string")
          : [],
        extensionsRegistration:
          typeof beat.extensionsRegistration === "string" ? beat.extensionsRegistration : null,
      };
    } catch {
      return null;
    }
  }

  #heartbeatFresh(): boolean {
    const beat = this.#readHeartbeat();
    return beat !== null && this.#now() - beat.lastTick <= this.#heartbeatStaleMs;
  }

  /* -------------------------------------------------------------- launch */

  async available(): Promise<boolean> {
    try {
      await this.prepare();
    } catch {
      return false;
    }
    return this.#heartbeatFresh();
  }

  /**
   * Prepares the channel, then refuses unless a dispatcher heartbeat is
   * fresh. Activation is a human action — Run Script File on
   * `activate.jsx`, or a Startup entry installed with
   * {@link installStartupScript} — so "prepared but silent" is reported as
   * exactly that instead of degenerating into a probe timeout.
   */
  async launch(): Promise<void> {
    await this.prepare();
    if (!this.#heartbeatFresh()) {
      throw new HostUnavailableError(
        "the in-AE dispatcher channel is prepared but no dispatcher is answering " +
          `(no fresh ${STATE_FILE}). Activate it once per After Effects process:\n` +
          `  1. In After Effects: File > Scripts > Run Script File, select\n` +
          `       ${this.activateScriptPath}\n` +
          "  2. Or install it into the per-user Scripts/Startup folder with\n" +
          "       DispatcherTransport.installStartupScript() so it activates on AE launch.\n" +
          "Check whether a dispatcher is answering with `ae-a8n dispatcher status`. " +
          "AE may ask once for 'Allow Scripts to Write Files and Access Network'; " +
          "that consent is yours to give. This transport never launches or quits AE.",
      );
    }
    const beat = this.#readHeartbeat();
    if (beat === null) {
      // #heartbeatFresh() passed, so this is unreachable in practice; kept
      // so a future freshness change cannot silently bind to nothing.
      throw new HostUnavailableError("the dispatcher heartbeat could not be read");
    }
    if (this.#expectedInstance !== undefined && beat.instance !== this.#expectedInstance) {
      throw new HostUnavailableError(
        `the answering dispatcher is instance ${beat.instance}, not the pinned ` +
          `${this.#expectedInstance}: refusing to operate a different After Effects. ` +
          "Re-run without the instance pin, or with the instance `ae-a8n dispatcher status` reports.",
      );
    }
    this.#assertExtensionSet(beat);
    this.#boundInstance = beat.instance;
  }

  /**
   * Refuses to bind while the dispatcher's registered extension set differs
   * from what this session staged (#146). The heartbeat reports what After
   * Effects actually registered at activation; `channel.json` records what
   * `prepare()` staged. A mismatch means the running After Effects loaded a
   * different host script — extension changes are never adopted implicitly,
   * and a dispatcher cannot be re-activated inside a running AE (the host
   * refuses a second one), so the remedy is a fresh activation.
   */
  #assertExtensionSet(beat: DispatcherHeartbeat): void {
    const staged = this.#stagedHost;
    if (staged === null) {
      return;
    }
    const activeMethods = [...(beat.extensionMethods ?? [])].sort();
    const stagedMethods = [...staged.methods].sort();
    const methodsMatch =
      activeMethods.length === stagedMethods.length &&
      activeMethods.every((name, index) => name === stagedMethods[index]);
    const registration = beat.extensionsRegistration ?? null;
    if (!methodsMatch || registration !== staged.registration) {
      throw new HostUnavailableError(
        "the answering dispatcher registered a different extension set than this " +
          "session staged — the running After Effects loaded a different host script. " +
          `Staged: ${staged.methods.length} method(s), registration ${staged.registration ?? "none"}; ` +
          `active: ${activeMethods.length} method(s), registration ${registration ?? "none"}. ` +
          "Extension changes are never adopted while a dispatcher runs. Reactivate: " +
          `restart After Effects, then File > Scripts > Run Script File on ${this.activateScriptPath}.`,
      );
    }
    this.#boundExtensions = { methods: activeMethods, registration };
  }

  /**
   * The extension methods the answering dispatcher reported at `launch()`
   * (#146) — the set actually registered inside After Effects — or null
   * before a successful launch. `ae.extensionMethods()` exposes this set,
   * never the staged declaration alone.
   */
  boundExtensions(): {
    readonly methods: readonly string[];
    readonly registration: string | null;
  } | null {
    return this.#boundExtensions;
  }

  /**
   * The dispatcher instance this session is bound to, or null before
   * `launch()` binds one. Evidence for target identification and reconnect
   * pinning — never authority for ownership.
   */
  boundInstance(): string | null {
    return this.#boundInstance;
  }

  /**
   * Refuses to deliver when the channel's answering dispatcher is no longer
   * the instance this session bound to (#145). A missing or stale heartbeat
   * is *not* a mismatch: the request may still be claimed, so it is written
   * and the caller's deadline decides UNKNOWN exactly as before.
   */
  #assertTargetCurrent(): void {
    if (this.#boundInstance === null) {
      return;
    }
    const beat = this.#readHeartbeat();
    if (beat !== null && beat.instance !== this.#boundInstance) {
      throw new ScriptNotSentError(
        `the answering dispatcher is now instance ${beat.instance}, not the ` +
          `${this.#boundInstance} this session bound to; the request was not sent`,
      );
    }
  }

  /**
   * Fast liveness check for the driver's readiness gate: resolves true as
   * soon as a fresh heartbeat is seen, false when `timeoutMs` runs out.
   */
  async awaitScriptable(timeoutMs: number): Promise<boolean> {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      if (this.#heartbeatFresh()) {
        return true;
      }
      if (this.#now() >= deadline) {
        return false;
      }
      await new Promise((done) => setTimeout(done, Math.min(200, Math.max(10, deadline - this.#now()))));
    }
  }

  /* -------------------------------------------------------------- invoke */

  /**
   * Session layout contract (`entryScriptPath` in bootstrap.ts): the entry
   * script is `<sessionRoot>/staging/<id>.entry.jsx`, the request is
   * `<sessionRoot>/inbox/<id>.request.json`, the expected result is
   * `<sessionRoot>/outbox/<id>.result.json`.
   */
  #pathsFromEntry(entryScriptPath: string): {
    requestPath: string;
    resultPath: string;
    id: string;
  } {
    const stagingDir = dirname(entryScriptPath);
    const sessionRoot = dirname(stagingDir);
    const id = basename(entryScriptPath, ".entry.jsx");
    if (!REQUEST_ID_RE.test(id)) {
      throw new ScriptNotSentError(`unrecognised dispatcher entry script name: ${entryScriptPath}`);
    }
    return {
      id,
      requestPath: join(sessionRoot, "inbox", `${id}.request.json`),
      resultPath: join(sessionRoot, "outbox", `${id}.result.json`),
    };
  }

  async invoke(entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    if (this.#closed) {
      throw new Error("dispatcher transport is closed");
    }
    if (this.#inFlight !== null) {
      // The channel is strictly one-in-flight: a second request while one is
      // unanswered is refused before it is ever written, never queued behind
      // an uncertain outcome.
      throw new ScriptNotSentError(
        `the in-AE dispatcher already has request ${this.#inFlight} in flight`,
      );
    }
    await this.prepare();
    this.#assertTargetCurrent();
    const paths = this.#pathsFromEntry(entryScriptPath);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(await readFile(paths.requestPath, "utf-8")) as Record<string, unknown>;
    } catch (error) {
      throw new ScriptNotSentError(
        `cannot read the request the driver wrote: ${messageOf(error)}`,
      );
    }
    if (request["v"] !== 1 || request["id"] !== paths.id) {
      throw new ScriptNotSentError("the driver's request envelope does not match its entry script");
    }
    // The token is the channel's shared secret with its dispatcher; it is
    // added here, at the boundary, and never appears in the session files.
    // `target` names the dispatcher instance this session bound to (#145):
    // a dispatcher answering for a different After Effects skips the file
    // instead of running it, which is what keeps two live dispatchers on one
    // channel from misdelivering each other's work.
    const channelRequest = {
      ...request,
      token: this.#token,
      ...(this.#boundInstance === null ? {} : { target: this.#boundInstance }),
    };
    const target = join(this.#inbox(), `${paths.id}${REQUEST_SUFFIX}`);
    if (existsSync(target)) {
      throw new ScriptNotSentError(`a channel request for ${paths.id} already exists`);
    }
    const part = `${target}.part`;
    await writeFile(part, JSON.stringify(channelRequest), { mode: 0o600 });
    renameSync(part, target);

    this.#inFlight = paths.id;
    this.#pending.set(paths.id, {
      id: paths.id,
      resultPath: paths.resultPath,
      dropAt: this.#now() + this.#lateResultMs,
    });
    this.#ensurePump();
  }

  /* ------------------------------------------------------------ delivery */

  #ensurePump(): void {
    if (this.#pump !== null) {
      return;
    }
    this.#pump = setInterval(() => this.#pumpOnce(), this.#pumpIntervalMs);
    // The pump must never keep the process alive on its own.
    this.#pump.unref?.();
  }

  #pumpOnce(): void {
    if (this.#closed || this.#pending.size === 0) {
      this.#stopPump();
      return;
    }
    const now = this.#now();
    for (const [id, pending] of this.#pending) {
      if (now > pending.dropAt) {
        this.#pending.delete(id);
        if (this.#inFlight === id) {
          this.#inFlight = null;
        }
        continue;
      }
      const channelResult = join(this.#outbox(), `${id}${RESULT_SUFFIX}`);
      if (!existsSync(channelResult)) {
        continue;
      }
      // Deliver only an envelope that names this request: a mismatched or
      // malformed file is left in the outbox as evidence and the caller
      // keeps waiting (then reports UNKNOWN) rather than reading a guess.
      let envelope: { v?: unknown; id?: unknown };
      try {
        envelope = JSON.parse(readFileSync(channelResult, "utf-8")) as { v?: unknown; id?: unknown };
      } catch {
        continue;
      }
      if (envelope.v !== 1 || envelope.id !== id) {
        continue;
      }
      try {
        this.#publishResult(pending.resultPath, readFileSync(channelResult));
      } catch {
        continue;
      }
      rmSync(channelResult, { force: true });
      this.#pending.delete(id);
      if (this.#inFlight === id) {
        this.#inFlight = null;
      }
    }
    if (this.#pending.size === 0) {
      this.#stopPump();
    }
  }

  /** Same publish-by-rename the session workspace uses: never a partial file. */
  #publishResult(target: string, contents: string | Buffer): void {
    const part = `${target}.part`;
    writeFileSync(part, contents);
    rmSync(target, { force: true });
    renameSync(part, target);
  }

  #stopPump(): void {
    if (this.#pump !== null) {
      clearInterval(this.#pump);
      this.#pump = null;
    }
  }

  /* -------------------------------------------------------- HostTransport */

  ownership(): HostOwnership {
    return {
      kind: "attached",
      evidence:
        "the dispatcher runs inside an After Effects this session did not start " +
        "and cannot identify; the channel proves only that it shares this OS user",
    };
  }

  hostState(): HostState {
    // The transport sees files, not processes: it cannot prove the AE process
    // exists, so it says "unknown" rather than guessing "alive".
    return "unknown";
  }

  /**
   * What the transport can attest: the dispatch executes inside an After
   * Effects on this machine under this OS user (the private channel is the
   * evidence), in "local" mode per ADR-0003. It cannot name a pid, a
   * session, or the process — those stay null rather than borrowed.
   */
  attestation(): Partial<HostAttestation> {
    return {
      pid: null,
      ownedProcess: null,
      platform:
        this.#platform === "win32" || this.#platform === "darwin"
          ? { os: this.#platform, arch: "unknown" }
          : null,
      executionMode: "local",
      sessionUid: null,
      sessionAsid: null,
      targetInstance: this.#boundInstance,
    };
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#stopPump();
    this.#pending.clear();
    this.#inFlight = null;
    return Promise.resolve();
  }

  /* --------------------------------------------------- activation (T2) */

  /**
   * The per-user `Scripts/Startup` folder for `aeVersion` (e.g. "26.5" or
   * "26.5.0") on this platform. Pure path computation; whether AE runs the
   * entry is the G0 question and stays unproven until real-host evidence.
   */
  startupDirFor(aeVersion: string): string {
    return dispatcherStartupDir({
      aeVersion,
      platform: this.#platform,
      homeDir: this.#homeDir,
      env: this.#env,
    });
  }

  /**
   * The AE version for Startup placement. On macOS an install dir (or .app
   * path) is read for `CFBundleShortVersionString`; elsewhere `aeVersion`
   * must be given explicitly — there is no unproven version probe.
   */
  resolveAeVersion(options: { readonly aeVersion?: string; readonly installDir?: string }): string {
    if (options.aeVersion !== undefined) {
      return aeScriptsVersion(options.aeVersion);
    }
    if (options.installDir === undefined) {
      throw new Error("pass aeVersion or installDir to place the dispatcher in Scripts/Startup");
    }
    if (this.#platform === "darwin") {
      return aeVersionFromMacBundle(macBundlePath(options.installDir));
    }
    throw new Error(
      "reading the AE version from an install dir is implemented for macOS only; " +
        "pass aeVersion explicitly (unproven on this platform)",
    );
  }

  /**
   * Copies `activate.jsx` into the per-user `Scripts/Startup` folder so AE
   * activates the dispatcher on launch. Refuses to overwrite a file that is
   * not recognisably ours. Returns the installed path.
   */
  async installStartupScript(options: { readonly aeVersion?: string; readonly installDir?: string }): Promise<string> {
    await this.prepare();
    const version = this.resolveAeVersion(options);
    const dir = this.startupDirFor(version);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, STARTUP_SCRIPT_NAME);
    const source = readFileSync(this.activateScriptPath, "utf-8");
    if (existsSync(target)) {
      const existing = readFileSync(target, "utf-8");
      if (!existing.includes("ae-a8n in-AE dispatcher activation")) {
        throw new Error(
          `refusing to overwrite ${target}: it is not an ae-a8n dispatcher script`,
        );
      }
    }
    await writeFile(target, source, { mode: 0o644 });
    return target;
  }

  /**
   * Removes the Startup entry, but only when it is recognisably ours —
   * anything else at that path is left alone and reported.
   */
  uninstallStartupScript(options: { readonly aeVersion?: string; readonly installDir?: string }): string | null {
    const version = this.resolveAeVersion(options);
    const target = join(this.startupDirFor(version), STARTUP_SCRIPT_NAME);
    if (!existsSync(target)) {
      return null;
    }
    const existing = readFileSync(target, "utf-8");
    if (!existing.includes("ae-a8n in-AE dispatcher activation")) {
      throw new Error(`refusing to remove ${target}: it is not an ae-a8n dispatcher script`);
    }
    rmSync(target, { force: true });
    return target;
  }
}
