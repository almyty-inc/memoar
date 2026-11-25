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

## Keep capture running in the background

`memoar sync --watch` captures only while something keeps it running. Started
from a terminal, it ends when that terminal closes, and nothing says so. Install
it as a service instead:

```sh
memoar login --endpoint https://archive.example.com/v1 --email you@example.com --password -
memoar service install
```

That installs a per-user service in the platform's own service manager. It
starts at login, restarts the watch after a crash or a lost network, and writes
its log to `logs/agent.log` in the data directory. Nothing needs administrator
rights.

| | macOS | Linux | Windows |
|---|---|---|---|
| Manager | launchd LaunchAgent | systemd user unit | Task Scheduler, at logon |
| Definition | `~/Library/LaunchAgents/dev.memoar.agent.plist` | `$XDG_CONFIG_HOME/systemd/user/memoar-agent.service` | Task `\Memoar\agent` |
| Restart after a failure | `KeepAlive` on a non-zero exit, `ThrottleInterval` 30s | `Restart=on-failure`, `RestartSec=30` | `RestartOnFailure`, every minute |

The service runs `memoar service run`, which starts `memoar sync --watch` and
watches it:

- A watch that crashes or exits on an error that waiting can fix is started
  again after 10 seconds, doubling to 5 minutes, and back to 10 seconds after a
  healthy run of 10 minutes or more.
- A watch that exits 2, 3 or 5 is not started again. Those are a setting no
  capture can satisfy, a configuration that is signed out, and an archive that
  refused this machine (a revoked key or a deregistered machine). Restarting
  cannot change them. The service records the reason and exits 0, which each
  service manager above treats as "stay stopped". `memoar status` and
  `memoar doctor` then say `background capture stopped:` and the reason.
- The service writes absolute paths for the binary and for all three
  directories into its definition, so it runs the same configuration whatever
  environment the service manager starts it in. An install with
  `--config-dir`, `--data-dir` or `--capture-home` gets a service for those.
- An upgrade that replaces the binary in place (the installers above, or
  `brew upgrade`, whose `/opt/homebrew/bin/memoar` path stays the same) is
  picked up within a minute: the service sees the file change and restarts the
  watch on the new binary.

`memoar service install` is safe to run again. It rewrites the definition and
restarts the service, which is also how to start it again after it stopped.

```sh
memoar service status        # installed, running, and whether capture is
memoar service logs          # the end of logs/agent.log
memoar service uninstall     # stop it and remove the definition
```

The log is rotated at 5 MiB with two older copies kept. A line that repeats the
one before it is counted rather than written, so an idle watch does not grow it.

`memoar logout` removes the service for that configuration as well, because it
cannot capture without the credential. Pass `--keep-service` to leave it.

### Per platform

**macOS.** The LaunchAgent is loaded with `launchctl bootstrap gui/$UID` and
runs while you are logged in. `launchctl print gui/$UID/dev.memoar.agent` shows
what launchd knows about it.

**Linux.** The unit is enabled with `systemctl --user enable` and restarted.
A user unit runs while you have a session. To keep capturing after you log out,
run `loginctl enable-linger` once. `memoar service install` says so when
lingering is off and does not change it for you. Without a systemd user session
(a container, WSL without systemd, or an init system other than systemd) the
install stops with `MEMOAR_SERVICE` and says what to use instead: your
desktop's autostart, or a `@reboot` crontab line running `memoar sync --watch`.

**Windows.** The task runs at your logon, as you, without administrator rights.
`memoar.exe` is a console program, so the task starts it through
`conhost.exe --headless`, which gives it a console without a window. The
installer replaces `memoar.exe` by renaming the running one aside, so upgrading
works while the service runs.

### Two configurations on one machine

Each service has a name, `agent` unless you pass `--name`. A second
configuration needs a second name:

```sh
memoar service install --name work --config-dir ~/work/memoar --data-dir ~/work/memoar-data
```

`install` and `uninstall` refuse to replace or remove a service of the same name
that belongs to another configuration directory, unless you pass `--force`.

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

"Open web app" goes to the archive address without its `/v1`. When the web
application is served from somewhere else, as in the Compose stack where the
API is on port 4000 and the web app on 5173, give its address in the optional
"Web app address" field at sign-in. The app keeps it on this machine.

Failures are handled by kind. An archive that cannot be reached, or answers
with a server error, is tried again on the next cycle. A wrong password is
refused at sign-in with the archive's reason. When the archive stops accepting
the machine's key, because it was revoked or the machine was removed, the app
stops capturing and asks for a new sign-in instead of retrying every two
minutes.

The app runs the CLI's own code and reads and writes the same configuration
and offline queue as `memoar` (see "Where the agent keeps its files"), so a
machine set up with one is already set up for the other. It honours
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
and keeps them as workflow artifacts.

A release ships the desktop app as `memoar-desktop-<version>-macos-arm64.dmg`,
`memoar-desktop-<version>-linux-x64.tar.gz` and
`memoar-desktop-<version>-windows-x64.zip`. The release workflow signs and
notarizes the macOS app and signs the Windows one when the signing secrets are
set, and marks them unsigned when they are not. Releases built before the
desktop app's packaging script landed do not include it. Packaging and signing
are described in [releasing.md](releasing.md).

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
