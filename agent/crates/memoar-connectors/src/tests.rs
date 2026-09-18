use super::*;
use std::collections::HashSet;
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
