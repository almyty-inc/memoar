# Install and connect a machine

Memoar needs the cloud service and one capture agent on each machine whose sessions should be archived.

## Start the local service

```sh
cp .env.example .env
npm install
make contracts-generate
make contracts-check
docker compose -f deploy/docker-compose.dev.yml up --build
```

The local web app is available at `http://localhost:5173`. The API health endpoint is `http://localhost:4000/health`.

## Install the capture agent

During repository development:

```sh
cargo install --path agent/crates/memoar-cli
memoar login --endpoint http://localhost:4000/v1 --email you@example.com --password '...'
memoar sources list
memoar sync
memoar doctor
```

Every command accepts `--config-dir`, `--data-dir`, and `--capture-home` so a machine can be
exercised against a scratch location without touching your real agent stores.

## The desktop application

For a machine where nobody wants a command-line tool, `memoar-desktop` does the
same capture in a window: sign in, and it registers the machine and captures
every two minutes, showing what it has uploaded and any failure. It reads and
writes the same configuration and offline queue as the CLI, so a machine set up
with one is already set up for the other.

```sh
cargo run --release -p memoar-desktop --manifest-path agent/Cargo.toml
```

The window shows capture state only. Reading the archive stays in the web
application, which the window can open.

Packaging it — the installer, signing, and where it is downloaded from — waits
on the same release-channel decision as the CLI.

## Materialize a conversion on this machine

`memoar listen` subscribes to this machine's durable command channel and applies conversions the
server pushes to it:

```sh
memoar listen                       # run until interrupted
memoar listen --max-commands 1      # handle one command and exit
```

Each command is acknowledged only after its bundle is written, so an interrupted materialization is
replayed on the next connection rather than lost. Bundles are fetched through a pre-signed URL
carried in the command, so the machine credential never needs archive access.

The POSIX release installer selects the OS/architecture asset, downloads its `.sha256` sidecar with `curl`, verifies it, and atomically installs the binary. Until a release channel is approved, point it at an explicit release fixture or approved base URL:

```sh
MEMOAR_VERSION=0.2.0 \
MEMOAR_DOWNLOAD_BASE=https://downloads.example.invalid/memoar \
MEMOAR_INSTALL_DIR="$PWD/.memoar-bin" \
sh packages/npx/install.sh
```

The unpublished Node launcher can be exercised without any download by using a local build:

```sh
cargo build --release --manifest-path agent/Cargo.toml
MEMOAR_BINARY="$PWD/agent/target/release/memoar" \
MEMOAR_NO_DOWNLOAD=1 \
node packages/npx/bin/memoar.js doctor
```

The credential-store adapter writes the access token separately from `config.json` to `credentials.json` with mode `0600` on Unix. This file is an explicit seam for a future operating-system keychain adapter, and no keychain integration exists today. The offline SQLite queue stores immutable content-addressed snapshots and resumable upload state. Optional client redaction is applied before snapshots are hashed. Native session content remains in its original location until upload.

## Add another machine

Install the agent, sign into the same account, and run `memoar sync`. The archive is shared through the cloud. Do not copy the local queue between machines.
