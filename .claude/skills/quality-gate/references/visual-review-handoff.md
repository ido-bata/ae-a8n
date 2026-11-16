# Visual/native review handoff — decision-ready evidence

This reference refines the existing `quality-gate` Skill for **user-visible UI, interaction and native-app changes**. It does not add a universal gate to mechanical or nonvisual changes. Project-local quality profile and applicable design/spec remain the authority for what must be verified.

## Desired outcome

A reviewer should be able to determine:
1. which stated requirement and design reference each changed screen or interaction is supposed to satisfy;
2. which actual build/source snapshot and environment produced the displayed result;
3. what passed, failed or was not verified;
4. which consequential **product/design judgment**, if any, still requires a human decision.

The handoff is an index of reviewable evidence, not a replacement for actual evidence or a new implementation/spec source of truth.

## Select the minimum meaningful coverage

Compile the scope from changed UI states, affected user journeys, layout constraints, platform risks and explicit acceptance criteria. Prefer focused regression evidence for changed surfaces and representative critical paths over a full screenshot dump. Cover relevant interactive states (loading, empty, error, input focus, accessibility, transitions), not only the idle default screenshot. Do not infer Windows-native validation from WSL, macOS, CI success or a remote terminal connection. When a project has a canonical design artifact (e.g., a design file with node identities), reference that version and the affected nodes; do not quietly treat an unapproved redesign as a matched implementation.

## Minimal review record

An individual record or its aggregate manifest identifies:
- **scope:** Issue/acceptance criterion, changed state/interaction and its design/spec URI and revision or node identity;
- **candidate:** source SHA or immutable digest, actual runnable build/package identity and dependency/version constraints where they matter;
- **environment:** OS, native/CI/emulated class, app version, window/viewport/resolution/DPI or device state, and verification tool/method;
- **evidence:** actual screenshot/video/log/interactions and reproducible action, along with observed result;
- **verdict per claim:** `pass`, `fail`, `unverified` or `not-applicable`, with an explanation for unknowns or omissions;
- **differences and risk:** concrete mismatch and affected behavior or visual invariant, with exact evidence links;
- **human decision:** a *single concrete question* when required, supporting evidence and proposed default, plus downstream consequence.

The reviewer-facing summary should lead with changed/failed/unverified items and the few unresolved decisions. Keep full evidence accessible, but do not require a human to open every artifact just to discover missing verification. Report facts, agent aesthetic evaluation, and user-owned preference decisions separately.

## Review sequence

1. Implementation/verification actor builds the candidate and captures evidence on an applicable environment. Never invent screenshots, procedures, model observations or platform identity.
2. Deterministic checks (e.g., navigation, layout invariants, critical E2E, expected controls) run where tooling supports them. A similarity score alone is not proof of functional or aesthetic quality.
3. A separate cold reviewer compares the *actual candidate* to the approved design/spec and acceptance criteria when execution profile requires independent review. Reviewer verdict must be evidence-backed; self-grading or an unsupported `APPROVED` is not enough.
4. Automatically repair clear implementation mismatches within agreed scope, then regenerate evidence for the modified SHA/build. Do not silently change a signed-off design to make a diff green.
5. Escalate only a material unresolved direction/trade-off, required physical interaction, safety/authority boundary, or product acceptance that automation cannot verify. Present a focused question and the relevant artifacts.
6. Record decision under the canonical Issue/design/ADR surface when it changes requirements. Ticket integration and release authorization remain separate as defined in `github-delivery`.

## Failure conditions

- Screenshots from an old SHA/build are applied to a new candidate without verifying equivalence.
- A screenshot lacks target resolution, state or platform identity.
- A design change is claimed as an implementation pass without approved reference.
- A missing real GUI/native execution is described as `pass` because CI or WSL succeeded.
- A cold review consists of a one-word approval without referencing real evidence.
- The user is asked to re-review all pages even though the tool could identify the changed and unverified surfaces.
- A subjective preference is represented as a deterministic quality signal, or the model silently decides a new product direction.

## Implementation ownership

Capture/report generators, screenshot tools, pen/design exporters, test runners, CI, OS GUI automation and storage/retention are **project-specific implementation**. Derive them from the existing quality profile and tooling; do not standardize a mandatory Playwright/Unity/Ae bundle here. Existing Issue/PR/build/artifact/evidence stores remain canonical. The review handoff may be a manifest and links on the PR; it is not required to create a new database.
