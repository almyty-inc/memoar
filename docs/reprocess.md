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
| `--stale-parser` | Only `parsed` artifacts whose sessions an older parser wrote, the newest capture of each session, and with `--machine` only sessions that machine captured. |
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

## Repair: sessions an older parser wrote

Parsers before the versions in `server/libs/parsers/src/versions.ts` dropped
tool output, thinking text, redacted and encrypted reasoning, images and
documents, and the system, compaction and summary records around them. The
raw bytes hold all of it, so a re-parse with the current parsers recovers it.

Each session records the parser that wrote it in its native provenance entry,
as `<source>:<format>:<semver>`. `--stale-parser` selects the `parsed`
artifacts whose sessions carry an older semver for their source, or `pending`,
or none. Of those it takes only the newest capture of each session, because an
older capture of a file that has grown since is parsed and then discarded by
the pipeline. With `--machine` it takes only sessions that machine captured,
since a re-parse files its sessions under the machine the run acts for.

Block ids of message content do not change, so redaction masks a person placed
stay anchored. Blocks that are new (tool output that was empty, Claude Code
system and attachment lines) get ids in a range of their own.

1. Deploy an image with these parsers to the api and the worker. If the
   artifact cleanup in `docs/artifact-cleanup.md` is due, run it first: its
   re-parses then already use the new parsers and drop out of this selection.
2. List the tenants, owners and machines behind the sessions, with the parser
   that wrote them. Read-only:

   ```sql
   SELECT s."tenantId", s.visibility->>'ownerId' AS "userId", s.source->>'machineId' AS machine,
          p->>'parserVersion' AS parser, count(*)
     FROM sessions s, jsonb_array_elements(s.provenance) p
    WHERE p->>'kind' = 'native'
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 3, 4;
   ```

3. For each tenant, user and machine in that list, a dry run, then the run:

   ```sh
   NS=memoar-dev
   kubectl -n $NS exec deploy/dev-worker -- node dist/reprocess.js \
     --tenant <tenantId> --user <userId> --machine <machineId> --stale-parser --dry-run \
     | jq '{selected, bySource}'
   kubectl -n $NS exec deploy/dev-worker -- node dist/reprocess.js \
     --tenant <tenantId> --user <userId> --machine <machineId> --stale-parser \
     > reprocess-<machineId>.json
   jq '[.results[] | .status] | group_by(.) | map({(.[0]): length}) | add' reprocess-<machineId>.json
   ```

   Sessions from uploads (ChatGPT and CASS exports, and anything an earlier
   reprocess filed without a machine) carry the upload placeholder machine,
   `uuidV5("<tenantId>:uploads")`. Run those with `--no-machine`. With
   `--stale-parser` that selects only sessions already under the placeholder,
   so it never moves a real machine's session onto it.

4. Run the query in step 2 again. Every row should carry the current version
   for its source. A second `--stale-parser --dry-run` selects nothing, except
   sessions whose newest capture failed to parse, which `--status failed`
   lists.
5. Check that the content is back. On dev, 2026-11-25, before the re-parse:

   ```sql
   SELECT kind, count(*), count(*) FILTER (WHERE coalesce(text, '') <> '' OR data IS NOT NULL) AS with_content
     FROM content_blocks WHERE kind IN ('tool_result', 'thinking', 'attachment') GROUP BY 1;
   ```

   | Kind | Rows | With text, before |
   | --- | ---: | ---: |
   | `tool_result` | 45,703 | 7,274 |
   | `thinking` | 20,209 | 1,043 |
   | `attachment` | 374 | 0 |

   After the run nearly every row should have content. What stays empty is a
   tool result that was empty in the transcript.
