/**
 * Terminate an owned After Effects process — the *separate* authorized
 * path (#340, specs/gui-supervision/spec.md US5, ADR-0005 §5).
 *
 * This module is the evidence half of termination, mirroring
 * `session-rebuild.ts`: given the launch-provenance record and a fresh
 * process census it decides — fail-closed — whether the recorded owned
 * host may be signalled at all, and later whether its disappearance is
 * proven. It never signals anything itself; the caller injects the OS
 * action, so every rule is unit-testable without a host.
 *
 * The rules, and why each exists:
 *
 *   - Terminate never mixes into rebuild. Rebuild only ever *starts* a new
 *     After Effects after disappearance is proven; this path only ever
 *     *signals* the recorded pid, and only while the census still proves
 *     that pid+start identity is the same process. A pid is not an
 *     identity: a record without a start time cannot tell a recycled pid
 *     from the original, so a live pid under such a record is ambiguous
 *     and refuses — signalling it could kill a foreign process.
 *   - "Alive" requires the recorded identity *and* no other in-scope
 *     instance of the install. A sibling means the environment drifted
 *     since launch; which After Effects answers is unprovable, so the
 *     whole operation refuses rather than reason about part of it.
 *   - "Gone" for the post-signal proof means the same thing rebuild
 *     requires: the recorded identity is absent *and* no sibling instance
 *     runs. Anything less is `unproven`, never "probably dead".
 *   - An unreadable census is never an answer: it makes the verdict
 *     `unproven`, not gone and not alive.
 */

import { execFile } from "node:child_process";

import { errorMessage } from "../errors.js";
import type { LaunchProvenance } from "./launch-provenance.js";
import {
  isInstallInstance,
  type ProcessCensus,
} from "./session-rebuild.js";
import {
  sameProcess,
  type HostProcess,
} from "./host-processes.js";

/**
 * What the census says about the recorded host, before any signal.
 *
 * - `alive`: the recorded pid+start identity is present and no other
 *   in-scope instance of the install runs — the only state a signal may
 *   be sent from.
 * - `gone`: the recorded identity is absent and no sibling instance runs —
 *   nothing to terminate; the rebuild path applies instead.
 * - `siblings`: the recorded identity is gone but another instance of the
 *   install runs in scope. Terminate has nothing to kill, and rebuild
 *   would refuse on the ambiguity anyway; reported separately so the
 *   caller learns *why* the session is not rebuild-ready.
 * - `ambiguous`: presence cannot be proven either way — a live pid under
 *   a record with no start time (possible pid reuse), or another instance
 *   alongside the recorded one. Never signalled.
 */
export type TerminateInspection =
  | { readonly kind: "alive"; readonly evidence: readonly string[] }
  | { readonly kind: "gone"; readonly evidence: readonly string[] }
  | { readonly kind: "siblings"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly reason: string };

/**
 * Classify the recorded owned host against a fresh census. See the module
 * comment for the rule order; the sibling filter is the same install-scope
 * rule `verifyRebuildHost` applies, so "gone" here means exactly what
 * rebuild's process-loss proof means.
 */
export function inspectTerminateTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly provenance: LaunchProvenance;
  readonly processes: readonly HostProcess[];
  readonly sessionUid: number;
}): TerminateInspection {
  const { platform, provenance, processes, sessionUid } = input;
  const recorded = provenance.host;
  const evidence: string[] = [];

  const pidReused = processes.some((p) => p.pid === recorded.pid);
  let recordedAlive = false;
  if (recorded.startedAt === null) {
    if (pidReused) {
      return {
        kind: "ambiguous",
        reason:
          `pid ${recorded.pid} is running but the launch record has no process ` +
          "start time, so it cannot be told apart from a reused pid; refusing " +
          "to signal a possibly foreign process",
      };
    }
    evidence.push(`pid ${recorded.pid} is absent from the process list`);
  } else {
    const recordedProcess: HostProcess = {
      pid: recorded.pid,
      startedAt: recorded.startedAt,
      executable: recorded.executable,
      ...(recorded.identity === null || recorded.identity === undefined
        ? {}
        : { identity: recorded.identity }),
    };
    recordedAlive = processes.some((p) => sameProcess(platform, p, recordedProcess));
    if (recordedAlive) {
      evidence.push(
        `pid ${recorded.pid} still names the recorded After Effects ` +
          `(started ${new Date(recorded.startedAt).toISOString()})`,
      );
    } else if (pidReused) {
      evidence.push(
        `pid ${recorded.pid} was reused by an unrelated process; the recorded ` +
          "start time proves the original is gone",
      );
    } else {
      evidence.push(
        `pid ${recorded.pid} with the recorded start time is absent from the process list`,
      );
    }
  }

  // In-scope instances *other than* the recorded process itself.
  const siblings = processes.filter((p) => {
    if (recordedAlive && p.pid === recorded.pid) {
      return false;
    }
    if (!isInstallInstance(p, recorded.executable, platform)) {
      return false;
    }
    if (platform === "darwin") {
      return p.uid === undefined || p.uid === sessionUid;
    }
    return true;
  });

  if (recordedAlive) {
    if (siblings.length > 0) {
      return {
        kind: "ambiguous",
        reason:
          `${siblings.length} other instance(s) of this install are running ` +
          `(pids ${siblings.map((p) => p.pid).join(", ")}); the environment is ` +
          "ambiguous, so nothing is signalled",
      };
    }
    evidence.push("no other instance of the recorded install is running in scope");
    return { kind: "alive", evidence };
  }
  if (siblings.length > 0) {
    return {
      kind: "siblings",
      reason:
        `the recorded After Effects is gone but ${siblings.length} other ` +
        `instance(s) of this install are running (pids ` +
        `${siblings.map((p) => p.pid).join(", ")}); rebuild would refuse on ` +
        "the ambiguity, so terminate reports it instead of claiming success",
    };
  }
  evidence.push("no other instance of the recorded install is running in scope");
  return { kind: "gone", evidence };
}

/** The outcome of waiting for the recorded host to disappear. */
export type GoneWait =
  | { readonly kind: "gone"; readonly evidence: readonly string[] }
  | {
      readonly kind: "timeout";
      /** What the last successful census said. */
      readonly detail: string;
    }
  | {
      readonly kind: "unproven";
      /** Why disappearance could not be proven within the deadline. */
      readonly detail: string;
    };

/**
 * Poll the census until the recorded host is provably gone or the deadline
 * passes. A census that cannot be read is not "still alive" and not "gone":
 * it is retried until the deadline and then reported `unproven` — an
 * unreadable OS query never upgrades to an answer (#340: OS照会不明は拒否).
 */
export async function waitForHostGone(input: {
  readonly platform: NodeJS.Platform;
  readonly provenance: LaunchProvenance;
  readonly processes: ProcessCensus;
  readonly sessionUid: number;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}): Promise<GoneWait> {
  const deadline = input.now() + input.deadlineMs;
  let lastCensusError: string | null = null;
  let lastInspection: string | null = null;
  for (;;) {
    let processes: readonly HostProcess[] | null = null;
    try {
      processes = input.processes();
      lastCensusError = null;
    } catch (error) {
      lastCensusError = errorMessage(error);
    }
    if (processes !== null) {
      const inspection = inspectTerminateTarget({
        platform: input.platform,
        provenance: input.provenance,
        processes,
        sessionUid: input.sessionUid,
      });
      if (inspection.kind === "gone") {
        return { kind: "gone", evidence: inspection.evidence };
      }
      lastInspection =
        inspection.kind === "alive"
          ? "the recorded After Effects is still running"
          : inspection.reason;
      if (inspection.kind !== "alive") {
        // Siblings or an ambiguous identity will not resolve by waiting:
        // the drift is real, so stop early and report it unproven.
        return { kind: "unproven", detail: lastInspection };
      }
    }
    if (input.now() >= deadline) {
      if (lastCensusError !== null) {
        return {
          kind: "unproven",
          detail:
            `the process list could not be read before the deadline ` +
            `(${lastCensusError}); disappearance is unproven`,
        };
      }
      return {
        kind: "timeout",
        detail:
          `${lastInspection ?? "the recorded After Effects is still running"} ` +
          `after ${input.deadlineMs}ms`,
      };
    }
    await input.sleep(Math.min(input.pollIntervalMs, Math.max(1, deadline - input.now())));
  }
}

/** What the OS-level terminate action is asked to do. */
export type TerminateHostRequest = {
  readonly pid: number;
  /**
   * `graceful`: the OS-mediated polite request — an AE `quit` Apple Event
   * on macOS (the app may still show its own save prompt), `taskkill`
   * without `/F` on Windows. `force`: the explicit-permission kill —
   * `SIGKILL` on macOS, `taskkill /F` on Windows.
   */
  readonly mode: "graceful" | "force";
  /** The recorded executable, for platform-specific addressing. */
  readonly executable: string;
};

/**
 * The `.app` bundle path inside a macOS executable path
 * (`…/Foo.app/Contents/MacOS/Foo` → `…/Foo.app`), or null when the
 * recorded path has no bundle shape — an unrecognised layout gets no
 * Apple-Event quit rather than a guessed target.
 */
export function darwinAppPath(executable: string): string | null {
  const segments = executable.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    if (segment.endsWith(".app")) {
      return segments.slice(0, i + 1).join("/");
    }
  }
  return null;
}

function runFile(
  file: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      { timeout: 15_000, windowsHide: true },
      (error) => {
        if (error === null) {
          resolvePromise();
        } else {
          rejectPromise(error);
        }
      },
    );
  });
}

/**
 * The production terminate action. Graceful is the OS's own polite
 * request; force is only ever reached when the caller passed explicit
 * permission (`TerminateOptions.force`). Both are addressed to the
 * recorded pid — never to a name that could resolve to another instance.
 */
export async function defaultHostTerminate(
  platform: NodeJS.Platform,
  request: TerminateHostRequest,
): Promise<void> {
  if (platform === "win32") {
    await runFile(
      "taskkill.exe",
      [
        "/PID",
        String(request.pid),
        "/T",
        ...(request.mode === "force" ? ["/F"] : []),
      ],
    );
    return;
  }
  if (request.mode === "force") {
    // SIGKILL cannot be caught or handled: this is the explicit force
    // path, and it is the only signal this module ever sends directly.
    process.kill(request.pid, "SIGKILL");
    return;
  }
  const app = darwinAppPath(request.executable);
  if (app === null) {
    throw new Error(
      `the recorded executable ${request.executable} has no .app bundle ` +
        "shape, so no graceful quit can be addressed; use force with " +
        "explicit permission or resolve the path by hand",
    );
  }
  // `tell application` by bundle path: the quit Apple Event goes to the
  // app itself, which may still raise its own save prompt — that is the
  // point of graceful-first. Single-instance was proven before this ran.
  await runFile("osascript", [
    "-e",
    `tell application "${app.replace(/"/g, '\\"')}" to quit`,
  ]);
}
