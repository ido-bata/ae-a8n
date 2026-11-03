#!/bin/sh
# Requests the Accessibility and Automation permissions **from inside the
# test user's own Terminal window**.
#
# There is no "Terminal" entry to switch on in macOS's Privacy & Security
# settings: those lists show only the apps that have *asked*. So the request
# has to come from Terminal itself, and the grant lands on Terminal.app —
# which is what we want, because every child of it (osascript, node) then
# inherits the permission.
#
# Run it as the test user, in that user's Terminal:
#
#   /Users/Shared/ae-a8n/run/ax-grant.command
#
# Two dialogs appear on the test session's screen. Click "OK" on both:
#
#   1. "Terminal wants to control this computer"      (Accessibility)
#   2. "Terminal wants to control System Events"      (Automation)
#
# Neither is the After Effects automation grant: AE is reached by
# DoScriptFile, which needs no TCC permission at all (see docs/offstage-macos.md
# §10.9). System Events is needed because the GUI fallback reads AE's windows
# through the Accessibility API.
set -u

HERE=$(dirname "$0")
SHARED=/Users/Shared/ae-a8n/run
# One log per user: the shared directory is a sticky world-writable one, so a
# file another user already made cannot be appended to. Writing a log named
# after the uid means the run never depends on someone else's file mode — and
# a redirect that cannot be opened would silently skip the whole block,
# prompts included.
LOG=$SHARED/ax-grant.$(id -u).log
PROMPT=$SHARED/ax-prompt

mkdir -p "$SHARED" 2>/dev/null || true

# Build the asker if it is not there yet. It is a one-line Swift program
# that calls AXIsProcessTrustedWithOptions with the prompt option.
if [ ! -x "$PROMPT" ]; then
  if [ -r "$HERE/ax-prompt.swift" ]; then
    /usr/bin/swiftc -O "$HERE/ax-prompt.swift" -o "$PROMPT" 2>&1
  elif [ -r "$SHARED/ax-prompt.swift" ]; then
    /usr/bin/swiftc -O "$SHARED/ax-prompt.swift" -o "$PROMPT" 2>&1
  fi
fi

{
  echo "=== at $(date -u +%FT%TZ) uid=$(id -u) user=$(id -un)"
  echo "--- 1. accessibility (a dialog should appear now):"
  if [ -x "$PROMPT" ]; then
    "$PROMPT" ask 2>&1
  else
    echo "could not build ax-prompt"
  fi
  echo "--- 2. automation -> System Events (a dialog should appear now):"
  /usr/bin/osascript -e 'tell application "System Events" to count processes' 2>&1
  echo "=== done"
} >> "$LOG" 2>&1

cat "$LOG"
