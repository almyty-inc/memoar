//! Parse-free discovery of native coding-agent session stores.

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
        macos_paths: &[
            "Library/Application Support/Claude/claude-code-sessions",
            "Library/Application Support/Claude/local-agent-mode-sessions",
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
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    for candidate in candidate_paths(spec, home, os, environment) {
        let root = pattern_root(&candidate);
        collect_files(&root, 0, &mut visited, &mut files)?;
    }
    files.sort();
    files.dedup();
    Ok(files)
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
    for entry in fs::read_dir(path).map_err(|source| DiscoveryError::Inspect {
        path: path.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| DiscoveryError::Inspect {
            path: path.to_path_buf(),
            source,
        })?;
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
    fn full_source_table_includes_amp_warp_and_windsurf_paths() {
        for id in ["amp", "warp", "windsurf"] {
            assert!(source(id).is_some(), "missing source {id}");
        }
        assert!(
            source("amp")
                .unwrap()
                .common_paths
                .contains(&".local/share/amp/threads")
        );
        assert!(
            source("warp")
                .unwrap()
                .macos_paths
                .iter()
                .any(|path| path.ends_with("Warp-Stable/warp.sqlite"))
        );
        assert!(
            source("windsurf")
                .unwrap()
                .windows_paths
                .contains(&"AppData/Roaming/Windsurf/User/globalStorage/state.vscdb")
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
