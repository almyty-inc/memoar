# memoar

Archive the coding sessions your AI agents already write to disk, from every
tool you use, in one searchable place you own.

Claude Code, Codex, Cursor, Goose and the rest each keep a transcript of every
session on your machine, in their own format, in their own directory. Memoar's
capture agent finds those files, preserves the original bytes, and uploads them
to your archive, which parses them into one shape — so you can search across all
of them at once, and convert a session from one agent into another agent's
native format.

```sh
npx memoar login --endpoint https://your-archive.example/v1
npx memoar sync --watch
```

That registers this computer, discovers which agents keep sessions on it, and
uploads what it finds. `--watch` keeps following the files as your agents append
to them.

## What this package is

A launcher. It downloads the capture agent binary for your platform, verifies it
against the SHA-256 published beside it, caches it under your user cache
directory, and runs it. A binary whose digest does not match is refused and
nothing is installed.

The agent itself is a Rust program; this package exists so you do not have to
build it.

## You need an archive to send sessions to

Memoar is not a hosted service. You run the archive — Postgres, object storage
and the API — and the agent uploads to it. Setup is in
[the getting started guide](https://github.com/almyty-inc/memoar-releases#readme).

## Commands

| Command | What it does |
| --- | --- |
| `memoar login --endpoint <url>` | Register this machine and store a capture-scoped token |
| `memoar sources list` | Show every agent whose sessions were found here, and where |
| `memoar sync` | Upload what is on disk; `--watch` to keep following |
| `memoar doctor` | Report what is configured and what would stop a sync |
| `memoar search <query>` | Search the archive from the terminal |
| `memoar convert` | Write a session out in another agent's native format |
| `memoar listen` | Materialize conversions the archive sends to this machine |

Every command takes `--json` for a stable machine-readable envelope, and
`--config-dir`, `--data-dir` and `--capture-home` to run against a scratch
location instead of your real one.

## Keeping things out of the archive

Redaction runs on your machine, before anything is hashed or uploaded:

```sh
npx memoar login --endpoint <url> --redact-secrets --redact-email-addresses --redact-home-paths
```

## Environment

| Variable | Effect |
| --- | --- |
| `MEMOAR_BINARY` | Use this binary instead of downloading one |
| `MEMOAR_NO_DOWNLOAD=1` | Never download; require a local binary |
| `MEMOAR_DOWNLOAD_BASE` | Install from a mirror or your own bucket |
| `MEMOAR_PREFER_LOCAL=1` | Prefer a locally built binary over the release |

If a download fails, the launcher looks for a binary in the adjacent Rust
workspace and on your `PATH` before giving up.

## Platforms

macOS on Apple silicon or Intel, Linux on x86-64 or arm64, Windows on x86-64.
The binaries are not code-signed.

Apache-2.0
