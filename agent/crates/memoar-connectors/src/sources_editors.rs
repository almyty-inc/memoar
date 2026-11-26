//! The sources that live inside an editor's own storage, or beside it.
//!
//! Windows paths follow where each editor puts its user data: VS Code and its
//! forks use `%APPDATA%`, which is `AppData/Roaming` under the home directory.

use crate::spec::{SourceSpec, Stability};

const NONE: &[&str] = &[];

pub(crate) const CURSOR: SourceSpec = SourceSpec {
    id: "cursor",
    display_name: "Cursor",
    tier: 1,
    format: "VS Code state SQLite",
    stability: Stability::ReverseEngineered,
    common_paths: NONE,
    // Cursor 3.x still keeps every conversation in the global `state.vscdb`:
    // `composerData:<id>` and `bubbleId:<composer>:<bubble>` rows in
    // `cursorDiskKV`, and the `composer.composerHeaders` index in `ItemTable`.
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
};

pub(crate) const COPILOT: SourceSpec = SourceSpec {
    id: "copilot",
    display_name: "GitHub Copilot",
    tier: 2,
    format: "VS Code chat log, CLI events JSONL or CLI SQLite",
    stability: Stability::Internal,
    // The CLI writes one `session-state/<id>/events.jsonl` per session, the
    // event stream its SDK publishes the schema of
    // (`github/copilot-sdk`, `nodejs/src/generated/session-events.ts`).
    // `session-store.db` beside it is an index with a `turns` table. Neither
    // the `workspace.yaml` nor the `checkpoints/` beside the events is a
    // transcript, so only `events.jsonl` is named.
    common_paths: &[
        ".copilot/session-store.db",
        ".copilot/session-state/*/events.jsonl",
    ],
    // VS Code writes a panel as `<id>.json` (before 1.109) or as `<id>.jsonl`,
    // a `{kind:0}` snapshot followed by `kind` 1, 2 and 3 writes against it
    // (`chatSessionStore.ts`, `objectMutationLog.ts`). A panel opened with no
    // folder goes to `globalStorage/emptyWindowChatSessions/` instead, and
    // `workspaceStorage/no-workspace/chatSessions/` is matched by the `*`.
    linux_paths: &[
        ".config/Code/User/workspaceStorage/*/chatSessions/*.json",
        ".config/Code/User/workspaceStorage/*/chatSessions/*.jsonl",
        ".config/Code/User/globalStorage/emptyWindowChatSessions/*.json",
        ".config/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl",
    ],
    macos_paths: &[
        "Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.json",
        "Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl",
        "Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.json",
        "Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl",
    ],
    windows_paths: &[
        "AppData/Roaming/Code/User/workspaceStorage/*/chatSessions/*.json",
        "AppData/Roaming/Code/User/workspaceStorage/*/chatSessions/*.jsonl",
        "AppData/Roaming/Code/User/globalStorage/emptyWindowChatSessions/*.json",
        "AppData/Roaming/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl",
    ],
    environment_override: None,
    environment_roots: NONE,
};

pub(crate) const ROO: SourceSpec = SourceSpec {
    id: "roo",
    display_name: "Roo Code",
    tier: 2,
    format: "task JSON",
    stability: Stability::Internal,
    common_paths: NONE,
    // The one file per task the parser reads. `*.json` also took
    // `ui_messages.json` and `task_metadata.json`, refused every time.
    linux_paths: &[
        ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/api_conversation_history.json",
    ],
    macos_paths: &[
        "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/api_conversation_history.json",
    ],
    windows_paths: &[
        "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/*/api_conversation_history.json",
    ],
    environment_override: None,
    environment_roots: NONE,
};

pub(crate) const KILO: SourceSpec = SourceSpec {
    id: "kilo",
    display_name: "Kilo Code",
    tier: 2,
    format: "OpenCode SQLite or Cline-family task JSON",
    stability: Stability::Internal,
    // Kilo Code was rebuilt on OpenCode and keeps its sessions in OpenCode's
    // SQLite schema. `packages/core/src/database/database.ts` names the file
    // `kilo.db` for a released channel and `kilo-<channel>.db` otherwise, in
    // `xdg-basedir`'s data directory, which is `~/.local/share` on every
    // platform, Windows included, unless XDG_DATA_HOME is set.
    common_paths: &[".local/share/kilo/kilo.db", ".local/share/kilo/kilo-*.db"],
    // The VS Code extension before the rebuild: the same single file as Roo.
    linux_paths: &[
        ".config/Code/User/globalStorage/kilocode.kilo-code/tasks/*/api_conversation_history.json",
    ],
    macos_paths: &[
        "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks/*/api_conversation_history.json",
    ],
    windows_paths: &[
        "AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks/*/api_conversation_history.json",
    ],
    environment_override: None,
    environment_roots: NONE,
};

pub(crate) const ZED: SourceSpec = SourceSpec {
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
    // `crates/paths/src/paths.rs`: `dirs::data_local_dir()` joined with `Zed`.
    windows_paths: &["AppData/Local/Zed/threads/threads*.db"],
    environment_override: None,
    environment_roots: NONE,
};
