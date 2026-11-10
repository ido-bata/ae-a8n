#!/bin/sh
# Checks whether the Accessibility and Automation permissions are in place,
# in the session this runs in. Run it in the test user's Terminal, after
# ax-grant.command.
#
# It asks nothing: AXIsProcessTrusted() without the prompt option reports
# the current state and never raises a dialog.
#
# Like ax-grant.command, it reads and compiles a helper from /Users/Shared,
# which is world-writable. The source and its pinned hash are checked before
# anything is compiled or run:
#
#   - neither may be a symlink;
#   - each must be a regular file owned by root or by the user running this
#     script (a file owned by a third party is refused);
#   - neither may be writable by group or others;
#   - the source must match scripts/isolated-session/ax-prompt.swift.sha256.
#
# Any failure prints a refusal and exits non-zero without executing anything.
# The helper is always compiled into a private temporary directory; an
# already-present $SHARED/ax-prompt binary is never executed.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || {
  echo "refusing to run: the directory this script lives in could not be read" >&2
  exit 1
}
SHARED=${A8N_AX_SHARED:-/Users/Shared/ae-a8n/run}
SWIFTC=${A8N_AX_SWIFTC:-/usr/bin/swiftc}
# One log per user, for the same reason as ax-grant.command: a file in the
# shared sticky directory belongs to whoever made it first.
LOG=$SHARED/ax-grant.$(id -u).log

refuse() {
  echo "refusing to run ax-grant-all: $*" >&2
  echo "No helper was compiled or executed." >&2
  exit 1
}

find_asset() {
  for dir in "$HERE" "$SHARED"; do
    if [ -e "$dir/$1" ] || [ -L "$dir/$1" ]; then
      echo "$dir/$1"
      return 0
    fi
  done
  return 1
}

check_owned_and_not_writable() {
  path=$1
  label=$2
  if [ -L "$path" ]; then
    refuse "$label is a symlink ($path); a symlink can point at any file"
  fi
  if [ ! -f "$path" ]; then
    refuse "$label is not a regular file ($path)"
  fi
  owner=$(/usr/bin/stat -f '%u' "$path" 2>/dev/null) ||
    refuse "the owner of $label ($path) could not be read"
  case "$owner" in
    "$(id -u)" | 0) ;;
    *) refuse "$label ($path) is owned by uid $owner; it must be owned by root or by uid $(id -u)" ;;
  esac
  mode=$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null) ||
    refuse "the mode of $label ($path) could not be read"
  if [ $((0$mode & 022)) -ne 0 ]; then
    refuse "$label ($path) is writable by group or others (mode $mode)"
  fi
}

SOURCE_PATH=$(find_asset ax-prompt.swift) ||
  refuse "ax-prompt.swift was not found in $HERE or $SHARED"
HASH_PATH=$(find_asset ax-prompt.swift.sha256) ||
  refuse "ax-prompt.swift.sha256 (the pinned hash) was not found in $HERE or $SHARED"

check_owned_and_not_writable "$SOURCE_PATH" "the ax-prompt source"
check_owned_and_not_writable "$HASH_PATH" "the ax-prompt hash file"

expected=$(/usr/bin/awk 'NF >= 1 && $1 !~ /^#/ { print tolower($1); exit }' "$HASH_PATH") ||
  refuse "the pinned hash in $HASH_PATH could not be read"
case "$expected" in
  *[!0-9a-f]*) refuse "the pinned hash in $HASH_PATH is not a lowercase SHA-256 value" ;;
esac
[ ${#expected} -eq 64 ] || refuse "the pinned hash in $HASH_PATH is not a SHA-256 value"
actual=$(/usr/bin/shasum -a 256 "$SOURCE_PATH" | /usr/bin/awk '{ print tolower($1) }') ||
  refuse "the SHA-256 of $SOURCE_PATH could not be computed"
[ "$actual" = "$expected" ] ||
  refuse "the ax-prompt source ($SOURCE_PATH) does not match the pinned SHA-256 (expected $expected, got $actual)"

BUILD_DIR=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/a8n-ax-grant-all.XXXXXX") ||
  refuse "a private build directory could not be created"
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM
PROMPT=$BUILD_DIR/ax-prompt
if ! "$SWIFTC" -O "$SOURCE_PATH" -o "$PROMPT" >"$BUILD_DIR/build.log" 2>&1; then
  cat "$BUILD_DIR/build.log" >&2
  refuse "the verified ax-prompt source could not be compiled"
fi
[ -x "$PROMPT" ] || refuse "the compiler produced no executable at $PROMPT"

{
  echo "=== at $(date -u +%FT%TZ) uid=$(id -u) user=$(id -un)"
  echo "--- accessibility:"
  "$PROMPT" status 2>&1
  echo "--- automation -> System Events:"
  /usr/bin/osascript -e 'tell application "System Events" to count processes' 2>&1
  echo "=== done"
} >> "$LOG" 2>&1

cat "$LOG"
