# Session sources

A source is supported when the archive can parse what the tool writes, and that
claim is tested: `server/test/parsers.test.ts` records which formats were checked
against real output from the tool itself, and
`server/test/agent-server-agreement.test.ts` fails in both directions if the
capture agent collects something the archive cannot parse, or the archive parses
something nothing captures.

Anything not listed here is not supported. This page previously advertised
Cline, OpenHands, Droid, Qwen, Kimi, Aider, Continue, Amp, Warp and Windsurf,
plus Claude.ai, Gemini, Mistral and Perplexity exports, none of which had a
parser; the agent collected files it could not read and the archive marked them
`unknown_format`.

## Captured from a machine

The capture agent finds these on disk. `memoar sources list` resolves the paths
for the operating system it runs on.

| Source | Native store |
| --- | --- |
| Claude Code | `~/.claude/projects/<encoded-project>/*.jsonl` and the subagent transcripts beneath each session, `<session>/subagents/*.jsonl` and `<session>/subagents/workflows/*/*.jsonl` |
| Claude Desktop local agent mode (macOS, as Claude Code) | `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/local_<session>/.claude/projects/<project>/*.jsonl` and its `subagents/*.jsonl`, plus the same below `agent/local_<session>/` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl` |
| Cursor | VS Code `state.vscdb` stores |
| OpenCode | JSON records or SQLite |
| GitHub Copilot | VS Code JSON or the CLI's SQLite |
| Goose | `~/.local/share/goose/sessions/sessions.db` |
| Crush | `~/.crush/crush.db` |
| Roo Code | task JSON |
| Kilo Code | Cline-family task JSON |
| Zed | Zstd-compressed SQLite threads |

Each source names the exact transcript files its parser reads, at each depth
they are written. Nothing else in those trees is taken. In Claude Desktop that
means the session's settings file `local_<session>.json`, `audit.jsonl` (a
signed audit stream of the same conversation), task lists, plugin checkouts,
debug logs, `outputs/` and `uploads/` all stay on the machine.

### Never captured

After every source's patterns, and for every memory file, the agent drops
anything on its deny list (`agent/crates/memoar-connectors/src/deny.rs`):

- anything inside `.git`, `.hg`, `.svn`, `.ssh`, `.gnupg` or `.aws`
- `.DS_Store`, `.audit-key`, `.claude.json` and its backups, `.credentials.json`,
  `credentials.json`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.env`
  and `.env.*`
- `*.key`, `*.pem`, `*.p12`, `*.pfx`, keychains, and SSH keys named `id_*`

`npm run capture:check` fails when a capture pattern could name one of these
and the list does not refuse it, and when a pattern names a file type its
parser does not read.

### How the archive recognises an upload

The agent sends only the tool name as `x-memoar-source`. The server reads the
first records of the upload and checks the fields its parser needs, for
example `step_index` and `type` for Antigravity or `session_meta` for Codex,
to choose the parser version (`server/src/ingest/format-detection.ts`).
`server/test/format-detection.test.ts` runs every contract fixture through
that path with the bare tool name and requires its own version.

## Imported, not captured

These arrive as a file somebody uploads, so no agent looks for them:

- **ChatGPT export** — the ZIP the vendor hands you.
- **Canonical bundle** — a Memoar export, for moving an archive.
- **CASS export** — the interchange format.

## Agent memory

The instruction files those tools read — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`.goosehints`, `.cursor/rules/*.mdc`, `.roo/rules/`, `.kilocode/rules/`,
`.github/copilot-instructions.md`, `.rules` and the Claude Code memory
directory — are captured too, with a revision kept each time one changes. Every
path was checked against the tool's own published source; see
`agent/crates/memoar-connectors/src/memory.rs`.

Memory files go to `POST /memory` as revisions. They are never uploaded as raw
session artifacts, so a `.md` file stored as a `claude-code` artifact came from
an agent build older than commit 31897b4 (2026-09-17), which walked every file
beneath a pattern's fixed prefix without applying the pattern.

## Redaction

The server scans every upload for secrets and records what it found as redaction
masks on the session; the review before sharing lists exactly those findings.

The agent can additionally mask before upload, with three switches: `secrets`,
`emailAddresses` and `homePaths`. They are off unless configured.
