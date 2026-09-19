//! Matching a collected path against a declared pattern.

use std::path::{Path, PathBuf};

/// Whether one collected path is named by one declared pattern.
///
/// A pattern with no `*` is a root or an exact file, and keeps the behaviour it
/// had: everything at or beneath it. That is what `MEMOAR_CAPTURE_HOME`-style
/// overrides rely on, and what a plain path like `.claude/history.jsonl` means.
pub(crate) fn path_matches_pattern(pattern: &Path, path: &Path) -> bool {
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

pub(crate) fn expand_pattern(home: &Path, pattern: &str) -> PathBuf {
    home.join(pattern)
}

pub(crate) fn pattern_root(pattern: &Path) -> PathBuf {
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
