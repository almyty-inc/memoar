#!/bin/sh
# Installs, inspects and removes a real background service on macOS (launchd)
# or Linux (systemd --user), for a scratch configuration under a unique name.
#
#   agent/scripts/service-smoke.sh /path/to/memoar
#
# It never touches the default configuration: every command names scratch
# --config-dir, --data-dir and --capture-home directories, and the service is
# called smoke-<pid>, so it cannot collide with a real install.
#
# What it proves, against the real service manager:
#   1. install starts the service, and it writes its log in the data dir
#   2. a crashed watch is restarted by the service
#   3. a failure retrying cannot fix (here: signed out, exit 3) stops the
#      service, `service status` names the reason, and nothing restarts it
#   4. uninstall stops it and removes the definition
set -eu

memoar=${1:?usage: service-smoke.sh /path/to/memoar}
root=$(mktemp -d "${TMPDIR:-/tmp}/memoar-service-smoke.XXXXXX")
name="smoke-$$"

m() {
  "$memoar" --json "$@" --config-dir "$root/config" --data-dir "$root/data" \
    --capture-home "$root/home"
}

fail() {
  echo "service-smoke: FAIL: $*" >&2
  echo "--- service status" >&2
  m service status --name "$name" >&2 || true
  echo "--- agent.log" >&2
  cat "$root/data/logs/agent.log" >&2 || true
  exit 1
}

cleanup() {
  m service uninstall --name "$name" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

field() {
  # The first value of a key in compact JSON, without needing jq.
  printf '%s' "$2" | tr -d ' \n' | tr ',' '\n' \
    | sed -n "s/.*\"$1\":\\([^}]*\\).*/\\1/p" | head -n 1
}

status_field() {
  field "$1" "$(m service status --name "$name")"
}

child_pid() {
  field childPid "$(cat "$root/data/service-state.json")"
}

wait_for() {
  # wait_for <seconds> <key> <value>: poll `service status` until it matches.
  waited=0
  while [ "$waited" -lt "$1" ]; do
    [ "$(status_field "$2")" = "$3" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# A signed-in configuration pointed at an address nothing listens on, so the
# watch runs and retries without reaching anything. The token is not a secret.
mkdir -p "$root/config" "$root/home"
cat >"$root/config/config.json" <<'JSON'
{"contractVersion":"0.3.0","endpoint":"http://127.0.0.1:9/v1","machineId":"00000000-0000-7000-8000-000000000001","installationId":"","disabledSources":[]}
JSON
cat >"$root/config/credentials.json" <<'JSON'
{"accessToken":"service-smoke-placeholder"}
JSON

echo "service-smoke: installing $name"
installed=$(m service install --name "$name") || fail "install: $installed"
echo "$installed"
[ "$(field installed "$installed")" = "true" ] || fail "install did not report installed"

case "$(uname -s)" in
  Darwin) definition="$HOME/Library/LaunchAgents/dev.memoar.$name.plist" ;;
  *) definition="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/memoar-$name.service" ;;
esac
[ -f "$definition" ] || fail "no definition at $definition"

wait_for 30 running true || fail "the service did not start"
sleep 4
grep -q "service: $name started" "$root/data/logs/agent.log" || fail "no start line in the log"
echo "service-smoke: running"

# A crash: the watch is killed, and the service starts it again.
first=$(child_pid)
[ -n "$first" ] && [ "$first" != "null" ] || fail "no watch process recorded"
kill -9 "$first"
waited=0
second=$first
while [ "$waited" -lt 40 ]; do
  second=$(child_pid)
  if [ -n "$second" ] && [ "$second" != "null" ] && [ "$second" != "$first" ]; then break; fi
  sleep 2
  waited=$((waited + 2))
done
[ "$waited" -lt 40 ] || fail "the killed watch was not restarted"
echo "service-smoke: the watch was restarted after a crash ($first, then $second)"

# Signed out: the next watch exits 3, and the service must stop for good.
rm "$root/config/credentials.json"
kill -9 "$second"
wait_for 60 running false || fail "the service kept running signed out"
stopped=$(m service status --name "$name")
echo "$stopped"
[ "$(field state "$stopped")" = '"stopped"' ] || fail "backgroundCapture is not stopped"
printf '%s' "$stopped" | grep -q 'background capture stopped: Memoar is not initialized' \
  || fail "the reason is not named"

# And it stays stopped, for longer than launchd's throttle and systemd's RestartSec.
sleep 45
[ "$(status_field running)" = "false" ] || fail "the service was started again"
starts=$(grep -c "service: $name started" "$root/data/logs/agent.log")
[ "$starts" -eq 1 ] || fail "the service started $starts times"
echo "service-smoke: stopped and stayed stopped"

removed=$(m service uninstall --name "$name") || fail "uninstall: $removed"
echo "$removed"
[ "$(field removed "$removed")" = "true" ] || fail "uninstall did not remove it"
[ ! -f "$definition" ] || fail "the definition is still at $definition"
[ "$(status_field installed)" = "false" ] || fail "still installed after uninstall"
echo "service-smoke: OK"
