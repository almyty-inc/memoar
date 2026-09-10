# Getting started

From nothing to a searchable archive of the coding sessions already sitting on
your machine.

Memoar does not ask your agents to do anything differently. Claude Code, Codex,
Cursor and the rest already write every session to disk; the capture agent finds
those files, uploads them, and the archive parses them into one shape you can
search across all of them.

## What you need

- **An archive** — the service, either running on your own machine or deployed
  somewhere you can reach.
- **The capture agent** — a small program on each computer whose sessions you
  want archived. One machine, one agent.

## 1. Run the archive

There is no hosted Memoar to sign up for. You run it.

```sh
git clone git@github.com:almyty-inc/memoar.git
cd memoar
cp .env.example .env
npm install
make contracts-generate
docker compose -f deploy/docker-compose.dev.yml up --build
```

That starts Postgres, Redis, MinIO, the API, the ingest worker and the web app.
When it settles:

- web app — <http://localhost:5173>
- API health — <http://localhost:4000/health>

`.env` sets `MEMOAR_BOOTSTRAP_EMAIL` and `MEMOAR_BOOTSTRAP_PASSWORD`. That
account is created once, on first start, and never overwritten afterwards —
changing your password is not undone by the next restart. Sign in with it.

The archive starts empty. It holds what you capture and nothing else: there is
no sample data, and there never will be.

For a real deployment — Kubernetes, TLS, backups, migrations — see
[install.md](install.md) and [backup.md](backup.md).

## 2. Build the capture agent

Nothing is published to a package registry yet, so the agent is built from this
repository. You need Rust stable.

```sh
cargo build --release --manifest-path agent/Cargo.toml
```

The binary lands at `agent/target/release/memoar`. Put it on your `PATH`, or
call it by path.

> The web app used to tell you to run `npx memoar connect`. That is not one of
> the CLI's commands, and nothing is published to run it with. Build from source
> until a release channel exists.

## 3. Sign the machine in

```sh
memoar login --endpoint http://localhost:4000/v1 --email you@example.com --password '...'
```

This registers the computer as a **machine** and stores a token scoped to
capture — it can upload sessions and nothing else. The token is written to
`credentials.json` with mode `0600`, separately from the rest of the config.

If you would rather not put a password in your shell history, pass `--token`
with an API key created in **Settings → API keys**.

## 4. See what is on this machine

```sh
memoar sources list
```

Every source the agent recognises on this operating system, with the paths it
will read. Nothing has been uploaded yet — this only looks.

```sh
memoar doctor
```

Reports what is configured, what was detected, and anything that will stop a
sync from working.

## 5. Capture

```sh
memoar sync              # walk every enabled source once
memoar sync --watch      # and keep following them as they grow
```

`--watch` re-reads files as your agents append to them, so a session you are in
the middle of stays current in the archive.

What happens to each file: it is hashed, snapshotted, and uploaded; the archive
stores the **raw bytes** exactly as written, then parses them into a canonical
session. The raw artifact is kept forever, so a parser improvement can be
replayed over everything already captured without asking you to re-upload.

Sessions appear on the timeline as they land.

### Keeping things out of the archive

Redaction is opt-in and applied on your machine, before anything is hashed or
uploaded:

```sh
memoar login --endpoint … --redact-secrets --redact-email-addresses --redact-home-paths
```

Disable a whole source in **Machines & sources** if you would rather it were
never read.

## 6. Import an archive instead

For sessions from a machine you no longer have, or a ChatGPT export, use
**Import** in the web app. It takes one file at a time: a Claude Code JSONL, a
Codex rollout, a Cursor database, a ChatGPT export ZIP, a Memoar bundle. Same
raw-first path as the agent — the bytes are preserved and then parsed.

## Adding a second machine

Build the agent there, sign in to the same account, and sync. The archive is
shared through the service. Do not copy the local queue between machines; each
one keeps its own.

## What next

[Using Memoar](using-memoar.md) — what each screen is for, and what the
archive can do once there is something in it.
