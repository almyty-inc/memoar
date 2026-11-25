//! What Claude Code capture takes from a home laid out like the one that
//! filled the dev archive with `unknown_format` artifacts.
//!
//! Every path below is a shape found among the 1,354 `claude-code` artifacts on
//! dev that never parsed: key files, settings that can hold tokens, task
//! lists, plugin checkouts with their `.git`, debug logs, Finder litter and
//! the files a session wrote into `outputs/`. Contents are invented. The test
//! names, from both ends, the transcripts that must be taken and asserts that
//! nothing else is.

use memoar_connectors::{OperatingSystem, files_for_source, source};
use std::fs;
use std::path::Path;

const LINE: &str =
    "{\"uuid\":\"u1\",\"parentUuid\":null,\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";

fn write(home: &Path, relative: &str, contents: &[u8]) {
    let path = home.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

const DESKTOP: &str = "Library/Application Support/Claude/local-agent-mode-sessions/acct-1/org-1";

/// The transcripts, which must all be captured.
fn transcripts() -> Vec<String> {
    vec![
        ".claude/projects/-work-repo/sess-1.jsonl".to_owned(),
        ".claude/projects/-work-repo/sess-1/subagents/agent-a1.jsonl".to_owned(),
        format!("{DESKTOP}/local_sess-2/.claude/projects/-sessions-outputs/sess-2.jsonl"),
        format!(
            "{DESKTOP}/local_sess-2/.claude/projects/-sessions-outputs/sess-2/subagents/agent-b1.jsonl"
        ),
        format!("{DESKTOP}/agent/local_ditto_sess-3/.claude/projects/-ditto/sess-3.jsonl"),
    ]
}

/// Everything else, each a path shape that reached dev.
fn never_captured() -> Vec<String> {
    let local = format!("{DESKTOP}/local_sess-2");
    let marketplace = format!("{local}/.claude/plugins/marketplaces/official");
    vec![
        format!("{DESKTOP}/local_sess-2.json"),
        format!("{local}/.audit-key"),
        format!("{local}/audit.jsonl"),
        format!("{local}/.DS_Store"),
        format!("{local}/.claude/.claude.json"),
        format!("{local}/.claude/.last-cleanup"),
        format!("{local}/.claude/policy-limits.json"),
        format!("{local}/.claude/backups/.claude.json.backup.1700000000000"),
        format!("{local}/.claude/tasks/task-1/1.json"),
        format!("{local}/.claude/plugins/known_marketplaces.json"),
        format!("{marketplace}/.git/index"),
        format!("{marketplace}/.git/logs/HEAD"),
        format!("{marketplace}/.git/packed-refs"),
        format!("{marketplace}/.claude-plugin/marketplace.json"),
        format!("{local}/.claude/projects/-sessions-outputs/sess-2/subagents/agent-b1.meta.json"),
        format!("{local}/.claude/projects/-sessions-outputs/sess-2/tool-results/page-08.jpg"),
        format!("{local}/.claude/projects/.git/sess-x.jsonl"),
        format!("{local}/outputs/deck.pdf"),
        format!("{local}/uploads/scan.pdf"),
        format!("{DESKTOP}/debug/sess-2.txt"),
        format!("{DESKTOP}/.project-cache/p1/metadata.json"),
        format!("{DESKTOP}/cowork_plugins/marketplaces/kw/LICENSE"),
        "Library/Application Support/Claude/claude-code-sessions/acct-1/org-1/local_sess-4.json"
            .to_owned(),
        ".claude/projects/-work-repo/.DS_Store".to_owned(),
        ".claude/projects/-work-repo/sess-1/.DS_Store".to_owned(),
        ".claude/projects/-work-repo/sess-1/subagents/agent-a1.meta.json".to_owned(),
        ".claude/projects/-work-repo/sess-1/tool-results/out.txt".to_owned(),
        ".claude/projects/-work-repo/memory/MEMORY.md".to_owned(),
        ".claude/projects/.git/sess-y.jsonl".to_owned(),
        ".claude/history.jsonl".to_owned(),
        ".claude/.credentials.json".to_owned(),
        ".claude.json".to_owned(),
    ]
}

#[test]
fn claude_code_takes_the_transcripts_and_nothing_else() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    for path in transcripts() {
        write(home, &path, LINE.as_bytes());
    }
    for path in never_captured() {
        write(home, &path, b"not a transcript\n");
    }

    let found = files_for_source(source("claude-code").unwrap(), home, OperatingSystem::Macos)
        .expect("discovery should not fail");
    let mut names: Vec<String> = found
        .iter()
        .map(|path| {
            path.strip_prefix(home)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    names.sort();
    let mut expected = transcripts();
    expected.sort();
    assert_eq!(names, expected);
}

#[test]
fn linux_takes_no_desktop_paths() {
    // Claude Desktop does not run there, and a same-named tree is not its.
    let temp = tempfile::tempdir().unwrap();
    for path in transcripts() {
        write(temp.path(), &path, LINE.as_bytes());
    }
    let found = files_for_source(
        source("claude-code").unwrap(),
        temp.path(),
        OperatingSystem::Linux,
    )
    .unwrap();
    assert_eq!(found.len(), 2, "{found:?}");
}
