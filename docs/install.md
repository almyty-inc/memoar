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

## Where the agent keeps its files

| | macOS | Linux | Windows |
|---|---|---|---|
| Config and credential | `~/.config/memoar` | `$XDG_CONFIG_HOME/memoar`, else `~/.config/memoar` | `%APPDATA%\memoar` |
| Offline queue | `~/.local/share/memoar` | `$XDG_DATA_HOME/memoar`, else `~/.local/share/memoar` | `%LOCALAPPDATA%\memoar` |

An install that already has `~/.config/memoar/config.json` keeps using
`~/.config/memoar` and `~/.local/share/memoar` on every platform, so upgrading
never moves a credential. `--config-dir`, `--data-dir` and `--capture-home`
override all of this, and a run that names all three needs no home directory.

`credentials.json` holds the API key, apart from `config.json`, and is written
with mode `0600` on Unix. The config directory, the data directory and the
`blobs` directory inside it, which holds the captured transcripts, are created
owner-only (`0700`). On Windows these files sit in the user's profile, whose
access list admits only that user, and the agent adds nothing to it. No
keychain integration exists today.

The offline SQLite queue stores immutable content-addressed snapshots and
resumable upload state. Optional client redaction is applied before snapshots
are hashed. Native session content remains in its original location until
upload. One `memoar sync` runs per data directory at a time: a second one exits
with `MEMOAR_LOCKED` and names the process that holds the queue. The lock is
released when that process ends, however it ends.

A sync that loses the archive part way stops at the first upload that cannot
connect, and nothing it did not send is counted against it. Run it again, or
let `sync --watch` retry, and it resumes. When the archive rate-limits uploads,
the agent waits the time the archive asks for and carries on.

## Exit codes and the JSON envelope

With `--json`, every command prints one envelope on stdout. Success is
`{"ok": true, "version": "1", "command": ..., "data": ...}` and failure is
`{"ok": false, "version": "1", "error": {"code", "kind", "message", "hint",
"retryable"}}`.

| Exit | Meaning | Retry? |
|---|---|---|
| 0 | Done | |
| 2 | Usage error, or a local file named on the command line is wrong | No |
| 3 | Not signed in, or the config or credential file is damaged. Run `memoar login` | No |
| 4 | The archive could not be reached, is overloaded or rate limiting, or a wait ran out | Yes |
| 5 | The archive answered and refused: a revoked key, a deregistered machine, a missing session | No |
| 7 | Another process holds the queue | Yes, once it finishes |
| 9 | Anything else, including a damaged queue file | No |

## Add another machine

Install the agent, sign into the same account, and run `memoar sync`. The archive is shared through the cloud. Do not copy the local queue between machines.
