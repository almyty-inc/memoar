# Agent integration

One command gives a coding agent the archive as memory:

```sh
memoar login --endpoint https://<memoar-host>/v1
memoar integrate claude-code codex
```

`memoar integrate <agent>` does two things for each agent named. It registers `memoar mcp` as a local stdio MCP server in the agent's own config file, and it installs the `memoar-memory` skill where that agent loads skills from. The agent then reaches the archive with the credential `memoar login` stored. There is no API key to paste and no header to configure.

## Commands

| Command | What it does |
| --- | --- |
| `memoar integrate` | Lists every supported agent, whether it is installed here, its config and skill paths, and whether memoar's entry is `missing`, `current` or `different`. Changes nothing. |
| `memoar integrate <agent>...` | Registers the MCP server and installs the skill. `all` means every supported agent found on this computer. |
| `--dry-run` | Reports each file it would create, update or leave unchanged, with the entry it would write. Writes nothing. |
| `--uninstall` | Removes memoar's entry and the skill files. Everything else in those files stays. |
| `--mcp-only`, `--skill-only` | Does one half. |
| `--command <path>` | The program the agent starts. Defaults to the absolute path of the running `memoar`, because an editor launched from the desktop does not see the shell's `PATH`. |
| `memoar mcp` | The stdio MCP server the agents start. |
| `memoar mcp tools` | Lists the archive's MCP tools with their input schemas. |
| `memoar mcp call <tool> '<json>'` | Calls one tool from a shell. `-` reads the arguments from standard input. |

`memoar integrate` run with `--config-dir` or `--data-dir` (or `MEMOAR_CONFIG_DIR` and `MEMOAR_DATA_DIR`) writes the same flags into the entry, so the agent serves that install's credential.

## What it promises about your files

- **Merge, never replace.** Only the entry named `memoar` changes. JSON and JSONC files are edited through a syntax tree that keeps comments and trailing commas. Codex's TOML is edited with a format-preserving parser. Goose's YAML is edited line by line under `extensions:`.
- **Back up first.** Before an existing file changes, its previous bytes are copied to `<file>.memoar-backup`, or `<file>.memoar-backup-N` when that name is taken. A run never overwrites an earlier backup.
- **Idempotent.** A second run reports `unchanged` and writes nothing.
- **All or nothing across agents.** Every file is planned before the first is written. One file that cannot be parsed stops the run with nothing changed, and the message names the file.
- **Refuse rather than guess.** A key that holds something other than an object, or Goose `extensions` in flow style, is refused. `--dry-run` shows the entry to add by hand.
- **Symlinks stay symlinks.** A config kept in a dotfiles repository is written through the link.
- **Atomic.** Each write goes to a temporary file that is renamed over the old one.

## Supported agents

`~` is the home directory: `%USERPROFILE%` on Windows. `%APPDATA%` is the roaming application data folder. "XDG" means `$XDG_CONFIG_HOME`, or `~/.config` when it is unset.

| Agent | id | MCP config (macOS / Linux / Windows) | Entry | Skill directory |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` | `mcpServers`, `type: stdio` | `~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills` |
| Codex | `codex` | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `[mcp_servers.memoar]` | `~/.agents/skills` |
| Gemini CLI | `gemini` | `~/.gemini/settings.json`, or under `$GEMINI_CLI_HOME` | `mcpServers` | `~/.agents/skills` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `mcpServers`, `type: stdio` | `~/.agents/skills` |
| OpenCode | `opencode` | XDG `opencode/opencode.json`, or an existing `opencode.jsonc`. Windows also uses `~/.config` | `mcp`, `type: local`, V1 shape | `~/.agents/skills` |
| Goose | `goose` | XDG `goose/config.yaml` / `%APPDATA%\Block\goose\config\config.yaml`, or `$GOOSE_PATH_ROOT/config/config.yaml` | `extensions`, `type: stdio` | `~/.agents/skills` |
| Zed | `zed` | `~/.config/zed/settings.json` / XDG `zed/settings.json` / `%APPDATA%\Zed\settings.json` | `context_servers`, flat `command` | `~/.agents/skills` |
| VS Code (Copilot) | `vscode` | `~/Library/Application Support/Code/User/mcp.json` / XDG `Code/User/mcp.json` / `%APPDATA%\Code\User\mcp.json` | `servers`, `type: stdio` | `~/.copilot/skills`, or `$COPILOT_HOME/skills` |
| Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json`, or `$COPILOT_HOME` | `mcpServers`, `type: local` | `~/.copilot/skills` |
| Windsurf (Cascade) | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `~/.agents/skills` |
| Devin Desktop (Devin Local) | `devin` | `~/.config/devin/mcp_config.json` / same / `%APPDATA%\devin\mcp_config.json` | `mcpServers` | `~/.agents/skills` |
| Cline | `cline` | `~/.cline/data/settings/cline_mcp_settings.json`, or under `$CLINE_DIR` / `$CLINE_DATA_DIR` | `mcpServers` | `~/.agents/skills` |
| Roo Code | `roo` | `<VS Code User>/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | `mcpServers` | `~/.agents/skills` |
| Kilo Code | `kilo` | XDG `kilo/kilo.json`, or an existing `kilo.jsonc` | `mcp`, `type: local` | `~/.agents/skills` |

`~/.agents/skills` is the user-level skills directory that Codex, Gemini CLI, Cursor, OpenCode, Goose, Zed, Devin, Cline, Roo and Kilo all read. Several agents share that one copy, so `--uninstall` for any one of them removes the skill for all of them.

### Notes per agent

- **Claude Code** rewrites `~/.claude.json` while it runs. Run `integrate` with no Claude Code session open, or restart open sessions afterwards.
- **Codex** asks before every MCP tool call unless the server is pre-approved. `integrate` does not approve on your behalf. To allow memoar's tools without a prompt, add `default_tools_approval_mode = "approve"` under `[mcp_servers.memoar]`. `codex exec` refuses tool calls that need approval.
- **Windsurf** was renamed Devin Desktop. The legacy Cascade agent reads `~/.codeium/windsurf/mcp_config.json`, and the Devin Local agent reads the `devin` file. Register both if both are in use.
- **OpenCode and Kilo** accept the V1 `mcp` shape in every current version, so that is what is written.
- **Roo Code**'s repository was archived. A custom `roo-cline.customStoragePath` setting moves its file, and `integrate` does not read that setting.

### Where each path comes from

| Agent | Source |
| --- | --- |
| Claude Code | code.claude.com/docs/en/mcp, /en/settings, /en/skills, /en/claude-directory |
| Codex | learn.chatgpt.com/docs/extend/mcp, learn.chatgpt.com/docs/build-skills, openai/codex `codex-rs/utils/home-dir`, `codex-rs/ext/skills/src/host_roots.rs` |
| Gemini CLI | google-gemini/gemini-cli `docs/reference/configuration.md`, `docs/cli/skills.md`, `packages/cli/src/config/settings.ts` |
| Cursor | cursor.com/docs/context/mcp, cursor.com/docs/context/skills |
| OpenCode | opencode.ai/docs/config, /docs/mcp-servers, /docs/skills, anomalyco/opencode `packages/util/src/global-roots.ts`, `packages/core/src/v1/config/mcp.ts` |
| Goose | aaif-goose/goose `documentation/docs/guides/config-files.md`, `crates/goose/src/config/paths.rs`, `crates/oi-kit-agent/src/extension.rs` |
| Zed | zed.dev/docs/ai/mcp, zed.dev/docs/ai/skills, zed-industries/zed `crates/paths/src/paths.rs`, `crates/settings_content/src/project.rs` |
| VS Code | code.visualstudio.com/docs/agents/reference/mcp-configuration, /docs/copilot/customization/agent-skills, /docs/configure/settings |
| Copilot CLI | docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers, /create-skills |
| Windsurf, Devin | docs.devin.ai/desktop/devin-desktop-faq, docs.devin.ai/cli/extensibility/mcp/configuration, docs.devin.ai/desktop/cascade/skills |
| Cline | cline/cline `docs/mcp/mcp-overview.mdx`, `docs/getting-started/config.mdx`, `docs/customization/skills.mdx`, `apps/vscode/src/sdk/SdkController.ts` |
| Roo Code | RooCodeInc/Roo-Code `src/shared/globalFileNames.ts`, `src/utils/storage.ts`, `src/services/mcp/McpHub.ts` |
| Kilo Code | Kilo-Org/kilocode `packages/kilo-docs/pages/automate/mcp/using-in-kilo-code.md`, `packages/kilo-docs/pages/customize/skills.md`, `packages/opencode/src/kilocode/paths.ts` |

Some paths were not stated outright in those sources and are inferred:

- the Windows paths for Cursor, Windsurf and Copilot CLI, which are the home-relative path the tool uses everywhere else
- the per-OS VS Code `mcp.json`, which sits beside the documented `settings.json`
- the Devin path on macOS and Linux
- the exact field list Roo Code accepts beyond `command`, `args` and `env`

The documentation also conflicts on one point. One Devin page lists the legacy Windsurf file as `~/.codeium/mcp_config.json` rather than `~/.codeium/windsurf/mcp_config.json`.

Proven end to end with real agents: Claude Code and Codex, through MCP and through the skill and CLI. The rest are covered by unit tests of the paths and file edits, not by a run of the agent itself.

## Credentials

`memoar mcp` signs in with the API key `memoar login` stored and forwards each JSON-RPC message to the archive's `/mcp` endpoint. That key carries `mcp:use` from this release on. A key minted by an older `memoar login` does not, and the archive refuses it with a message that says to run `memoar login` again. Writes such as `save_note` also need `archive:write`, which the login key carries.

## Without MCP

An agent that has the skill but no MCP client runs the same tools from a shell:

```sh
memoar mcp call search_sessions '{"query":"rate limiter decision"}' --json
memoar mcp call list_memory_documents '{"scope":"project","workspacePath":"/path/to/repo"}' --json
printf '%s' '{"sessionId":"<uuid>","topic":"auth","markdown":"Decided to ..."}' | memoar mcp call save_note - --json
```
