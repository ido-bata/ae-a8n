/**
 * Apple Event denial modes → the next action a human can take (#57, T024;
 * the action text mirrors `specs/isolated-ae/contracts/permissions.md` §4).
 *
 * osascript reports a refused or unanswered Apple Event as an exit-code
 * error whose stderr carries the Apple Event number, e.g.
 * `execution error: ... (-1743)`. The numbers mean different things and
 * have different remedies; collapsing them into "it failed" sends the
 * reader to the wrong fix. This classifier is the single place that
 * mapping lives — the API error path and any CLI surface share it.
 */

export type AppleEventDenial = {
  /** The Apple Event error number, e.g. -1743. */
  readonly code: number;
  /** What the number means, in one clause. */
  readonly meaning: string;
  /** The distinct next action. */
  readonly nextAction: string;
};

const DENIALS: ReadonlyArray<{
  readonly code: number;
  readonly meaning: string;
  readonly nextAction: string;
}> = [
  {
    code: -1708,
    meaning: "AE script trust / script-folder approval is pending",
    nextAction:
      "approve the driver's script folder in After Effects on the target desktop " +
      "(Settings > Scripting & Expressions), then retry; a person must answer the modal",
  },
  {
    code: -1743,
    meaning: "Automation consent is missing, or the sender has no responsible-process bundle",
    nextAction:
      "run the sender as a child of the responsible app (Terminal.app) in the target " +
      "session and grant Automation there; if it persists with no prompt the earlier " +
      "denial is remembered — reset that one service and re-prompt",
  },
  {
    code: -1712,
    meaning: "the event reached AE but AE is not answering",
    nextAction:
      "a modal, welcome or sign-in screen is up: a person dismisses it on the target " +
      "desktop; this is not a permission problem and the call is never re-sent",
  },
  {
    code: -609,
    meaning: "the connection to AE is invalid — the process exited mid-call",
    nextAction:
      "AE quit or crashed during the call; check for a crash report and relaunch — " +
      "do not assume the operation ran",
  },
  {
    code: -2741,
    meaning: "osascript could not compile the AppleScript",
    nextAction:
      "the application reference did not resolve (wrong bundle path or name); this is " +
      "a transport bug report, not a permission issue",
  },
];

/**
 * The denial an osascript failure carries, or null when the stderr names no
 * known Apple Event number. Only the *last* parenthesised number is read:
 * osascript appends the Apple Event code at the end of its error line, and
 * earlier numbers in the message are AE's own text.
 */
export function classifyAppleEventError(stderr: string): AppleEventDenial | null {
  const matches = [...stderr.matchAll(/\((-?\d{1,5})\)/g)];
  const last = matches.at(-1);
  if (last === undefined) {
    return null;
  }
  const code = Number(last[1]);
  const denial = DENIALS.find((entry) => entry.code === code);
  if (denial === undefined) {
    return null;
  }
  return { code, meaning: denial.meaning, nextAction: denial.nextAction };
}
