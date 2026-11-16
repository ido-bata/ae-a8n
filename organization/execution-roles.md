# Execution roles and attempt classes

This document defines the current Operating Model vocabulary for delegated execution.

## Roles

### Supervisor

Owns lifecycle authority for supervised execution attempts.

Responsibilities may include:

- start/spawn
- observe/wait
- cancel
- resource/policy application
- ownership fencing and reassignment
- interruption recovery and orphan reconciliation
- result collection and admission support

Supervisor is a logical role. It may be implemented by a native agent runtime, an external control plane, Herdr, a project-local adapter, or another mechanism that provides equivalent guarantees.

A **dedicated non-authoring Supervisor execution profile** is a separate authority choice (ADR-0035 / `supervisor-boundary`). When enabled, that actor may reason, dispatch, observe, and decide admission, but cannot directly author source, run arbitrary shell, or use privileged service connectors. Solo/mechanical execution is still performed by a Worker. This restriction must be enforced by runtime capabilities and distinct identities, not inferred from a role prompt. A combined actor topology remains valid only when dedicated separation was not selected.

### Worker

Executes a delegated work unit under a bounded input/authority contract and returns result/evidence.

A Worker is not synonymous with:

- GitHub Issue
- Git branch
- process
- terminal pane
- subagent API object
- worktree

Those may be implementation details.

### Coordinator

Owns decomposition, dependency ordering, routing, and integration planning.

Coordinator and Supervisor may be the same actor, but a Worker does not gain integration authority merely because it can technically mutate shared state.

### Reviewer

A specialized Worker that evaluates a candidate artifact/evidence. It is non-authoring by default so review evidence remains independent from implementation.

## Attempt classes

| Class | Typical work | Mutable source/runtime ownership | Durable recovery |
| --- | --- | --- | --- |
| Observational | research, exploration, review, diagnostics | no | not required by default |
| Mutable | independent implementation or stateful execution | yes, explicit boundary required | optional unless continuity requires it |
| Durable | Issue-level / long-running / background / remote work | as applicable | required |

The lightest class that satisfies constitutional obligations should be used.

## Promotion

An attempt must be promoted when its behavior exceeds the current class.

Examples:

- research subagent begins editing source -> Observational to Mutable
- implementation becomes background/remote and must survive session loss -> Mutable to Durable
- reviewer needs to reproduce a stateful test in a singleton native environment -> remain non-authoring but acquire the applicable mutable-resource lease defined by verification policy

Promotion changes guarantees, not necessarily the agent process.

## Capability mapping

Organizational code/policy should prefer logical capabilities:

`spawn_worker`, `observe_worker`, `wait_worker`, `cancel_worker`, `recover_worker`, `get_worker_result`, `admit_worker_result`.

Runtime-specific commands belong to Practice adapters.

## Durable state boundary

Terminal panes, provider session IDs, native subagent IDs, and Supervisor-local state are useful transient identifiers but are not sufficient as the only representation of consequential unfinished work.

Durable attempts must remain reconstructable from durable project state and checkpoints according to `agent-recovery`.

## Execution function and presentation

Execution roles define responsibility, not UI placement. Functional work (refactor/review/verification/recovery/reconciliation/cleanup) is composed with actor role and attempt class, not substituted for either. See [execution-functions.md](execution-functions.md) for the function vocabulary, collision invariants and Herdr presentation adapter; tabs and panes never confer authority.
