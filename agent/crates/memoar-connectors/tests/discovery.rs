//! What discovery is allowed to reach, per source and per link.

// Only the symlink-escape test reads instruction files, and that test is
// unix-only, so on Windows this import is dead and `-D warnings` says so.
#[cfg(unix)]
use memoar_connectors::memory::memory_files;
use memoar_connectors::{OperatingSystem, files_for_source, files_for_source_with_env, source};
use std::fs;
use std::path::{Path, PathBuf};

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn names(files: &[PathBuf]) -> Vec<String> {
    files
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

/// A wildcard segment must not be followed through a symlink.
///
/// The literal branch refuses links and the `**` branch filters them; the `*`
/// branch called `entries` and recursed into whatever came back. That is the
/// one branch where it matters most: `.claude/projects/*/memory/*.md` puts a
/// `*` exactly where a project directory goes, so one link named `escaped`
/// pointing out of the tree handed back `escaped/memory/private.md`, read from
/// wherever it really lived.
#[cfg(unix)]
#[test]
fn a_wildcard_segment_does_not_follow_a_link_out_of_the_tree() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let elsewhere = temp.path().join("somebody-else");
    write(&elsewhere.join("memory/private.md"), "not ours to upload");
    // A real project beside it, so the test cannot pass by finding nothing.
    write(
        &home.join(".claude/projects/-repo/memory/state.md"),
        "what we are building",
    );
    fs::create_dir_all(home.join(".claude/projects")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, home.join(".claude/projects/escaped")).unwrap();

    let found = memory_files(&home, &[]);
    assert!(
        found
            .iter()
            .any(|file| file.path.ends_with("memory/state.md")),
        "the real project's memory should still be found"
    );
    assert!(
        !found
            .iter()
            .any(|file| file.path.to_string_lossy().contains("escaped")),
        "read through a link out of the tree: {:?}",
        found.iter().map(|file| &file.path).collect::<Vec<_>>()
    );
}

/// Junk every bare-directory source used to sweep up, per source.
///
/// `claude-code` had its bare directories replaced with globs after a machine
/// where one of them offered 5,392 files — markdown, TypeScript, JPEGs and
/// node_modules an agent had written into its own working directory — to an
/// uploader whose whole promise is session stores and nothing else. Every other
/// source below still named a bare directory, and a bare directory means
/// everything beneath it.
#[test]
fn a_source_reads_only_the_records_its_pattern_names() {
    let cases: &[(&str, OperatingSystem, &str, &str, &[&str])] = &[
        (
            // opencode keeps its sessions in the database and its configuration
            // under `storage/`. The parser refuses anything that is not native
            // SQLite, so the JSON was collected, uploaded and rejected.
            "opencode",
            OperatingSystem::Linux,
            ".local/share/opencode",
            "opencode.db",
            &[
                "opencode.db-wal",
                "opencode.db-shm",
                "storage/project/global.json",
            ],
        ),
        (
            "copilot",
            OperatingSystem::Linux,
            ".copilot/session-state",
            "state.json",
            &["debug.log", "cache.bin"],
        ),
        (
            "roo",
            OperatingSystem::Linux,
            ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/task-1",
            "api_conversation_history.json",
            &["checkpoint.bin", "screenshot.png"],
        ),
        (
            "kilo",
            OperatingSystem::Linux,
            ".config/Code/User/globalStorage/kilocode.kilo-code/tasks/task-1",
            "ui_messages.json",
            &["thumbnail.jpg"],
        ),
        (
            // The real layout on a machine that runs Zed: the agent threads
            // are `threads/threads.db`, and `db/<channel>/db.sqlite` is the
            // editor's own state. This case named the editor's database as the
            // thing to capture, so it passed while capture took the terminal
            // history and no sessions at all.
            "zed",
            OperatingSystem::Linux,
            ".local/share/zed/threads",
            "threads.db",
            &["threads.db-wal", "threads.db-shm", "LOCK"],
        ),
        (
            "goose",
            OperatingSystem::Windows,
            "AppData/Roaming/Block/goose/data/sessions",
            "session-one.jsonl",
            &["goose.log", "config.yaml"],
        ),
    ];

    for (id, os, dir, wanted, junk) in cases {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write(&home.join(dir).join(wanted), "{}\n");
        for name in *junk {
            write(&home.join(dir).join(name), "not a session store");
        }
        // And a stray tree beneath the source root, which is what "bare
        // directory" actually cost: everything, twelve levels deep.
        write(
            &home.join(dir).join("node_modules/pkg/index.js"),
            "module.exports = {}",
        );

        let files = files_for_source(source(id).unwrap(), home, *os).unwrap();
        let found = names(&files);
        assert!(
            found.iter().any(|name| name == wanted),
            "{id}: the record the pattern names was lost: {found:?}"
        );
        for name in junk.iter().chain(std::iter::once(&"index.js")) {
            assert!(
                !found.iter().any(|found| found == name),
                "{id}: {name} is not a session store, got {found:?}"
            );
        }
    }
}

/// An environment override re-roots the globs; it does not switch them off.
///
/// `candidate_paths` returned the override directory on its own, and a pattern
/// with no `*` in it means "this and everything beneath it". So setting
/// `CODEX_HOME` or `OPENCODE_DATA_DIR` — which is what you do when your data
/// lives somewhere unusual — turned off every glob the source declares and
/// offered the whole directory.
#[test]
fn an_environment_override_keeps_the_patterns_it_re_roots() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("custom-codex");
    let rollout = root.join("sessions/2026/08/18/rollout-one.jsonl");
    write(&rollout, "{}\n");
    write(&root.join("config.toml"), "model = \"opus\"");
    write(&root.join("log/codex-tui.log"), "chatter");
    write(&root.join("sessions/2026/08/18/screenshot.png"), "binary");

    let files = files_for_source_with_env(
        source("codex").unwrap(),
        temp.path(),
        OperatingSystem::Linux,
        |key| (key == "CODEX_HOME").then(|| root.clone()),
    )
    .unwrap();

    assert_eq!(
        files,
        vec![rollout],
        "the override names where the sessions live, not what counts as one"
    );
}

/// Every source that takes an override says what the override stands in for,
/// so re-rooting can never quietly fall back to sweeping the directory.
#[test]
fn every_override_declares_a_root_one_of_its_patterns_starts_with() {
    for spec in memoar_connectors::SOURCES {
        if spec.environment_override.is_none() {
            continue;
        }
        assert!(
            !spec.environment_roots.is_empty(),
            "source {} takes an override and names no root for it",
            spec.id
        );
        for root in spec.environment_roots {
            assert!(
                [
                    spec.common_paths,
                    spec.linux_paths,
                    spec.macos_paths,
                    spec.windows_paths
                ]
                .iter()
                .flat_map(|paths| paths.iter())
                .any(|pattern| pattern.starts_with(&format!("{root}/"))),
                "source {}: nothing is declared under {root}",
                spec.id
            );
        }
    }
}

/// Zed keeps two SQLite databases and only one of them is a session store.
///
/// `threads/threads.db` holds the agent threads — the parser reads a single
/// table, `threads`, and only that database has it. `db/<channel>/db.sqlite` is
/// the editor's own state: panes, terminals, breakpoints, keybindings. The
/// pattern pointed at `db/`, so capture took the editor's terminal history
/// every time and never took a conversation. Both halves are asserted, because
/// fixing one without the other just moves the mistake.
#[test]
fn zed_captures_the_threads_and_not_the_editors_own_state() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let threads = home.join("Library/Application Support/Zed/threads");
    let editor = home.join("Library/Application Support/Zed/db/0-stable");
    std::fs::create_dir_all(&threads).unwrap();
    std::fs::create_dir_all(&editor).unwrap();
    std::fs::write(threads.join("threads.db"), b"threads").unwrap();
    std::fs::write(editor.join("db.sqlite"), b"panes and terminals").unwrap();

    let found = files_for_source(source("zed").unwrap(), home, OperatingSystem::Macos).unwrap();
    let names: Vec<_> = found
        .iter()
        .map(|path| {
            path.strip_prefix(home)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();

    assert!(
        names
            .iter()
            .any(|name| name.ends_with("threads/threads.db")),
        "the thread store must be captured: {names:?}",
    );
    assert!(
        !names.iter().any(|name| name.contains("/db/")),
        "the editor's own state is not a session store: {names:?}",
    );
}
