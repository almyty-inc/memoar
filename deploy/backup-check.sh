#!/usr/bin/env sh
# Says whether a recent backup exists, as an exit code.
#
# The dangerous failure is not a lost backup; it is a backup that quietly
# stopped running months ago and nobody noticed, because everything else looks
# exactly the same either way. So this is a thing that can be run from a cron
# entry, a health check or a monitoring probe and that fails loudly.
#
#   exit 0  a dump succeeded within the window
#   exit 1  no dump has succeeded within the window, or none ever has
set -eu

BACKUP_DIR=${MEMOAR_BACKUP_DIR:-/backups}
# A day and a half by default, so a daily schedule that slips by an hour does
# not cry wolf and a schedule that stopped is caught on the second night.
MAX_AGE_SECONDS=${MEMOAR_BACKUP_MAX_AGE_SECONDS:-129600}

stamp="$BACKUP_DIR/last-success"
if [ ! -f "$stamp" ]; then
  echo "backup-check: no successful backup has ever been recorded in $BACKUP_DIR" >&2
  exit 1
fi

last=$(cat "$stamp")
now=$(date -u +%s)
age=$((now - last))

if [ "$age" -gt "$MAX_AGE_SECONDS" ]; then
  echo "backup-check: the last successful backup was ${age}s ago, which is older than ${MAX_AGE_SECONDS}s" >&2
  exit 1
fi

printf '{"lastSuccessSecondsAgo":%s,"maxAgeSeconds":%s}\n' "$age" "$MAX_AGE_SECONDS"
