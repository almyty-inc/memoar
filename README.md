# Memoar

Memoar is a vendor-neutral cloud archive for AI coding sessions. It captures native session files, preserves their raw bytes, normalizes them into one branch-aware schema, and makes the archive available to people through a web app and to agents through MCP and a CLI.

This repository is a contracts-first monorepo:

- `contracts` contains the canonical schema, OpenAPI contract, fixtures, and native conversion matrix.
- `agent` contains the Rust capture daemon, CLI, connectors, and materializer.
- `server` contains the NestJS API, ingest worker, search, conversion, sharing, and MCP modules.
- `web` contains the React and Tailwind archive interface.
- `agent/crates/memoar-desktop` contains the desktop application: a window that signs a machine in, captures on a timer, and reports what it captured. It drives the same code the CLI runs rather than reimplementing capture.
- `packages/npx` contains the launcher for the capture agent. It refuses to download anything until a release channel is decided, so today it runs a locally built binary (`MEMOAR_PREFER_LOCAL=1`, or `MEMOAR_BINARY=<path>`).
- `skill` contains the agent-facing retrieval instructions and robot-mode reference.
- `deploy` contains the local Postgres, Redis, MinIO, API, worker, and web stack.

## Local setup

Requirements are Node.js 24 or newer, Rust stable, Docker, and Docker Compose.

```sh
npm install
make contracts-generate
make contracts-check
npm run build
cargo test --workspace --manifest-path agent/Cargo.toml
docker compose -f deploy/docker-compose.dev.yml up --build
```

Copy `.env.example` to `.env` before starting the compose stack. The checked-in defaults are local-only values.

## Operational checks

These gates also run in CI and need Docker. They are ordinary vitest suites, so they skip automatically when Docker is unavailable.

- `server/test/migrations.test.ts` proves every database migration applies, reverts, and re-applies on a throwaway Postgres, and that the tenant policies actually filter for the least-privilege runtime role (catalog flags alone do not prove enforcement).
- `server/test/perf-100k.test.ts` seeds 100,000 sessions with search documents and embeddings into a throwaway Postgres, runs 200 live hybrid searches, and fails unless p95 holds under 300 ms. On a host whose load average says it is saturated the absolute budget is reported rather than enforced, because a shared machine cannot disprove a latency figure; `MEMOAR_PERF_STRICT=1` enforces it regardless, and the query-plan assertion beside it is structural and always enforced. Opt in locally with `MEMOAR_TEST_PERF=1`; CI runs it in the data-gates job.
- `node dist/reprocess.js --tenant <tenantId>` inside the api container reparses every stored raw artifact. Reprocessing is idempotent: the same native session always maps to the same canonical session, turns are replaced atomically, and annotations survive.
## Contract changes

The source of truth is `contracts/source/canonical.model.json`. `make contracts-generate` produces the JSON Schema, TypeScript types, Rust types, and scrubbed fixture corpus. `make contracts-check` fails when generated files drift, fixtures do not validate, OpenAPI operation identifiers collide, or the conversion matrix is incomplete.

Captured session data is immutable. Tags, notes, summaries, collections, pins, and redaction masks live in the separate annotation layer.
