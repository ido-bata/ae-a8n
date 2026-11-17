/**
 * Windows access-control checks, the counterpart of the POSIX mode checks.
 *
 * Two safety properties the macOS path proves with mode bits have no mode-bit
 * equivalent on Windows:
 *
 *   - the channel key is readable only by the account that owns it;
 *   - the channel directory is not writable by accounts that have no business
 *     writing jobs into it (the POSIX path proves this with the sticky bit).
 *
 * `loadKeyFile` used to skip both on Windows and promise a real-host check
 * later. That left the Windows build with the weaker guarantee, so the checks
 * live here instead: `icacls` is the OS's own account of the ACL, it needs no
 * elevation to read, and its output can be parsed and tested without Windows.
 *
 * What is deliberately *not* refused: SYSTEM and the local Administrators
 * group. They can take ownership of any file on the machine, so a key that
 * refuses them refuses every key on every real host — a check that always
 * fails is not a check. The property proven here is narrower and true: no
 * account outside those can read the key.
 */

export type AccessControlEntry = {
  readonly principal: string;
  /** `icacls` rights as printed: `F`, `M`, `RX`, `R,W`, … */
  readonly rights: string;
};

/** Principals whose access the machine itself already grants everywhere. */
const PRIVILEGED = [
  "nt authority\\system",
  "builtin\\administrators",
  "nt authority\\local system",
];

function normalise(principal: string): string {
  return principal.trim().toLowerCase();
}

/**
 * Does `principal` name one of `trusted`? An exact match always counts; a
 * qualified `QUALIFIER\account` also counts when the bare account is trusted
 * and the qualifier is a machine or domain this side can vouch for — the
 * same rule `keyFileAclVerdict` applies to its owner, so `CONTOSO\alice`
 * cannot stand in for a different `alice` the caller never named.
 */
function trustedMatcher(
  trusted: readonly string[],
  qualifiers: readonly string[],
): (principal: string) => boolean {
  const names = new Set(trusted.map(normalise).filter((name) => name !== ""));
  const ownQualifiers = new Set(qualifiers.map(normalise));
  return (principal: string): boolean => {
    const name = normalise(principal);
    if (names.has(name)) {
      return true;
    }
    const slash = name.lastIndexOf("\\");
    if (slash <= 0) {
      return false;
    }
    return names.has(name.slice(slash + 1)) && ownQualifiers.has(name.slice(0, slash));
  };
}

/** The parenthesis groups of a rights token: `(OI)(CI)(RX)` is `OI CI RX`. */
function parenthesised(text: string): string[] {
  return [...text.matchAll(/\(([^)]*)\)/gu)].map((match) => match[1] ?? "");
}

function rightsOf(text: string): string {
  return parenthesised(text)
    // Inheritance markers are not access rights.
    .filter((token) => !/^(OI|CI|IO|NP|I)$/iu.test(token))
    .join(",");
}

/** A first token that is the path `icacls` echoes, not a principal. */
function looksLikePath(token: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(token) || token.startsWith("\\\\") || token.startsWith("/");
}

/** What an ACL read produced: entries, or the named reason there are none. */
export type AclRead =
  | { readonly ok: true; readonly entries: readonly AccessControlEntry[] }
  | { readonly ok: false; readonly detail: string };

/**
 * Parse `icacls <path>` output, keeping *why* it failed. Each entry is
 * `<path> <principal>:(<rights>)` on the first line and
 * `<principal>:(<rights>)` on the lines under it, with principals that may
 * contain spaces (`NT AUTHORITY\SYSTEM`). The ACE shape — a colon and a
 * parenthesised rights token — is locale-independent, so a Japanese or
 * German summary line is skipped by shape, not by wording; a line that
 * carries a colon but no rights token is a parse failure with a named
 * reason, never a skipped grant (T101).
 *
 * `path`, when given, is the path handed to `icacls`. The first line echoes
 * it, and a Windows path can contain spaces — `C:\Users\First Last\key` is
 * indistinguishable from a path followed by a principal unless the caller
 * says which is which. With no `path`, the first token is taken as the path
 * only when it looks like one.
 */
export function parseIcaclsReport(
  output: string,
  path?: string,
): AclRead {
  const entries: AccessControlEntry[] = [];
  let first = true;
  let lineNumber = 0;
  for (const raw of output.split(/\r?\n/)) {
    lineNumber += 1;
    let line = raw.trim();
    if (line === "") {
      continue;
    }
    // The trailing summary is localised ("1 個のファイルが正常に処理されました"),
    // so it is recognised by shape: an ACE always has a colon, the summary
    // never does.
    if (!line.includes(":")) {
      continue;
    }
    if (first && path !== undefined) {
      const prefix = path.trim();
      // Windows paths are case-insensitive, and icacls echoes what it was
      // given rather than a canonical form.
      if (prefix !== "" && line.toLowerCase().startsWith(prefix.toLowerCase())) {
        line = line.slice(prefix.length).trimStart();
      }
    }
    const tokens = line.split(/\s+/u).filter((token) => token !== "");
    const rightsIndex = tokens.findIndex((token) => token.includes(":("));
    if (rightsIndex === -1) {
      return {
        ok: false,
        detail:
          `icacls line ${String(lineNumber)} has a colon but no rights token; ` +
          "the output may be localized or truncated, and a grant this parser " +
          "cannot read must not be treated as absent",
      };
    }
    const head = tokens.slice(0, rightsIndex + 1).join(" ");
    const colon = head.indexOf(":(");
    const principals = head.slice(0, colon).replace(/:$/, "");
    const rights = rightsOf(head.slice(colon));
    const principal = principals.trim();
    if (principal === "" || rights === "") {
      return {
        ok: false,
        detail: `icacls line ${String(lineNumber)} did not yield a principal and rights`,
      };
    }
    const named = first && looksLikePath(principal) ? principal.split(/\s+/u).slice(1).join(" ") : principal;
    first = false;
    if (named === "") {
      return { ok: false, detail: `icacls line ${String(lineNumber)} named no principal` };
    }
    entries.push({ principal: named, rights });
  }
  if (entries.length === 0) {
    return {
      ok: false,
      detail:
        "icacls produced no access-control entries; the output may be localized, " +
        "empty, or from a failed command, and an unread ACL is not an open one",
    };
  }
  return { ok: true, entries };
}

/** Entries, or null — kept for callers that only need the fail-closed shape. */
export function parseIcacls(
  output: string,
  path?: string,
): readonly AccessControlEntry[] | null {
  const report = parseIcaclsReport(output, path);
  return report.ok ? report.entries : null;
}

/**
 * The only rights an entry may carry and still count as read-only.
 *
 * An allow list of read-only spellings, not a list of write spellings: `icacls`
 * prints rights this module does not know in their own spelling — `AD` (append
 * data, enough to plant a `jobs/<id>` directory), `GW`, or `(special access:)`
 * with word-form rights under it — and none of those starts with `W`. A write
 * that cannot be named is still a write, so anything outside this set counts
 * as write access.
 */
const READ_ONLY_RIGHTS = new Set(["R", "RX", "RC", "REA", "GR", "GX", "S"]);

function hasWrite(rights: string): boolean {
  const tokens = rights
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== "");
  return tokens.length === 0 || !tokens.every((token) => READ_ONLY_RIGHTS.has(token));
}

function isPrivileged(principal: string): boolean {
  const name = normalise(principal);
  return PRIVILEGED.includes(name) || name.endsWith("\\administrators");
}

export type AclVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * The qualifiers this process may legitimately appear under: the machine's
 * own name and the account's domain.
 *
 * `userInfo().username` is unqualified (`alice`), while `icacls` prints
 * qualified principals (`PC1\alice`, `CONTOSO\alice`). Accepting any
 * qualifier would let `CONTOSO\alice` stand in for the local `alice` — two
 * different principals on a domain-joined host, which is exactly the SMB
 * deployment this check protects.
 */
export function ownerQualifiers(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [env.COMPUTERNAME, env.USERDOMAIN].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
}

/**
 * The key may be read only by its owner, SYSTEM and Administrators.
 *
 * `owner` is the account running this process, as the OS reports it. A grant
 * to any other account — even a read-only one — is refused: a reader is a
 * forger. When the owner is unknown, every account that is not privileged is
 * treated as foreign, because none of them can be shown to be the owner.
 *
 * `qualifiers` names the machine and domain the owner may be qualified by.
 * It defaults to none, which refuses every qualified principal: a caller that
 * does not know the machine must not accept one by name alone.
 */
export function keyFileAclVerdict(
  entries: readonly AccessControlEntry[],
  owner: string | null,
  qualifiers: readonly string[] = [],
): AclVerdict {
  const ownerName = owner === null ? null : normalise(owner);
  const ownQualifiers = new Set(qualifiers.map(normalise));
  const foreign = entries.filter((entry) => {
    if (isPrivileged(entry.principal)) {
      return false;
    }
    if (ownerName === null) {
      return true;
    }
    const name = normalise(entry.principal);
    if (name === ownerName) {
      return false;
    }
    const slash = name.lastIndexOf("\\");
    if (slash <= 0) {
      return true;
    }
    const account = name.slice(slash + 1);
    return !(account === ownerName && ownQualifiers.has(name.slice(0, slash)));
  });
  if (foreign.length === 0) {
    return { ok: true };
  }
  const named = foreign.map((entry) => `${entry.principal} (${entry.rights})`).join(", ");
  return {
    ok: false,
    detail:
      `the key file is readable by accounts other than its owner: ${named}; ` +
      "a shared secret must be readable only by its owner",
  };
}

/**
 * The channel directory must not be writable by any account outside the set
 * the caller trusts (T105). Writes are what inject an agent's claim, a
 * result or a presence heartbeat — and, before T103, what let an unsigned
 * file block a job — so "writable by anyone but SYSTEM, Administrators and
 * the named accounts" is the same property the POSIX path proves with the
 * sticky bit.
 *
 * `trusted` is the controller's and the agent's accounts, as the OS will
 * print them (`alice`, `HOST\alice`, `CONTOSO\alice`, or a SID). Passing
 * `null` or an empty list means the trusted set is unknown, and an unknown
 * set refuses: a channel whose writers cannot be named is a channel whose
 * jobs cannot be attributed. `isShared`/`SHARED` no longer decide anything —
 * `CONTOSO\Domain Users` is refused not because it is on a list but because
 * it is not in the trusted set.
 */
export function channelAclVerdict(
  entries: readonly AccessControlEntry[],
  trusted: readonly string[] | null,
  qualifiers: readonly string[] = [],
): AclVerdict {
  if (trusted === null || trusted.filter((name) => name.trim() !== "").length === 0) {
    return {
      ok: false,
      detail:
        "the set of accounts trusted to write the channel is unknown; " +
        "name the controller's and the agent's accounts before the channel " +
        "can be called closed",
    };
  }
  const isTrusted = trustedMatcher(trusted, qualifiers);
  const open = entries.filter(
    (entry) => hasWrite(entry.rights) && !isPrivileged(entry.principal) && !isTrusted(entry.principal),
  );
  if (open.length === 0) {
    return { ok: true };
  }
  const named = open.map((entry) => `${entry.principal} (${entry.rights})`).join(", ");
  return {
    ok: false,
    detail:
      `the channel directory is writable by ${named}, which is outside the trusted ` +
      "controller/agent accounts; any account that can write there can inject a " +
      "job, so it must be closed to them",
  };
}

/** A path with an escaped single quote, for a PowerShell single-quoted string. */
export function quoteForPowerShell(path: string): string {
  return `'${path.replace(/'/gu, "''")}'`;
}

/** The command whose output `parseIcacls` reads. */
export function icaclsCommand(path: string): readonly string[] {
  return ["icacls", path];
}
