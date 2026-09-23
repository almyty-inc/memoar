# Backing up the archive

Locked out of an account rather than out of the data? See
[password-reset.md](password-reset.md).

Everything in this repository can be rebuilt from source. The sessions cannot.
This page is about the one thing that is irreplaceable.

There are two stores to think about, and they need different treatment.

| What | Where | How it is protected |
| --- | --- | --- |
| Sessions, turns, annotations, identities, machines | Postgres | `deploy/backup.sh`, below |
| Raw captured bytes | The object store | Bucket versioning and lifecycle rules — **only once somebody has run [the commands below](#protecting-the-object-store)** |

The raw artifacts are content-addressed and never modified after they are
written, so nothing can overwrite one with different content. What they need is
protection from deletion — versioning on the bucket, and a lifecycle rule that
keeps noncurrent versions long enough to notice a mistake. A nightly copy of an
append-only store mostly copies what it copied yesterday.

That is the design. Whether it is also the truth depends on your bucket, because
versioning and lifecycle are settings on the bucket rather than anything this
repository deploys, and for a long time this page claimed the protection without
anyone ever having switched it on. The next section is how to switch it on and,
more importantly, how to find out whether it is on right now.

## Protecting the object store

These are one-time, per-bucket, and they need credentials for the bucket. The
examples are DigitalOcean Spaces, which is what the hosted deployment uses; any
S3-compatible store takes the same calls against its own endpoint.

**First, find out what is actually true.** Do this before assuming anything:

```sh
aws s3api get-bucket-versioning --bucket "$S3_BUCKET" \
  --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION"
```

Empty output means versioning has never been enabled and nothing is protecting
these bytes from a delete. `{"Status": "Enabled"}` means it is on.

**Enable versioning.** On Spaces this is only possible through the API —
DigitalOcean's documentation states that versioning cannot be enabled from the
control panel — which is a large part of why it had never been done:

```sh
aws s3api put-bucket-versioning --bucket "$S3_BUCKET" \
  --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" \
  --versioning-configuration Status=Enabled
```

Enable it on an empty bucket if you can. Versioning only covers writes made
after it is on; objects already there carry a `null` version and a delete takes
them with it.

**Set the lifecycle rules.** Write this to `lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "expire-noncurrent-raw-artifacts",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

```sh
aws s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET" \
  --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" \
  --lifecycle-configuration file://lifecycle.json

aws s3api get-bucket-lifecycle-configuration --bucket "$S3_BUCKET" \
  --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION"
```

There is no `Expiration` rule here and there must not be one. A plain expiration
on a bucket whose purpose is to keep things forever deletes the archive on a
schedule. What expires is superseded versions — which for immutable,
content-addressed objects only exist when something was overwritten or deleted —
and multipart uploads that never finished, which are otherwise billed forever
and invisible.

Run the `get-` command afterwards and read what comes back. If the rule is
rejected or returns altered, your store does not support what this page claims,
and the honest fix is to change this page rather than to leave the claim
standing.

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

## The schedule

`deploy/backup-cron.sh` runs as the `backup` service in the compose stack. It
takes a dump every `MEMOAR_BACKUP_INTERVAL_SECONDS` (a day by default), keeps
the newest `MEMOAR_BACKUP_KEEP` (fourteen), and logs one JSON object per line
like the API does.

It counts dumps rather than days when pruning. A stretch where backups were
failing must not silently delete the last good copies as they age past a date.

A failed run is loud but not fatal: the loop continues, because one bad night
should not end all future backups. It also leaves `last-success` untouched,
which is what makes a run of failures visible:

```sh
docker compose -f deploy/docker-compose.dev.yml exec backup sh /backup-check.sh
# {"lastSuccessSecondsAgo":3612,"maxAgeSeconds":129600}
```

That is the service's health check, so a schedule that has stopped shows up as
an unhealthy container. **This is the failure worth guarding against.** A lost
backup is visible. A backup that quietly stopped running four months ago looks
exactly like a healthy one until the day it is needed, which is why the check
exists and why it is wired to something that goes red on its own.

`server/test/backup-restore.test.ts` runs the loop with a one-second interval
and a limit of three, then asserts that backups appeared, that old ones were
pruned, and that the staleness check fails on a directory whose last success is
old and on one where no backup ever succeeded.

## What is still yours to decide

Where the dumps go. They are on a volume beside the database, which protects
against a dropped table and not against losing the machine. Copying them
somewhere else is a decision about hosting and about what may leave the machine,
and both are open. When that is settled it is one `aws s3 cp` — or equivalent —
after the `wrote` line in `backup-cron.sh`.
