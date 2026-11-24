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

For a machine where nobody wants a command-line tool, the Memoar desktop
application does the same capture in a native window on macOS, Linux and
Windows. Sign in with the archive's address and either an email and password
or an API key, the same two ways `memoar login` accepts. The app registers the
machine and captures every two minutes. Its window shows:

- the archive and the machine's id
- when it last captured, and how many sessions that capture uploaded
- how many artifacts this machine has uploaded in total, and how many wait in the queue
- which agents' session stores it found on this machine
- the last failure, in a sentence, with what the archive said underneath

From the window you can capture now, pause and resume the timer, open the web
application, change what is masked before upload, and sign out. Signing out
removes the machine's credential and keeps its configuration and queue, so
signing in again reuses the same machine record and loses nothing captured.

Failures are handled by kind. An archive that cannot be reached, or answers
with a server error, is tried again on the next cycle. A wrong password is
refused at sign-in with the archive's reason. When the archive stops accepting
the machine's key, because it was revoked or the machine was removed, the app
stops capturing and asks for a new sign-in instead of retrying every two
minutes.

The app runs the CLI's own code and reads and writes the same configuration
(`~/.config/memoar`) and offline queue (`~/.local/share/memoar`) as `memoar`,
so a machine set up with one is already set up for the other. It honours
`MEMOAR_CONFIG_DIR`, `MEMOAR_DATA_DIR` and `MEMOAR_CAPTURE_HOME` as the CLI does.

The window is drawn with [NSH](https://nsh.dev): AppKit on macOS 14 or later,
GTK 4.14 or later on Linux, and Win32 on Windows 10 1809 or later. It lives in
`agent/crates/memoar-desktop`, a Cargo workspace of its own. To build it you
need Rust, the `nsh` CLI at the version the crate pins, and on Linux the GTK 4
and WebKitGTK 6.0 development files (`libgtk-4-dev` and `libwebkitgtk-6.0-dev`
on Ubuntu 24.04, which bring libsoup 3 and JavaScriptCore with them):

```sh
cargo install nsh-cli --version 0.2.0 --locked
cd agent/crates/memoar-desktop
nsh run                       # a development window on this machine
cargo run --release           # the same window, without nsh
```

Tests and packages:

```sh
agent/scripts/test-desktop.sh      # Rust tests, then the window headless (nsh test) against a stand-in archive
agent/scripts/package-desktop.sh   # an installable archive for this machine, in agent/dist/desktop
```

`package-desktop.sh` builds on the operating system it runs on and writes
`memoar-desktop-<version>-macos-<arch>.zip` (an ad hoc signed `Memoar.app`),
`memoar-desktop-<version>-linux-<arch>.tar.gz` (the runner, its bundle and a
`.desktop` file) or `memoar-desktop-<version>-windows-<arch>.zip`
(`Memoar.exe` and its bundle). CI builds all three on every change to the agent
and keeps them as workflow artifacts. Developer ID signing, notarization and
Windows code signing wait on the same release-channel decision as the CLI.

The Linux archive is not a distribution package and declares no dependencies.
Install GTK 4 and WebKitGTK 6.0 before running it. On Ubuntu 24.04 and Debian
13:

```sh
sudo apt-get install libgtk-4-1 libwebkitgtk-6.0-4
```

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
