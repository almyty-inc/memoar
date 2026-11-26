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

Paths are relative to the home directory. "VS Code user data" is
`~/Library/Application Support/Code/User` on macOS, `~/.config/Code/User` on
Linux and `%APPDATA%\Code\User` on Windows. The last column says whether the
current layout was read off a real store on 2026-11-26 or only off the tool's
own source.

| Source | Native store | Current layout checked |
| --- | --- | --- |
| Claude Code | `.claude/projects/<encoded-project>/*.jsonl` and the subagent transcripts beneath each session, `<session>/subagents/*.jsonl` and `<session>/subagents/workflows/*/*.jsonl` | real store |
| Claude Desktop local agent mode (macOS, as Claude Code) | `Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/local_<session>/.claude/projects/<project>/*.jsonl` and its `subagents/*.jsonl`, plus the same below `agent/local_<session>/` | real store |
| Codex CLI | `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `rollout-*.jsonl.zst`, or the same under `CODEX_HOME` | real store, all 3,882 rollouts |
| Antigravity CLI | `.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl` | real store, all 655 |
| Cursor | `state.vscdb` in Cursor's `globalStorage` and `workspaceStorage/*` | source only |
| OpenCode | `.local/share/opencode/opencode.db` or `opencode-<channel>.db`, under `XDG_DATA_HOME` when set, on every platform | real store |
| GitHub Copilot | VS Code user data `workspaceStorage/*/chatSessions/*.json(l)` and `globalStorage/emptyWindowChatSessions/*.json(l)`, the CLI's `.copilot/session-state/<id>/events.jsonl` and `.copilot/session-store.db` | VS Code files and CLI database: real, but empty. `events.jsonl`: source only |
| Goose | `.local/share/goose/sessions/sessions.db` | source only |
| Crush | `.crush/crush.db` | real store |
| Roo Code | VS Code user data `globalStorage/rooveterinaryinc.roo-cline/tasks/*/api_conversation_history.json` | source only |
| Kilo Code | `.local/share/kilo/kilo.db` or `kilo-<channel>.db` (opencode's schema), and the older extension's `globalStorage/kilocode.kilo-code/tasks/*/api_conversation_history.json` | source only |
| Zed | `threads/threads*.db` in Zed's data directory: `Library/Application Support/Zed`, `.local/share/zed`, or `AppData/Local/Zed` | real store (macOS) |

Codex compresses a rollout it has not touched for a while into
`rollout-*.jsonl.zst` and deletes the plain file. On the machine checked,
3,405 of 3,882 rollouts were compressed and none of them had ever been
captured. The agent now decompresses them itself, before redaction, so
redaction sees the text. It tells the archive the plain file name, so a
rollout that Codex compresses, or decompresses again to append to it, stays
one session.

Each turn records the model that produced it where the store says: Codex
`turn_context.model`, OpenCode and Kilo `modelID`, Crush `messages.model`,
Copilot `selectedModel` and `model`, Cursor `modelInfo.modelName`. The
session's `models` lists them, and Goose's comes from `model_config_json`.

Antigravity also writes `conversations/<id>.db`, protobuf steps with no
published schema. Every conversation on the machine checked still has its
`transcript.jsonl`, and every transcript step is a database row at the same
index. What only the database holds is model error details and cancelled tool
calls, so the database is not captured.

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

`scripts/verify-store-sweep.mjs` puts every file of the Codex, Antigravity,
Copilot, OpenCode and Kilo stores on a machine through that same path and
prints counts. `scripts/verify-parsers-locally.mjs` reads the newest file of
every source.

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
