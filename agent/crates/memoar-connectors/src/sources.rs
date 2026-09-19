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
        // The transcripts, not the trees the sessions built beside them. These
        // were bare directories, and a bare directory means everything beneath
        // it: on one machine that was 5,392 files — markdown, TypeScript,
        // Python, JPEGs and node_modules the agent had written into its own
        // working directory — offered to the uploader by a source that promises
        // session stores and nothing else.
        //
        // A session and the subagents it ran are one conversation. The
        // subagent transcripts sit one directory below the session that spawned
        // them, and `projects/*/*.jsonl` alone reaches none of them: on this
        // machine that is 233 files holding 58,467 lines that carry both `uuid`
        // and `message` — the two fields the parser turns into turns — against
        // 15 top-level transcripts. Narrowing the sweep must not throw those
        // away, so each depth they are written at is named, and only `.jsonl`
        // at that depth: `subagents/*.meta.json` and `tool-results/**` sit
        // beside them and are not transcripts.
        //
        // `.claude/history.jsonl` is not one either. It is the prompt history
        // the CLI keeps for its own up-arrow: 10,619 lines on this machine,
        // every one valid JSON, every one `{display, pastedContents, timestamp,
        // project, sessionId}` and not one carrying `uuid` or `message`. The
        // parser needs both, so all 2.8 MB of it was uploaded on every sync —
        // it grows with every prompt typed — and came back `unknown_format`,
        // carrying every prompt and every paste with it. The conversation it
        // indexes is the transcript named by its own `sessionId`, which
        // `.claude/projects/*/*.jsonl` already takes.
        common_paths: &[
            ".claude/projects/*/*.jsonl",
            ".claude/projects/*/*/subagents/*.jsonl",
            ".claude/projects/*/*/subagents/workflows/*/*.jsonl",
        ],
        linux_paths: NONE,
        // `claude-code-sessions/*/*/local_*.json` and its local-agent-mode twin
        // held no conversation. They are the desktop app's per-session
        // settings: model, permission mode, allowed egress domains, the
        // rendered system prompt, `accountName` and `emailAddress`. Checked on
        // this machine, 22 files matched the two patterns and not one contained
        // a message, a `parentUuid` or a transcript — the parser reads JSONL
        // records carrying `uuid` and `message`, so every one was uploaded and
        // came back `unknown_format`, carrying an email address with it.
        //
        // The conversation those files describe is the CLI transcript named by
        // their own `cliSessionId`, which `.claude/projects/*/*.jsonl` above
        // already captures when it is on this host. For a local-agent-mode
        // session it is not: that runs in a VM, and nothing on this side of it
        // is a transcript.
        macos_paths: NONE,
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
        // The transcript log, which is the only thing the parser reads: it
        // takes JSON lines and has no SQLite branch at all, whatever its own
        // "requires a native SQLite trajectory database" diagnostic says.
        //
        // `brain/*/conversations/*.db` named a directory that does not exist.
        // On the machine that runs this tool the conversation databases are one
        // level up, in `.gemini/antigravity-cli/conversations/*.db`, and
        // `brain/<id>/` holds only `.system_generated` and `.user_uploaded`.
        // Pointing the pattern at the real databases would not help while the
        // parser cannot open one; that is a server-side gap, recorded in
        // contracts/fixtures/PROVENANCE.md rather than papered over here.
        //
        // `brain/*/*.md` matched nothing on that machine either, and markdown
        // is not a transcript: the parser refuses anything that is not JSONL.
        common_paths: &[".gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl"],
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
        // The CLI's session store, which is the only thing its parser opens.
        //
        // The four `*.json` patterns that stood here named directories the CLI
        // does not write JSON into. Checked against GitHub Copilot CLI 1.0.59
        // with a recorded session on disk: `~/.copilot/session-state/` holds one
        // directory per session — `workspace.yaml`, `checkpoints/index.md`, and
        // empty `files/` and `research/` — and no `.json` at any depth, while
        // `~/.copilot/history-session-state/` does not exist at all. The only
        // JSON under `~/.copilot` is `config.json` and
        // `command-history-state.json` at the top level, which are settings and
        // which those patterns never named anyway. So the patterns could only
        // ever have collected something that is not a session, and the parser
        // refuses everything that is not native SQLite.
        //
        // The VS Code `chatSessions/*.json` below are a different case and stay:
        // see UNSETTLED in scripts/check-capture-parser-agreement.mjs.
        common_paths: &[".copilot/session-store.db"],
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
