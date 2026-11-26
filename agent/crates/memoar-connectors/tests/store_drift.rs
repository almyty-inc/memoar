//! The stores the tools moved to, each named beside what is left alone.
//!
//! Every case here is a layout a tool started writing after its pattern was
//! written: Codex compressing rollouts, Kilo Code moving onto OpenCode's
//! database, the Copilot CLI writing an event stream, and VS Code keeping
//! folder-less chat panels in global storage.

use memoar_connectors::{OperatingSystem, files_for_source_with_env, source};
use std::fs;
use std::path::{Path, PathBuf};

fn write(path: &Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn collect(id: &str, home: &Path, os: OperatingSystem) -> Vec<PathBuf> {
    files_for_source_with_env(source(id).unwrap(), home, os, |_| None).unwrap()
}

#[test]
fn codex_takes_compressed_rollouts_beside_plain_ones() {
    let temp = tempfile::tempdir().unwrap();
    let day = temp.path().join(".codex/sessions/2026/04/17");
    let plain = day.join("rollout-2026-04-17T07-29-00-a.jsonl");
    let packed = day.join("rollout-2025-09-24T06-56-02-b.jsonl.zst");
    write(&plain, b"{}\n");
    write(&packed, b"\x28\xb5\x2f\xfd");
    write(&day.join("rollout-compress-x.tmp"), b"partial");
    write(&day.join("notes.zst"), b"not a rollout");

    let mut expected = vec![packed, plain];
    expected.sort();
    assert_eq!(
        collect("codex", temp.path(), OperatingSystem::Macos),
        expected
    );
}

#[test]
fn kilo_takes_its_opencode_database_and_its_legacy_tasks() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join(".local/share/kilo");
    write(&data.join("kilo.db"), b"SQLite format 3\0");
    write(&data.join("kilo-dev.db"), b"SQLite format 3\0");
    write(&data.join("kilo.db-wal"), b"journal");
    write(&data.join("log/kilo.log"), b"chatter");
    let task = temp
        .path()
        .join(".config/Code/User/globalStorage/kilocode.kilo-code/tasks/t1");
    write(&task.join("api_conversation_history.json"), b"[]");
    write(&task.join("ui_messages.json"), b"[]");

    let files = collect("kilo", temp.path(), OperatingSystem::Linux);
    assert_eq!(
        files,
        vec![
            task.join("api_conversation_history.json"),
            data.join("kilo-dev.db"),
            data.join("kilo.db"),
        ]
    );
    // xdg-basedir puts the data directory under the home on Windows too.
    let windows = collect("kilo", temp.path(), OperatingSystem::Windows);
    assert!(windows.contains(&data.join("kilo.db")), "{windows:?}");
}

#[test]
fn opencode_follows_xdg_data_home_and_its_channel_databases() {
    let temp = tempfile::tempdir().unwrap();
    let xdg = temp.path().join("xdg-data");
    write(&xdg.join("opencode/opencode.db"), b"SQLite format 3\0");
    write(
        &xdg.join("opencode/opencode-local.db"),
        b"SQLite format 3\0",
    );
    write(&xdg.join("opencode/storage/project/global.json"), b"{}");

    let files = files_for_source_with_env(
        source("opencode").unwrap(),
        temp.path(),
        OperatingSystem::Windows,
        |key| (key == "XDG_DATA_HOME").then(|| xdg.clone()),
    )
    .unwrap();
    assert_eq!(
        files,
        vec![
            xdg.join("opencode/opencode-local.db"),
            xdg.join("opencode/opencode.db"),
        ]
    );

    // Without the variable, Windows reads the same home-relative directory.
    let home_db = temp.path().join(".local/share/opencode/opencode.db");
    write(&home_db, b"SQLite format 3\0");
    assert_eq!(
        collect("opencode", temp.path(), OperatingSystem::Windows),
        vec![home_db]
    );
}

#[test]
fn copilot_takes_the_cli_event_stream_and_nothing_beside_it() {
    let temp = tempfile::tempdir().unwrap();
    let session = temp.path().join(".copilot/session-state/17a4");
    write(&session.join("events.jsonl"), b"{}\n");
    write(&session.join("workspace.yaml"), b"cwd: /w\n");
    write(&session.join("checkpoints/index.md"), b"# none\n");
    write(&temp.path().join(".copilot/config.json"), b"{}");

    assert_eq!(
        collect("copilot", temp.path(), OperatingSystem::Linux),
        vec![session.join("events.jsonl")]
    );
}

#[test]
fn copilot_takes_panels_opened_without_a_folder() {
    let temp = tempfile::tempdir().unwrap();
    let user = temp.path().join("Library/Application Support/Code/User");
    let empty = user.join("globalStorage/emptyWindowChatSessions/0b10.jsonl");
    let none = user.join("workspaceStorage/no-workspace/chatSessions/9f.jsonl");
    write(&empty, b"{\"kind\":0}\n");
    write(&none, b"{\"kind\":0}\n");
    write(&user.join("globalStorage/storage.json"), b"{}");

    let files = collect("copilot", temp.path(), OperatingSystem::Macos);
    assert_eq!(files, vec![empty, none]);
}

#[test]
fn zed_on_windows_reads_local_app_data() {
    let temp = tempfile::tempdir().unwrap();
    let threads = temp.path().join("AppData/Local/Zed/threads/threads.db");
    write(&threads, b"SQLite format 3\0");
    write(
        &temp.path().join("AppData/Local/Zed/db/0-stable/db.sqlite"),
        b"x",
    );
    assert_eq!(
        collect("zed", temp.path(), OperatingSystem::Windows),
        vec![threads]
    );
}
