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
