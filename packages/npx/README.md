# memoar

Your AI assistants already write every session to disk. Memoar collects those
files from every tool, keeps the original bytes, and turns them into one history
you can search — across Claude Code, Codex, Cursor, Goose and the rest at once.

This package is the capture agent: the part that runs on your machine and finds
those files. It reads the eleven coding agents that keep transcripts locally,
and the instruction files they read — `CLAUDE.md`, `AGENTS.md`, `.goosehints`
and the rest — keeping a revision each time one changes.

Conversations from hosted products arrive a different way: a ChatGPT export is
uploaded to the archive through the web app, and lands in the same history.

## See what is on this machine

Nothing to install, nothing to sign up for. This reads your disk and reports
what it finds:

```sh
npx memoar sources list
```

```
Claude Code      found      ~/.claude/projects/*/*.jsonl
Codex CLI        found      ~/.codex/sessions/*/*/*/rollout-*.jsonl
Antigravity CLI  found      ~/.gemini/antigravity-cli/brain/*/…/transcript.jsonl
Cursor           not found  ~/Library/Application Support/Cursor/…/state.vscdb
… 11 sources checked
```

It uploads nothing. It only looks.

## Archiving them needs somewhere to put them

**Memoar is self-hosted. There is no service to sign up for**, and this package
alone cannot archive anything — it needs an archive to send sessions to, and you
run that: Postgres, object storage, and the API, which is a `docker compose up`
away and yours to keep running.

Setting one up is [the getting started
guide](https://github.com/almyty-inc/memoar/blob/main/docs/getting-started.md),
and it is worth reading before the commands below, because every one of them
needs an endpoint.

Once you have one:

```sh
npx memoar login --endpoint https://your-archive.example/v1
npx memoar sync --watch
```

`login` registers this computer and stores a token scoped to capture — it can
upload sessions and nothing else. `sync` uploads what is on disk; `--watch`
keeps following the files as your agents append to them, so a session you are in
the middle of stays current.

## Commands

| Command | Needs an archive |
| --- | --- |
| `memoar sources list` | no |
| `memoar --version`, `--help` | no |
| `memoar login --endpoint <url>` | yes |
| `memoar sync [--watch]` | yes |
| `memoar doctor` | yes |
| `memoar search <query>` | yes |
| `memoar view <session>` | yes |
| `memoar pack` | yes |
| `memoar convert` | yes |
| `memoar listen` | yes |

Every command takes `--json` for a stable machine-readable envelope, and
`--config-dir`, `--data-dir` and `--capture-home` to run against a scratch
location instead of your real one.

## Keeping things out of the archive

Redaction runs here, on your machine, before anything is hashed or uploaded:

```sh
npx memoar login --endpoint <url> --redact-secrets --redact-email-addresses --redact-home-paths
```

Sessions are private to your account. Sharing one always goes through a
redaction review first, in the web app.

## What this package actually does

It is a launcher. The agent is a Rust binary; this downloads the one for your
platform from the project's releases, checks it against the SHA-256 published
beside it, caches it under your user cache directory, and runs it. A binary
whose digest does not match is refused and nothing is installed.

| Variable | Effect |
| --- | --- |
| `MEMOAR_BINARY` | Use this binary instead of downloading one |
| `MEMOAR_NO_DOWNLOAD=1` | Never download; require a local binary |
| `MEMOAR_DOWNLOAD_BASE` | Install from a mirror or your own bucket |
| `MEMOAR_PREFER_LOCAL=1` | Prefer a locally built binary over the release |

If a download fails it looks for a binary in the adjacent Rust workspace and on
your `PATH` before giving up.

macOS on Apple silicon or Intel, Linux on x86-64 or arm64, Windows on x86-64.
The binaries are not code-signed.

Apache-2.0 · [source](https://github.com/almyty-inc/memoar)
