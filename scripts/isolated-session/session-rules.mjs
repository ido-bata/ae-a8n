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
/**
 * The result of a job that ran in the target session.
 *
 * The result file lives in a directory any local process may write to, so
 * the account it names is not proof on its own. It has to name the session
 * the controller asked for, and the console must still belong to somebody
 * else: if the target session became the console session while the job ran,
 * the job ran on the human's desktop, and no result may be believed.
 */
export function assertOutcomeSession(outcome, target, consoleUidValue) {
  if (outcome.uid !== target.uid) {
    throw new Error(
      `the job ran as uid ${outcome.uid}, not ${target.uid}: it did not run in the requested session. ` +
        "The result is not trusted.",
    );
  }
  if (target.asid !== null && outcome.asid !== target.asid) {
    // The job has to name the session it ran in. An unknown session (the job
    // could not read one) is not a match: refusing here costs one run,
    // while accepting it costs the whole point of the isolation.
    throw new Error(
      `the job ran in session ${outcome.asid}, not in session ${target.asid}: it did not run in the ` +
        "requested session. The result is not trusted.",
    );
  }
  if (consoleUidValue === target.uid) {
    throw new Error(
      `the target session (uid ${target.uid}) owns the console now: the job ran on the human's own desktop. ` +
        "The result is not trusted.",
    );
  }
  return outcome;
}

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

/**
 * The target session, as offstage reports it.
 *
 * The controller usually runs in the console session, and from there
 * `launchctl print gui/<uid>` for another user is refused ("Operation not
 * permitted"): the console user cannot read another user's launchd domain.
 * offstage can, because it talks to the daemon running inside that session.
 * So the facts about the target session come from offstage, and the launchd
 * document is only the fallback for a controller already inside the target
 * session.
 */
export function sessionFromOffstageStatus(status) {
  if (status === null || status === undefined) {
    return null;
  }
  if (status.available !== true) {
    throw new Error(
      `the session lane is not available: ${status.reason ?? "unknown reason"}. ` +
        `Fix: ${status.fix ?? "see `offstage session status`"}. Nothing was run.`,
    );
  }
  if (status.accountExists !== true) {
    throw new Error(
      `there is no account on this Mac, so there is no second session to run in. ` +
        `Fix: ${status.fix ?? "create the account"}. Nothing was run.`,
    );
  }
  const gui = status.guiSession;
  return {
    uid: status.uid,
    username: status.user,
    asid: gui?.sessionId ?? null,
    kind: gui?.exists === true && gui?.loginDone === true ? "Aqua" : "none",
  };
}

/**
 * One shell argument, quoted for `sh`.
 *
 * The command that runs in the other session is written into a file that a
 * shell reads, so its words are data: a path with a space, a quote or a `;`
 * stays one argument and stays harmless.
 */
export function shellQuote(argument) {
  const text = String(argument);
  if (text.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** A command as one shell line, with every word quoted as data. */
export function shellCommandLine(command) {
  return command.map((word) => shellQuote(word)).join(" ");
}

/**
 * What the job that ran in the other session wrote down about itself.
 *
 * The lines are written by the job, in the other session, so they are the
 * job's own account of where it ran — not the controller's guess.
 */
export function parseTerminalResult(text) {
  const fields = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (match !== null) {
      fields.set(match[1], match[2]);
    }
  }
  const uid = Number(fields.get("uid"));
  const asid = Number(fields.get("asid"));
  const exitCode = Number(fields.get("exit"));
  return {
    uid: Number.isInteger(uid) ? uid : -1,
    username: fields.get("username") ?? "unknown",
    asid: Number.isInteger(asid) ? asid : null,
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
  };
}

