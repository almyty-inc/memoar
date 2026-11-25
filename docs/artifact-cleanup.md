# Cleaning up artifacts that never became a session

`cleanup-artifacts` makes one pass over every stored artifact that is not
`parsed` and does two things:

1. It deletes the row and the object-storage bytes of anything capture should
   never have taken. That is any path the agent's deny list refuses (`.git`
   and its peers, `.DS_Store`, `.audit-key`, `.claude.json` and its backups,
   credential files, key material), and any `unknown_format` artifact whose
   file name its source's parser never reads: for `claude-code` anything that
   is not session JSONL (memory markdown, `local_<id>.json` settings,
   `history.jsonl`, `audit.jsonl`, `tool-results/`, `*.meta.json`), for
   `codex` anything that is not `rollout-*.jsonl`, for `antigravity-cli`
   anything that is not `transcript.jsonl`.
2. It hands every other `unknown_format` artifact back to the ingest pipeline,
   so a detector or parser fixed since the refusal gets another look.

An artifact that produced a session is never touched, whatever its path says.
An artifact with no source path, such as an upload from the web app, is never
deleted.

The rules are in `server/src/cleanup/never-captured.ts`. Its deny tables are a
copy of `agent/crates/memoar-connectors/src/deny.rs`, and
`server/test/artifact-cleanup.test.ts` fails if the two differ.

## Safety

- It is a dry run unless `--apply` is passed. The dry run lists every artifact
  it would delete with the reason, and every artifact it would re-parse with
  the user and machine the session would belong to.
- It is idempotent. Bytes are deleted before the row, so an interrupted run
  leaves rows that the next run finds and finishes. A second run deletes
  nothing and re-parses only what is still refused.
- A raw artifact does not record who uploaded it. The owner and machine for a
  re-parse are read off the parsed artifact in the same tenant whose capture
  time is nearest, which is the same sync in every case on dev. Override them
  with `--tenant <id> --user <id> --machine <id>`.
- It exits 1 if any artifact failed, and says which in the report.
- Artifacts in `stored` are left to the settle job, unless the deny list
  refuses them. A superseded artifact is `parsed` and is never touched. For a
  re-parse of one artifact or one status with a chosen machine, use
  `reprocess` (docs/reprocess.md).

## Running it against dev

It needs the image that contains this command, so deploy first. The new
format detector and parsers must be running too, or the re-parse half finds
the same refusals again.

```sh
NS=memoar-dev
# 1. A backup first. Deleting bytes cannot be undone.
kubectl -n $NS create job --from=cronjob/dev-backup dev-backup-before-cleanup
kubectl -n $NS wait --for=condition=complete job/dev-backup-before-cleanup --timeout=15m

# 2. The dry run. Read it before going on.
API=$(kubectl -n $NS get pod -l app=api -o name | head -1)
kubectl -n $NS exec "$API" -- node dist/cleanup-artifacts.js > cleanup-dry-run.json
jq '{deleted: [.lines[] | select(.action == "delete")] | length,
     reparse: [.lines[] | select(.action == "reparse")] | length}' cleanup-dry-run.json
jq -r '.lines[] | select(.action == "delete") | .reason' cleanup-dry-run.json | sort | uniq -c

# 3. Apply, then run it once more to see that nothing is left to delete.
kubectl -n $NS exec "$API" -- node dist/cleanup-artifacts.js --apply > cleanup-apply.json
kubectl -n $NS exec "$API" -- node dist/cleanup-artifacts.js > cleanup-after.json
```

The worker pod (`-l app=worker`) works equally well. Add `--tenant <id>` to
limit a run to one tenant.

What the dry run should report on dev, computed from its rows on 2026-11-25:

| Verdict | Artifacts | Size |
| --- | ---: | ---: |
| `claude-code` delete, not a transcript (markdown, settings, task lists, outputs, `history.jsonl`) | 1,212 | 62.0 MB |
| `claude-code` delete, inside `.git` | 52 | 9.5 MB |
| `claude-code` delete, `.claude.json` backups | 45 | 1.3 MB |
| `claude-code` delete, `.DS_Store` | 16 | 0.1 MB |
| `claude-code` delete, `.claude.json` | 15 | 0.4 MB |
| `claude-code` delete, `.audit-key` | 13 | 0.0 MB |
| `claude-code` delete, `.npmrc` | 1 | 0.0 MB |
| `antigravity-cli` re-parse | 655 | 2.2 MB |
| `codex` re-parse | 10 | 105.8 MB |

After `--apply` the 655 Antigravity transcripts and 8 of the 10 Codex rollouts
should be `parsed`. The other 2 Codex rollouts are guardian threads holding
only an encrypted compaction and stay `unknown_format`, correctly.
