//! The workspace a session was recorded in, for the project rules of the policy.
//!
//! Session formats name it in a `cwd` field near the top of the file: Claude
//! Code on each record, Codex in its `session_meta` line. Claude Code also
//! keeps every session of one workspace in one directory, so the answer is
//! read once per directory rather than once per file. That matters on a
//! machine with a quarter of a million sessions.

use regex::Regex;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// How much of a file is read looking for the workspace.
const HEAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Default)]
pub struct WorkspaceResolver {
    by_project_dir: HashMap<PathBuf, Option<String>>,
}

impl WorkspaceResolver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The answer already known without reading `path`, if there is one.
    #[must_use]
    pub fn cached(&self, source: &str, path: &Path) -> Option<Option<String>> {
        let dir = claude_project_dir(source, path)?;
        self.by_project_dir.get(&dir).cloned()
    }

    /// The workspace of `path`, reading its head unless `bytes` already holds
    /// the file or the directory has been answered for.
    pub fn resolve(&mut self, source: &str, path: &Path, bytes: Option<&[u8]>) -> Option<String> {
        if let Some(known) = self.cached(source, path) {
            return known;
        }
        let found = match bytes {
            Some(bytes) => cwd_in(&bytes[..bytes.len().min(HEAD_BYTES)]),
            None => read_head(path).and_then(|head| cwd_in(&head)),
        };
        let Some(dir) = claude_project_dir(source, path) else {
            return found;
        };
        // The directory name is the workspace with its separators flattened to
        // dashes. Lossy, since a dash in a name looks the same, so it is only
        // used when no record in the file names the workspace.
        let answer = found.or_else(|| decode_project_dir(&dir));
        self.by_project_dir.insert(dir, answer.clone());
        answer
    }
}

/// `~/.claude/projects/<dir>` for a Claude Code transcript at any depth below it.
fn claude_project_dir(source: &str, path: &Path) -> Option<PathBuf> {
    if source != "claude-code" {
        return None;
    }
    let mut candidate = path.parent()?;
    loop {
        let parent = candidate.parent()?;
        if parent.file_name().is_some_and(|name| name == "projects")
            && parent
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".claude")
        {
            return Some(candidate.to_path_buf());
        }
        candidate = parent;
    }
}

fn decode_project_dir(dir: &Path) -> Option<String> {
    let name = match dir.components().next_back()? {
        Component::Normal(name) => name.to_string_lossy().into_owned(),
        _ => return None,
    };
    name.starts_with('-').then(|| name.replace('-', "/"))
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(HEAD_BYTES);
    File::open(path)
        .ok()?
        .take(HEAD_BYTES as u64)
        .read_to_end(&mut head)
        .ok()?;
    Some(head)
}

/// The first `"cwd": "..."` in a run of JSON records, unescaped.
fn cwd_in(bytes: &[u8]) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r#""cwd"\s*:\s*"((?:[^"\\]|\\.)*)""#).expect("static pattern compiles")
    });
    let text = String::from_utf8_lossy(bytes);
    let quoted = pattern.captures(&text)?.get(1)?.as_str();
    serde_json::from_str::<String>(&format!("\"{quoted}\""))
        .ok()
        .filter(|cwd| !cwd.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_the_cwd_once_per_claude_project_directory() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".claude/projects/-work-app");
        fs::create_dir_all(dir.join("s1/subagents")).unwrap();
        let first = dir.join("a.jsonl");
        fs::write(
            &first,
            "{\"type\":\"summary\"}\n{\"cwd\":\"/work/app\",\"uuid\":\"1\"}\n",
        )
        .unwrap();
        let nested = dir.join("s1/subagents/b.jsonl");
        fs::write(&nested, "{\"cwd\":\"/elsewhere\"}\n").unwrap();

        let mut resolver = WorkspaceResolver::new();
        assert_eq!(resolver.cached("claude-code", &first), None);
        assert_eq!(
            resolver.resolve("claude-code", &first, None).as_deref(),
            Some("/work/app")
        );
        assert_eq!(
            resolver.cached("claude-code", &nested),
            Some(Some("/work/app".to_owned())),
            "a subagent belongs to the project directory it sits in"
        );
    }

    #[test]
    fn falls_back_to_the_directory_name_and_reads_other_sources_per_file() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".claude/projects/-private-tmp-x");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jsonl");
        fs::write(&file, "{\"type\":\"summary\"}\n").unwrap();
        let mut resolver = WorkspaceResolver::new();
        assert_eq!(
            resolver.resolve("claude-code", &file, None).as_deref(),
            Some("/private/tmp/x")
        );
        let rollout = br#"{"type":"session_meta","payload":{"cwd":"C:\\work\\api"}}"#;
        assert_eq!(
            resolver
                .resolve("codex", Path::new("rollout.jsonl"), Some(rollout))
                .as_deref(),
            Some(r"C:\work\api")
        );
        assert_eq!(resolver.resolve("codex", Path::new("x"), Some(b"{}")), None);
    }
}
