//! Which instruction file each tool reads, and where a conversion may write it.
//!
//! The mirror of `server/src/convert/memory-dialects.ts`, and held to it by a
//! test that reads both. Two tables in two languages with nothing comparing
//! them is the shape of bug that has broken `memoar login` in CI and made every
//! browser-minted API key inert — twice in one day. Here the cost of a
//! disagreement would be a file written where the target tool never looks.

use serde::{Deserialize, Serialize};

use crate::error::MaterializeError;
use memoar_canonical::MemoryScope;

/// A dialect a conversion can be written into.
///
/// Cursor is deliberately absent. It reads nothing from a `.cursor/rules/*.mdc`
/// that carries no frontmatter, and inventing frontmatter is not a mechanical
/// port, so Cursor is a source and never a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryDialect {
    AntigravityCli,
    ClaudeCode,
    Codex,
    Copilot,
    Crush,
    Goose,
    Kilo,
    Opencode,
    Roo,
    Zed,
}

impl MemoryDialect {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AntigravityCli => "antigravity-cli",
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Copilot => "copilot",
            Self::Crush => "crush",
            Self::Goose => "goose",
            Self::Kilo => "kilo",
            Self::Opencode => "opencode",
            Self::Roo => "roo",
            Self::Zed => "zed",
        }
    }

    /// Every dialect, so a caller can list them without repeating the table.
    pub const ALL: [Self; 10] = [
        Self::AntigravityCli,
        Self::ClaudeCode,
        Self::Codex,
        Self::Copilot,
        Self::Crush,
        Self::Goose,
        Self::Kilo,
        Self::Opencode,
        Self::Roo,
        Self::Zed,
    ];
}

impl std::str::FromStr for MemoryDialect {
    type Err = MaterializeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|dialect| dialect.as_str() == value)
            .ok_or_else(|| MaterializeError::UnsupportedTarget(value.to_owned()))
    }
}

/// Where a dialect reads: one exact path, or a directory of rules files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryDestination {
    /// The tool reads exactly this path, and nothing else.
    File(&'static str),
    /// The tool reads every `.md` directly inside this directory.
    Directory(&'static str),
}

/// The whole table. A `None` means that tool documents no such file.
#[must_use]
pub fn memory_destination(
    dialect: MemoryDialect,
    scope: &MemoryScope,
) -> Option<MemoryDestination> {
    use MemoryDestination::{Directory, File};
    let global = matches!(scope, MemoryScope::Global);
    match (dialect, global) {
        (MemoryDialect::AntigravityCli, true) => Some(File(".gemini/GEMINI.md")),
        (MemoryDialect::AntigravityCli, false) => Some(File("GEMINI.md")),
        (MemoryDialect::ClaudeCode, true) => Some(File(".claude/CLAUDE.md")),
        (MemoryDialect::ClaudeCode, false) => Some(File("CLAUDE.md")),
        (MemoryDialect::Codex, true) => Some(File(".codex/AGENTS.md")),
        (MemoryDialect::Codex, false) => Some(File("AGENTS.md")),
        (MemoryDialect::Copilot, true) => None,
        (MemoryDialect::Copilot, false) => Some(File(".github/copilot-instructions.md")),
        (MemoryDialect::Crush, true) => Some(File(".config/crush/CRUSH.md")),
        (MemoryDialect::Crush, false) => Some(File("AGENTS.md")),
        (MemoryDialect::Goose, true) => None,
        (MemoryDialect::Goose, false) => Some(File(".goosehints")),
        (MemoryDialect::Kilo, _) => Some(Directory(".kilocode/rules")),
        (MemoryDialect::Opencode, true) => Some(File(".config/opencode/AGENTS.md")),
        (MemoryDialect::Opencode, false) => Some(File("AGENTS.md")),
        (MemoryDialect::Roo, _) => Some(Directory(".roo/rules")),
        (MemoryDialect::Zed, true) => None,
        (MemoryDialect::Zed, false) => Some(File(".rules")),
    }
}

/// The prefix a wire path carries so the root is never guessed: `~/` is the
/// home directory, `./` is the workspace the conversion named.
#[must_use]
pub const fn root_prefix(scope: &MemoryScope) -> &'static str {
    match scope {
        MemoryScope::Global => "~/",
        MemoryScope::Project => "./",
    }
}
