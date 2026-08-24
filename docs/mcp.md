# MCP setup

Memoar exposes Streamable HTTP at `/mcp`. Use an API key limited to memory read tools unless the client must save notes.

## Tool order

Use tools in this order:

1. `search_sessions` for compact summaries.
2. `get_excerpt` for a bounded turn span.
3. `pack` for a cited multi-session handoff under a token budget.
4. `get_session` in chunks when earlier tools cannot answer the request.

Other tools are `list_collections`, `get_memory`, and `save_note`.

## Claude Code

Configure a remote HTTP MCP server with URL `https://<memoar-host>/mcp` and send the API key in `X-Memoar-Key`.

## Codex

Add the same Streamable HTTP endpoint to the Codex MCP configuration. Keep the key outside repository files and pass it through the supported secret or environment mechanism.

## Antigravity and Cursor

Use each client's remote MCP configuration with the same endpoint and header. If a client cannot set a custom header, use the Memoar MCP authentication handshake to obtain a short-lived bearer token.

## Safety

Tool results include evidence age and redaction status. Clients must not display masked content. Use `freshness_policy: strict` when a decision depends on versions, services, prices, or other changing facts.
