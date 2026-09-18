//! Which instruction files each agent reads, and where it keeps them.
//!
//! Split out of `memory.rs`, which was over the file-size rule: the table
//! was most of it, and it is the part that grows every time a tool ships.
//! Nothing moved but the table.

use super::{MemoryScope, MemorySpec};

pub static MEMORY_FILES: &[MemorySpec] = &[
    // Global: what the user has told their agents everywhere.
    MemorySpec {
        pattern: ".claude/CLAUDE.md",
        scope: MemoryScope::Global,
        readers: &["claude-code"],
    },
    // The memory Claude Code writes for itself, one file per fact, plus the
    // index it loads every session.
    MemorySpec {
        pattern: ".claude/projects/*/memory/*.md",
        scope: MemoryScope::Global,
        readers: &["claude-code"],
    },
    MemorySpec {
        pattern: ".codex/AGENTS.md",
        scope: MemoryScope::Global,
        readers: &["codex"],
    },
    MemorySpec {
        pattern: ".gemini/GEMINI.md",
        scope: MemoryScope::Global,
        readers: &["antigravity-cli"],
    },
    MemorySpec {
        pattern: ".config/opencode/AGENTS.md",
        scope: MemoryScope::Global,
        readers: &["opencode"],
    },
    // Crush documents both: one for itself, one it expects other tools to read.
    MemorySpec {
        pattern: ".config/crush/CRUSH.md",
        scope: MemoryScope::Global,
        readers: &["crush"],
    },
    MemorySpec {
        pattern: ".config/AGENTS.md",
        scope: MemoryScope::Global,
        readers: &["crush"],
    },
    MemorySpec {
        pattern: ".roo/rules/**/*.md",
        scope: MemoryScope::Global,
        readers: &["roo"],
    },
    MemorySpec {
        pattern: ".kilocode/rules/**/*.md",
        scope: MemoryScope::Global,
        readers: &["kilo"],
    },
    MemorySpec {
        pattern: ".kilo/rules/**/*.md",
        scope: MemoryScope::Global,
        readers: &["kilo"],
    },
    // Project: what this repository tells whatever agent opens it.
    MemorySpec {
        pattern: "AGENTS.md",
        scope: MemoryScope::Project,
        readers: &[
            "codex", "copilot", "crush", "cursor", "goose", "opencode", "roo", "zed",
        ],
    },
    MemorySpec {
        pattern: "CLAUDE.md",
        scope: MemoryScope::Project,
        readers: &["claude-code", "copilot", "zed"],
    },
    MemorySpec {
        pattern: "GEMINI.md",
        scope: MemoryScope::Project,
        readers: &["antigravity-cli", "copilot", "zed"],
    },
    MemorySpec {
        pattern: "AGENT.md",
        scope: MemoryScope::Project,
        readers: &["roo", "zed"],
    },
    MemorySpec {
        pattern: ".rules",
        scope: MemoryScope::Project,
        readers: &["zed"],
    },
    MemorySpec {
        pattern: ".clinerules",
        scope: MemoryScope::Project,
        readers: &["zed"],
    },
    MemorySpec {
        pattern: ".goosehints",
        scope: MemoryScope::Project,
        readers: &["goose"],
    },
    MemorySpec {
        pattern: ".github/copilot-instructions.md",
        scope: MemoryScope::Project,
        readers: &["copilot", "zed"],
    },
    MemorySpec {
        pattern: ".github/instructions/**/*.instructions.md",
        scope: MemoryScope::Project,
        readers: &["copilot"],
    },
    // Cursor ignores a plain .md here: without frontmatter it has no rule.
    MemorySpec {
        pattern: ".cursor/rules/**/*.mdc",
        scope: MemoryScope::Project,
        readers: &["cursor"],
    },
    MemorySpec {
        pattern: ".roo/rules/**/*.md",
        scope: MemoryScope::Project,
        readers: &["roo"],
    },
    MemorySpec {
        pattern: ".roorules",
        scope: MemoryScope::Project,
        readers: &["roo"],
    },
    MemorySpec {
        pattern: ".kilocode/rules/**/*.md",
        scope: MemoryScope::Project,
        readers: &["kilo"],
    },
    MemorySpec {
        pattern: ".kilocoderules",
        scope: MemoryScope::Project,
        readers: &["kilo"],
    },
];
