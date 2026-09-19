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

The token records the key it came from, and is refused the moment that key is
revoked — `DELETE /v1/auth/api-keys/{id}` ends every MCP session minted from
that key without touching the account's other keys. This is checked on every
request, not at issue: a token is worth exactly what the credential behind it
is still worth.

It is also minted with its own token type rather than as a browser session, so
what a token is comes from the token rather than from the shape of its scope
list. Tokens issued by an older build — which said `browser` and carried
`mcp:use` alone — keep working until they expire, within the hour, and are
checked the way that build checked them: against the account holding any
unrevoked API key, rather than against one key.

## Arguments

Tool arguments arrive inside a JSON-RPC body, so the global validation pipe that
guards every HTTP body never sees them. Every tool validates its arguments
against a class-validator DTO instead (`server/src/mcp/arguments.ts`), with the
same settings the HTTP surface uses: unknown fields are **refused**, nothing is
implicitly converted, and every bound is stated. A `limit` of `"10"` is a
malformed argument, not the number ten; an extra field is an error, not
something to ignore. A refusal comes back as `invalid_arguments:<fields>`.

Every tool also bounds its own response. An agent calling one spends its context
on the answer, so page sizes, character budgets and revision counts all have
ceilings, and a result that was cut says so with `truncated`.

## Finding things

| Tool | What it answers |
| --- | --- |
| `search_sessions` | Rank sessions by relevance to a query. Optional `agent`, `workspace`, `from`, `to`. Start here. |
| `list_sessions` | Enumerate sessions newest-first *without* a query, filtered by `agent`, `workspace`, `machineId`, `model` or date range, paged with `cursor`. |
| `get_excerpt` | One bounded turn span of one session. Prefer over `pack` when a single session answers the question. |
| `pack` | Cited evidence across sessions under an explicit token budget, with evidence age and redaction status kept structured. |
| `get_memory` | `pack` with conservative defaults for a topic. Packs *sessions*; see `list_memory_documents` for the instruction files. |
| `get_session` | Last resort: one chunk of a whole session. Continue with `nextCursor`, keep `chunkSize` small. |
| `list_machines` | The machines capturing for this account, with platform, last-seen time and per-source session counts. Resolves a `machineId` for the filters above. |

## Curating

| Tool | What it does |
| --- | --- |
| `list_annotations` | Read the notes, tags, pins and summaries on a session, or across the account. Bodies over `maxValueChars` come back as `{valueTruncated, valuePreview}` rather than as broken JSON. |
| `save_note` | Write a durable markdown note linked to a source session. |
| `add_annotation` | Write a `tag`, `pin`, `note` or `summary`, optionally against one turn or block. The tool stamps `value.source = "mcp"`; a caller cannot claim to be something else. |
| `list_collections` | The curated collections in this account. |
| `create_collection` | Create one, optionally scoped to a team the caller belongs to. |
| `list_collection_sessions` | The sessions in one collection, as summaries. |
| `add_session_to_collection` / `remove_session_from_collection` | Change what a collection lists. Membership is not visibility: who may read a session is `session.visibility`, which no MCP tool touches. |

## Instruction files and project memory

`list_memory_documents` lists the captured CLAUDE.md, AGENTS.md, GEMINI.md and
.goosehints files, filtered by `machineId`, `scope`, `workspacePath` or a
`pathPattern` glob over the file name or full path, and paged with `limit` and
`offset`. `get_memory_document` reads one of them: its current text, bounded by
`maxChars`, and its revision history newest first, bounded by `maxRevisions`.

These are the files themselves. `get_memory`, despite the name, packs *sessions*
for a topic and has nothing to do with them.

`export_project_memory` renders the notes already distilled for one workspace as
CLAUDE.md- or AGENTS.md-style markdown, each note cited to its source session
and turn span, bounded by `maxChars`. It reads existing notes; it does not run
distillation.

## Seeing what is shared

`list_share_links` and `list_transfers` are read-only. They answer "is any of
this already exposed, and to whom" before an agent quotes a session or advises
on one. Neither returns a usable secret: the token for a share link exists only
in the response to `POST /sharing/links`, and `listLinks` has never carried it.

## What MCP deliberately does not do

The boundary below is a decision, not an oversight. Each of these is reachable
over the HTTP API and in the web app, and each is absent here on purpose.

**Nothing changes who can see a session.** `create_share_link`,
`update_session_visibility`, `request_transfer`, `accept_transfer` and
`import_share` are all absent. Sharing is gated on a completed redaction review
(`SharingService.requireCurrentReview`) whose whole point is that a *person*
looked at the transcript and decided what to mask. An agent minting a public
link would be deciding, unattended and irreversibly, that a transcript full of
someone's code, paths and tool output is safe for the internet. `import_share`
and `accept_transfer` are the same decision pointing inwards: they copy a
session of unknown provenance into this account, where the search and pack
tools will later quote it back as evidence.

**Revoking is absent too, and that is not symmetry for its own sake.**
`SharingService.revoke` writes `status: "revoked"` and there is no path back to
`active`. An agent that decided a link looked risky would cut off a colleague
mid-review with no undo, which is a small harm but a permanent one.

**`complete_redaction_review` is absent because it is the assertion itself.**
The review record is what unlocks link creation and visibility widening, and it
is built from the `redaction_mask` annotations on the session — which is why
`add_annotation` refuses that kind. A tool that could write the masks and
complete the review could manufacture the evidence of a human review that never
happened.

**Nothing deletes.** `DELETE /sessions/{id}`, `DELETE /memory/{id}` and
`DELETE /annotations/{id}` have no tools. Sessions and instruction files are the
archive's reason to exist. Annotations are smaller but no safer: `Annotation`
carries no author, so a tool cannot tell an agent's note from a person's, and
the correction an agent actually needs — "that earlier note was wrong" — is a
new annotation rather than a silent overwrite of someone else's. Editing has the
same problem and is absent for the same reason.

**Nothing mints, reveals or spends.** `POST /auth/api-keys`,
`DELETE /auth/api-keys/{id}` and `POST /auth/machine-token` are credential
operations; the agent already holds exactly the credential it was given.
`GET`/`PUT /distillation/settings` hold a sealed BYOK provider key and a monthly
budget, and `POST /distillation/sessions/{id}` spends real money against that
budget on a third-party model. Reading notes that have already been distilled is
free and is what `export_project_memory` does.

**Nothing changes tenant or machine configuration.** `PUT /settings` sets the
redaction and retention policy for the whole account — including a retention
sweep that deletes sessions. `POST`/`PATCH /machines` register a machine and set
its `sourceSettings`, which decide what a developer's laptop captures in the
first place. `POST /convert/{id}/materialize` queues a command that writes files
onto that laptop through the capture agent. Team membership
(`PUT`/`DELETE /teams/{id}/members`) widens who can read team-scoped sessions.

**Browser and operator mechanics are not applicable.** OAuth start and callback,
login, register, `GET /auth/me`, `GET /health`, `GET /metrics`, `GET /errors`,
`GET /openapi.json`, the raw-artifact upload protocol (`PUT /ingest/artifacts`,
`POST /ingest/manifests`, `POST /ingest/delta`), the machine command SSE stream
and its acks, `GET /sessions/{id}/export` (a file download; `get_session` reads
the same content in bounded chunks) and `GET /convert/{id}/download` (a signed
URL an MCP client cannot consume) are all shaped for a browser or for the
capture agent's own credential, not for a tool call.

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
`server/test/mcp-handshake.test.ts`, and what a revoked key does to a token
minted from it by `server/test/browser-token-revocation.test.ts`.

## Safety

Tool results include evidence age and redaction status. Clients must not display
masked content. Use `freshnessPolicy: strict` when a decision depends on
versions, services, prices, or other changing facts.

Every tool reaches data through the same tenant-scoped service the HTTP surface
uses; none of them writes a query against an entity directly.
`server/test/mcp-parity.test.ts` seeds a second account holding data of the same
shape — the same workspace path, the same machine id, the same collection name —
so a tool that ever read outside its tenant would fail there as a collision.
