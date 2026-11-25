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

The capture agent is one binary, `memoar`. Every
[GitHub Release](https://github.com/almyty-inc/memoar/releases) carries it for
macOS (Apple silicon and Intel), Linux (x86-64 and arm64, glibc and musl) and
Windows (x64 and ARM64), each with a `.sha256` file beside it, a `SHA256SUMS`
file for the whole release, and a build provenance attestation. Every installer
below refuses a binary whose SHA-256 does not match.

### macOS and Linux

```sh
curl -fsSL https://github.com/almyty-inc/memoar/releases/latest/download/install.sh | sh
```

The script picks the binary for your OS and CPU, and on Linux for your C
library: Alpine and other musl systems get a static build, everything else the
glibc build, which needs glibc 2.28 or newer (RHEL 8, Debian 10, Ubuntu 20.04).
It installs to `~/.local/bin` and tells you how to add that to `PATH` when it
is not there already.

| Variable | Effect |
| --- | --- |
| `MEMOAR_VERSION=0.4.0` | Install that release instead of the latest |
| `MEMOAR_INSTALL_DIR=/usr/local/bin` | Install somewhere else |
| `MEMOAR_LIBC=musl` | Override the C library detection on Linux |
| `MEMOAR_DOWNLOAD_BASE=<url>` | Install from a mirror laid out as `<url>/v<version>/<asset>` (needs `MEMOAR_VERSION`) |

To read the script before running it, download it first:

```sh
curl -fsSLO https://github.com/almyty-inc/memoar/releases/latest/download/install.sh
less install.sh
sh install.sh
```

### Windows

In PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://github.com/almyty-inc/memoar/releases/latest/download/install.ps1 | iex
```

It picks the x64 or ARM64 binary, installs `memoar.exe` to
`%LOCALAPPDATA%\Programs\Memoar\bin`, and adds that directory to your user
`PATH`. Open a new terminal afterwards. The same variables as above apply, set
with `$env:MEMOAR_VERSION = '0.4.0'` before running it, plus
`$env:MEMOAR_NO_MODIFY_PATH = '1'` to leave `PATH` alone.

### Node.js

With Node.js 18 or newer nothing has to be installed. The `memoar` npm package
downloads the binary for your platform on first use, verifies it and caches it:

```sh
npx memoar sources list
```

### Homebrew

Each release attaches a formula, `memoar.rb`. Until there is a tap for it,
install it through a local one:

```sh
brew tap-new --no-git local/memoar
curl -fsSL -o "$(brew --repository local/memoar)/Formula/memoar.rb" \
  https://github.com/almyty-inc/memoar/releases/latest/download/memoar.rb
brew install local/memoar/memoar
```

### Check what you downloaded

The installers verify the SHA-256 for you. To check a file by hand, and to check
that it was built by this repository's release workflow:

```sh
sha256sum -c SHA256SUMS --ignore-missing      # shasum -a 256 -c on macOS
gh attestation verify memoar-x86_64-unknown-linux-gnu --repo almyty-inc/memoar
```

Whether the macOS and Windows binaries of a release are code-signed is stated
in its release notes. When they are not, macOS does not quarantine a binary
fetched by `curl` or the npm launcher, and Windows SmartScreen may ask once
before the first run.

### From source

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

The npm launcher runs a local build without downloading anything:

```sh
cargo build --release --manifest-path agent/Cargo.toml
MEMOAR_BINARY="$PWD/agent/target/release/memoar" \
MEMOAR_NO_DOWNLOAD=1 \
node packages/npx/bin/memoar.js doctor
```

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

From a release that includes it, the desktop app comes as
`memoar-desktop-<version>-macos-arm64.dmg`, `memoar-desktop-<version>-linux-x64.tar.gz`
and `memoar-desktop-<version>-windows-x64.zip`. Releases built before the
desktop app's packaging script landed do not include it. Packaging is
described in [releasing.md](releasing.md).

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
