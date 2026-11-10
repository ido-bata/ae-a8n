/**
 * Exit codes from `specs/isolated-ae/contracts/cli.md` §4.
 *
 * They are part of the programmatic contract: a caller keys off the number,
 * not the wording of a message.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  blocked: 3,
  refused: 4,
  testFailed: 5,
  unknown: 6,
  setupIncomplete: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
