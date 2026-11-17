/**
 * The POSIX counterpart of the Windows channel ACL check.
 *
 * `channelAclVerdict` answers "may an account outside the two that use this
 * channel write here?" from `icacls` output. POSIX mode bits cannot name
 * accounts, so the honest equivalent is coarser: a channel root that group
 * or others can write is refused outright. A deployment that needs a shared
 * group must express it with POSIX ACLs (`setfacl`), which mode bits do not
 * show — that residual is named in the review dispositions, and the check
 * fails closed rather than guessing.
 *
 * The sticky bit is not an exception: a `1777` root still lets any account
 * create top-level entries (`jobs/`, `claims/` races), and "can write
 * something into the channel" is the property being refused.
 */

export type ChannelModeStats = {
  isDirectory(): boolean;
  /** `stat.mode`, including the file-type bits. */
  readonly mode: number;
};

export type ChannelModeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** Group or other write permission on the channel root. */
const GROUP_OTHER_WRITE = 0o022;
const MODE_BITS = 0o7777;

/**
 * The channel root must be a directory nobody outside its owner can write.
 * Owner write is the property the write probe already proves; this verdict
 * covers everyone else.
 */
export function channelModeVerdict(stats: ChannelModeStats): ChannelModeVerdict {
  if (!stats.isDirectory()) {
    return { ok: false, detail: "the channel root is not a directory" };
  }
  const mode = stats.mode & MODE_BITS;
  if ((mode & GROUP_OTHER_WRITE) !== 0) {
    return {
      ok: false,
      detail:
        `the channel directory is writable by group or others (mode ${mode.toString(8)}); ` +
        "any account that can write there can inject a job, so it must be closed to them",
    };
  }
  return { ok: true };
}
