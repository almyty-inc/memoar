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
| Claude Code | `~/.claude/projects/<encoded-project>/*.jsonl`, `~/.claude/history.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<conversation>/` |
| Cursor | VS Code `state.vscdb` stores |
| OpenCode | JSON records or SQLite |
| GitHub Copilot | VS Code JSON or the CLI's SQLite |
| Goose | `~/.local/share/goose/sessions/sessions.db` |
| Crush | `~/.crush/crush.db` |
| Roo Code | task JSON |
| Kilo Code | Cline-family task JSON |
| Zed | Zstd-compressed SQLite threads |

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

## Redaction

The server scans every upload for secrets and records what it found as redaction
masks on the session; the review before sharing lists exactly those findings.

The agent can additionally mask before upload, with three switches: `secrets`,
`emailAddresses` and `homePaths`. They are off unless configured.
