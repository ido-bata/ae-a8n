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
#
# Both this script and ax-grant-all.command read and compile a helper from
# /Users/Shared, which is world-writable. Before anything is compiled or run,
# the helper source and its pinned hash are checked:
#
#   - neither may be a symlink;
#   - each must be a regular file owned by root or by the user running this
#     script (a file owned by a third party is refused);
#   - neither may be writable by group or others (someone else could replace
#     it between the check and the compile);
#   - the source must match scripts/isolated-session/ax-prompt.swift.sha256.
#
# Any failure prints a refusal and exits non-zero without executing anything.
# The helper is always compiled into a private temporary directory; an
# already-present $SHARED/ax-prompt binary is never executed. Install both
# ax-prompt.swift and ax-prompt.swift.sha256 as root (or as the account that
# will run this) when copying them into /Users/Shared/ae-a8n/run.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || {
  echo "refusing to run: the directory this script lives in could not be read" >&2
  exit 1
}
SHARED=${A8N_AX_SHARED:-/Users/Shared/ae-a8n/run}
SWIFTC=${A8N_AX_SWIFTC:-/usr/bin/swiftc}
# One log per user: the shared directory is a sticky world-writable one, so a
# file another user already made cannot be appended to. Writing a log named
# after the uid means the run never depends on someone else's file mode — and
# a redirect that cannot be opened would silently skip the whole block,
# prompts included.
LOG=$SHARED/ax-grant.$(id -u).log

refuse() {
  echo "refusing to run ax-grant: $*" >&2
  echo "No helper was compiled or executed and no permission prompt was requested." >&2
  exit 1
}

# Locate one of the two files, preferring the directory this script was run
# from and falling back to the shared run directory.
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

# Build in a private directory owned by this user. Nothing in the shared
# directory is executed, so a pre-existing $(SHARED)/ax-prompt cannot be used.
BUILD_DIR=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/a8n-ax-grant.XXXXXX") ||
  refuse "a private build directory could not be created"
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM
PROMPT=$BUILD_DIR/ax-prompt
if ! "$SWIFTC" -O "$SOURCE_PATH" -o "$PROMPT" >"$BUILD_DIR/build.log" 2>&1; then
  cat "$BUILD_DIR/build.log" >&2
  refuse "the verified ax-prompt source could not be compiled"
fi
[ -x "$PROMPT" ] || refuse "the compiler produced no executable at $PROMPT"

mkdir -p "$SHARED" 2>/dev/null || true

{
  echo "=== at $(date -u +%FT%TZ) uid=$(id -u) user=$(id -un)"
  echo "--- 1. accessibility (a dialog should appear now):"
  "$PROMPT" ask 2>&1
  echo "--- 2. automation -> System Events (a dialog should appear now):"
  /usr/bin/osascript -e 'tell application "System Events" to count processes' 2>&1
  echo "=== done"
} >> "$LOG" 2>&1

cat "$LOG"
