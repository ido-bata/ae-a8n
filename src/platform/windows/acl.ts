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
  "builtin\\adminstrators",
  "nt authority\\local system",
];

/** Accounts every interactive user belongs to, or that mean "everyone". */
const SHARED = [
  "everyone",
  "builtin\\users",
  "nt authority\\authenticated users",
  "nt authority\\interactive",
  "nt authority\\service",
  "builtin\\remote desktop users",
];

function normalise(principal: string): string {
  return principal.trim().toLowerCase();
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

/**
 * Parse `icacls <path>` output. Each entry is `<path> <principal>:(<rights>)`
 * on the first line and `<principal>:(<rights>)` on the lines under it, with
 * principals that may contain spaces (`NT AUTHORITY\SYSTEM`). Anything that
 * does not parse as an entry is refused rather than skipped: a line this does
 * not understand might be the one carrying a grant.
 *
 * `path`, when given, is the path handed to `icacls`. The first line echoes
 * it, and a Windows path can contain spaces — `C:\Users\First Last\key` is
 * indistinguishable from a path followed by a principal unless the caller
 * says which is which. With no `path`, the first token is taken as the path
 * only when it looks like one.
 */
export function parseIcacls(
  output: string,
  path?: string,
): readonly AccessControlEntry[] | null {
  const entries: AccessControlEntry[] = [];
  let first = true;
  for (const raw of output.split(/\r?\n/)) {
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
      return null;
    }
    const head = tokens.slice(0, rightsIndex + 1).join(" ");
    const colon = head.indexOf(":(");
    const principals = head.slice(0, colon).replace(/:$/, "");
    const rights = rightsOf(head.slice(colon));
    const principal = principals.trim();
    if (principal === "" || rights === "") {
      return null;
    }
    const named = first && looksLikePath(principal) ? principal.split(/\s+/u).slice(1).join(" ") : principal;
    first = false;
    if (named === "") {
      return null;
    }
    entries.push({ principal: named, rights });
  }
  return entries.length === 0 ? null : entries;
}

function hasWrite(rights: string): boolean {
  const tokens = rights.split(",").map((token) => token.trim().toUpperCase());
  return tokens.some(
    (token) => token === "F" || token === "M" || token.startsWith("W"),
  );
}

function isPrivileged(principal: string): boolean {
  const name = normalise(principal);
  return PRIVILEGED.includes(name) || name.endsWith("\\administrators");
}

function isShared(principal: string): boolean {
  return SHARED.includes(normalise(principal));
}

export type AclVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * The key may be read only by its owner, SYSTEM and Administrators.
 *
 * `owner` is the account running this process, as the OS reports it. A grant
 * to any other account — even a read-only one — is refused: a reader is a
 * forger. When the owner is unknown, every account that is not privileged is
 * treated as foreign, because none of them can be shown to be the owner.
 */
export function keyFileAclVerdict(
  entries: readonly AccessControlEntry[],
  owner: string | null,
): AclVerdict {
  const ownerName = owner === null ? null : normalise(owner);
  const foreign = entries.filter((entry) => {
    if (isPrivileged(entry.principal)) {
      return false;
    }
    if (ownerName === null) {
      return true;
    }
    const name = normalise(entry.principal);
    return name !== ownerName && !name.endsWith(`\\${ownerName}`);
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
 * The channel directory must not be writable by accounts outside the two that
 * use it. Writes are what injects a job, so a writable channel is a forgeable
 * one — the same property the POSIX path proves with the sticky bit.
 */
export function channelAclVerdict(entries: readonly AccessControlEntry[]): AclVerdict {
  const open = entries.filter((entry) => isShared(entry.principal) && hasWrite(entry.rights));
  if (open.length === 0) {
    return { ok: true };
  }
  const named = open.map((entry) => `${entry.principal} (${entry.rights})`).join(", ");
  return {
    ok: false,
    detail:
      `the channel directory is writable by ${named}; ` +
      "any account that can write there can inject a job, so it must be closed to them",
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
