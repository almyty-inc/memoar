//! The instruction files an agent reads before it does anything.
//!
//! These are not transcripts. They are the standing context every transcript
//! was produced under, and an archived session cannot be read for what it was
//! without them: the same question answered under different instructions is a
//! different session.
//!
//! Every entry below was checked against the tool's own published source, not
//! against an article about it — zed's `RULES_FILE_NAMES`, goose's
//! `load_hints.rs`, kilo's rules migrator, roo's and crush's own documentation,
//! GitHub's and Cursor's. Anything that could not be confirmed is absent.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Where a memory file applies: to everything this user does, or to one project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemoryScope {
    Global,
    Project,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

/// One place a memory file lives, and which tools read it.
#[derive(Debug, Clone, Copy)]
pub struct MemorySpec {
    /// Slash-separated, relative to the home directory or to a project root.
    /// `*` matches within one segment; `**` matches any depth.
    pub pattern: &'static str,
    pub scope: MemoryScope,
    /// The supported tools that read this path. A fact about the file: one
    /// AGENTS.md at a repo root is read by seven of them, and it is still one
    /// file rather than seven copies belonging to seven owners.
    pub readers: &'static [&'static str],
}

/// A memory file found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredMemory {
    pub path: PathBuf,
    pub scope: MemoryScope,
    /// The project root, when the file belongs to one.
    pub workspace: Option<PathBuf>,
    pub readers: Vec<&'static str>,
}

/// These files are written by hand and stay small. A larger one is something
/// else that happens to share the name, and uploading it would be a surprise.
const MAX_BYTES: u64 = 1_000_000;

/// Every memory file under `home` and each of `workspaces`.
///
/// A file matched by more than one entry keeps one record naming every tool
/// that reads it, rather than becoming several records that each claim it.
pub fn memory_files(home: &Path, workspaces: &[PathBuf]) -> Vec<DiscoveredMemory> {
    let mut found: BTreeMap<PathBuf, DiscoveredMemory> = BTreeMap::new();
    for spec in MEMORY_FILES {
        let roots: Vec<(&Path, Option<PathBuf>)> = match spec.scope {
            MemoryScope::Global => vec![(home, None)],
            MemoryScope::Project => workspaces
                .iter()
                .map(|workspace| (workspace.as_path(), Some(workspace.clone())))
                .collect(),
        };
        for (root, workspace) in roots {
            for path in expand(root, &spec.pattern.split('/').collect::<Vec<_>>()) {
                let entry = found.entry(path.clone()).or_insert(DiscoveredMemory {
                    path,
                    scope: spec.scope,
                    workspace: workspace.clone(),
                    readers: Vec::new(),
                });
                for reader in spec.readers {
                    if !entry.readers.contains(reader) {
                        entry.readers.push(reader);
                    }
                }
                entry.readers.sort_unstable();
            }
        }
    }
    found.into_values().collect()
}

/// Walks only where the pattern can lead.
///
/// A literal segment is joined rather than listed, so matching `AGENTS.md` in a
/// repository does not read the repository. Only a wildcard lists a directory,
/// and the entries above put every wildcard inside a small one.
fn expand(root: &Path, segments: &[&str]) -> Vec<PathBuf> {
    let Some((segment, rest)) = segments.split_first() else {
        return match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_BYTES => {
                vec![root.to_path_buf()]
            }
            _ => Vec::new(),
        };
    };

    if *segment == "**" {
        let mut matches = expand(root, rest);
        for child in directories(root) {
            matches.extend(expand(&child, segments));
        }
        return matches;
    }

    if segment.contains('*') {
        return entries(root)
            .into_iter()
            .filter(|entry| {
                matches_segment(
                    segment,
                    &entry.file_name().unwrap_or_default().to_string_lossy(),
                )
            })
            // Never through a symlink, which is what the literal branch below
            // and the `**` branch already refuse. Only this one did not, and
            // `.claude/projects/*/memory/*.md` puts a `*` exactly where another
            // tool's project directory goes: one link named `escaped` pointing
            // out of the tree, and `escaped/memory/private.md` was read from
            // wherever it really lived and uploaded.
            .filter(|entry| {
                !fs::symlink_metadata(entry).is_ok_and(|metadata| metadata.file_type().is_symlink())
            })
            .flat_map(|entry| expand(&entry, rest))
            .collect();
    }

    // A literal segment is joined, but not followed blindly: `.roo/rules` can
    // be a link to somewhere else entirely, and walking it would upload files
    // that are not this project's — or, pointed at the home directory, the
    // whole machine. The starting root is exempt because a home directory or a
    // checkout may legitimately be reached through one.
    let child = root.join(segment);
    if fs::symlink_metadata(&child).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Vec::new();
    }
    expand(&child, rest)
}

fn entries(root: &Path) -> Vec<PathBuf> {
    let Ok(reader) = fs::read_dir(root) else {
        return Vec::new();
    };
    reader.flatten().map(|entry| entry.path()).collect()
}

fn directories(root: &Path) -> Vec<PathBuf> {
    entries(root)
        .into_iter()
        // Never through a symlink: a link into the home directory would walk
        // the whole machine, and a link out of it would upload somebody else's.
        .filter(|path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
        })
        .collect()
}

/// `*` within one segment: `*.md`, `*.instructions.md`.
pub(crate) fn matches_segment(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == name;
    }
    let Some(rest) = name.strip_prefix(parts[0]) else {
        return false;
    };
    let last = parts[parts.len() - 1];
    if rest.len() < last.len() || !rest.ends_with(last) {
        return false;
    }
    let mut remaining = &rest[..rest.len() - last.len()];
    for middle in &parts[1..parts.len() - 1] {
        match remaining.find(middle) {
            Some(index) => remaining = &remaining[index + middle.len()..],
            None => return false,
        }
    }
    true
}

#[path = "memory_files.rs"]
mod memory_files;
pub use memory_files::MEMORY_FILES;

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
