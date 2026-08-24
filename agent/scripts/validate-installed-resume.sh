#!/bin/sh
set -eu

claude_bin=/opt/homebrew/bin/claude
codex_bin=/opt/homebrew/bin/codex
antigravity_bin=/Users/frane/.local/bin/agy
claude_version=2.1.224
codex_version=0.147.0
antigravity_version=1.1.6

usage() {
  echo "usage: validate-installed-resume.sh claude-code|codex|antigravity-cli UUIDV7" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
target=$1
session_id=$2
case "$session_id" in
  ????????-????-7???-[89aAbB]???-????????????) ;;
  *) echo "memoar resume gate: session ID must be an explicit UUIDv7" >&2; exit 2 ;;
esac

case "$target" in
  claude-code) binary=$claude_bin; expected=$claude_version ;;
  codex) binary=$codex_bin; expected=$codex_version ;;
  antigravity-cli) binary=$antigravity_bin; expected=$antigravity_version ;;
  *) usage ;;
esac

if [ ! -x "$binary" ]; then
  echo "memoar resume gate: SKIP installed binary unavailable at $binary" >&2
  exit 77
fi
actual=$($binary --version 2>&1)
case "$actual" in
  *"$expected"*) ;;
  *)
    echo "memoar resume gate: installed $target version drift: expected $expected, got $actual" >&2
    exit 1
    ;;
esac

case "$target" in
  claude-code) set -- "$binary" -r "$session_id" --print smoke ;;
  codex) set -- "$binary" exec resume "$session_id" smoke --all --json --skip-git-repo-check ;;
  antigravity-cli) set -- "$binary" --conversation "$session_id" --print smoke ;;
esac

if [ "${MEMOAR_VALIDATE_ONLY:-0}" = 1 ]; then
  printf 'validated %s %s; bounded command:' "$target" "$actual"
  printf ' %s' "$@"
  printf '\n'
  exit 0
fi

if [ "${MEMOAR_ALLOW_RESUME:-0}" != 1 ]; then
  echo "memoar resume gate: validated path/version; set MEMOAR_ALLOW_RESUME=1 only after provisioning a unique no-clobber fixture" >&2
  exit 77
fi
receipt=${MEMOAR_RESUME_FIXTURE_RECEIPT:-}
if [ -z "$receipt" ] || [ ! -f "$receipt" ]; then
  echo "memoar resume gate: MEMOAR_RESUME_FIXTURE_RECEIPT must name the recovery receipt" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "memoar resume gate: jq is required to validate the recovery receipt" >&2
  exit 1
fi
jq -e --arg target "$target" --arg session "$session_id" '
  .target == $target and
  .sessionId == $session and
  (.createdPaths | type == "array" and length > 0) and
  (.recoveryDirectory | type == "string" and length > 0)
' "$receipt" >/dev/null

seconds=${MEMOAR_RESUME_TIMEOUT_SECONDS:-90}
case "$seconds" in
  *[!0-9]*|'') echo "memoar resume gate: timeout must be an integer" >&2; exit 2 ;;
esac
if command -v timeout >/dev/null 2>&1; then
  timeout "$seconds" "$@"
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout "$seconds" "$@"
elif command -v perl >/dev/null 2>&1; then
  perl -e '$seconds = shift @ARGV; $SIG{ALRM} = sub { exit 124 }; alarm $seconds; exec @ARGV' "$seconds" "$@"
else
  echo "memoar resume gate: no bounded command runner (timeout, gtimeout, or perl)" >&2
  exit 1
fi
