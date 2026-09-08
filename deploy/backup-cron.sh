#!/usr/bin/env sh
# Takes a backup on a schedule and keeps a bounded number of them.
#
# backup.sh takes one dump when somebody runs it. That is the mechanism, not the
# protection: a backup nobody takes is exactly as useful as one nobody restores.
# This is the loop that runs it, prunes what has aged out, and says loudly when
# a run fails — because the failure mode being guarded against is not "the
# backup was lost" but "nobody noticed it stopped running four months ago".
#
# Deliberately a shell loop rather than a cron daemon: the container this runs
# in has one job, cron's log goes somewhere nobody reads, and a supervised
# process that exits is visible to whatever restarts it.
set -eu

: "${MEMOAR_BACKUP_URL:?MEMOAR_BACKUP_URL is required (the migration connection, not the runtime one)}"
BACKUP_DIR=${MEMOAR_BACKUP_DIR:-/backups}
INTERVAL_SECONDS=${MEMOAR_BACKUP_INTERVAL_SECONDS:-86400}
KEEP=${MEMOAR_BACKUP_KEEP:-14}

log() {
  # One JSON object per line, like the API's log, so both can be read the same way.
  printf '{"time":"%s","level":"%s","event":"backup","message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
}

prune() {
  # Newest first, drop everything past the limit. Counting dumps rather than
  # days, so a stretch where backups failed does not silently delete the last
  # good copies as they age past a date.
  ls -1t "$BACKUP_DIR"/memoar-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" "$old.sha256"
    log info "pruned $(basename "$old")"
  done
}

log info "starting: every ${INTERVAL_SECONDS}s, keeping ${KEEP}"
while true; do
  label=$(date -u +%Y%m%dT%H%M%SZ)
  if output=$(sh /backup.sh --url "$MEMOAR_BACKUP_URL" --out "$BACKUP_DIR" --label "$label" 2>&1); then
    log info "wrote $output"
    # Written only after a dump succeeded, so its age is the age of the last
    # backup that actually exists rather than of the last attempt. backup-check.sh
    # reads this; see docs/backup.md.
    date -u +%s > "$BACKUP_DIR/last-success"
    prune
  else
    # Not fatal: the next run may well succeed, and exiting here would mean one
    # bad night ends all future backups. It is loud, and it leaves last-success
    # untouched, which is what makes a run of failures visible.
    log error "failed: $(echo "$output" | tr '\n' ' ')"
  fi
  sleep "$INTERVAL_SECONDS"
done
