//! Files capture never uploads, whatever a source's patterns say.
//!
//! The patterns say what a source is. This list says what nothing is: key
//! material, credential stores, version control internals and Finder litter.
//! It is applied after every source's patterns and to every memory file, so a
//! pattern written too broadly tomorrow still cannot send one of these.
//!
//! Every entry here was uploaded once. In September 2026, before the patterns
//! were applied at all, the dev archive received 13 `.audit-key` files, 13
//! `.claude/.claude.json` files and their backups (which can hold OAuth
//! tokens), `.git/index`, `.git/logs/HEAD` and `.git/packed-refs` from a plugin
//! marketplace checkout, and 14 `.DS_Store` files, all as `claude-code`
//! artifacts that could only come back `unknown_format`.
//!
//! `scripts/check-capture-parser-agreement.mjs` reads these three tables. It
//! fails when a capture pattern can name one of its sample files and nothing
//! here refuses it.

use std::path::{Component, Path};

/// Directories whose contents are never a session, at any depth.
pub const DENIED_DIRECTORIES: &[&str] = &[".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws"];

/// File names refused exactly.
pub const DENIED_NAMES: &[&str] = &[
    ".DS_Store",
    ".audit-key",
    ".claude.json",
    ".credentials.json",
    "credentials.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];

/// Name patterns refused, with `*` matching within the name.
pub const DENIED_PATTERNS: &[&str] = &[
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    "*.keychain",
    "*.keychain-db",
    ".env.*",
    ".claude.json.*",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
];

/// Whether `relative`, a path below a capture root, may never be uploaded.
///
/// Only the components below the root are judged. A home directory that
/// happens to sit inside a checkout says nothing about the files in it.
#[must_use]
pub fn is_denied(relative: &Path) -> bool {
    let names: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let Some((file, directories)) = names.split_last() else {
        return false;
    };
    directories
        .iter()
        .any(|directory| DENIED_DIRECTORIES.contains(&directory.as_str()))
        || DENIED_DIRECTORIES.contains(&file.as_str())
        || DENIED_NAMES.contains(&file.as_str())
        || DENIED_PATTERNS
            .iter()
            .any(|pattern| crate::memory::matches_segment(pattern, file))
}

#[cfg(test)]
mod tests {
    use super::is_denied;
    use std::path::Path;

    #[test]
    fn refuses_what_was_uploaded_before() {
        for path in [
            "local_1/.audit-key",
            "local_1/.claude/.claude.json",
            "local_1/.claude/backups/.claude.json.backup.1776805475693",
            "local_1/.claude/plugins/marketplaces/official/.git/index",
            "local_1/.claude/plugins/marketplaces/official/.git/logs/HEAD",
            "projects/-repo/1234/.DS_Store",
            "keys/server.pem",
            "keys/signing.key",
            "project/.env.local",
            ".ssh/config",
            "home/id_ed25519.pub",
        ] {
            assert!(is_denied(Path::new(path)), "{path} must be refused");
        }
    }

    #[test]
    fn keeps_transcripts_and_memory() {
        for path in [
            ".claude/projects/-repo/1234.jsonl",
            ".claude/projects/-repo/1234/subagents/agent-a1.jsonl",
            "local_1/.claude/projects/-outputs/1234.jsonl",
            ".gemini/antigravity-cli/brain/1/.system_generated/logs/transcript.jsonl",
            ".claude/projects/-repo/memory/keys.md",
            "project/.envrc.md",
        ] {
            assert!(!is_denied(Path::new(path)), "{path} must be kept");
        }
    }
}
