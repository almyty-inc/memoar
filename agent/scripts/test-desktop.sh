#!/usr/bin/env bash
# Tests the desktop application: its Rust tests, then its window headless with
# `nsh test` against the stand-in archive (examples/stub_archive.rs).
#
#   agent/scripts/test-desktop.sh [--junit <file>]
#
# The app is pointed at scratch directories through the variables the CLI also
# reads, so neither run touches a real ~/.config/memoar. Runs on macOS, Linux
# and Windows (Git Bash, as GitHub's runners provide).
set -euo pipefail

. "$(dirname -- "$0")/desktop-nsh.sh"
ensure_nsh

# The address App.test.tsx signs in to.
stub_address=127.0.0.1:47613
target_dir=${CARGO_TARGET_DIR:-"$desktop_dir/target"}

cd "$desktop_dir"
cargo test --locked --all-targets
cargo build --locked --example stub_archive

scratch=$(mktemp -d "${TMPDIR:-/tmp}/memoar-desktop-test.XXXXXX")
stub_pid=
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$scratch/stub.log" ]; then
    echo "memoar desktop: what the stub archive was asked" >&2
    cat "$scratch/stub.log" >&2
  fi
  if [ -n "$stub_pid" ]; then kill "$stub_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT HUP INT TERM

session_dir="$scratch/home/.claude/projects/-memoar-desktop-test"
mkdir -p "$session_dir" "$scratch/config" "$scratch/data"
printf '{"type":"user","message":{"role":"user","content":"desktop test"}}\n' \
  >"$session_dir/0198d8d0-977c-777b-9f8f-0f6d8416eb01.jsonl"

"$target_dir/debug/examples/stub_archive$(exe_suffix)" "$stub_address" >"$scratch/stub.log" 2>&1 &
stub_pid=$!
for _ in $(seq 1 50); do
  if grep -q listening "$scratch/stub.log" 2>/dev/null; then break; fi
  sleep 0.2
done
if ! grep -q listening "$scratch/stub.log"; then
  echo "memoar desktop: the stub archive did not start" >&2
  cat "$scratch/stub.log" >&2
  exit 1
fi

MEMOAR_CONFIG_DIR=$(native_path "$scratch/config") \
  MEMOAR_DATA_DIR=$(native_path "$scratch/data") \
  MEMOAR_CAPTURE_HOME=$(native_path "$scratch/home") \
  nsh test "$@"
