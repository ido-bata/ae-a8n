/**
 * The rules that decide whether a job may run in another user's session.
 *
 * They are kept in one file, with no side effects, so they can be checked
 * without a second user and without a second session: every rule here is a
 * refusal, and the refusals are the point.
 *
 * The rule behind all of them: a test must never reach the desktop the human
 * is looking at. A result is only believed when it says which session it came
 * from, and a job is only run when the session it names is the agent's own.
 */

/**
 * The target session must exist, belong to the target user, be graphical,
 * and must not be the console session.
 */
export function assertTargetSession(session, targetUid, consoleUid) {
  if (session === null || session === undefined) {
    throw new Error(
      `uid ${targetUid} has no login session on this Mac. Log that user in (a fast user switch is enough) ` +
        "and try again; nothing was run.",
    );
  }
  if (session.uid !== targetUid) {
    throw new Error(`the session belongs to uid ${session.uid}, not to ${targetUid}; nothing was run.`);
  }
  if (session.kind !== "Aqua") {
    throw new Error(`uid ${targetUid} has a ${session.kind} session, not a graphical one; nothing was run.`);
  }
  if (consoleUid === targetUid) {
    throw new Error(
      `uid ${targetUid} owns the console session; running there would touch the screen the user is looking at. ` +
        "Nothing was run.",
    );
  }
  return session;
}

/**
 * A result is only believed when it names the session it was asked to run in.
 */
export function assertResultSession(result, targetUid) {
  if (result?.session?.uid !== targetUid) {
    throw new Error(
      `the result came from uid ${result?.session?.uid}, not from ${targetUid}: the job did not run in the ` +
        "requested session. The result is not trusted.",
    );
  }
  return result;
}

/**
 * After Effects must not be running for anyone.
 *
 * Adobe's terms allow a separate OS account on the same computer, but only
 * one OS user may use the Adobe apps at a time. A run therefore starts from a
 * machine with no After Effects in it — including another user's instance,
 * which the user has to quit themselves. Nothing here kills a process.
 */
export function assertNoRunningAfterEffects(processes) {
  if (processes.length > 0) {
    throw new Error(
      "After Effects is already running (pid/uid: " +
        processes.map((process) => `${process.pid}/${process.uid}`).join(", ") +
        "). Quit it normally before testing: Adobe apps may only be used by one OS user at a time. " +
        "No process was killed.",
    );
  }
  return processes;
}

/**
 * The After Effects processes in a `ps` listing.
 *
 * The exact binary is matched, whatever version is installed, and the owner
 * is read from the listing so a process of another user is recognised.
 */
export function parseAeProcesses(psOutput) {
  const processes = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      throw new Error("cannot parse the process list; refusing to start After Effects");
    }
    const executable = match[3];
    if (/(?:^|\/)After Effects$/.test(executable)) {
      processes.push({ pid: Number(match[1]), uid: Number(match[2]), executable });
    }
  }
  return processes;
}

/**
 * The agent side of the same rule: a job that names another session is not
 * run at all. The agent knows which session it is in; a job that claims a
 * different one is either misrouted or forged.
 */
export function assertJobSession(job, session) {
  const wanted = job?.session?.uid;
  if (wanted !== undefined && wanted !== null && wanted !== session.uid) {
    throw new Error(
      `the job asks for uid ${wanted}, but this agent runs in uid ${session.uid}'s session; the job was not run.`,
    );
  }
  return job;
}
