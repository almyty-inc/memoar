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
if ! command -v curl >/dev/null 2>&1; then
  echo "memoar e2e: curl is required" >&2
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

# The standing instructions the fixture machine's agents read, planted here
# beside the transcript because there is exactly one `memoar sync` in this
# script and both fixtures have to exist before it runs. A second sync would
# re-read the file `memoar convert --here` materializes further down and
# archive it as another session, whose workspace is the flattened path of the
# first — which grows by a whole path on every run until the filesystem refuses
# the name.
#
# Written to trip the secret scanner on purpose. `requireReviewed` refuses only
# a document whose status is `findings`; a clean file converts with no review
# at all, and the refusal asserted below would then be asserting nothing.
memory_file="$capture_home/.claude/CLAUDE.md"
ported_file="$capture_home/.codex/AGENTS.md"
mkdir -p "$(dirname "$memory_file")"
cat > "$memory_file" <<'MEMORY_FIXTURE'
# Standing instructions for the compose e2e

Credentials do not belong in this file. The staging key is
sk-e2e-not-a-real-credential-0000 and it lives in the vault.
MEMORY_FIXTURE

# Says what went wrong and then shows it. Every assertion below reaches this
# with a sentence naming the thing that did not hold, followed by whatever the
# archive or the CLI actually said — a bare exit code is not a test result.
fail() {
  printf 'memoar e2e: %s\n' "$1" >&2
  shift
  for detail in "$@"; do
    printf '%s\n' "$detail" >&2
  done
  exit 1
}

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

# The same call, kept alive past a non-zero exit, for the one assertion whose
# subject is the refusal.
#
# `memoar` above forwards stdout only when the command succeeded, which is
# right for every command whose success is the point. Here the failure is the
# point, and the JSON error envelope on stdout is the only thing that says
# which refusal it was: an assertion on the exit code alone would pass just as
# happily if the archive had been unreachable.
refusal_status=0
refusal_output=
memoar_refused() {
  refusal_status=0
  refusal_output=$("$binary" --json \
    --config-dir "$config_dir" \
    --data-dir "$data_dir" \
    --capture-home "$capture_home" \
    "$@") || refusal_status=$?
}

# `GET /memory` and `POST /memory/{documentId}/redaction-reviews` have no CLI
# command, and should not: the agent captures these files and converts them,
# while the review is a person reading the file in the web client and saying it
# may go out. This script stands in for that person, so it calls the two
# endpoints itself with the capture key `memoar login` has just stored.
#
# The status is kept apart from the body rather than folded into a curl exit
# code, because the body is an RFC 9457 problem document and is the only thing
# that says what the archive objected to.
archive_status=
archive_body=

archive_get() {
  archive_status=$(curl -sS -o "$scratch/http-body" -w '%{http_code}' \
    -H "x-memoar-key: $api_key" "$endpoint$1")
  archive_body=$(cat "$scratch/http-body")
}

archive_post() {
  archive_status=$(curl -sS -o "$scratch/http-body" -w '%{http_code}' \
    -X POST \
    -H "x-memoar-key: $api_key" \
    -H 'content-type: application/json' \
    --data "$2" "$endpoint$1")
  archive_body=$(cat "$scratch/http-body")
}

login=$(memoar login --endpoint "$endpoint" --email "$email" --password "$password")
printf '%s' "$login" | jq -e '.ok == true and .data.initialized == true' >/dev/null
# This run's machine, registered fresh because the config directory is. Every
# memory call below is narrowed to it: the archive outlives the run, a global
# conversion selects every document the source tool reads, and without the
# filter a second run against the same stack ports its own instruction file
# concatenated with the previous run's.
machine_id=$(printf '%s' "$login" | jq -r '.data.machineId // empty')
[ -n "$machine_id" ] \
  || fail "\`memoar login\` reported no machine id" "$login"
sync_result=$(memoar sync)
printf '%s' "$sync_result" | jq -e '.ok == true and .data.sync.considered >= 1' >/dev/null
printf '%s' "$sync_result" | jq -e '.data.memory.found >= 1 and .data.memory.uploaded >= 1' >/dev/null \
  || fail "\`memoar sync\` did not capture the planted memory file at $memory_file" "$sync_result"

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

# --- Porting the standing instructions between dialects ----------------------
#
# The half of `memoar memory convert --here` that no unit test reaches: the
# HTTP round trip through ApiClient to a live archive, and the redaction gate
# on the far side of it. The materializer's own tests run off a committed
# bundle fixture, so they can say where bytes land but not whether the archive
# would ever have handed those bytes over.
#
# The refusal is asserted first and deliberately. A memory file the scanner
# flagged must not become a second copy of somebody's key on another machine,
# and a flow that only ever walks the happy path would stay green with the gate
# deleted.
api_key=$(jq -r '.apiKey // empty' "$config_dir/credentials.json")
[ -n "$api_key" ] \
  || fail "\`memoar login\` stored no API key in $config_dir/credentials.json"

# The document id and the content hash come from the archive's own listing,
# which is where the web client gets them too: a review is of one version of
# one file, and the hash is what says which version was read.
archive_get "/memory?scope=global&machineId=$machine_id"
[ "$archive_status" = "200" ] \
  || fail "GET /memory answered HTTP $archive_status" "$archive_body"
document=$(printf '%s' "$archive_body" \
  | jq -c --arg path "$memory_file" 'first(.items[] | select(.path == $path)) // empty')
[ -n "$document" ] \
  || fail "the archive holds no memory document for $memory_file" "$archive_body"
printf '%s' "$document" | jq -e '.redactionStatus == "findings" and (.redactionFindings | length) >= 1' >/dev/null \
  || fail "the planted memory file was not flagged by the secret scanner, so the refusal below would prove nothing" "$document"
document_id=$(printf '%s' "$document" | jq -r '.id')
content_hash=$(printf '%s' "$document" | jq -r '.contentHash')

# Unreviewed: refused, and nothing written.
memoar_refused memory convert --source claude-code --target codex --scope global \
  --machine-id "$machine_id" --here
[ "$refusal_status" -ne 0 ] \
  || fail "\`memoar memory convert --here\` ported an unreviewed memory file: the redaction-review gate did not hold" "$refusal_output"
printf '%s' "$refusal_output" | jq -e '.error.message | test("HTTP 409")' >/dev/null \
  || fail "the unreviewed conversion failed for some reason other than the review gate" "$refusal_output"
[ ! -e "$ported_file" ] \
  || fail "the refused conversion still left a file at $ported_file"

archive_post "/memory/$document_id/redaction-reviews" \
  "$(jq -n --arg hash "$content_hash" '{contentHash: $hash}')"
[ "$archive_status" = "200" ] \
  || fail "POST /memory/$document_id/redaction-reviews answered HTTP $archive_status" "$archive_body"
printf '%s' "$archive_body" | jq -e '.redactionStatus == "reviewed"' >/dev/null \
  || fail "the review did not clear $memory_file for egress" "$archive_body"

# Reviewed: ported to the path Codex reads, byte for byte. One source document
# means no concatenation and therefore no source note, so the two files are
# comparable with `cmp` rather than by eye.
conversion=$(memoar memory convert --source claude-code --target codex --scope global \
  --machine-id "$machine_id" --here)
printf '%s' "$conversion" | jq -e --arg path "$ported_file" \
  '.ok == true
     and .data.result.report.documents == 1
     and .data.result.report.concatenated == false
     and ((.data.result.written // []) | index($path)) != null' >/dev/null \
  || fail "\`memoar memory convert --here\` did not report writing $ported_file" "$conversion"
[ -f "$ported_file" ] \
  || fail "\`memoar memory convert --here\` reported success but there is no file at $ported_file" "$conversion"
cmp -s "$memory_file" "$ported_file" \
  || fail "the ported file at $ported_file is not the bytes of $memory_file" "$(diff -u "$memory_file" "$ported_file" || true)"

printf 'memoar compiled-agent Compose e2e passed for session %s\n' "$session_id"
printf 'memoar memory convert --here ported %s to %s\n' "$memory_file" "$ported_file"
