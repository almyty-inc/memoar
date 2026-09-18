//! Finding the declared stores on disk and collecting the files they name.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::glob::{expand_pattern, path_matches_pattern, pattern_root};
use crate::sources::SOURCES;
use crate::spec::{OperatingSystem, SourceSpec, Stability};

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
        // Re-root the declared patterns, rather than handing back the root
        // itself. A bare root is read as "everything beneath this", so setting
        // CODEX_HOME or OPENCODE_DATA_DIR used to switch off every glob the
        // source declares and offer the uploader the whole directory.
        let mut candidates: Vec<PathBuf> = spec
            .paths_for(os)
            .filter_map(|pattern| {
                spec.environment_roots.iter().find_map(|prefix| {
                    pattern
                        .strip_prefix(prefix)
                        .and_then(|rest| rest.strip_prefix('/'))
                        .map(|rest| root.join(rest))
                })
            })
            .collect();
        if candidates.is_empty() {
            // A source that declares an override and no root beneath it. The
            // table test below refuses that, so this is only ever reached if
            // one is added without the other; capturing nothing would be worse
            // than the old behaviour.
            candidates.push(root);
        }
        candidates.sort();
        candidates.dedup();
        return candidates;
    }
    spec.paths_for(os)
        .map(|pattern| expand_pattern(home, pattern))
        .collect()
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
