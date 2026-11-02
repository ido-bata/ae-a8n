# AGENTS.md

This repository's root contract is [`CLAUDE.md`](CLAUDE.md). It is a dispatcher: it names the
project's boundary, the commands, the working agreement, the verification levels, and the Skill
in charge of each capability.

Read `CLAUDE.md` first, then the document or Skill it points at.

- `docs/development.md` — bootstrap, commands, layout, release
- `docs/architecture.md` — the layers, the bridge protocol, the bridge rules
- `docs/verification.md` — what has actually been observed, and at what evidence level
- `docs/sessions.md` — ownership, unsaved changes, timeouts
- `docs/releasing.md` — the publish procedure
- `docs/recovery.md` — resuming work from GitHub, not from a conversation
- `docs/security.md` — what the package does on a user's machine, and what it does not hold
- `docs/troubleshooting.md` — where to look when something fails
- `docs/adr/` — decisions and their reasons
- `.claude/skills/` — project-local Agent Skills, pinned by `skills-lock.json`
