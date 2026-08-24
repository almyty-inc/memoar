# Architecture

Memoar keeps original session bytes and normalized session data in the cloud. The local Rust agent is a capture and materialization client. It is not the system of record and it does not parse vendor formats.

## Data flow

1. The capture agent finds enabled source paths and hashes changed files.
2. Delta negotiation tells the agent which content hashes are absent.
3. The agent uploads raw bytes, then submits a manifest with source and machine metadata.
4. The worker detects the format, runs a versioned parser, scans for secrets, and writes canonical rows.
5. Search jobs update PostgreSQL full-text indexes and optional vectors.
6. The API serves the web app, CLI, and MCP module from the same tenant-scoped services.

Raw artifacts live in S3-compatible object storage. PostgreSQL stores canonical sessions, turns, blocks, mutable annotations, grants, jobs, and vector indexes. Redis carries BullMQ jobs. An offline SQLite queue exists only in the local capture agent.

## Contract boundary

`contracts/source/canonical.model.json` is the schema source. Generated JSON Schema, TypeScript, and Rust files must remain byte-for-byte deterministic. Fixture inputs and expected canonical outputs define parser behavior. The conversion matrix defines native writers and resume checks.

## Tenant and privacy boundary

Every query is scoped by organization, team, and user before filters or joins are applied. Captured content is immutable. Mutable tags, notes, summaries, collections, pins, and redaction masks are stored separately. A share link or user transfer cannot widen visibility until a redaction review is complete.

## Retrieval boundary

Search uses PostgreSQL full-text retrieval as the required path. Embeddings are optional. Hybrid mode combines lexical and semantic ranks with reciprocal-rank fusion. A semantic failure returns lexical results and reports the realized mode.

Pack is the primary agent handoff primitive. It is extractive, cited, bounded by explicit token and evidence limits, and deterministic for the same indexed state and request.

## Tenant isolation

Every tenant-scoped table has a row-level security policy keyed on the
`memoar.tenant_id` setting, and the API sets that value at the start of each
transaction. Postgres exempts superusers and `BYPASSRLS` roles from policies, so
the API and worker connect as `memoar_app`, a role that owns nothing and holds
only `SELECT/INSERT/UPDATE/DELETE`. Migrations use a separate owner connection
(`MIGRATION_DATABASE_URL`) because DDL needs privileges the runtime must not
have.

Checking `relrowsecurity`/`relforcerowsecurity` proves the policy exists, not
that it filters. The migrations prover and `server/test/rls.test.ts` both connect
as `memoar_app` and assert observed behavior: a wrong tenant reads zero rows, an
unset tenant reads zero rows, a cross-tenant insert is rejected, and DDL fails.
