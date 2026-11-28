#!/usr/bin/env bash
# RC-S1 consecutive-success runner (run 4).
# Runs s1-happy.mjs attempts until PASS_STREAK consecutive `pass` verdicts
# or MAX_ATTEMPTS total attempts, whichever first. After EVERY attempt,
# recover-leftover.mjs sweeps for modal-blocked/spawned leftovers through
# the public terminate path (#458) — never SIGKILL, never dialog input.
# Each invocation is a NEW ledgered attempt (spec §5.2 retry rule).
set -uo pipefail

CONSUMER=/tmp/rc436r4-consumer
RC_DIR=/Users/rebui/work/ae-a8n.436-r4/docs/evidence/release-0-7-0-rc-r4
export RC_DIR
PASS_STREAK=10
MAX_ATTEMPTS=${MAX_ATTEMPTS:-25}
START_AT=${START_AT:-1}

streak=0
attempt=$((START_AT-1))
while [ "$attempt" -lt "$MAX_ATTEMPTS" ] && [ "$streak" -lt "$PASS_STREAK" ]; do
  attempt=$((attempt+1))
  label=$(printf "r4-s1-%02d" "$attempt")
  echo "=== $label (streak=$streak) $(date '+%H:%M:%S') ==="
  (cd "$CONSUMER" && node harness/s1-happy.mjs "$label")
  rc=$?
  # Always sweep for leftovers before the next attempt.
  (cd "$CONSUMER" && node harness/recover-leftover.mjs --label "$label")
  if [ "$rc" -eq 0 ]; then
    streak=$((streak+1))
  else
    streak=0
  fi
  echo "--- $label rc=$rc streak=$streak $(date '+%H:%M:%S') ---"
done
echo "S1 streak result: streak=$streak attempts=$attempt"
[ "$streak" -ge "$PASS_STREAK" ]
