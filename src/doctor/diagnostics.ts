/**
 * Diagnostic codes shared by `doctor`, `setup`, `test` and `recover`.
 *
 * The registry is the single source of truth: a code that is not here cannot
 * be reported, and `test/diagnostics.test.ts` fails if the registry and the
 * contract in `specs/isolated-ae/contracts/cli.md` drift apart.
 */

export const SEVERITIES = ["info", "warning", "blocker"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Who can clear the condition. */
export type RemedyKind = "human" | "automatic" | "none";

export type DiagnosticEvidence = Readonly<
  Record<string, string | number | boolean | null>
>;

/** One entry of the `checks[]` array in the CLI envelope. */
export type DiagnosticCheck = {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly remedy: string;
  readonly remedyKind: RemedyKind;
  readonly evidence: DiagnosticEvidence;
};

/**
 * Append-only. Changing a code's meaning is a breaking change; adding one is
 * not. `specs/isolated-ae/contracts/cli.md` §5 is the reviewed copy.
 */
export const DIAGNOSTIC_CODES = {
  "A8N-ENV-001": { severity: "blocker", title: "Unsupported OS or architecture" },
  "A8N-ENV-002": { severity: "blocker", title: "Node version below the package floor" },
  "A8N-ENV-003": { severity: "blocker", title: "After Effects not found" },
  "A8N-ENV-004": { severity: "warning", title: "Multiple After Effects installations" },
  "A8N-SESSION-001": { severity: "blocker", title: "Target account does not exist" },
  "A8N-SESSION-002": { severity: "blocker", title: "Target account has no GUI session" },
  "A8N-SESSION-003": { severity: "blocker", title: "Target session is the console session" },
  "A8N-SESSION-004": { severity: "blocker", title: "Session identity changed during the run" },
  "A8N-PERM-001": { severity: "blocker", title: "Screen Recording not granted in the target session" },
  "A8N-PERM-002": { severity: "blocker", title: "Accessibility not granted in the target session" },
  "A8N-PERM-003": { severity: "blocker", title: "After Effects script file/network permission is off" },
  "A8N-PERM-004": { severity: "blocker", title: "Adobe sign-in required in the target session" },
  "A8N-AE-001": { severity: "blocker", title: "Another After Effects is running on the target" },
  "A8N-AE-002": { severity: "blocker", title: "The After Effects is not owned by this run" },
  "A8N-AE-003": { severity: "blocker", title: "The script destination could not be proven" },
  "A8N-AE-004": { severity: "warning", title: "A timed-out script may still be running" },
  "A8N-JOB-001": { severity: "blocker", title: "Job or result file failed ownership or integrity checks" },
  "A8N-JOB-002": { severity: "warning", title: "A prior run left a lock or quarantine state" },
  "A8N-SEC-001": { severity: "blocker", title: "A licence, sign-in or permission dialog is present" },
  "A8N-EXT-001": { severity: "blocker", title: "Extension registration is invalid" },
  "A8N-RELEASE-001": { severity: "blocker", title: "Package version already exists on the registry" },
} as const satisfies Record<string, { readonly severity: Severity; readonly title: string }>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export type DiagnosticInput = {
  readonly detail: string;
  readonly remedy: string;
  readonly remedyKind: RemedyKind;
  readonly evidence?: DiagnosticEvidence;
};

/** Build a check, taking `severity` and `title` from the registry. */
export function diagnostic(code: DiagnosticCode, input: DiagnosticInput): DiagnosticCheck {
  const registered = DIAGNOSTIC_CODES[code];
  return {
    code,
    severity: registered.severity,
    title: registered.title,
    detail: input.detail,
    remedy: input.remedy,
    remedyKind: input.remedyKind,
    evidence: input.evidence ?? {},
  };
}

export type DiagnosticStatus = "ok" | "blocked";

/**
 * `doctor`'s status rule: any blocker blocks. A warning or a refusal that
 * describes a live run is reported but does not by itself fail the command.
 */
export function aggregateDiagnosticStatus(checks: readonly DiagnosticCheck[]): DiagnosticStatus {
  return checks.some((check) => check.severity === "blocker") ? "blocked" : "ok";
}
