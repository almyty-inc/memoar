//! Parse-free discovery of native coding-agent session stores.

pub mod memory;

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stability {
    Internal,
    Stable,
    ReverseEngineered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperatingSystem {
    Linux,
    Macos,
    Windows,
}

impl OperatingSystem {
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SourceSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub tier: u8,
    pub format: &'static str,
    pub stability: Stability,
    pub common_paths: &'static [&'static str],
    pub linux_paths: &'static [&'static str],
    pub macos_paths: &'static [&'static str],
    pub windows_paths: &'static [&'static str],
    pub environment_override: Option<&'static str>,
}

impl SourceSpec {
    pub fn paths_for(&self, os: OperatingSystem) -> impl Iterator<Item = &'static str> + '_ {
        let platform_paths = match os {
            OperatingSystem::Linux => self.linux_paths,
            OperatingSystem::Macos => self.macos_paths,
            OperatingSystem::Windows => self.windows_paths,
        };
        self.common_paths
            .iter()
            .chain(platform_paths.iter())
            .copied()
    }
}

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
    },
    SourceSpec {
        id: "opencode",
        display_name: "OpenCode",
        tier: 2,
        format: "JSON records or SQLite",
        stability: Stability::Internal,
        common_paths: &[
            ".local/share/opencode/storage",
            ".local/share/opencode/opencode.db",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: &[
            "AppData/Roaming/opencode/storage",
            "AppData/Roaming/opencode/opencode.db",
        ],
        environment_override: Some("OPENCODE_DATA_DIR"),
    },
    SourceSpec {
        id: "copilot",
        display_name: "GitHub Copilot",
        tier: 2,
        format: "VS Code JSON or CLI SQLite",
        stability: Stability::Internal,
        common_paths: &[
            ".copilot/session-state",
            ".copilot/history-session-state",
            ".copilot/session-store.db",
        ],
        linux_paths: &[".config/Code/User/workspaceStorage/*/chatSessions/*.json"],
        macos_paths: &[
            "Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.json",
        ],
        windows_paths: &["AppData/Roaming/Code/User/workspaceStorage/*/chatSessions/*.json"],
        environment_override: None,
    },
    SourceSpec {
        id: "goose",
        display_name: "Goose",
        tier: 2,
        format: "SQLite or legacy JSONL",
        stability: Stability::Internal,
        common_paths: &[".local/share/goose/sessions/sessions.db"],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: &["AppData/Roaming/Block/goose/data/sessions"],
        environment_override: None,
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
    },
    SourceSpec {
        id: "roo",
        display_name: "Roo Code",
        tier: 2,
        format: "task JSON",
        stability: Stability::Internal,
        common_paths: NONE,
        linux_paths: &[".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks"],
        macos_paths: &[
            "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
        ],
        windows_paths: &[
            "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
        ],
        environment_override: None,
    },
    SourceSpec {
        id: "kilo",
        display_name: "Kilo Code",
        tier: 2,
        format: "Cline-family task JSON",
        stability: Stability::Internal,
        common_paths: NONE,
        linux_paths: &[".config/Code/User/globalStorage/kilocode.kilo-code/tasks"],
        macos_paths: &[
            "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks",
        ],
        windows_paths: &["AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks"],
        environment_override: None,
    },
    SourceSpec {
        id: "zed",
        display_name: "Zed",
        tier: 3,
        format: "Zstd-compressed SQLite threads",
        stability: Stability::ReverseEngineered,
        common_paths: NONE,
        linux_paths: &[".local/share/zed/db"],
        macos_paths: &["Library/Application Support/Zed/db"],
        windows_paths: NONE,
        environment_override: None,
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDiscovery {
    pub id: &'static str,
    pub display_name: &'static str,
    pub tier: u8,
    pub format: &'static str,
    pub stability: Stability,
    pub paths: Vec<PathBuf>,
    pub detected: bool,
}

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("could not inspect {path}: {source}")]
    Inspect {
        path: PathBuf,
        source: std::io::Error,
    },
}

#[must_use]
pub fn source(id: &str) -> Option<&'static SourceSpec> {
    SOURCES.iter().find(|spec| spec.id == id)
}

#[must_use]
pub fn discover(home: &Path, os: OperatingSystem) -> Vec<SourceDiscovery> {
    discover_with_env(home, os, |key| std::env::var_os(key).map(PathBuf::from))
}

#[must_use]
pub fn discover_with_env<F>(
    home: &Path,
    os: OperatingSystem,
    environment: F,
) -> Vec<SourceDiscovery>
where
    F: Fn(&str) -> Option<PathBuf> + Copy,
{
    SOURCES
        .iter()
        .map(|spec| {
            let paths = candidate_paths(spec, home, os, environment);
            let detected = paths.iter().any(|path| pattern_root(path).exists());
            SourceDiscovery {
                id: spec.id,
                display_name: spec.display_name,
                tier: spec.tier,
                format: spec.format,
                stability: spec.stability,
                paths,
                detected,
            }
        })
        .collect()
}

pub fn files_for_source(
    spec: &SourceSpec,
    home: &Path,
    os: OperatingSystem,
) -> Result<Vec<PathBuf>, DiscoveryError> {
    files_for_source_with_env(spec, home, os, |key| {
        std::env::var_os(key).map(PathBuf::from)
    })
}

pub fn files_for_source_with_env<F>(
    spec: &SourceSpec,
    home: &Path,
    os: OperatingSystem,
    environment: F,
) -> Result<Vec<PathBuf>, DiscoveryError>
where
    F: Fn(&str) -> Option<PathBuf> + Copy,
{
    let candidates = candidate_paths(spec, home, os, environment);
    // Walk each distinct root once, then keep only what the declared pattern
    // actually names.
    //
    // `pattern_root` cuts `~/.claude/projects/<project>/<file>.jsonl` down to
    // `~/.claude/projects`, and the walk below used to return everything
    // underneath it to twelve levels deep — every file of every type another
    // tool had put there. The glob was written down and never applied. That is
    // how a socket and a second tool's SQLite database ended up being offered to
    // the uploader, and it contradicts what this agent promises: the session
    // stores these patterns name, and nothing else.
    //
    // Several patterns can share a root — Antigravity has three — so the roots
    // are de-duplicated before walking and a file is kept if any pattern for
    // this source matches it.
    let mut roots: Vec<PathBuf> = candidates.iter().map(|path| pattern_root(path)).collect();
    roots.sort();
    roots.dedup();

    let mut found = Vec::new();
    let mut visited = HashSet::new();
    for root in &roots {
        collect_files(root, 0, &mut visited, &mut found)?;
    }

    let mut files: Vec<PathBuf> = found
        .into_iter()
        .filter(|path| {
            candidates
                .iter()
                .any(|pattern| path_matches_pattern(pattern, path))
        })
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Whether one collected path is named by one declared pattern.
///
/// A pattern with no `*` is a root or an exact file, and keeps the behaviour it
/// had: everything at or beneath it. That is what `MEMOAR_CAPTURE_HOME`-style
/// overrides rely on, and what a plain path like `.claude/history.jsonl` means.
fn path_matches_pattern(pattern: &Path, path: &Path) -> bool {
    let pattern_text = pattern.to_string_lossy();
    if !pattern_text.contains('*') {
        return path == pattern || path.starts_with(pattern);
    }
    let pattern_parts: Vec<_> = pattern.components().collect();
    let path_parts: Vec<_> = path.components().collect();
    if pattern_parts.len() != path_parts.len() {
        return false;
    }
    pattern_parts
        .iter()
        .zip(path_parts.iter())
        .all(|(expected, actual)| {
            crate::memory::matches_segment(
                &expected.as_os_str().to_string_lossy(),
                &actual.as_os_str().to_string_lossy(),
            )
        })
}

fn candidate_paths<F>(
    spec: &SourceSpec,
    home: &Path,
    os: OperatingSystem,
    environment: F,
) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<PathBuf>,
{
    if let Some(root) = spec.environment_override.and_then(environment) {
        return vec![root];
    }
    spec.paths_for(os)
        .map(|pattern| expand_pattern(home, pattern))
        .collect()
}

fn expand_pattern(home: &Path, pattern: &str) -> PathBuf {
    home.join(pattern)
}

fn pattern_root(pattern: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for component in pattern.components() {
        let text = component.as_os_str().to_string_lossy();
        if text.contains('*') || text.contains('<') || text.contains('{') {
            break;
        }
        root.push(component);
    }
    root
}

fn collect_files(
    path: &Path,
    depth: u8,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), DiscoveryError> {
    if depth > 12 || !path.exists() || !visited.insert(path.to_path_buf()) {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).map_err(|source| DiscoveryError::Inspect {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    /*
        Anything that is neither a regular file nor a directory — a unix socket,
        a fifo, a device node — is skipped rather than descended into.

        A socket answers `symlink_metadata` perfectly well and is not a file, so
        it fell through to `read_dir` and came back ENOTDIR, which aborted the
        entire walk. One `lsp.sock` left under ~/.claude/projects by another tool
        meant `memoar sync` captured nothing at all, on every source, with a
        message about a path the reader never put there.
    */
    if !metadata.is_dir() {
        return Ok(());
    }
    /*
        A directory that cannot be read is skipped too. Losing one subtree is a
        gap; aborting the walk is an archive that silently stays empty, and the
        second is what this did.
    */
    let Ok(entries) = fs::read_dir(path) else {
        return Ok(());
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        collect_files(&entry.path(), depth + 1, visited, files)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn table_has_unique_source_ids_and_all_tiers() {
        let ids: HashSet<_> = SOURCES.iter().map(|source| source.id).collect();
        assert_eq!(ids.len(), SOURCES.len());
        assert!(SOURCES.iter().any(|source| source.tier == 1));
        assert!(SOURCES.iter().any(|source| source.tier == 2));
        assert!(SOURCES.iter().any(|source| source.tier == 3));
    }

    /// The declared pattern is what gets read. Nothing else.
    ///
    /// `pattern_root` cuts the glob back to its fixed prefix and the walk then
    /// returned every file beneath it, twelve levels deep — so the Claude Code
    /// source, whose pattern names `*.jsonl` two levels down, was handing the
    /// uploader another tool's SQLite database, its logs, and anything else
    /// living under ~/.claude/projects. Both the docs and the app say only the
    /// session stores are read; this is that claim, as a test.
    #[test]
    fn reads_only_what_the_pattern_names() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join(".claude/projects/-tmp-project");
        fs::create_dir_all(project.join("memory/.agented")).unwrap();
        fs::create_dir_all(project.join("subdir")).unwrap();

        fs::write(project.join("session.jsonl"), "{}\n").unwrap();
        // Everything below is somebody else's, and none of it is a transcript.
        fs::write(
            project.join("memory/.agented/state.db"),
            b"SQLite format 3\0",
        )
        .unwrap();
        fs::write(project.join("memory/notes.md"), "private\n").unwrap();
        fs::write(project.join("subdir/deeper.jsonl"), "{}\n").unwrap();

        let spec = SOURCES
            .iter()
            .find(|source| source.id == "claude-code")
            .unwrap();
        let files = files_for_source(spec, temp.path(), OperatingSystem::Linux).unwrap();

        assert!(
            files.iter().any(|path| path.ends_with("session.jsonl")),
            "the transcript the pattern names must still be found"
        );
        for unwanted in ["state.db", "notes.md", "deeper.jsonl"] {
            assert!(
                !files.iter().any(|path| path.ends_with(unwanted)),
                "{unwanted} is not named by .claude/projects/*/*.jsonl, got {files:?}"
            );
        }
    }

    /// A socket in a source directory must not cost you the whole archive.
    ///
    /// `symlink_metadata` answers for a unix socket, and it is not a file, so
    /// the walk fell through to `read_dir` and got ENOTDIR — which aborted
    /// discovery for every source. One `lsp.sock` another tool had left under
    /// ~/.claude/projects meant `memoar sync` captured nothing at all.
    #[cfg(unix)]
    #[test]
    fn a_socket_beside_the_sessions_does_not_stop_discovery() {
        use std::os::unix::net::UnixListener;

        // A socket path has to fit in sockaddr_un (~104 bytes on macOS), and
        // the default temp root is nowhere near short enough.
        let temp = tempfile::Builder::new()
            .prefix("mc")
            .tempdir_in("/tmp")
            .unwrap();
        let project = temp.path().join(".claude/projects/p");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("session.jsonl"), "{}\n").unwrap();
        // Exactly what was on the machine this was found on.
        let nested = project.join("memory/.agented");
        fs::create_dir_all(&nested).unwrap();
        let _socket = UnixListener::bind(nested.join("lsp.sock")).unwrap();

        let spec = SOURCES
            .iter()
            .find(|source| source.id == "claude-code")
            .unwrap();
        let files = files_for_source(spec, temp.path(), OperatingSystem::Linux)
            .expect("a socket in the tree must not fail the whole walk");

        assert!(
            files.iter().any(|path| path.ends_with("session.jsonl")),
            "expected the transcript beside the socket, got {files:?}"
        );
        assert!(
            !files.iter().any(|path| path.ends_with("lsp.sock")),
            "a socket is not a transcript"
        );
    }

    #[test]
    fn discovers_and_lists_claude_files() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp
            .path()
            .join(".claude/projects/-tmp-project/session.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, "{}\n").unwrap();

        let discoveries = discover(temp.path(), OperatingSystem::Linux);
        let claude = discoveries
            .iter()
            .find(|entry| entry.id == "claude-code")
            .unwrap();
        assert!(claude.detected);

        let files = files_for_source(
            source("claude-code").unwrap(),
            temp.path(),
            OperatingSystem::Linux,
        )
        .unwrap();
        assert_eq!(files, vec![session]);
    }

    #[test]
    fn every_capture_source_names_a_path_on_some_platform() {
        // This used to assert that amp, warp and windsurf were present. They
        // were captured and uploaded while the server had no parser for any of
        // them, so every file collected from them became an unknown_format
        // artifact. A source belongs here only if a session read from it can
        // actually be archived.
        assert!(!SOURCES.is_empty(), "the capture table is empty");
        for spec in SOURCES {
            let has_path = !spec.common_paths.is_empty()
                || !spec.linux_paths.is_empty()
                || !spec.macos_paths.is_empty()
                || !spec.windows_paths.is_empty();
            assert!(has_path, "source {} names no path on any platform", spec.id);
        }
    }

    #[test]
    fn captures_only_what_the_archive_can_parse() {
        // Kept in step with the server by server/test/agent-server-agreement,
        // which reads this table; this is the same list stated once here so a
        // change to SOURCES has to be deliberate.
        let mut ids: Vec<&str> = SOURCES.iter().map(|spec| spec.id).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            [
                "antigravity-cli",
                "claude-code",
                "codex",
                "copilot",
                "crush",
                "cursor",
                "goose",
                "kilo",
                "opencode",
                "roo",
                "zed",
            ]
        );
    }

    #[test]
    fn environment_override_is_the_authoritative_root() {
        let temp = tempfile::tempdir().unwrap();
        let override_root = temp.path().join("custom-codex");
        let session = override_root.join("sessions/2026/08/18/rollout-one.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, "{}\n").unwrap();

        let files = files_for_source_with_env(
            source("codex").unwrap(),
            temp.path(),
            OperatingSystem::Linux,
            |key| (key == "CODEX_HOME").then(|| override_root.clone()),
        )
        .unwrap();
        assert_eq!(files, vec![session]);
    }
}
