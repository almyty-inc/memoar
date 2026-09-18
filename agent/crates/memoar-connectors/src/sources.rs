//! The capture table: every source this agent knows how to find.

use crate::spec::{SourceSpec, Stability};

const NONE: &[&str] = &[];

pub static SOURCES: &[SourceSpec] = &[
    SourceSpec {
        id: "claude-code",
        display_name: "Claude Code",
        tier: 1,
        format: "JSONL parentUuid stream",
        stability: Stability::Internal,
        common_paths: &[".claude/projects/*/*.jsonl", ".claude/history.jsonl"],
        linux_paths: NONE,
        // The transcripts, not the trees the sessions built beside them. These
        // were bare directories, and a bare directory means everything beneath
        // it: on one machine that was 5,392 files — markdown, TypeScript,
        // Python, JPEGs and node_modules the agent had written into its own
        // working directory — offered to the uploader by a source that promises
        // session stores and nothing else.
        macos_paths: &[
            "Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json",
            "Library/Application Support/Claude/local-agent-mode-sessions/*/*/local_*.json",
        ],
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "codex",
        display_name: "Codex CLI",
        tier: 1,
        format: "typed rollout JSONL",
        stability: Stability::Internal,
        common_paths: &[".codex/sessions/*/*/*/rollout-*.jsonl"],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: Some("CODEX_HOME"),
        environment_roots: &[".codex"],
    },
    SourceSpec {
        id: "antigravity-cli",
        display_name: "Antigravity CLI",
        tier: 1,
        format: "brain directory",
        stability: Stability::Internal,
        common_paths: &[
            ".gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl",
            ".gemini/antigravity-cli/brain/*/conversations/*.db",
            ".gemini/antigravity-cli/brain/*/*.md",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "cursor",
        display_name: "Cursor",
        tier: 1,
        format: "VS Code state SQLite",
        stability: Stability::ReverseEngineered,
        common_paths: NONE,
        linux_paths: &[
            ".config/Cursor/User/globalStorage/state.vscdb",
            ".config/Cursor/User/workspaceStorage/*/state.vscdb",
        ],
        macos_paths: &[
            "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
            "Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb",
        ],
        windows_paths: &[
            "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
            "AppData/Roaming/Cursor/User/workspaceStorage/*/state.vscdb",
        ],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "opencode",
        display_name: "OpenCode",
        tier: 2,
        format: "JSON records or SQLite",
        stability: Stability::Internal,
        // The stored records, not the directory they sit in. `storage` was a
        // bare path, and a bare path is a sweep: the same 5,392-file incident
        // that put globs on Claude Code was waiting under every one of these.
        common_paths: &[
            // `storage/` is opencode's configuration — `project/global.json` and
            // a migration marker. The sessions are in the database, which is
            // also the only thing the parser accepts: it refuses anything that
            // is not native SQLite. Collecting the JSON uploaded a config file
            // on every sync and produced an `unknown_format` artifact each time.
            ".local/share/opencode/opencode.db",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: &["AppData/Roaming/opencode/opencode.db"],
        environment_override: Some("OPENCODE_DATA_DIR"),
        environment_roots: &[".local/share/opencode", "AppData/Roaming/opencode"],
    },
    SourceSpec {
        id: "copilot",
        display_name: "GitHub Copilot",
        tier: 2,
        format: "VS Code JSON or CLI SQLite",
        stability: Stability::Internal,
        common_paths: &[
            ".copilot/session-state/*.json",
            ".copilot/session-state/*/*.json",
            ".copilot/history-session-state/*.json",
            ".copilot/history-session-state/*/*.json",
            ".copilot/session-store.db",
        ],
        linux_paths: &[".config/Code/User/workspaceStorage/*/chatSessions/*.json"],
        macos_paths: &[
            "Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.json",
        ],
        windows_paths: &["AppData/Roaming/Code/User/workspaceStorage/*/chatSessions/*.json"],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "goose",
        display_name: "Goose",
        tier: 2,
        format: "SQLite or legacy JSONL",
        stability: Stability::Internal,
        common_paths: &[
            ".local/share/goose/sessions/sessions.db",
            ".local/share/goose/sessions/*.jsonl",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: &[
            "AppData/Roaming/Block/goose/data/sessions/*.db",
            "AppData/Roaming/Block/goose/data/sessions/*.jsonl",
        ],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "crush",
        display_name: "Crush",
        tier: 2,
        format: "SQLite",
        stability: Stability::Internal,
        common_paths: &[".crush/crush.db"],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "roo",
        display_name: "Roo Code",
        tier: 2,
        format: "task JSON",
        stability: Stability::Internal,
        common_paths: NONE,
        // One directory per task, holding that task's JSON. The directory
        // itself also accumulates whatever the extension caches there.
        linux_paths: &[".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/*.json"],
        macos_paths: &[
            "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/*.json",
        ],
        windows_paths: &[
            "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/*.json",
        ],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "kilo",
        display_name: "Kilo Code",
        tier: 2,
        format: "Cline-family task JSON",
        stability: Stability::Internal,
        common_paths: NONE,
        linux_paths: &[".config/Code/User/globalStorage/kilocode.kilo-code/tasks/*/*.json"],
        macos_paths: &[
            "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks/*/*.json",
        ],
        windows_paths: &[
            "AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks/*/*.json",
        ],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "zed",
        display_name: "Zed",
        tier: 3,
        format: "Zstd-compressed SQLite threads",
        stability: Stability::ReverseEngineered,
        common_paths: NONE,
        // The thread databases, not the write-ahead logs, lock files and
        // whatever else lives in a database directory.
        // `db/` is the editor's own state — panes, terminals, breakpoints,
        // keybindings. The agent threads are a separate database, and the
        // parser reads exactly one table, `threads`, which only that one has.
        // Pointed at `db/` this captured the editor's terminal history and
        // never captured a single session.
        linux_paths: &[".local/share/zed/threads/threads*.db"],
        macos_paths: &["Library/Application Support/Zed/threads/threads*.db"],
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
];
