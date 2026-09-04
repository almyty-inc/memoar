#!/usr/bin/env sh
# Takes a restorable copy of the archive.
#
# The archive is the product: everything else in this repository can be rebuilt
# from source, and the sessions cannot. Nothing here dumped the database until
# now, and a backup nobody has restored is a promise, not a copy — so this is
# paired with restore.sh and with a test that dumps, wipes and restores a real
# database and checks the sessions survived.
#
# Two things have to be kept, and only one of them is here:
#   - Postgres, which holds the canonical sessions, annotations and identities.
#   - The object store, which holds the raw captured bytes. Those are
#     content-addressed and immutable, so the right protection is versioning
#     and lifecycle rules on the bucket rather than a nightly copy; see
#     docs/backup.md.
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: backup.sh --url <postgres-url> --out <directory> [--label <name>]

  --url    connection string with rights to read every table. The migration
           role, not the runtime role: the runtime role is subject to row-level
           security and would silently dump nothing.
  --out    directory the dump is written to. Created if missing.
  --label  name for this dump; defaults to the current UTC timestamp.
USAGE
  exit 2
}

url=""
out=""
label=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "backup.sh: unexpected argument $1" >&2; usage ;;
  esac
done

[ -n "$url" ] || { echo "backup.sh: --url is required" >&2; usage; }
[ -n "$out" ] || { echo "backup.sh: --out is required" >&2; usage; }
[ -n "$label" ] || label="$(date -u +%Y%m%dT%H%M%SZ)"

command -v pg_dump >/dev/null 2>&1 || { echo "backup.sh: pg_dump is not installed" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "backup.sh: psql is not installed" >&2; exit 1; }

# A dump is only worth having if this server can read it back. pg_dump writes
# the settings of its own major version into the file — a v18 client emits
# `SET transaction_timeout`, which a v16 server rejects halfway through the
# restore — so a mismatched client produces a backup that looks perfect and
# cannot be restored. Better to refuse now than to find out during an outage.
server_major=$(psql "$url" -tAc "SHOW server_version_num" | cut -c1-2)
client_major=$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
if [ "$server_major" != "$client_major" ]; then
  echo "backup.sh: pg_dump is version $client_major but the server is version $server_major;" >&2
  echo "           a dump taken with a mismatched client may not restore into this server." >&2
  echo "           Run this with a version $server_major client — for a container deployment," >&2
  echo "           that is 'docker compose exec postgres' rather than the host's client." >&2
  exit 1
fi

mkdir -p "$out"
dump="$out/memoar-$label.dump"

# Custom format: compressed, and restorable selectively by pg_restore. --clean
# is deliberately absent — dropping objects belongs to the restore, where the
# operator has said which database they mean.
pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$url"

# A checksum beside the dump, so a restore can refuse a file that arrived
# damaged rather than half-restoring an archive.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$dump" | awk '{print $1}' > "$dump.sha256"
else
  shasum -a 256 "$dump" | awk '{print $1}' > "$dump.sha256"
fi

size=$(wc -c < "$dump" | tr -d ' ')
printf '{"dump":"%s","bytes":%s,"sha256":"%s"}\n' "$dump" "$size" "$(cat "$dump.sha256")"
