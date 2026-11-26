//! Every agent `integrate` supports, with its paths and entry shape.
//!
//! The source each row was checked against is listed in
//! `docs/agent-integration.md`. A path marked there as inferred is the
//! documented one for the other platforms, carried over the way the tool
//! resolves its home directory.

use serde_json::json;

use super::agents::{Agent, Format, command_line, plain, typed_stdio};

pub(crate) const AGENTS: &[Agent] = &[
    Agent {
        id: "claude-code",
        aliases: &["claude"],
        name: "Claude Code",
        format: Format::Json(&["mcpServers"]),
        config: |env| env.claude_json(),
        skills: Some(|env| env.claude_dir().join("skills")),
        detect: |env| env.claude_dir(),
        entry: |launch| json!({ "type": "stdio", "command": launch.command, "args": launch.args, "env": {} }),
        note: Some(
            "Claude Code rewrites ~/.claude.json while it runs. Restart open sessions to load the server.",
        ),
    },
    Agent {
        id: "codex",
        aliases: &[],
        name: "Codex",
        format: Format::Toml("mcp_servers"),
        config: |env| env.codex_home().join("config.toml"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.codex_home(),
        entry: plain,
        note: Some(
            "Codex asks before each MCP tool call. Set default_tools_approval_mode = \"approve\" on the server to allow them all.",
        ),
    },
    Agent {
        id: "gemini",
        aliases: &["gemini-cli"],
        name: "Gemini CLI",
        format: Format::Json(&["mcpServers"]),
        config: |env| env.gemini_dir().join("settings.json"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.gemini_dir(),
        entry: plain,
        note: None,
    },
    Agent {
        id: "cursor",
        aliases: &[],
        name: "Cursor",
        format: Format::Json(&["mcpServers"]),
        config: |env| env.home.join(".cursor").join("mcp.json"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.home.join(".cursor"),
        entry: typed_stdio,
        note: None,
    },
    Agent {
        id: "opencode",
        aliases: &[],
        name: "OpenCode",
        format: Format::Json(&["mcp"]),
        config: |env| env.xdg_json("opencode", "opencode"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.opencode_dir(),
        entry: |launch| json!({ "type": "local", "command": command_line(launch), "enabled": true }),
        note: None,
    },
    Agent {
        id: "goose",
        aliases: &[],
        name: "Goose",
        format: Format::Yaml("extensions"),
        config: |env| env.goose_config_dir().join("config.yaml"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.goose_config_dir(),
        entry: |launch| {
            json!({
                "type": "stdio",
                "name": "memoar",
                "description": "Memoar archive of past coding sessions",
                "enabled": true,
                "cmd": launch.command,
                "args": launch.args,
                "envs": {},
                "env_keys": [],
                "timeout": 300,
            })
        },
        note: None,
    },
    Agent {
        id: "zed",
        aliases: &[],
        name: "Zed",
        format: Format::Json(&["context_servers"]),
        config: |env| env.zed_dir().join("settings.json"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.zed_dir(),
        entry: |launch| json!({ "command": launch.command, "args": launch.args, "env": {} }),
        note: None,
    },
    Agent {
        id: "vscode",
        aliases: &["copilot", "vscode-copilot"],
        name: "VS Code (GitHub Copilot)",
        format: Format::Json(&["servers"]),
        config: |env| env.vscode_user_dir().join("mcp.json"),
        skills: Some(|env| env.copilot_home().join("skills")),
        detect: |env| env.vscode_user_dir(),
        entry: typed_stdio,
        note: None,
    },
    Agent {
        id: "copilot-cli",
        aliases: &[],
        name: "GitHub Copilot CLI",
        format: Format::Json(&["mcpServers"]),
        config: |env| env.copilot_home().join("mcp-config.json"),
        skills: Some(|env| env.copilot_home().join("skills")),
        detect: |env| env.copilot_home(),
        entry: |launch| json!({ "type": "local", "command": launch.command, "args": launch.args, "env": {}, "tools": ["*"] }),
        note: None,
    },
    Agent {
        id: "windsurf",
        aliases: &[],
        name: "Windsurf (Cascade)",
        format: Format::Json(&["mcpServers"]),
        config: |env| {
            env.home
                .join(".codeium")
                .join("windsurf")
                .join("mcp_config.json")
        },
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.home.join(".codeium").join("windsurf"),
        entry: plain,
        note: Some(
            "Windsurf is now Devin Desktop. Its Devin Local agent reads the devin entry instead.",
        ),
    },
    Agent {
        id: "devin",
        aliases: &["devin-desktop"],
        name: "Devin Desktop (Devin Local)",
        format: Format::Json(&["mcpServers"]),
        config: |env| env.devin_dir().join("mcp_config.json"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.devin_dir(),
        entry: plain,
        note: None,
    },
    Agent {
        id: "cline",
        aliases: &[],
        name: "Cline",
        format: Format::Json(&["mcpServers"]),
        config: |env| {
            env.cline_data()
                .join("settings")
                .join("cline_mcp_settings.json")
        },
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.cline_dir(),
        entry: |launch| json!({ "command": launch.command, "args": launch.args, "env": {}, "disabled": false, "autoApprove": [] }),
        note: None,
    },
    Agent {
        id: "roo",
        aliases: &["roo-code"],
        name: "Roo Code",
        format: Format::Json(&["mcpServers"]),
        config: |env| {
            env.vscode_global_storage("rooveterinaryinc.roo-cline")
                .join("settings")
                .join("mcp_settings.json")
        },
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.vscode_global_storage("rooveterinaryinc.roo-cline"),
        entry: |launch| json!({ "command": launch.command, "args": launch.args, "env": {} }),
        note: None,
    },
    Agent {
        id: "kilo",
        aliases: &["kilo-code"],
        name: "Kilo Code",
        format: Format::Json(&["mcp"]),
        config: |env| env.xdg_json("kilo", "kilo"),
        skills: Some(|env| env.shared_skills()),
        detect: |env| env.kilo_dir(),
        entry: |launch| json!({ "type": "local", "command": command_line(launch), "enabled": true }),
        note: None,
    },
];
