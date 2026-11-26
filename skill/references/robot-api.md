# Robot API

Use `--json` whenever a program or agent consumes Memoar CLI output. A command writes one JSON envelope to standard output. Diagnostics go to standard error.

```json
{ "ok": true, "version": "1", "command": "search", "data": { "items": [] } }
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command completed |
| 2 | Invalid usage |
| 3 | Memoar is not initialized. Run `memoar login` |
| 4 | Network or service failure, worth retrying |
| 5 | The archive answered and refused. Retrying unchanged is refused again |
| 6 | The data directory's volume is at the free-space floor, so nothing new was captured |
| 7 | Local queue or process lock is held |
| 9 | Unknown failure |

Failures use one envelope:

```json
{
  "ok": false,
  "version": "1",
  "error": {
    "code": "MEMOAR_REFUSED",
    "kind": "refused",
    "message": "Validation failed (uuid is expected) (HTTP 400)",
    "hint": "The archive refused the request as sent. Sending it again unchanged is refused the same way.",
    "retryable": false
  }
}
```

## Discovery

`memoar capabilities --json` reports the client and contract versions, the capture sources and the conversion targets. `memoar introspect --json` lists every command, whether it needs a login or the network, and the exit codes. `memoar <command> --help` documents each command's flags.

## Every MCP tool from the shell

`memoar mcp tools --json` lists the archive's MCP tools with their input schemas.

`memoar mcp call <tool> '<json arguments>' --json` calls one tool and returns its result as `data`. Pass `-` as the arguments to read them from standard input. A tool that refuses its arguments exits 5 with the tool's own message, which names the field to change.

```sh
memoar mcp call list_memory_documents '{"scope":"project","workspacePath":"/path/to/repo"}' --json
printf '%s' '{"sessionId":"<uuid>","topic":"auth","markdown":"Decided to ..."}' | memoar mcp call save_note - --json
```

## Retrieval commands

`memoar search <query> [--mode hybrid|lexical|semantic] [--limit <n>] [--agent <source>] [--workspace <path>] --json` returns ranked summary rows in `items`, with `aggregations` by agent and workspace, and `meta.realizedMode`, which says whether semantic retrieval took part.

`memoar view <session-id> [--chunk-size <n>] [--cursor <cursor>] --json` returns one chunk of a session: `session`, `turns`, `provenance`, and `nextCursor` for the next chunk. For a bounded turn span use `memoar mcp call get_excerpt` instead.

`memoar pack <query> [--max-tokens <n>] [--max-evidence <n>] [--max-sessions <n>] [--max-excerpt-chars <n>] [--freshness-policy strict|mixed] [--stale-after-days <n>] --json` returns a deterministic evidence bundle: `evidence` items with `sessionId`, `turnStart`, `turnEnd`, `ageDays` and `excerpt`, plus `markdown`, `staleCount`, `redactionStatus` and `tokenEstimate`.

`memoar convert <session-id> --target <target> --here --json` downloads a gated conversion, materializes it on the current machine, and returns the exact resume command. Native targets are claude-code, codex, and antigravity-cli. With `--fallback injection` any other target produces a cited, token-budgeted context prelude instead of a native bundle.

## Capture commands

`memoar sources list --json` reports path, source stability, and enabled state. `memoar sources enable|disable <source>` changes one connector without affecting the others.

`memoar sync --json` hashes changed native files, negotiates missing objects, uploads bytes, and submits a batch manifest. Unknown formats remain in the raw mirror with a diagnostic. Run it to archive the current session before linking a note to it.

`memoar doctor --json` reports authentication, local queue, source path access, clock, network, and server contract compatibility.

`memoar listen --json` subscribes to this machine's command channel and applies conversions the server pushes to it. `--max-commands <n>` exits after that many commands and `--idle-timeout-seconds <n>` gives up when the channel stays quiet.

## Setting up an agent

`memoar integrate <agent>` registers `memoar mcp` as a stdio MCP server in that agent's config and installs this skill where the agent loads skills. `memoar integrate` alone lists the supported agents and what is installed. `--dry-run` shows the plan, `--uninstall` removes both.
