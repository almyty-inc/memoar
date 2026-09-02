# MCP setup

Memoar serves Streamable HTTP at `/mcp` — outside the `/v1` API prefix, so the
endpoint is `https://<memoar-host>/mcp`. Create an API key with `mcp:use`; add
`archive:read` only if the client should also reach the REST API.

## Authentication

The endpoint accepts an API key in the `X-Memoar-Key` header. A client that
cannot send a custom header exchanges the key for a short-lived bearer token
scoped to `mcp:use` alone:

```sh
curl -s -X POST https://<memoar-host>/v1/mcp/auth/handshake \
  -H "x-memoar-key: $MEMOAR_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"clientName":"codex","protocolVersion":"2025-06-18"}'
```

The response carries `accessToken` and `expiresAt` along with the endpoint and
tool list. The token expires in an hour and opens MCP only: it cannot read the
archive over REST.

## Tool order

Use tools in this order:

1. `search_sessions` for compact summaries.
2. `get_excerpt` for a bounded turn span.
3. `pack` for a cited multi-session handoff under a token budget.
4. `get_session` in chunks when earlier tools cannot answer the request.

Other tools are `list_collections`, `get_memory`, and `save_note`.

## Claude Code

```sh
claude mcp add --transport http memoar https://<memoar-host>/mcp \
  --header "X-Memoar-Key: $MEMOAR_API_KEY"
```

## Codex

Codex takes a bearer token from an environment variable and no custom header,
so use the handshake above:

```sh
export MEMOAR_MCP_TOKEN=...   # accessToken from the handshake
codex mcp add memoar --url https://<memoar-host>/mcp \
  --bearer-token-env-var MEMOAR_MCP_TOKEN
```

## Other clients

Any client that can send `X-Memoar-Key` uses the key directly; any client that
can send a bearer token uses the handshake. Both paths are exercised by
`server/test/mcp-handshake.test.ts`.

## Safety

Tool results include evidence age and redaction status. Clients must not display
masked content. Use `freshness_policy: strict` when a decision depends on
versions, services, prices, or other changing facts.
