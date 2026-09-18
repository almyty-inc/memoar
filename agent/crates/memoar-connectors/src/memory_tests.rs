//! Tests for the instruction files this crate handles.
//!
//! Split out because `memory.rs` was over the file-size rule and its own
//! test module was most of the excess. Nothing moved but the tests.

use super::*;
use std::fs;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// Finds a discovered file by the tail of its path, written with forward
/// slashes whatever the platform separator is.
///
/// Windows renders these paths with backslashes, so a suffix of
/// `.claude/CLAUDE.md` matched nothing there and the test reported the file
/// missing when discovery had found it perfectly well — a failure of the
/// assertion, not of the thing asserted.
fn found<'a>(files: &'a [DiscoveredMemory], suffix: &str) -> Option<&'a DiscoveredMemory> {
    files.iter().find(|file| {
        file.path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(suffix)
    })
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

/// Unix only, and the whole test rather than just the `symlink` call.
///
/// Without the link this asserts that nothing was found in a tree where nothing
/// was ever linked — true on any platform, and evidence of nothing. A test that
/// passes vacuously is worse than one that does not run, because the count says
/// it ran.
#[cfg(unix)]
#[test]
fn never_follows_a_symlink_out_of_the_tree() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("repo");
    let elsewhere = temp.path().join("somebody-else");
    write(&elsewhere.join("rules/private.md"), "not ours to upload");
    fs::create_dir_all(project.join(".roo")).unwrap();
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
