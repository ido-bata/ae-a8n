#!/usr/bin/env bash
# Prepare the current worktree. Every worktree frontend (Worktrunk, Orca,
# plain git) calls this through `mise run worktree:setup`, so a worktree ends
# up in the same state no matter which tool created it. Safe to run repeatedly.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

# Derive per-worktree values from the branch, not from a frontend template.
branch=$(git branch --show-current)
key=${branch:-$(git rev-parse --short HEAD)}
checksum=$(printf '%s' "$key" | cksum | cut -d' ' -f1)
port=$((20000 + checksum % 10000))

# Write atomically so a concurrent or interrupted run never leaves a partial file.
tmp=$(mktemp "$root/.worktree.env.XXXXXX")
printf 'WORKTREE_KEY=%s\nPORT=%s\n' "$key" "$port" > "$tmp"
mv "$tmp" "$root/.worktree.env"

# Materialize the project toolchain when the project declares one.
if [ -f mise.toml ] && command -v mise >/dev/null 2>&1; then
  if [ -f mise.lock ]; then
    mise install --locked
  else
    mise install
  fi
fi

# Project-specific setup goes below. Keep every step idempotent.

# Dependencies: a fresh worktree has no node_modules; reinstall when the
# lockfile is newer than the last install so an interrupted run self-heals.
if [ -f package-lock.json ] && { [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; }; then
  npm ci
fi
