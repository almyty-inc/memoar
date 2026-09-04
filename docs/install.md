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

Sign in with the account named by `MEMOAR_BOOTSTRAP_EMAIL` and
`MEMOAR_BOOTSTRAP_PASSWORD`. It is created once, if it does not already exist,
and an account that exists is never overwritten by what those variables say —
so changing your password does not get undone by the next restart. The archive
itself starts empty: it holds what the agent captures and nothing else.

### Upgrading an archive from an earlier build

Earlier builds created a `demo@memoar.dev` account whose password was printed
in this repository, and wrote a fabricated session into every archive. Both are
gone, but removing the code does not remove what it already created. On an
existing archive:

```sh
# The published account, if it is still there. Check before deleting: on a
# development stack it may own the sessions you captured.
psql "$MIGRATION_DATABASE_URL" -c \
  "SELECT u.id, u.email, (SELECT count(*) FROM sessions s WHERE s.\"tenantId\" = i.\"tenantId\") AS sessions
     FROM users u JOIN auth_identities i ON i.\"userId\" = u.id
    WHERE u.email = 'demo@memoar.dev'"
```

If it owns nothing, delete it. If it owns your sessions, change its password
instead. The API refuses to start in production while that account still has
its published password, so this cannot be forgotten quietly.

The fabricated session is `0191cafe-0000-7000-8000-00000000d001`; delete it if
it is in your archive.

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
