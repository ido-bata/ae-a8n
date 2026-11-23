/**
 * The dispatcher-activation delivery core shared by
 * `AfterEffects.activateDispatcher()` (#276) and the verified session
 * rebuild's transport re-staging (#313).
 *
 * Both callers run the identical proof chain — owned-session gate,
 * script-transport delivery of the canonical `activate.jsx`, nonce-bound
 * heartbeat proof, post-delivery ownership re-check, provenance record —
 * so it lives here once rather than being duplicated into the rebuild
 * path. The public method keeps its own closed-session check and error
 * contextualisation; this function assumes an open session.
 */

import { rmSync } from "node:fs";

import { errorMessage } from "../errors.js";
import {
  defaultDispatcherChannelDir,
  DispatcherTransport,
} from "../driver/dispatcher-transport.js";
import { recordDispatcherProvenance } from "../driver/dispatcher-provenance.js";
import { recordSessionDispatcherActivation } from "../driver/session-dispatcher-activations.js";
import { HostNotOwnedError } from "./errors.js";
import { AfterEffectsError } from "./errors.js";
import type { Session } from "./session.js";
import type {
  ActivateDispatcherOptions,
  DispatcherActivation,
} from "./types.js";

/**
 * Activates the in-AE dispatcher inside the After Effects `session` owns
 * and proves the activation with the per-delivery nonce. See
 * `AfterEffects.activateDispatcher` for the full contract; `op` is the
 * API operation name errors are contextualised under.
 */
export async function activateDispatcherForSession(
  session: Session,
  options: ActivateDispatcherOptions,
  op: string,
): Promise<DispatcherActivation> {
  const ownership = session.driver.ownership();
  if (ownership.kind !== "owned") {
    throw new HostNotOwnedError(
      op,
      ownership.kind,
      `${ownership.evidence}; dispatcher activation is only delivered to an After ` +
        "Effects this session owns — activating a foreign instance stays a human action",
    );
  }
  const transport = session.driver.scriptTransport();
  if (transport === null) {
    throw new AfterEffectsError(
      "only a session on the built-in script transport can deliver the " +
        "dispatcher activation script; this session's transport cannot",
      op,
    );
  }
  const channelDir = options.channelDir ?? defaultDispatcherChannelDir();
  const dispatcher = new DispatcherTransport({ channelDir });
  await dispatcher.prepare();
  const activation = await dispatcher.prepareActivationScript();
  const timeoutMs = options.timeoutMs ?? 15_000;
  let deliveredPath: string | null = null;
  // The staged per-call file is always safe to remove: AE only ever
  // reads the private copy `deliverActivationScript` returns. That copy
  // must survive until AE has read it — proven by the nonce appearing —
  // so on timeout it is left behind: a still-pending script-trust
  // dialog may yet read it and complete the activation.
  try {
    // Pre-spawn refusals (ownership lost, non-canonical file) propagate
    // as-is: nothing was delivered, so the timeout wording would lie.
    deliveredPath = await transport.deliverActivationScript(activation.path);
    // The nonce — not heartbeat freshness — is the proof: a dispatcher
    // that was already answering the channel cannot carry this call's
    // nonce, so a stale-but-fresh heartbeat fails closed here.
    let beat: NonNullable<ReturnType<typeof dispatcher.status>["heartbeat"]>;
    try {
      beat = await dispatcher.waitForActivationNonce(activation.nonce, timeoutMs);
    } catch (error) {
      throw new AfterEffectsError(
        `the activation script was delivered to the owned After Effects but ` +
          `${errorMessage(error)}; After Effects may be showing a script-trust ` +
          "or consent dialog, or the -r hand-off reached a different instance. " +
          "If so, answer it, or run " +
          `${dispatcher.activateScriptPath} via File > Scripts > Run Script File`,
        op,
      );
    }
    // The nonce proves the delivered script ran on an After Effects
    // answering this channel. Bind it to the owned instance: if the
    // census no longer proves a single owned in-scope process, the
    // `-r` hand-off may have reached a different After Effects that
    // started mid-delivery — fail closed rather than claim it.
    const postDelivery = session.driver.ownership();
    if (postDelivery.kind !== "owned") {
      throw new AfterEffectsError(
        `the activation script ran, but the owned After Effects can no ` +
          `longer be proven sole in-scope (${postDelivery.evidence}); ` +
          "the dispatcher may have activated a different instance — " +
          "inspect `ae-a8n dispatcher status` before attaching",
        op,
      );
    }
    // Record which owned process the nonce proved the dispatcher
    // activated in (#294): later attach sessions through this channel
    // attest pid/session from this record — re-verified live against
    // the heartbeat and the OS census — instead of reporting nothing.
    // Evidence only: it never grants this session ownership of that
    // process, and a failed write must not fail a proven activation.
    const ownedHost = transport.ownedProcess();
    if (ownedHost !== null) {
      const targetSession = transport.targetSession;
      try {
        recordDispatcherProvenance(channelDir, {
          host: ownedHost,
          instance: beat.instance,
          activatedAt: beat.activatedAt,
          activationNonce: activation.nonce,
          session:
            targetSession === null
              ? null
              : {
                  uid: targetSession.uid,
                  asid: targetSession.asid,
                  user: targetSession.username,
                },
        });
      } catch (error) {
        session.trace.record("session.dispatcherProvenance", "error", 0, {
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: errorMessage(error),
          },
        });
      }
    }
    // Index the channel for a later rebuild (#313): the dispatcher lives
    // inside this AE process and dies with it, so the rebuild path must
    // be able to enumerate which channels to re-activate. Best-effort
    // like the provenance record — the activation itself is already
    // proven, and a failed index write degrades discovery, not proof.
    try {
      recordSessionDispatcherActivation(session.driver.sessionRoot, channelDir);
    } catch (error) {
      session.trace.record("session.dispatcherActivationIndex", "error", 0, {
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: errorMessage(error),
        },
      });
    }
    rmSync(deliveredPath, { force: true });
    deliveredPath = null;
    return { channelDir, instance: beat.instance, aeVersion: beat.aeVersion };
  } finally {
    rmSync(activation.path, { force: true });
  }
}
