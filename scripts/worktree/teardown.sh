#!/usr/bin/env bash
# Release resources that live outside the worktree directory before the
# worktree is removed. Every frontend calls this through
# `mise run worktree:teardown`. Safe to run repeatedly and when setup never ran.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

key=""
if [ -f .worktree.env ]; then
  key=$(sed -n 's/^WORKTREE_KEY=//p' .worktree.env)
fi
: "${key:=$(git branch --show-current)}"

# Project-specific teardown goes below, keyed by "$key" (for example
# `docker compose -p "wt-$key" down`). Keep every step idempotent.
