.PHONY: contracts-generate contracts-check build test compose-up compose-down

contracts-generate:
	npm run contracts:generate

contracts-check:
	npm run contracts:check

build: contracts-check
	npm run build
	cargo build --workspace --manifest-path agent/Cargo.toml

test: contracts-check
	npm test
	cargo test --workspace --manifest-path agent/Cargo.toml

compose-up:
	docker compose -f deploy/docker-compose.dev.yml up --build

compose-down:
	docker compose -f deploy/docker-compose.dev.yml down

# Runs each parser against the real store of a tool installed on this machine.
# Cannot run in CI: there are no transcripts on a build agent, only fixtures —
# which is the whole point.
verify-parsers-local:
	npm run build --workspace @memoar/server
	node scripts/verify-parsers-locally.mjs
