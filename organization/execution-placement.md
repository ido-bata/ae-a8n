# Cross-device execution placement (current Practice)

- Layer: **Practice**; refines [execution functions](execution-functions.md), [release-driven-solo](profiles/release-driven-solo.md), [parallel-orchestration](../skills/parallel-orchestration/SKILL.md), [quality-gate](../skills/quality-gate/SKILL.md), [herdr-runtime](../skills/herdr-runtime/SKILL.md).
- Scope: choosing **where** to execute Work, Verify, Review, Benchmark, Render, Serve, or a durable agent attempt. Does **not** define who is authorized, how agents are routed, or how SSH/Herdr sessions are synchronized.
- Status: policy candidate; cross-device operational acceptance is **not complete**. See [project-init #147](https://github.com/rebuildup/project-init/issues/147) and [dotfiles #78](https://github.com/rebuildup/dotfiles/issues/78).

## Separate identities and authorities

| Concept | Meaning / owner |
| --- | --- |
| Task, attempt, role, function, fencing | project-init orchestration and GitHub Issue/result contracts; **not** a Herdr tab |
| Logical device / SSH endpoint / remote session | dotfiles/Infisical node definition and native SSH/Herdr; not permission to execute arbitrary work |
| Physical host / shared resource group | real host capacity and contention, observed when needed |
| OS runtime | Windows native, macOS native, WSL/Linux, or another target environment; not necessarily independent hardware |
| Mutable resource and lease | sandbox/runtime or the owner of the actual GUI, build directory, DB, port, service, GPU, or hardware |
| Artifact and evidence | immutable commit/artifact SHA, environment identity, procedure and observed outcome |

**Windows native and its WSL2 distributions normally share physical CPU, RAM, GPU/VRAM, SSD, power and thermal budgets.** Do not count them as independent capacity when choosing placements. The environments *do* offer separate OS interfaces. A separate Mac is a distinct physical host when this has been verified, but its suitability and available headroom are not assumed.

Do not duplicate live endpoint secrets, private keys, host inventory, model/provider config, or machine state into project-init. Infisical/dotfiles owns connection definitions; `agent` launcher owns model/provider routing; Git and GitHub own source/evidence. Herdr owns terminal/session presentation only.

## Placement decision: small, explicit, evidence-based

1. **Classify work**: `actor_role` / `function` / observational-mutable-durable attempt, expected output, exact input commit/artifact SHA and deadline. A short, local, single-process task needs no remote placement.
2. **Match hard capabilities**: required OS/architecture, native GUI/interactive logon, SDK/tool/license/hardware, target data, security boundary, network reachability, permissions, workspace/sandbox isolation, lease/ownership, budget/provider route. Unsupported capability is a blocker, not a guess.
3. **Evaluate capacity only when material**: observed CPU/RAM/IO/GPU/VRAM/disk, physical-host group, other running jobs, power/thermal/sleep state, network transfer/setup overhead, interactive responsiveness, relevant singleton leases. Probe **candidate** machines on demand, not a perpetual full-mesh background scan. If unknown, either probe or state uncertainty.
4. **Choose smallest useful route**: local first where equivalent; use target OS for native verification; use another *physical host* for actual resource relief only when the marginal benefit exceeds transfer, setup, supervision and recovery cost. Capacity is not permission; Herdr availability is not ownership.
5. **Materialize before execution**: for mutable work, assign exclusive mutable workspace/service ownership and fencing before spawning; for verification, pin clean candidate + environment, acquire singleton GUI/device lease where required, and avoid authoring.
6. **Attach and run**: use the installed dotfiles `devices` / native SSH / Herdr remote interface only after confirming the target logical node, OS/user/instance/session and supported CLI version. Never infer destination from tab title or silently fall back. Start the process *on the intended host* and record its identity.
7. **Collect and evaluate**: evidence must name input SHA/digest, environment (actual OS/native-vs-WSL, tool versions and host group where material), command/action, results/artifacts, unexpected mutation and held lease. Compare only equivalent inputs and conditions. Apply existing acceptance and reviewer boundaries.
8. **Disconnect/recover safely**: Herdr client detach does not itself terminate a server-side process, but **sleep, shutdown, user logout and server loss may**. Before retry/move to another host, reconcile live process and side effects, revoke/advance attempt fencing where applicable, then reassign once. Do not equate a disconnected client with a cancelled attempt.

A concise placement record can extend an existing attempt/verification contract without a new database:

```yaml
task_id: <Issue or ephemeral task>
attempt_id: <immutable attempt identity; generation if durable>
role_function_class: <role / function / observational|mutable|durable>
input_artifact: <commit SHA or immutable digest>
target: <logical device ID + observed OS/user/instance/session>
physical_host_group: <verified group; Windows and its WSL share one>
requirements: <required native capabilities and hard constraints>
ownership_and_capacity: <lease/serialization + relevant resource checks>
route: <resolved harness/provider, if a coding agent is used>
evidence: <commands, artifacts, environment, source mutation status>
failure_policy: <queue | blocked | explicit reassign after reconcile>
```

Omit inapplicable fields for brief observational work; never invent an unobserved identity or metric. Do not store credentials in the record.

## Operational examples

| Use | Placement and required evidence |
| --- | --- |
| Windows ACL, PowerShell, Win32 behavior | **Windows native**, not WSL. Confirm normal-user logon when required; record command, tool version, commit and native outcome. A CI Windows runner is useful but does not prove a user's GUI session works. |
| Apple-native build / GUI / After Effects plug-in | **macOS native** with the actual application/version and GUI/device lease. Terminal health or headless tests are not substitute visual interaction. |
| Linux CLI and Linux-specific validation | **WSL/Linux**, with distribution/kernel/toolchain identity and pinned candidate. WSL success is not a Windows-native result. |
| Cross-platform release check | Run the same fixed candidate separately on each **applicable native OS**; compare outcomes and note coverage gaps. Do not relabel mocks or cross-compiled artifacts as host-native E2E. |
| CPU-heavy build/test or render | Place on a physically separate host with observed headroom, correct architecture/tooling and isolated output. Do not schedule Windows and its WSL as if two separate CPUs/GPUs. |
| Independent reviewer or benchmark | Reviewer reads immutable candidate without sharing author's mutable workspace. Benchmark also needs stable input, power/resource conditions and isolation from competing jobs. |
| Long-running remote agent | Start on chosen target host in its own authorized runtime; Herdr provides observation/reattach. Check host sleep policy, process survival, recoverability, credentials and cost. Disconnect is not cancellation. |

**Connection example, conditional on dotfiles #78 being installed and validated:**

```sh
devices list          # Read logical destinations; this does not prove capacity or authority
devices check <id>    # Validate one target against pinned SSH/instance identity
devices herdr <id>    # Attach to its intended remote Herdr session
```

These are commands from the *separate* dotfiles Practice, **not** an installation or an implementation of `devices` by project-init. For a remote GUI test, Herdr is the terminal/log/agent channel; use a separately authorized GUI automation/human observation path. Verify actual tool versions, session identity and behavior before using this in unattended operation.

## Non-negotiable negative contract

- Never infer task completion, successful validation, resource ownership, authority or cancellation from `herdr idle/done`, pane ID, UI placement or mere SSH connectivity.
- Never use WSL to claim independent compute capacity from its Windows host; never oversubscribe shared CPU/GPU/disk, singleton GUI/device, port, DB, working tree/index, Cargo build output, or mutable caches without equivalent isolation/serialization.
- Never move a mutable attempt to another host on timeout/SSH failure/quota failure before observing or fencing its prior execution. No silent local or alternative-machine fallback, no unbounded recursive dispatch.
- Never use remote SSH/Herdr to bypass Supervisor non-authoring permissions, sandbox/tool allowlists or user authorization. Existence of SSH access does not grant application write, elevated, secret or release permissions.
- Never copy client private keys, login/session caches or provider credentials between hosts for convenience, enable SSH agent forwarding implicitly, or grant broad Infisical paths.
- Never restart the remote Herdr server, change `machine` registration, steal existing panes, terminate unrelated jobs, or overwrite local user sessions as an incidental placement side effect.
- Never label CLI/API/nonce/connectivity, fake-provider success, green CI, or a visible terminal as real native GUI E2E.
- Never create a new always-on scheduler, telemetry database, VPN/controller or extra machine registry for placement when targeted inspection and existing tools suffice.

## Validation / acceptance matrix

| Case | Expected behavior | Evidence class |
| --- | --- | --- |
| Windows native versus WSL | Separate OS-specific results; **shared** physical-host resource group | Contract test + actual system inventory |
| Mac as alternative compute host | Capability and headroom observed; data movement and contention considered | Native execution + resource observations |
| Unknown, offline or wrong-instance target | Block/queue; no implicit local fallback or second mutable attempt | Negative test + real connection |
| Two jobs using one GUI/GPU/port/DB | Correct lease/serialization, or explicit rejection; no concurrent ownership | Concurrency negative test |
| Different commit than expected | Reject stale validation/review before admission | Contract test + Git SHA checks |
| Client disconnect while remote process runs | Reattach to **same** job/session or report real loss; no fake continuation | Real Herdr end-to-end test |
| User's active pane and sessions | No focus theft, unapproved kill/restart or workspace proliferation | Real UI observation |
| Supervisor denied authoring | No bypass by picking another host/harness or SSH | Enforcement negative test |
| WSL recreation/deletion | Old instance/session rejected after intended re-registration and resync; distinguish definition removal from SSH key revocation | Real lifecycle test with dotfiles #78 |

Unit/mock and CI success prove the **policy implementation**, not the real cross-machine experience. Do not make this PR Ready solely from simulated CLI responses. Record exact host OS, session/instance and artifact identity for live acceptance. If environment access is unavailable, keep this class of acceptance explicitly pending.

## Ownership and replacement boundary

Implement placement as a modest extension of the existing spawn/verification decision. If a machine-selection wrapper becomes necessary, first demonstrate why `devices`, native SSH, Herdr and the existing role/route preflight are insufficient. Any additional tool must remain replaceable, targeted and deny-by-default. Re-evaluate and remove it when native execution/runtime capabilities make it redundant.
