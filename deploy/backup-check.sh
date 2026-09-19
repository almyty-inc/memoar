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

# How old the last success may be before this is a problem.
#
# Derived from the schedule rather than fixed beside it. A flat day and a half
# is only right while the schedule is daily, and it is wrong in both directions
# the moment somebody changes MEMOAR_BACKUP_INTERVAL_SECONDS — which is a
# supported thing to change, and the only one of the pair the compose stack
# exposes:
#
#   - Shortened to an hour, a fixed 36-hour window lets thirty-five consecutive
#     backups fail before anything says so. That is the direction that loses an
#     archive, and it is silent the whole way.
#   - Lengthened to a week, the window is permanently exceeded, the container
#     is unhealthy on a schedule that is working perfectly, and a signal that is
#     always red is a signal people stop reading — which puts us back where this
#     script was written to get us out of.
#
# One and a half intervals: enough slack for a run that starts late or takes a
# while, and short enough that a schedule which has stopped is caught on the
# next one rather than eventually. An explicit MEMOAR_BACKUP_MAX_AGE_SECONDS
# still wins, for a deployment that knows better.
INTERVAL_SECONDS=${MEMOAR_BACKUP_INTERVAL_SECONDS:-86400}
MAX_AGE_SECONDS=${MEMOAR_BACKUP_MAX_AGE_SECONDS:-$((INTERVAL_SECONDS + INTERVAL_SECONDS / 2))}

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
