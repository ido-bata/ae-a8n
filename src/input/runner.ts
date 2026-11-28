/**
 * The input operation runner (#371, `specs/ime-input/spec.md` §5).
 *
 * Platform-neutral orchestration over injected seams — the same shape
 * as `src/panels/controller.ts`: every OS touch arrives through
 * `InputPoster`, `InputFocusOps`, clipboard/IME ports, so the contract
 * (authorize → focus-proof → post → cleanup → audit) is identical on
 * macOS, Windows and in tests. Real posting helpers are #372/#373;
 * this runner is the contract they plug into.
 *
 * Fail-closed order, every step before anything posts:
 *
 *   1. `mutate-session` class → refuse `unsupported` (out of slice).
 *   2. `attribution !== "owned"` → refuse `unproven`.
 *   3. Scope requiring global input → `inputAuthorizationVerdict`;
 *      absent/mismatched grant refuses `unavailable`/`refused` —
 *      reported, never a silent no-op.
 *   4. Mutation gate → refuse `refused` (production gate always
 *      refuses today).
 *   5. Session-stream → three-step focus proof; failure refuses
 *      `focus-unproven` before the first post.
 *   6. Preflight: every step's delivery channel must exist on the
 *      poster, or the whole op refuses `unsupported` up front.
 *
 * Then steps run with a focus guard between posts; `finally` always
 * runs the cleanup plan (pressed-set reverse release, modifier
 * clear, clipboard/IME/focus restore records) and the audit record is
 * returned — the runner never throws for an expected refusal.
 */

import { randomUUID } from "node:crypto";

import type { PanelTarget } from "../panels/types.js";
import { proveSessionStreamFocus, type FocusGuard, type InputFocusOps } from "./focus.js";
import {
  newCleanupPlan,
  normalizeModifiers,
  payloadDigest,
  runCleanup,
  type CleanupPlan,
} from "./cleanup.js";
import { inputAuthorizationVerdict, type InputMutationGate } from "./gate.js";
import {
  INPUT_OPERATION_GATES,
  type ClipboardSnapshot,
  type ExpectedFocus,
  type FocusHolder,
  type GlobalInputAuthorization,
  type ImeModeSnapshot,
  type InputAuditRecord,
  type InputCleanupReport,
  type InputFocusEvidence,
  type InputPlan,
  type InputPoster,
  type InputStep,
  type InputStepRecord,
  type InputVerdict,
} from "./types.js";

/** Clipboard port: snapshot prior contents, write, restore. */
export type InputClipboardOps = {
  /** Snapshot current contents as flavors+digest — never the payload. */
  snapshot(): ClipboardSnapshot | Promise<ClipboardSnapshot>;
  restore(snapshot: ClipboardSnapshot): void | Promise<void>;
};

/** IME/input-source port: query current mode, restore a prior mode. */
export type InputImeOps = {
  currentMode(): ImeModeSnapshot | Promise<ImeModeSnapshot>;
  restore(mode: string | null): void | Promise<void>;
};

export type InputRunnerDeps = {
  /** The resolved, owned PanelTarget every op addresses. */
  readonly target: PanelTarget;
  readonly poster: InputPoster;
  readonly focus: InputFocusOps;
  readonly clipboard?: InputClipboardOps;
  readonly ime?: InputImeOps;
  /**
   * The mutate-gui gate. Fail-closed: absent means every mutation
   * refuses. Production wires `inputMutationGate()`.
   */
  readonly authorizeMutation?: InputMutationGate;
  /** Explicit global-input grant; absent on gated scopes refuses. */
  readonly authorization?: GlobalInputAuthorization | null;
  /** Session kind the op runs in — drives the §5.4 grant check. */
  readonly sessionKind: "shared" | "dedicated" | "unknown";
  readonly sessionId?: string | undefined;
  /** The element identity the session-stream proof expects. */
  readonly expectedFocus?: ExpectedFocus;
  /** Re-prove focus every N steps; default 1 (every step after the first). */
  readonly recheckEvery?: number;
  /**
   * Declared composition resolution for the cleanup contract
   * ("commit" | "cancel"), plus the channel that performs it. Both or
   * neither: a declared resolution with no channel is recorded as a
   * skipped cleanup action, never silently dropped.
   */
  readonly compositionResolution?: "commit" | "cancel";
  readonly compositionResolveChannel?: (
    resolution: "commit" | "cancel",
  ) => void | Promise<void>;
  readonly newOperationId?: () => string;
  readonly now?: () => Date;
};

function emptyCleanup(): InputCleanupReport {
  return { actions: [], allRestored: true };
}

function focusEvidence(
  before: FocusHolder | null,
  proven: FocusHolder | null,
  after: FocusHolder | null,
  expected: ExpectedFocus | undefined,
  changedMidSequence: boolean,
): InputFocusEvidence {
  // Element-level proof only when the expectation named an element and
  // the proven holder matched it; a pid-only expectation is pid-level.
  const elementProven =
    proven !== null &&
    expected !== undefined &&
    expected.element !== null &&
    proven.element === expected.element;
  return { before, proven, after, elementProven, changedMidSequence };
}

/** Does the poster have the channel a step needs? Preflight, fail-closed. */
function stepChannelMissing(step: InputStep, poster: InputPoster): string | null {
  switch (step.kind) {
    case "type-sequential":
      return poster.typeSequential === undefined ? "typeSequential" : null;
    case "type-direct":
      return poster.postText === undefined ? "postText" : null;
    case "clipboard-write":
      return poster.clipboardWrite === undefined ? "clipboardWrite" : null;
    case "ime-mode-select":
      return poster.imeSelect === undefined ? "imeSelect" : null;
    case "custom":
      return step.channel === "mouse" && poster.mouse === undefined
        ? "mouse"
        : null;
    default:
      return null;
  }
}

function summarizeStep(
  step: InputStep,
): { summary: string; payload?: InputStepRecord["payload"] } {
  switch (step.kind) {
    case "key-press":
    case "key-down":
    case "key-up": {
      const mods = normalizeModifiers(step.modifiers);
      return {
        summary:
          `${step.kind} ${step.key}` +
          (mods.length > 0 ? ` [${mods.join("+")}]` : ""),
      };
    }
    case "type-sequential":
    case "type-direct":
    case "clipboard-write": {
      const digest = payloadDigest(step.text);
      return {
        summary: `${step.kind} (${digest.length} chars)`,
        payload: {
          kind: "text",
          length: digest.length,
          sha256: digest.sha256,
          sensitive: true,
        },
      };
    }
    case "ime-mode-select":
      return { summary: `ime-mode-select ${step.mode}` };
    case "custom":
      return { summary: step.summary };
  }
}

/** Post one step through the poster, tracking pressed keys for cleanup. */
function postStep(
  step: InputStep,
  poster: InputPoster,
  plan: CleanupPlan,
): void {
  switch (step.kind) {
    case "key-press": {
      const mods = normalizeModifiers(step.modifiers);
      // Register before posting: if keyDown throws mid-press the key
      // may be down, and the residue sweep must release it.
      plan.pressed.press(step.key, mods);
      try {
        poster.keyDown(step.key, mods);
        poster.keyUp(step.key, mods);
      } finally {
        plan.pressed.release(step.key);
      }
      return;
    }
    case "key-down": {
      const mods = normalizeModifiers(step.modifiers);
      plan.pressed.press(step.key, mods);
      poster.keyDown(step.key, mods);
      return;
    }
    case "key-up": {
      const mods = normalizeModifiers(step.modifiers);
      poster.keyUp(step.key, mods);
      plan.pressed.release(step.key);
      return;
    }
    case "type-sequential": {
      if (poster.typeSequential === undefined) {
        throw new Error("poster has no typeSequential channel");
      }
      poster.typeSequential(step.text);
      return;
    }
    case "type-direct": {
      if (poster.postText === undefined) {
        throw new Error("poster has no postText channel");
      }
      poster.postText(step.text);
      return;
    }
    case "clipboard-write": {
      if (poster.clipboardWrite === undefined) {
        throw new Error("poster has no clipboardWrite channel");
      }
      poster.clipboardWrite(step.text);
      return;
    }
    case "ime-mode-select": {
      if (poster.imeSelect === undefined) {
        throw new Error("poster has no imeSelect channel");
      }
      poster.imeSelect(step.mode);
      return;
    }
    case "custom": {
      step.run(poster);
      return;
    }
  }
}

/**
 * Run one input plan and return its audit record. Always resolves —
 * expected refusals are verdicts, not exceptions.
 */
export async function runInputPlan(
  plan: InputPlan,
  deps: InputRunnerDeps,
): Promise<InputAuditRecord> {
  const now = deps.now ?? (() => new Date());
  const operationId = (deps.newOperationId ?? randomUUID)();
  const gateRow = INPUT_OPERATION_GATES[plan.operation];
  const steps: InputStepRecord[] = [];
  const cleanupPlan = newCleanupPlan();
  let verdict: InputVerdict = "refused";
  let refusal: InputAuditRecord["refusal"] = null;
  let authorization: InputAuditRecord["authorization"] = null;
  let focusBefore: FocusHolder | null = null;
  let focusProven: FocusHolder | null = null;
  let focusAfter: FocusHolder | null = null;
  let focusChanged = false;
  let valueReadback: InputAuditRecord["valueReadback"] = null;
  let cleanup: InputCleanupReport = emptyCleanup();

  const finish = async (): Promise<InputAuditRecord> => {
    cleanup = await runCleanup(cleanupPlan, {
      poster: deps.poster,
      ...(deps.clipboard !== undefined
        ? {
            clipboardRestore: (snapshot: ClipboardSnapshot) =>
              deps.clipboard!.restore(snapshot),
          }
        : {}),
      ...(deps.ime !== undefined
        ? { imeRestore: (mode: string | null) => deps.ime!.restore(mode) }
        : {}),
      ...(deps.compositionResolveChannel !== undefined
        ? { compositionResolve: deps.compositionResolveChannel }
        : {}),
      ...(deps.focus.restoreFocus !== undefined
        ? {
            focusRestore: (holder: FocusHolder) =>
              deps.focus.restoreFocus!(holder),
          }
        : {}),
    });
    // A performed op with failed restores is not fully clean — report
    // it as indeterminate rather than claiming success (spec §5.5:
    // restore failure is reported, and honesty beats optimism).
    if (verdict === "performed" && !cleanup.allRestored) {
      verdict = "indeterminate";
      refusal = {
        code: "indeterminate",
        reason:
          "the operation posted but cleanup reported failures — " +
          "see cleanup.actions for which restore did not complete",
      };
    }
    return {
      operationId,
      target: deps.target,
      operation: plan.operation,
      operationClass: gateRow.class,
      scope: gateRow.scope,
      authorization,
      focus: focusEvidence(focusBefore, focusProven, focusAfter, deps.expectedFocus, focusChanged),
      steps,
      tier1a: null,
      tier1b: null,
      valueReadback,
      cleanup,
      verdict,
      refusal,
      observedAt: now().toISOString(),
    };
  };

  const refuse = async (
    code: NonNullable<InputAuditRecord["refusal"]>["code"],
    reason: string,
  ): Promise<InputAuditRecord> => {
    refusal = { code, reason };
    verdict = "refused";
    return finish();
  };

  try {
    // 1. Out-of-slice class.
    if (gateRow.class === "mutate-session") {
      return await refuse(
        "unsupported",
        "mutate-session input (effects outside the target pid) is out of " +
          "this slice and requires its own spec + A-SAFETY sign-off",
      );
    }

    // 2. Attribution — only an owned surface may be driven.
    if (deps.target.surface.attribution !== "owned") {
      return await refuse(
        "unproven",
        `target attribution is "${deps.target.surface.attribution}"; ` +
          'only "owned" surfaces may receive input',
      );
    }

    // 3. Global-input authorization where the scope requires it.
    if (gateRow.requiresGlobalInputAuthorization) {
      const authz = inputAuthorizationVerdict(deps.authorization, {
        operation: plan.operation,
        operationClass: gateRow.class,
        target: deps.target,
        sessionKind: deps.sessionKind,
        sessionId: deps.sessionId,
      });
      if (authz.status !== "granted") {
        return await refuse(authz.code, authz.reason);
      }
      authorization = {
        tokenRef: authz.tokenRef,
        scope: deps.authorization!.kind,
      };
    }

    // 4. The mutation gate — fail-closed.
    if (gateRow.class !== "observe") {
      const gate = deps.authorizeMutation;
      const gateVerdict =
        gate === undefined
          ? { allowed: false as const, reason: "no mutation gate wired — fail-closed" }
          : gate(gateRow.class, gateRow.scope);
      if (!gateVerdict.allowed) {
        return await refuse("refused", gateVerdict.reason);
      }
    }

    // 5. Session-stream focus proof (spec §5.3).
    let guard: FocusGuard | undefined;
    let anyPosted = false;

    if (gateRow.scope === "session-stream") {
      const expected =
        deps.expectedFocus ??
        ({ pid: deps.target.pid, element: null } satisfies ExpectedFocus);
      focusBefore = deps.focus.readFocusHolder();
      const proof = await proveSessionStreamFocus(expected, deps.focus);
      if (!proof.proven) {
        focusProven = proof.observed;
        return await refuse(proof.code, proof.reason);
      }
      focusProven = proof.holder;
      // If requesting focus moved the holder, remember the prior one
      // so cleanup can attempt a restore (spec §5.5 focus bullet).
      if (
        focusBefore !== null &&
        (focusBefore.pid !== proof.holder.pid ||
          focusBefore.element !== proof.holder.element)
      ) {
        cleanupPlan.focusPrior = focusBefore;
      }
      guard = proof.guard;
    }

    // 6. Preflight — every step's channel must exist before anything posts.
    for (const step of plan.steps) {
      const missing = stepChannelMissing(step, deps.poster);
      if (missing !== null) {
        return await refuse(
          "unsupported",
          `the poster has no "${missing}" channel; step "${step.kind}" ` +
            "cannot run — refusing before any post",
        );
      }
    }

    // Shared-state prior capture before the first mutating step.
    const touchesClipboard = plan.steps.some((s) => s.kind === "clipboard-write");
    if (touchesClipboard && deps.clipboard !== undefined) {
      cleanupPlan.clipboardPrior = await deps.clipboard.snapshot();
    }
    if (plan.operation === "ime-mode-select" && deps.ime !== undefined) {
      cleanupPlan.imePrior = await deps.ime.currentMode();
    }
    if (deps.compositionResolution !== undefined) {
      cleanupPlan.compositionResolution = deps.compositionResolution;
    }

    // 7. Post the steps.
    const recheckEvery = Math.max(1, deps.recheckEvery ?? 1);
    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = plan.steps[i];
      if (step === undefined) continue;

      // Focus re-check between posts; a change aborts, never continues.
      if (guard !== undefined && i > 0 && i % recheckEvery === 0) {
        const check = guard.assert(i);
        if (!check.ok) {
          focusChanged = true;
          focusAfter = deps.focus.readFocusHolder();
          verdict = anyPosted ? "indeterminate" : "refused";
          refusal = { code: check.code, reason: check.reason };
          return await finish();
        }
      }

      const { summary, payload } = summarizeStep(step);
      const stepStart = Date.now();
      try {
        postStep(step, deps.poster, cleanupPlan);
        anyPosted = true;
        steps.push({
          index: i,
          kind: step.kind,
          summary,
          payload,
          outcome: "posted",
          detail: null,
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        steps.push({
          index: i,
          kind: step.kind,
          summary,
          payload,
          outcome: "failed",
          detail,
          durationMs: Date.now() - stepStart,
        });
        verdict = anyPosted ? "indeterminate" : "failed";
        refusal = {
          code: "indeterminate",
          reason: `step ${i} (${step.kind}) failed: ${detail}`,
        };
        return await finish();
      }
    }

    // 8. Post-step readback (spec §5.3 step "Post") — requested vs
    // observed are reported separately, never claimed on timeout.
    if (plan.readback !== undefined) {
      try {
        const observed = await plan.readback();
        valueReadback = { requested: null, observed };
      } catch {
        valueReadback = { requested: null, observed: null };
      }
    }
    focusAfter = deps.focus.readFocusHolder();
    verdict = "performed";
    return await finish();
  } catch (error) {
    // Unexpected failure — still run cleanup, report honestly.
    verdict = "failed";
    refusal = {
      code: "indeterminate",
      reason: `runner failure: ${error instanceof Error ? error.message : String(error)}`,
    };
    return await finish();
  }
}

/** Digest helper re-exported for tests building expected payloads. */
export { payloadDigest };
