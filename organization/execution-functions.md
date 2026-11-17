# Execution functions and Herdr presentation

This document refines [execution roles](execution-roles.md) and does not redefine the Constitution, Issue authority or GitHub state.

## Four different concepts

| Dimension | Meaning | Canonical source |
| --- | --- | --- |
| Actor role | Coordinator, Supervisor, Worker, Reviewer: who is responsible and has authority | execution-roles / ADR-0019 |
| Execution function | what an attempt does: implement, refactor, review, verify, recover, reconcile, cleanup, etc. | the task's objective, acceptance and applicable Skills |
| Attempt class | observational / mutable / durable: isolation, identity, fencing, checkpoint obligations | execution-roles / parallel-orchestration / agent-recovery |
| Presentation | human-facing Herdr workspace/tab/pane, label and capacity | herdr-runtime layout adapter |

A Worker may perform refactoring or verification; a Reviewer is a specialized Worker. Recovery is a cross-cutting operation, not a permanent agent process or an unconditional permission to kill another attempt. Device is a host/tool resource, not an actor role. A tab is **never** evidence of task/attempt completion, authorization or ownership.

## Function vocabulary and applicable contract

| Function | Work and outputs | Governing boundary |
| --- | --- | --- |
| coordinate, supervise, integrate | task decomposition, observation, result admission | only the integration authority may admit results |
| implement, fix, refactor | mutable candidate creation, changes and repair | explicit writable-state ownership, immutable result and validation |
| research | bounded investigation and alternatives | observational unless promoted due to mutation |
| review | independent critical evaluation | cold review independence; non-authoring by default |
| verify, benchmark | tests and measurements on a pinned artifact | validated SHA/environment identity and exclusive singleton device lease when needed |
| recover | discover and safely resume interrupted attempts | atomic ownership transfer, fencing and stale-result exclusion |
| reconcile | align real remote/branch/PR/runtime state with declared state | side effects verified and authorized before changing it |
| cleanup | free completed session/workspace/branch resources | no unique uncommitted work, unreconciled side effects or uncollected evidence |
| device, serve, logs | host-native applications, singleton GUI/device, background service and diagnostics | explicitly leased mutable service/device state where applicable |

Project-specific functions may be added by extending this vocabulary and its operating contract. Do not let a UI lane or role string itself grant mutating capabilities. Under the dedicated non-authoring Supervisor profile (ADR-0035), `implement`/`fix`/`refactor` must be executed by a separate Worker or scoped deterministic executor, not by self-promoting the Supervisor's current session. Tool access must be enforced by runtime permissions, remote credentials, and a constrained broker.

## Composition and conflicts

Each attempt independently determines \`actor_role\`, \`function\`, \`attempt_class\`, \`task_id\`, \`input_sha\`, applicable \`ownership/fencing\`, \`required_resources\` and \`result_contract\`. Two functions can share a visual tab without sharing resource authority. Review and verification can operate concurrently on the same immutable snapshot; code edits that change the SHA invalidate affected evidence. Two mutable attempts cannot both own a singleton GUI instance, database or shared worktree. A fresh Recover attempt must acquire ownership before replacing old execution; a Cleanup attempt cannot infer safety from Herdr \`idle\` or \`done\`.

project-init's existing [parallel-orchestration](../skills/parallel-orchestration/SKILL.md), [agent-recovery](../skills/agent-recovery/SKILL.md), [sandbox-runtime](../skills/sandbox-runtime/SKILL.md) and GitHub delivery contracts remain the authorization/coordination mechanisms. Layout planning is **not** a lease manager and cannot alone prevent cross-process writes.

## Presentation adapter

Default human-facing tabs are \`Ctrl\`, \`Work\`, \`Device\`. Multiple functions share each tab without losing their logical identity. For example, Implement, Refactor, Review and Verify may all be placed in Work while their evidence/ownership rules remain different. Recover/Reconcile/Cleanup ordinarily belong to Ctrl, but are created only when work requires them. Device is a visual grouping for tool/host work, not authority to operate a physical device.

The Herdr adapter may:
- reuse an existing project workspace when identity is unambiguous;
- create one project-root anchored workspace if absent, leaving its root shell in Ctrl;
- use an existing named functional tab; otherwise create only a needed tab;
- split a pane only while under a configured pane cap (default four, hard configuration limit six);
- queue overflow by default, with optional bounded extra tabs (\`Work2\` etc.);
- refuse ambiguous, conflicting, unknown or incomplete runtime layout inventory.

The Herdr adapter must not:
- create a workspace for each execution attempt;
- treat each function as a mandatory tab or each native subagent as a pane;
- rerun work merely because a pane says \`idle\`/\`done\`;
- commandeer any pre-existing shell for a new worker (a new split is required);
- silently switch machine/provider, close or move a live user's pane, perform \`layout.apply\` or steal focus;
- infer worktree, issue, task or device ownership from a Herdr ID or label.

Human rearrangements are not automatically reverted. Future reorganizations require a separate explicit non-destructive reconciliation plan; moving active panes changes IDs and must update transient references. Herdr's client-specific screen width determines visual readability, so four panes is a *starting bound*, not a universal claim of optimality.

## Project-specific settings and evaluation

The reference implementation in \`templates/agent-routing/layout.mts\` is a replaceable Practice. Projects may override concise tab labels, function-to-tab presentation, capacity and overflow preference without creating a competing authority or provider catalog. \`templates/agent-routing/layout.test.mts\` tests workspace reuse, bounded growth, ambiguous identity, missing data and duplicate names. The runtime adapter uses \`herdr api snapshot\` and the documented \`workspace/tab/pane\` commands, but no real machine E2E has been completed for this change; live adoption remains blocked until a target environment passes it.

CLI route selection and real model/provider identity remain in the #132/#133 delegation contract and dotfiles launcher. The layout adapter does not validate Infisical credentials or start any provider by itself.
