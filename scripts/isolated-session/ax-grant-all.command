#!/bin/sh
# Checks whether the Accessibility and Automation permissions are in place,
# in the session this runs in. Run it in the test user's Terminal, after
# ax-grant.command.
#
# It asks nothing: AXIsProcessTrusted() without the prompt option reports
# the current state and never raises a dialog.
set -u

HERE=$(dirname "$0")
SHARED=/Users/Shared/ae-a8n/run
LOG=$SHARED/ax-grant.log
PROMPT=$SHARED/ax-prompt

if [ ! -x "$PROMPT" ]; then
  if [ -r "$HERE/ax-prompt.swift" ]; then
    /usr/bin/swiftc -O "$HERE/ax-prompt.swift" -o "$PROMPT" 2>&1
  elif [ -r "$SHARED/ax-prompt.swift" ]; then
    /usr/bin/swiftc -O "$SHARED/ax-prompt.swift" -o "$PROMPT" 2>&1
  fi
fi

{
  echo "=== at $(date -u +%FT%TZ) uid=$(id -u) user=$(id -un)"
  echo "--- accessibility:"
  if [ -x "$PROMPT" ]; then
    "$PROMPT" status 2>&1
  else
    echo "could not build ax-prompt"
  fi
  echo "--- automation -> System Events:"
  /usr/bin/osascript -e 'tell application "System Events" to count processes' 2>&1
  echo "=== done"
} >> "$LOG" 2>&1

cat "$LOG"
