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
fn matches_segment(pattern: &str, name: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn found<'a>(files: &'a [DiscoveredMemory], suffix: &str) -> Option<&'a DiscoveredMemory> {
        files
            .iter()
            .find(|file| file.path.to_string_lossy().ends_with(suffix))
    }

    #[test]
    fn finds_what_each_tool_is_told_globally_and_per_project() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("work/memoar");

        write(&home.join(".claude/CLAUDE.md"), "be terse");
        write(
            &home.join(".claude/projects/-work-memoar/memory/project-state.md"),
            "what we are building",
        );
        write(&home.join(".codex/AGENTS.md"), "codex global");
        write(&home.join(".gemini/GEMINI.md"), "gemini global");
        write(&home.join(".config/crush/CRUSH.md"), "crush global");
        write(&project.join("AGENTS.md"), "project rules");
        write(&project.join(".goosehints"), "goose rules");
        write(
            &project.join(".cursor/rules/style.mdc"),
            "---\nalwaysApply: true\n---\nstyle",
        );
        write(
            &project.join(".github/instructions/tests.instructions.md"),
            "how to test",
        );

        let files = memory_files(&home, std::slice::from_ref(&project));

        for expected in [
            ".claude/CLAUDE.md",
            "memory/project-state.md",
            ".codex/AGENTS.md",
            ".gemini/GEMINI.md",
            "crush/CRUSH.md",
            "memoar/AGENTS.md",
            ".goosehints",
            "style.mdc",
            "tests.instructions.md",
        ] {
            assert!(found(&files, expected).is_some(), "missing {expected}");
        }

        // One AGENTS.md is read by seven tools and is still one file.
        let agents = found(&files, "memoar/AGENTS.md").unwrap();
        assert_eq!(agents.scope, MemoryScope::Project);
        assert_eq!(agents.workspace.as_deref(), Some(project.as_path()));
        assert_eq!(
            agents.readers,
            [
                "codex", "copilot", "crush", "cursor", "goose", "opencode", "roo", "zed"
            ]
        );

        let claude = found(&files, ".claude/CLAUDE.md").unwrap();
        assert_eq!(claude.scope, MemoryScope::Global);
        assert_eq!(claude.workspace, None);
    }

    #[test]
    fn does_not_read_the_repository_to_find_a_file_at_its_root() {
        // Matching AGENTS.md must not walk node_modules. A literal segment is
        // joined, never listed, so only the wildcards inside .cursor and
        // .github ever enumerate anything.
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        write(&project.join("AGENTS.md"), "rules");
        for index in 0..50 {
            write(
                &project.join(format!("node_modules/package-{index}/AGENTS.md")),
                "a dependency's own instructions, not this project's",
            );
        }

        let files = memory_files(temp.path(), std::slice::from_ref(&project));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, project.join("AGENTS.md"));
    }

    #[test]
    fn skips_a_file_too_large_to_be_one_of_these() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        write(
            &project.join("AGENTS.md"),
            &"x".repeat(MAX_BYTES as usize + 1),
        );

        assert!(memory_files(temp.path(), &[project]).is_empty());
    }

    #[test]
    fn never_follows_a_symlink_out_of_the_tree() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        let elsewhere = temp.path().join("somebody-else");
        write(&elsewhere.join("rules/private.md"), "not ours to upload");
        fs::create_dir_all(project.join(".roo")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, project.join(".roo/rules")).unwrap();

        assert!(memory_files(temp.path(), &[project]).is_empty());
    }

    #[test]
    fn matches_within_a_segment_only() {
        assert!(matches_segment("*.md", "CLAUDE.md"));
        assert!(!matches_segment("*.md", "CLAUDE.mdc"));
        assert!(matches_segment(
            "*.instructions.md",
            "tests.instructions.md"
        ));
        assert!(!matches_segment("*.instructions.md", "tests.md"));
        assert!(matches_segment("rules-*", "rules-code"));
        assert!(!matches_segment("rules-*", "rules"));
    }
}
