# Reprocessing stored artifacts

`reprocess` parses artifacts the archive already holds, with the parser the
deployed image carries. Raw bytes are never changed. Each run replaces the
turns of the sessions it touches, so a run over the same selection twice
leaves the archive as the first run left it.

## Running it

It runs inside the worker image, against the same database and object store
the worker uses.

```sh
kubectl -n <namespace> exec deploy/<release>-worker -- node dist/reprocess.js \
  --tenant <tenantId> --user <userId> --machine <machineId> [selection] [--dry-run]
```

| Flag | Meaning |
| --- | --- |
| `--tenant` | The account. Required. |
| `--user` | The user the parse acts for. Defaults to the tenant id. |
| `--machine` | The machine that uploaded the bytes. Required, or `--no-machine` to act as an upload. |
| `--sha256 <hash>` | One artifact. |
| `--status <status>` | Only artifacts in this status, for example `stored`. |
| `--merged-sessions` | Only artifacts linked to a session that more than one file writes to. |
| `--dry-run` | Print the selection and parse nothing. |

The selection is processed oldest capture first. Without a selection flag the
run covers every artifact in the account.

The machine matters. A session records the machine that captured it, and a
format with no session id of its own is identified by machine and path. Runs
before this flag existed acted as the upload placeholder machine
(`uuidV5("<tenantId>:uploads")`), and every session they touched says it came
from there.

Find the machine with a read-only query:

```sql
SELECT source->>'machineId' AS machine, count(*)
  FROM sessions WHERE "tenantId" = '<tenantId>'
 GROUP BY 1;
```

An artifact does not record its machine. In an account with several machines,
run `--sha256` per artifact with the machine that uploaded it.

## Repair: subagent transcripts merged into their parent session

Claude Code subagent transcripts name their parent's session id, and parsers
before `claude-code:v1:0.4.0` filed them under the parent's session. The file
parsed last replaced the turns of all the others. The bytes are all held, so a
re-parse with the fixed parser recovers every transcript.

1. Deploy an image that contains `claude-code:v1:0.4.0` to the api and the worker.
2. List what the repair will parse:

   ```sh
   kubectl -n memoar-dev exec deploy/dev-worker -- node dist/reprocess.js \
     --tenant <tenantId> --user <userId> --machine <machineId> --merged-sessions --dry-run
   ```

   On dev on 2026-11-25 this was 163 artifacts, 847 MB, behind 9 sessions.
3. Run the same command without `--dry-run`.
4. Check that no session is written by two files any more. This must return no rows:

   ```sql
   SELECT a."sessionId", count(DISTINCT r."sourcePath")
     FROM artifact_sessions a JOIN raw_artifacts r ON r.id = a."artifactId"
    WHERE r."sourcePath" IS NOT NULL
    GROUP BY 1 HAVING count(DISTINCT r."sourcePath") > 1;
   ```

A second run selects nothing, because the subagent artifacts are now linked to
sessions of their own.

The parent session keeps its id, so links, collections and shares that name it
still work. Each subagent gets a new session whose `ext.claudeCode` names the
parent's native session id and the agent id. Scanner redaction masks are
recomputed. Masks placed by a person are kept.

## Repair: artifacts stored and never parsed

An upload is parsed when its manifest arrives, and since this change also by a
settle job the upload queues itself, which runs after `MEMOAR_SETTLE_DELAY_MS`
(15 minutes by default) and parses the artifact if it is still `stored`.
Artifacts uploaded before the change, or whose settle job was lost with Redis,
are found and parsed with:

```sh
kubectl -n memoar-dev exec deploy/dev-worker -- node dist/reprocess.js \
  --tenant <tenantId> --user <userId> --machine <machineId> --status stored --dry-run
```

Only artifacts older than a pass in flight belong in this run. A sync uploads up
to 256 artifacts before it sends their manifest, so `stored` artifacts captured
in the last few minutes are waiting for it and need nothing.
