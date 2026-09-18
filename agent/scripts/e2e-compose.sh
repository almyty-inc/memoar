#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
binary=${MEMOAR_E2E_BINARY:-"$repo_root/agent/target/debug/memoar"}
endpoint=${MEMOAR_E2E_ENDPOINT:-http://127.0.0.1:4000/v1}
email=${MEMOAR_E2E_EMAIL:-owner@memoar.local}
password=${MEMOAR_E2E_PASSWORD:-local-stack-password-change-me}

if [ ! -x "$binary" ]; then
  echo "memoar e2e: binary is missing or not executable: $binary" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "memoar e2e: jq is required" >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/memoar-agent-e2e.XXXXXX")
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM
config_dir="$scratch/config"
data_dir="$scratch/data"
capture_home="$scratch/fixture-home"
native_id=0198d8d0-977c-777b-9f8f-0f6d8416ea01
session_file="$capture_home/.claude/projects/-memoar-e2e/$native_id.jsonl"
mkdir -p "$(dirname "$session_file")"
printf '%s\n' '{"uuid":"0198d8d0-977c-777b-9f8f-0f6d8416ea02","parentUuid":null,"sessionId":"0198d8d0-977c-777b-9f8f-0f6d8416ea01","type":"user","message":{"role":"user","content":[{"type":"text","text":"memoar-compose-agent-e2e-marker"}]},"timestamp":"2026-08-18T00:00:00Z","cwd":"/memoar/e2e"}' > "$session_file"

# Every call here is captured into a variable, so a failing command's own
# explanation goes into that variable and never reaches the log: `set -e` then
# ends the run with an exit code and nothing else. A whole CI job reported
# "exit code 4" and not one word about a scope the archive had refused.
memoar() {
  output=$("$binary" --json \
    --config-dir "$config_dir" \
    --data-dir "$data_dir" \
    --capture-home "$capture_home" \
    "$@") || {
    status=$?
    echo "memoar e2e: \`memoar $*\` exited $status" >&2
    printf '%s\n' "$output" >&2
    return "$status"
  }
  printf '%s' "$output"
}

login=$(memoar login --endpoint "$endpoint" --email "$email" --password "$password")
printf '%s' "$login" | jq -e '.ok == true and .data.initialized == true' >/dev/null
sync_result=$(memoar sync)
printf '%s' "$sync_result" | jq -e '.ok == true and .data.sync.considered >= 1' >/dev/null

session_id=
attempt=0
while [ "$attempt" -lt 30 ]; do
  search=$(memoar search memoar-compose-agent-e2e-marker --mode lexical --limit 5)
  session_id=$(printf '%s' "$search" | jq -r '.data.items[0].sessionId // .data.items[0].id // empty')
  [ -n "$session_id" ] && break
  attempt=$((attempt + 1))
  sleep 1
done
if [ -z "$session_id" ]; then
  echo "memoar e2e: ingested session did not become searchable" >&2
  exit 1
fi

memoar view "$session_id" | jq -e '.ok == true' >/dev/null
memoar pack memoar-compose-agent-e2e-marker --max-tokens 1200 | jq -e '.ok == true' >/dev/null
memoar convert "$session_id" --target claude-code --fallback fail --here --wait-seconds 30 \
  | jq -e '.ok == true and (.data.written | length) >= 1' >/dev/null
memoar doctor | jq -e '.ok == true and .data.ok == true' >/dev/null
printf 'memoar compiled-agent Compose e2e passed for session %s\n' "$session_id"
