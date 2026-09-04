#!/usr/bin/env sh
# Restores an archive from a dump taken by backup.sh.
#
# Refuses to run against a database that already holds sessions unless told to
# replace them, because the common way to lose an archive is to restore an old
# copy over a working one.
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: restore.sh --url <postgres-url> --dump <file> [--replace]

  --url      connection string with rights to create every object. The
             migration role, not the runtime role.
  --dump     dump file written by backup.sh. Its .sha256 sidecar is verified
             when present.
  --replace  restore over a database that already has sessions in it. Without
             this, a non-empty archive is left alone.
USAGE
  exit 2
}

url=""
dump=""
replace="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:-}"; shift 2 ;;
    --dump) dump="${2:-}"; shift 2 ;;
    --replace) replace="yes"; shift ;;
    -h|--help) usage ;;
    *) echo "restore.sh: unexpected argument $1" >&2; usage ;;
  esac
done

[ -n "$url" ] || { echo "restore.sh: --url is required" >&2; usage; }
[ -n "$dump" ] || { echo "restore.sh: --dump is required" >&2; usage; }
[ -f "$dump" ] || { echo "restore.sh: no such dump: $dump" >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "restore.sh: pg_restore is not installed" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "restore.sh: psql is not installed" >&2; exit 1; }

# A damaged file must fail before it touches anything, not halfway through.
if [ -f "$dump.sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$dump" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$dump" | awk '{print $1}')
  fi
  expected=$(cat "$dump.sha256")
  if [ "$actual" != "$expected" ]; then
    echo "restore.sh: dump does not match its checksum; refusing to restore" >&2
    exit 1
  fi
fi

existing=$(psql "$url" -tAc "SELECT count(*) FROM sessions" 2>/dev/null || echo 0)
if [ "$existing" -gt 0 ] && [ "$replace" != "yes" ]; then
  echo "restore.sh: this database already holds $existing sessions; pass --replace to overwrite them" >&2
  exit 1
fi

# --clean --if-exists so a replace is a replace, and one transaction so a
# failure leaves the archive as it was rather than half-written.
pg_restore --dbname="$url" --no-owner --no-privileges --clean --if-exists --single-transaction "$dump"

restored=$(psql "$url" -tAc "SELECT count(*) FROM sessions")
turns=$(psql "$url" -tAc "SELECT count(*) FROM turns")
printf '{"sessions":%s,"turns":%s}\n' "$restored" "$turns"
