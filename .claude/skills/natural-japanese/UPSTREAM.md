# Upstream attribution

`natural-japanese` combines a primary upstream Skill with selected, complementary material from another MIT-licensed Japanese rewriting project.

## Primary upstream: coji/natural-japanese

This Skill is derived from [coji/natural-japanese](https://github.com/coji/natural-japanese).

- Upstream source commit: `9a78a42964096da509b8f3e011f0085a5f080151`
- Upstream license: MIT
- Original copyright: Copyright (c) 2026 coji
- Imported scope: `skills/natural-japanese/` runtime surface

The full upstream MIT notice is preserved in [LICENSE.upstream](./LICENSE.upstream).

## Incorporated upstream: nanaism/yomiyasu

Selected semantic-fidelity and rewrite-diff behavior is adapted from [nanaism/yomiyasu](https://github.com/nanaism/yomiyasu).

- Reviewed source commit: `8f77b7aa8f19c3f718b511e71a3eee5d06eb3013`
- Upstream license: MIT
- Original copyright: Copyright (c) 2026 nanaism
- Adapted normative scope: `references/semantic-fidelity.md`
- Adapted normative scope (structural rewriting, reviewed at `1bc21f9`): `references/structural-reconstruction.md`
- Adapted runtime scope: `scripts/fidelity_diff.py`
- Adapted runtime scope (structural rewriting): `METAPHOR_VERB_PATTERNS` and `detect_metaphor_verbs` in `scripts/lint.py`, taken from upstream `yomiyasu_lint.py` without the over-broad 「〜した瞬間」 pattern

The full yomiyasu MIT notice is preserved in [LICENSE.yomiyasu](./LICENSE.yomiyasu).

The `fidelity_diff.py` implementation is a narrowed adaptation of upstream `yomiyasu_diff.py`: it keeps lexical, modality, sentence-ending, connective, and structural drift signals while intentionally dropping unrelated Markdown emphasis repair and other formatting checks. The behavior remains advisory: it surfaces changes that need review but does not decide whether meaning changed.

Apart from the metaphor-verb patterns, the upstream `yomiyasu_lint.py`, corpus/eval infrastructure, domain packs, slop catalog, plugin packaging, and research artifacts are intentionally not vendored. Their responsibilities either overlap with the existing `natural-japanese` lint/references or are outside this runtime surface.

## writing-skills adaptations

The Skill remains layered on top of this repository's contracts.

- The activation description follows the writing-skills `Use when ...` convention.
- `writing-discipline` remains the canonical foundation; this Skill adds Japanese-specific naturalness, readability, diagnostics, and rewrite fidelity.
- Existing generation-time constraints, doctype guidance, lint, score, and readability review remain intact.
- Rewrite fidelity is a separate pre/post lane: naturalness improvements must not silently change claim, emphasis, certainty, or communicative function.
- Deterministic findings are candidates for review, not automatic rewrite commands.
- Upstream corpus, experimental research infrastructure, CI, release automation, and plugin packaging are not copied unless separately justified.

When updating either upstream-derived surface, compare against a specific upstream commit and record the new commit here so provenance and drift remain reviewable.
