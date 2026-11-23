/**
 * Dialog taxonomy v2 (#284, specs/gui-supervision/spec.md §Blocking taxonomy).
 *
 * This module is the single registry of After Effects dialog classes. Every
 * entry carries four things the older scattered lists did not:
 *
 *   - a `tier` from the supervision contract: `auto-safe` (measured, the safe
 *     dismissal was verified on a real host), `human-required` (measured or
 *     policy-required; a human decision — never pressed), `report-only`
 *     (measured informational/busy state; reported, not pressed). `unknown`
 *     is deliberately absent: it is what an unmatched window gets, never a
 *     registered class.
 *   - structured `evidence` provenance: which OS, which AE version, when it
 *     was observed, and where the record lives, plus an honest `level` —
 *     `real-host` means the window shape was actually seen and recorded;
 *     `policy` means the class is registered conservatively (human-required)
 *     without a captured window, so an unseen dialog of that kind is named
 *     rather than guessed at. A `policy` entry is never `auto-safe`.
 *   - `pressPolicy`: the reason automation may or may not press, in words a
 *     report can quote.
 *   - an optional `extract` that pulls structured fields out of the window's
 *     static texts (script error line/message, contention detail) instead of
 *     leaving consumers to re-parse prose.
 *
 * Hard rules encoded here, not by convention:
 *
 *   - Only `auto-safe` entries may name a button, and only
 *     `ae-a8n ui.alert` qualifies today: its `OK` press was verified on a
 *     real host (docs/offstage-macos.md §10.14).
 *   - Classes without real-machine measurement stay `human-required`,
 *     `report-only`, or unmatched (`unknown` → `A8N-SEC-001`). Nothing here
 *     is auto-safe "to be helpful".
 *   - The multi-script contention class (`after-effects-second-script`) is
 *     flagged `contention`: supervision annotates it with the driver's
 *     in-flight request and transport. The dispatch layer's one-in-flight
 *     serialization is the actual fix for #41; the dialog is classified and
 *     reported, never merely dismissed.
 *   - No OCR, no screenshots, no image recognition: matching runs on the
 *     OS accessibility text only.
 */

import type { DiagnosticCode } from "../doctor/diagnostics.js";
import type { DialogWindow, RecoveryButton } from "./recovery-policy.js";

/** The supervision tier a registered class carries. `unknown` is never registered. */
export type DialogTier = "auto-safe" | "human-required" | "report-only" | "unknown";

/** Tiers a registry entry may actually have. */
export type RegisteredDialogTier = Exclude<DialogTier, "unknown">;

/**
 * How strong the evidence behind a class is.
 *
 *   - `real-host`: the dialog shape was observed on a real After Effects
 *     installation and the observation is recorded (OS, version, date,
 *     source). This is the only level that can ever back `auto-safe`.
 *   - `policy`: the class is registered without a captured window because
 *     the safe answer is already decided by policy (a human decision, or a
 *     busy indicator that must not be pressed). Always `human-required` or
 *     `report-only` — never `auto-safe`.
 */
export type DialogEvidenceLevel = "real-host" | "policy";

/** Where a class's evidence comes from, so a later reader can check it. */
export type DialogEvidence = {
  readonly level: DialogEvidenceLevel;
  /** OS the observation was made on, e.g. "macOS", "Windows"; null when policy-only. */
  readonly platform: string | null;
  /** AE version/build observed, e.g. "26.5x89"; null when not applicable. */
  readonly aeVersion: string | null;
  /** ISO-8601 observation date; null when policy-only. */
  readonly observedAt: string | null;
  /** Where the record lives: doc path, evidence directory, or "policy". */
  readonly source: string;
  /** What was seen and why the tier is what it is. */
  readonly detail: string;
};

/**
 * Structured content pulled out of a window's accessible text. `fields`
 * holds class-specific extractions (script error line/message); `summary`
 * is the one-line description reports and traces carry.
 */
export type StructuredDialogContent = {
  /** The registered class name, or null when nothing matched. */
  readonly dialogClass: string | null;
  readonly tier: DialogTier;
  /** The diagnostic code to report, when the class carries one. */
  readonly code: string | null;
  /** The evidence level behind the class, when one matched. */
  readonly evidenceLevel: DialogEvidenceLevel | null;
  readonly fields: Readonly<Record<string, string | number | null>>;
  readonly summary: string;
};

/** One measured (or policy-registered) dialog class. */
export type DialogClassSpec = {
  /** What the evidence calls this class. */
  readonly name: string;
  readonly tier: RegisteredDialogTier;
  /** The diagnostic code reported with this class; null when none applies. */
  readonly code: DiagnosticCode | null;
  /**
   * The only button automation may press, and only for `auto-safe`.
   * `null` for every other tier — enforced below, not by convention.
   */
  readonly button: RecoveryButton | null;
  /** Why automation may or may not press this class, in reportable words. */
  readonly pressPolicy: string;
  /**
   * True for the multi-script contention class: the dialog is a symptom of
   * a dispatch-level conflict, so supervision annotates reports with the
   * in-flight request and transport instead of treating it as a bare modal.
   */
  readonly contention?: boolean;
  readonly evidence: DialogEvidence;
  readonly matches: (window: DialogWindow) => boolean;
  /** Pull structured fields (error line, message) out of the window text. */
  readonly extract?: (
    window: DialogWindow,
  ) => Readonly<Record<string, string | number | null>>;
};

function windowText(window: DialogWindow): string {
  return [window.title, window.role, window.subrole ?? "", ...window.texts]
    .join(" ")
    .toLowerCase();
}

/** First non-empty static text, falling back to the title. */
function primaryText(window: DialogWindow): string {
  return window.texts.find((text) => text.trim().length > 0) ?? window.title;
}

/** `line N` / `at line N` extraction shared by script-error dialogs. */
function scriptErrorFields(window: DialogWindow): Record<string, string | number | null> {
  const all = window.texts.join("\n");
  const line = /(?:at\s+)?line\s*#?(\d+)/iu.exec(all)?.[1];
  return {
    message: primaryText(window),
    line: line === undefined ? null : Number(line),
  };
}

/**
 * The registry. Order is match precedence: the first entry whose `matches`
 * accepts a window names it, so specific classes precede broader ones.
 *
 * Evidence levels, honestly:
 *
 *   real-host (window shape observed and recorded):
 *     - ae-a8n ui.alert — macOS 26.5x89, 2026-11-03, docs/offstage-macos.md §10.14
 *     - after-effects-second-script — Windows 26.5x89, 2026-10-16,
 *       docs/windows-verification.md (full dialog text recorded)
 *     - after-effects-script-error — Windows 26.5x89,
 *       docs/windows-verification.md ("Unable to execute script at line 0.
 *       Object is invalid" modal; regenerates after every OK)
 *     - after-effects-script-progress — Windows 26.5x89,
 *       docs/windows-verification.md ("Executing Script … Script execution
 *       time … [Cancel]" progress window)
 *     - after-effects-crash-repair — Windows 26.5x89
 *       (docs/windows-verification.md) and macOS 26.5.3 2026-11-15
 *       (src/driver/recovery.ts UNPRESSABLE evidence, G0 2026-11-16)
 *     - after-effects-crash-recovery-project — macOS 26.5.3 2026-11-15
 *     - after-effects-startup-directory-warning — macOS 26.5.3 2026-11-15
 *     - script-file-network-permission — macOS 26.5.3, G0 probe
 *       2026-11-16 (docs/evidence/g0-startup-2026-11-16) plus the measured
 *       preference gate in docs/offstage-macos.md
 *     - adobe-sign-in — macOS, the Creative Cloud sign-in window text was
 *       observed in the AX listing (src/driver/gui-recovery.ts) and the AE
 *       launch sign-in modal is documented in docs/offstage-macos.md
 *     - after-effects-scripting-component-missing — macOS AE 27.0.0
 *       2026-11-16 (docs/evidence/g0-startup-2026-11-16) and the Windows
 *       Safe Mode note in docs/windows-verification.md
 *
 *   policy (registered conservatively; the window itself was not captured):
 *     - after-effects-unsaved-changes — the save/discard decision is always
 *       a human's (user data), but no unsaved-changes dialog has been
 *       captured on a real host in this repo's evidence yet. It is
 *       `human-required`, never `auto-safe`, and its evidence says so.
 *     - adobe-licence — licence/activation is a human decision in every UI
 *       language; no licence window shape was captured either.
 *
 * Deliberately NOT registered (stay `unknown` → `A8N-SEC-001` quarantine):
 *   - the script-execution permission 警告 modal (docs/offstage-macos.md
 *     measures that it appears with a line number, but its wording was never
 *     recorded, so no honest matcher exists yet);
 *   - the Adobe survey/feedback dialog (seen once on Windows; whether it
 *     blocks scripts "was not established" — docs/windows-verification.md);
 *   - CEP/ScriptUI/plugin modals (no captured shape).
 */
export const DIALOG_TAXONOMY: readonly DialogClassSpec[] = [
  {
    name: "ae-a8n ui.alert",
    tier: "auto-safe",
    code: null,
    button: "OK",
    pressPolicy:
      "the only measured pressable class: an AXDialog with an empty title and the run's own " +
      "`ae-a8n:` text; pressing OK closed it and the original call completed",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: "26.5x89",
      observedAt: "2026-11-03",
      source: "docs/offstage-macos.md §10.14",
      detail:
        "AXWindow/AXDialog with an empty title, an `ae-a8n:` static text, and an OK button; " +
        "pressing OK closed it and the original call completed. Re-verified once after the " +
        "review fixes on the same host.",
    },
    matches: (window) =>
      (window.subrole ?? "").toLowerCase() === "axdialog" &&
      window.title.trim() === "" &&
      window.texts.some((text) => /^\s*ae-a8n:/u.test(text)),
  },
  {
    name: "after-effects-scripting-component-missing",
    tier: "human-required",
    code: "A8N-AE-006",
    button: null,
    pressPolicy:
      "the scripting plug-in/component is not installed; only installing it (a human, per-AE-version " +
      "decision) clears this — no button on the dialog was ever measured as safe",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: "27.0.0",
      observedAt: "2026-11-16",
      source: "docs/evidence/g0-startup-2026-11-16/README.md",
      detail:
        "AE 2027 on this machine lacks the ExtendScript component; the operator saw " +
        "「スクリプトファイルは実行できません。スクリプト機能のプラグインはインストールされていません」 " +
        "plus a crash-repair dialog. The Windows Safe Mode note in docs/windows-verification.md " +
        "records the English form ('The Scripting plugin is not installed').",
    },
    matches: (window) =>
      /スクリプトファイルは実行できません|スクリプト機能のプラグイン|scripting (plugin|component) is not/iu.test(
        windowText(window),
      ),
  },
  {
    name: "after-effects-second-script",
    tier: "human-required",
    code: "A8N-AE-004",
    button: null,
    pressPolicy:
      "a script may still be running behind the dialog and one OK click did not clear it in the " +
      "measured cases; the root cause is dispatch contention (#41), which the transport's " +
      "one-in-flight serialization owns — the dialog is reported, never dismissed",
    contention: true,
    evidence: {
      level: "real-host",
      platform: "Windows",
      aeVersion: "26.5x89",
      observedAt: "2026-10-16",
      source: "docs/windows-verification.md §The \"second script\" dialog",
      detail:
        "Full text recorded: 'After Effects warning: Attempt was made to run a second script " +
        "while another script was already running. Second script was not run.' Seen in the " +
        "persistent cases at the first project.open after launch; AE was responsive and idle " +
        "behind it, and a fresh -r ran nothing. Cause unknown; rare (4 in ~150 sessions).",
    },
    matches: (window) =>
      /second script while another script|another script was already running/iu.test(
        windowText(window),
      ),
    extract: (window) => ({
      message: primaryText(window),
      detail: window.texts.join(" / "),
    }),
  },
  {
    name: "after-effects-script-error",
    tier: "human-required",
    code: "A8N-AE-010",
    button: null,
    pressPolicy:
      "the measured 'Unable to execute script at line 0. Object is invalid' modal regenerated " +
      "after every OK — pressing cannot resolve a stale engine reference; the script content " +
      "and its line are extracted for the human instead",
    evidence: {
      level: "real-host",
      platform: "Windows",
      aeVersion: "26.5x89",
      observedAt: null,
      source: "docs/windows-verification.md §The modal: \"Unable to execute script at line 0. Object is invalid\"",
      detail:
        "Reproduced without ae-a8n: a script left a global holding an AE object and a later " +
        "app.open made AE show the modal as the switching script ended; the dialog " +
        "regenerated after every OK (2/2 controls). #targetengine did not avoid it.",
    },
    matches: (window) =>
      /unable to execute script|object is invalid|\bscript error\b|\berror\b[^\n]*\bline\s*\d+|\bline\s*\d+[^\n]*\berror\b/iu.test(
        windowText(window),
      ),
    extract: scriptErrorFields,
  },
  {
    name: "after-effects-script-progress",
    tier: "report-only",
    code: null,
    button: null,
    pressPolicy:
      "AE's own progress window for a running script ('Executing Script … Script execution " +
      "time … [Cancel]'); its Cancel button would kill running work, so it is reported as a " +
      "busy indicator and never pressed",
    evidence: {
      level: "real-host",
      platform: "Windows",
      aeVersion: "26.5x89",
      observedAt: null,
      source: "docs/windows-verification.md §The \"second script\" dialog (correction note)",
      detail:
        "AE shows this window for any script running longer than about a second, also for a " +
        "lone -r. An earlier misreading mistook it for the second-script dialog; the correction " +
        "is recorded in the same section.",
    },
    matches: (window) =>
      /executing script|script execution time/iu.test(windowText(window)),
  },
  {
    name: "after-effects-crash-recovery-project",
    tier: "human-required",
    code: "A8N-AE-012",
    button: null,
    pressPolicy:
      "the crash-recovery project window decides whether a recovered project is generated or " +
      "discarded; discarding unsaved work is a human's decision",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: "26.5.3",
      observedAt: "2026-11-15",
      source: "src/driver/recovery.ts UNPRESSABLE_DIALOG_CLASSES (measured 2026-11-15, AE 26.5.3)",
      detail:
        "Observed on a real host alongside the crash-repair options and AppDirs warnings; " +
        "each offers choices that are a human's decision and none has a measured safe button.",
    },
    matches: (window) =>
      /リカバリプロジェクト|recovery project|crash[_ ]?\d+\.aep/iu.test(windowText(window)),
  },
  {
    name: "after-effects-crash-repair",
    tier: "human-required",
    code: "A8N-SEC-001",
    button: null,
    pressPolicy:
      "crash repair offers repair-method and report-submission choices; sending a report or " +
      "changing repair settings is a human's decision, and no button was ever measured safe",
    evidence: {
      level: "real-host",
      platform: "Windows + macOS",
      aeVersion: "26.5x89 / 26.5.3",
      observedAt: "2026-11-15",
      source:
        "docs/windows-verification.md (Windows) + src/driver/recovery.ts UNPRESSABLE_DIALOG_CLASSES / docs/evidence/g0-startup-2026-11-16 (macOS)",
      detail:
        "Windows: an unclean exit makes the next start show Crash Repair Options. macOS: the " +
        "クラッシュ修復 options dialog was observed 2026-11-15 on AE 26.5.3. Reported and never pressed.",
    },
    matches: (window) =>
      /クラッシュ修復|crash[ -]?repair|repair options|crash[ -]?recovery|recover unsaved/iu.test(
        windowText(window),
      ),
  },
  {
    name: "after-effects-startup-directory-warning",
    tier: "human-required",
    code: "A8N-AE-012",
    button: null,
    pressPolicy:
      "the AppDirs/Required Dir warning reports an application-directory problem at launch; " +
      "its choices change how After Effects starts and are a human's decision",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: "26.5.3",
      observedAt: "2026-11-15",
      source: "src/driver/recovery.ts UNPRESSABLE_DIALOG_CLASSES (measured 2026-11-15, AE 26.5.3)",
      detail:
        "Observed on a real host at launch; the window text names AppDirs/Required Dir. Its " +
        "choices are a human's decision.",
    },
    matches: (window) => /appdirs|required dir/iu.test(windowText(window)),
  },
  {
    name: "script-file-network-permission",
    tier: "human-required",
    code: "A8N-PERM-003",
    button: null,
    pressPolicy:
      "the scripting file/network permission prompt changes a security setting; granting it is " +
      "a human's decision in every UI language",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: "26.5.3",
      observedAt: "2026-11-16",
      source:
        "docs/evidence/g0-startup-2026-11-16/README.md + docs/offstage-macos.md (Pref_SCRIPTING_FILE_NETWORK_SECURITY)",
      detail:
        "G0 probe: with 'Allow Scripts To Write Files And Access Network' off, the whole " +
        "file-envelope transport cannot answer app.info — a hard prerequisite gate. The " +
        "preference itself was measured off for this account; the prompt wording is policy-" +
        "matched in English and the class is never pressed regardless.",
    },
    matches: (window) =>
      /allow scripts to write|script.*(file|network)|scripts? to write files|file and network access/iu.test(
        windowText(window),
      ),
  },
  {
    name: "after-effects-unsaved-changes",
    tier: "human-required",
    code: "A8N-AE-011",
    button: null,
    pressPolicy:
      "saving or discarding unsaved project changes is a user-data decision; automation never " +
      "answers it on the user's behalf",
    evidence: {
      level: "policy",
      platform: null,
      aeVersion: null,
      observedAt: null,
      source: "policy (specs/gui-supervision/spec.md §Blocking taxonomy)",
      detail:
        "No unsaved-changes dialog window has been captured on a real host in this repo's " +
        "evidence — the API-level UnsavedChangesError refusal is measured (docs/sessions.md), " +
        "the dialog shape is not. Registered human-required so a matching window is named and " +
        "never pressed rather than guessed at; if the real wording differs the window falls " +
        "back to unknown/A8N-SEC-001 quarantine, which is equally safe.",
    },
    matches: (window) =>
      /save changes|unsaved|discard changes|do you want to save|変更を保存|保存しますか|保存しない/iu.test(
        windowText(window),
      ),
  },
  {
    name: "adobe-sign-in",
    tier: "human-required",
    code: "A8N-PERM-004",
    button: null,
    pressPolicy:
      "an Adobe sign-in or account window is always a human decision, in every UI language; " +
      "credentials are never entered or stored by automation",
    evidence: {
      level: "real-host",
      platform: "macOS",
      aeVersion: null,
      observedAt: null,
      source:
        "src/driver/gui-recovery.ts AX listing (Creative Cloud sign-in window text) + docs/offstage-macos.md (AE launch sign-in modal)",
      detail:
        "The sign-in window's own text was observed in a real AX listing " +
        "('Adobe Creative Cloud にサインインしてください'), and the AE start-up sign-in modal " +
        "is documented as a human gate. Policy additionally requires human handling.",
    },
    matches: (window) =>
      /sign[ -]?in|sign[ -]?out|log[ -]?in|adobe ?id|creative ?cloud|サインイン|サインアウト|ログイン/iu.test(
        windowText(window),
      ),
  },
  {
    name: "adobe-licence",
    tier: "human-required",
    code: "A8N-SEC-001",
    button: null,
    pressPolicy:
      "a licence or activation window is always a human decision; automation never accepts " +
      "terms, activates or deactivates on the user's behalf",
    evidence: {
      level: "policy",
      platform: null,
      aeVersion: null,
      observedAt: null,
      source: "policy",
      detail:
        "Policy requirement: a licence or activation window is always a human decision. No " +
        "licence window shape was captured on a real host; the wording match is broad on " +
        "purpose so the window is named human-required rather than pressed or guessed.",
    },
    matches: (window) =>
      /licen[cs]|activat|deactivat|ライセンス|認証|アクティベーション/iu.test(windowText(window)),
  },
];

/**
 * Registry invariant, checked once at module load: only `auto-safe` entries
 * may name a press button, and the button must be one of the recovery-safe
 * endings. A violation is a programming error, so it throws at import time
 * rather than being discovered mid-recovery.
 */
const SAFE_BUTTONS: readonly string[] = ["OK", "Cancel", "Close", "Dismiss"];
for (const spec of DIALOG_TAXONOMY) {
  if (spec.tier === "auto-safe") {
    if (spec.button === null || !SAFE_BUTTONS.includes(spec.button)) {
      throw new Error(`dialog class ${spec.name} is auto-safe without a safe button`);
    }
  } else if (spec.button !== null) {
    throw new Error(`dialog class ${spec.name} is ${spec.tier} but names a press button`);
  }
}

/** The first registered class a window matches, or null when unmeasured. */
export function matchDialogClass(window: DialogWindow): DialogClassSpec | null {
  return DIALOG_TAXONOMY.find((spec) => spec.matches(window)) ?? null;
}

/** The registry entry by name, for consumers that hold a class name. */
export function dialogClassByName(name: string): DialogClassSpec | null {
  return DIALOG_TAXONOMY.find((spec) => spec.name === name) ?? null;
}

/** One-line provenance string for reports and the `evidence` field. */
export function describeDialogEvidence(evidence: DialogEvidence): string {
  const where =
    evidence.platform === null
      ? "policy"
      : `${evidence.platform}${evidence.aeVersion === null ? "" : ` AE ${evidence.aeVersion}`}` +
        `${evidence.observedAt === null ? "" : `, ${evidence.observedAt}`}`;
  return `${evidence.level} (${where}; ${evidence.source}): ${evidence.detail}`;
}

function contentSummary(window: DialogWindow, spec: DialogClassSpec | null): string {
  const said = window.texts.filter((text) => text.trim().length > 0);
  const texts = said.length === 0 ? "" : ` — ${said.join(" / ")}`;
  const buttons = window.buttons.filter((button) => button.trim().length > 0);
  const presses = buttons.length === 0 ? "" : ` [${buttons.join(", ")}]`;
  return `${spec?.name ?? "unclassified"} ${window.role}${window.subrole === null ? "" : `/${window.subrole}`}${presses} "${window.title}"${texts}`;
}

/**
 * Structured content for one observed window: the class it matched (if any),
 * its tier and code, class-specific extracted fields, and a one-line summary.
 * An unmatched window reports `dialogClass: null`, `tier: "unknown"` and the
 * quarantine code `A8N-SEC-001` — the honest answer, not a guess.
 */
export function extractDialogContent(window: DialogWindow): StructuredDialogContent {
  const spec = matchDialogClass(window);
  if (spec === null) {
    return {
      dialogClass: null,
      tier: "unknown",
      code: "A8N-SEC-001",
      evidenceLevel: null,
      fields: {},
      summary: contentSummary(window, null),
    };
  }
  return {
    dialogClass: spec.name,
    tier: spec.tier,
    code: spec.code,
    evidenceLevel: spec.evidence.level,
    fields: spec.extract?.(window) ?? {},
    summary: contentSummary(window, spec),
  };
}
