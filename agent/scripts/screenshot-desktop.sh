#!/usr/bin/env bash
# Screenshots the desktop application's two screens, light and dark, on the
# desktop this runs on.
#
#   agent/scripts/screenshot-desktop.sh [out-dir]
#
# Writes <os>-<screen>-<appearance>.png into out-dir (default:
# agent/dist/screenshots): sign-in with an empty form, and status after
# signing in to the stand-in archive (examples/stub_archive.rs) and capturing
# one Claude Code session. Every run gets scratch directories of its own,
# window state included, so nothing touches a real ~/.config/memoar or an
# installed app's state.
#
# macOS captures the window with screencapture (the runner needs screen
# recording, which GitHub's macOS runners allow). Linux needs an X display:
# run it under xvfb-run, with ImageMagick's `import` on PATH. Windows captures
# the window's rectangle with agent/scripts/screenshot-window.ps1.
set -euo pipefail

. "$(dirname -- "$0")/desktop-nsh.sh"

target=$(host_target)
out_dir=${1:-"$desktop_dir/../../dist/screenshots"}
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)
scripts_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=${CARGO_TARGET_DIR:-"$desktop_dir/target"}
suffix=$(exe_suffix)
stub_address=127.0.0.1:47614
endpoint="http://$stub_address/v1"
export MEMOAR_MIN_FREE_BYTES=0

cd "$desktop_dir"
cargo build --locked --bin memoar-desktop --example stub_archive --example headless

scratch=$(mktemp -d "${TMPDIR:-/tmp}/memoar-desktop-shots.XXXXXX")
stub_pid=
app_pid=
cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; fi
  if [ -n "$stub_pid" ]; then kill "$stub_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT HUP INT TERM

"$target_dir/debug/examples/stub_archive$suffix" "$stub_address" >"$scratch/stub.log" 2>&1 &
stub_pid=$!
for _ in $(seq 1 50); do
  if grep -q listening "$scratch/stub.log" 2>/dev/null; then break; fi
  sleep 0.2
done

# The window of process $1 into $2.
capture() {
  case "$target" in
    macos)
      local id=
      for _ in $(seq 1 10); do
        id=$(swift "$scripts_dir/window-id.swift" "$1" 2>/dev/null || true)
        if [ -n "$id" ] && screencapture -x -o -l "$id" "$2"; then return; fi
        sleep 1
      done
      echo "memoar desktop: no window to capture" >&2
      return 1
      ;;
    linux) import -window root "$2" ;;
    windows)
      powershell.exe -NoProfile -ExecutionPolicy Bypass \
        -File "$(native_path "$scripts_dir/screenshot-window.ps1")" \
        -ProcessId "$(cat /proc/$1/winpid 2>/dev/null || echo "$1")" -Path "$(native_path "$2")"
      ;;
  esac
}

for screen in sign-in status; do
  for appearance in light dark; do
    run="$scratch/$screen-$appearance"
    mkdir -p "$run/config" "$run/data" "$run/home" "$run/state"
    if [ "$screen" = status ]; then
      session="$run/home/.claude/projects/-memoar-desktop-shots"
      mkdir -p "$session"
      printf '{"type":"user","message":{"role":"user","content":"screenshot"}}\n' \
        >"$session/0198d8d0-977c-777b-9f8f-0f6d8416eb02.jsonl"
      "$target_dir/debug/examples/headless$suffix" "$(native_path "$run")" "$endpoint" \
        person@example.com "correct horse battery staple" >"$run/headless.log"
    fi
    MEMOAR_CONFIG_DIR=$(native_path "$run/config") \
      MEMOAR_DATA_DIR=$(native_path "$run/data") \
      MEMOAR_CAPTURE_HOME=$(native_path "$run/home") \
      MEMOAR_DESKTOP_STATE_DIR=$(native_path "$run/state") \
      MEMOAR_APPEARANCE=$appearance \
      "$target_dir/debug/memoar-desktop$suffix" >"$run/app.log" 2>&1 &
    app_pid=$!
    # Long enough for the window to open and, on status, the first capture.
    sleep 8
    shot="$out_dir/$target-$screen-$appearance.png"
    capture "$app_pid" "$shot"
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
    app_pid=
    echo "$(native_path "$shot")"
  done
done
