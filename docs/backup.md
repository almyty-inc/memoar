# Backing up the archive

Everything in this repository can be rebuilt from source. The sessions cannot.
This page is about the one thing that is irreplaceable.

There are two stores to think about, and they need different treatment.

| What | Where | How it is protected |
| --- | --- | --- |
| Sessions, turns, annotations, identities, machines | Postgres | `deploy/backup.sh`, below |
| Raw captured bytes | The object store | Bucket versioning and lifecycle rules |

The raw artifacts are content-addressed and never modified after they are
written, so nothing can overwrite one with different content. What they need is
protection from deletion — versioning on the bucket, and a lifecycle rule that
keeps noncurrent versions long enough to notice a mistake. A nightly copy of an
append-only store mostly copies what it copied yesterday.

## Take a backup

```sh
docker compose -f deploy/docker-compose.dev.yml exec postgres \
  sh /backup.sh --url "$MIGRATION_DATABASE_URL" --out /backups
```

Run it with the **migration** connection, not the runtime one. The runtime role
is subject to row-level security, so a dump taken with it would succeed, be
quiet, and contain no sessions at all.

The script writes `memoar-<label>.dump` and `memoar-<label>.dump.sha256`, and
prints where they went:

```json
{"dump":"/backups/memoar-20260904T101500Z.dump","bytes":4211984,"sha256":"…"}
```

### Why it runs inside the container

`pg_dump` writes the settings of its own major version into the dump. A version
18 client emits `SET transaction_timeout`, which a version 16 server rejects
part way through a restore — the backup looks perfect for months and fails on
the day it is needed. `backup.sh` compares the two versions and refuses to dump
when they disagree, so run it where the client matches the server: inside the
database's own container.

## Restore

```sh
docker compose -f deploy/docker-compose.dev.yml exec postgres \
  sh /restore.sh --url "$MIGRATION_DATABASE_URL" --dump /backups/memoar-….dump
```

The checksum is verified before anything is touched, and the restore runs in a
single transaction, so a failure leaves the archive as it was rather than half
written. It refuses to run against a database that already holds sessions
unless you pass `--replace`; restoring an old copy over a working archive is the
ordinary way to lose one.

It prints what came back:

```json
{"sessions":1284,"turns":39122}
```

## Test the restore, not the backup

A backup nobody has restored is a promise, not a copy. `server/test/backup-restore.test.ts`
takes a real dump, drops the schema, restores it and checks that the sessions,
their turns and their content blocks came back — and that the row-level security
policies came back with them. A restore that returns the rows without the
policies is worse than no restore: every tenant would be able to read every
other tenant's archive, and the archive would look completely healthy.

Run it against a real database:

```sh
cd server && npx vitest run test/backup-restore.test.ts
```

Do the same against a copy of production periodically. The failure mode this
protects against is not "the backup did not run" — that is visible. It is "the
backup ran for a year and cannot be read", which is not.

## What is not automated yet

Scheduling and off-site copies are deployment decisions and depend on where the
service runs, which is not settled. What exists here is the mechanism and the
proof it works; a cron entry that calls `backup.sh` and ships the file somewhere
durable is the remaining step, and it belongs with the hosting choice.
