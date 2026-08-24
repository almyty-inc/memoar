# Robot API

Use `--json` whenever a program or agent consumes Memoar CLI output. Successful commands write one JSON value to standard output. Diagnostics go to standard error.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command completed |
| 2 | Invalid usage |
| 3 | Memoar is not initialized |
| 4 | Network or service failure |
| 7 | Local queue or process lock is held |
| 9 | Unknown failure |

Failures use one envelope:

```json
{
  "error": {
    "code": "network_unavailable",
    "kind": "network",
    "message": "Memoar could not reach the configured service.",
    "hint": "Check the service URL or retry when the network is available.",
    "retryable": true
  }
}
```

## Discovery

Run `memoar capabilities --json` before depending on an optional source or conversion target. Run `memoar introspect --json` to obtain command input and output schemas.

## Retrieval commands

`memoar search <query> --json` returns summary rows, cursor data, aggregations, and `meta.realizedMode`. Results are ordered by stable reciprocal-rank fusion when semantic retrieval is available. Lexical results remain available when embeddings fail.

`memoar view <session-id> --turn-start <n> --turn-end <n> --json` returns a bounded excerpt with provenance and redaction status.

`memoar pack <query> --max-tokens <n> --max-evidence <n> --max-sessions <n> --freshness-policy strict|mixed --json` returns a deterministic evidence bundle. Each evidence item contains a session id, turn span, age, excerpt, and redaction state.

`memoar convert <session-id> --target <target> --here --json` downloads a gated conversion, materializes it on the current machine, and returns the exact resume command. Native targets are claude-code, codex, and antigravity-cli; any other target is an open target: with `--fallback injection` it produces a cited, token-budgeted context prelude instead of a native bundle.

## Capture commands

`memoar sources list --json` reports path, source stability, and enabled state. Enable or disable one connector without affecting other connectors.

`memoar sync --json` hashes changed native files, negotiates missing objects, uploads bytes, and submits a batch manifest. Unknown formats remain in the raw mirror with a diagnostic.

`memoar doctor --json` reports authentication, local queue, source path access, clock, network, and server contract compatibility.

`memoar listen --json` subscribes to this machine's durable command channel and applies conversions the server pushes to it, returning the commands it handled. `--max-commands <n>` exits after that many commands and `--idle-timeout-seconds <n>` gives up when the channel stays quiet. Commands are acknowledged only after their bundle is written, so an interrupted materialization is replayed rather than lost.
