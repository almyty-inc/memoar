# Session sources

Each connector fails independently. A missing or unreadable source does not stop other sources from syncing. Unknown formats are uploaded to the raw mirror and marked for parser work.

## Tier 1

| Source | Native store | Stability |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-project>/*.jsonl` | Internal JSONL with `parentUuid` links |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Typed rollout events |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<id>/` | Transcript JSONL, conversation SQLite, and Markdown artifacts |
| Cursor | Global and workspace `state.vscdb` stores | SQLite blobs with known v2 and v3 differences |

## Tier 2

OpenCode, Copilot CLI and Chat, Goose, Crush, Cline, Roo, and Kilo have known local paths and parser fixtures. Use `memoar sources list` to see the resolved path on the current operating system.

## Tier 3 and imports

Antigravity IDE, OpenHands, Droid, Qwen, Kimi, Aider, Continue, Zed, Amp, Warp, and Windsurf are preserved through available local stores with source-specific stability labels. ChatGPT, Claude.ai, Gemini, Mistral, and Perplexity use user-requested export imports. Memoar does not scrape consumer chat browser sessions.

## Redaction

Server-side scanning runs for every upload. Optional client-side scanning can mask keys, tokens, private keys, environment blocks, paths, and email addresses before upload. Always inspect the redaction review before sharing or transferring a session.
