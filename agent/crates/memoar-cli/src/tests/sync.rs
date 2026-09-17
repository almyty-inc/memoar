use memoar_daemon::RedactionConfig;
use serde_json::{Value, json};
use std::fs;

use super::mock::{configured_paths, spawn_mock_api, spawn_mock_api_with_workspace};
use crate::args::SyncArgs;
use crate::config::{load_config, save_config};
use crate::sync::sync;

#[test]
fn http_sync_negotiates_uploads_raw_bytes_and_submits_manifest() {
    let (endpoint, requests, server) = spawn_mock_api(5, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    let session = paths.home.join(".claude/projects/-fixture/session.jsonl");
    fs::create_dir_all(session.parent().unwrap()).unwrap();
    fs::write(&session, b"{\"type\":\"user\"}\n").unwrap();
    let result = sync(
        &SyncArgs {
            watch: false,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 0,
        },
        false,
        &paths,
    )
    .unwrap();
    assert_eq!(result.data["sync"]["uploaded"], 1);
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[2].path, "/v1/ingest/delta");
    assert!(requests[3].path.starts_with("/v1/ingest/artifacts/"));
    assert_eq!(requests[3].body, b"{\"type\":\"user\"}\n");
    assert_eq!(requests[4].path, "/v1/ingest/manifests");
}

#[test]
fn sync_captures_the_memory_files_of_projects_the_archive_knows() {
    // What the agents on this machine are told is part of the archive: a
    // transcript cannot be read for what it was without the instructions it
    // was produced under. Which directories are projects is not something
    // the agent can know by looking, so it asks the archive, which knows
    // because every transcript names the directory it was recorded in.
    let temp = tempfile::tempdir().unwrap();
    // Inside the capture home, because that is the only place a
    // server-supplied workspace is now allowed to point.
    let project = temp.path().join("fixture-home/project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("AGENTS.md"), "project rules").unwrap();

    let (endpoint, requests, server) =
        spawn_mock_api_with_workspace(8, None, project.to_string_lossy().into_owned());
    let paths = configured_paths(&temp, &endpoint);
    fs::create_dir_all(paths.home.join(".claude")).unwrap();
    fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();
    let session = paths.home.join(".claude/projects/-fixture/session.jsonl");
    fs::create_dir_all(session.parent().unwrap()).unwrap();
    fs::write(&session, b"{\"type\":\"user\"}\n").unwrap();

    let result = sync(
        &SyncArgs {
            watch: false,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 0,
        },
        false,
        &paths,
    )
    .unwrap();

    assert_eq!(result.data["memory"]["found"], 2, "one global, one project");
    assert_eq!(result.data["memory"]["uploaded"], 2);
    assert_eq!(result.data["memory"]["recorded"], 2);
    server.join().unwrap();

    let requests = requests.lock().unwrap();
    let captured: Vec<Value> = requests
        .iter()
        .filter(|request| request.path == "/v1/memory")
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect();
    assert_eq!(captured.len(), 2);
    let project_file = captured
        .iter()
        .find(|body| body["scope"] == "project")
        .expect("the project's own AGENTS.md");
    assert_eq!(project_file["text"], "project rules");
    assert!(
        project_file["readers"]
            .as_array()
            .unwrap()
            .contains(&json!("codex")),
        "the tools that read this path, not the one that wrote it"
    );
    // A machine token, not the user session: this is capture.
    assert!(
        requests
            .iter()
            .find(|request| request.path == "/v1/memory")
            .unwrap()
            .headers
            .contains("authorization: Bearer machine-token")
    );
}

/// A workspace is a string the server chose, and it was being used as a
/// local read root on the strength of "absolute and a directory" alone.
/// An archive that is compromised, or simply wrong, could answer
/// `"workspace": "/Users/someone-else"` and this machine would read that
/// directory's instruction files and upload them. The server does not get
/// to choose which local files the client reads.
#[test]
fn a_workspace_outside_the_capture_home_is_never_read() {
    let temp = tempfile::tempdir().unwrap();
    let elsewhere = temp.path().join("someone-else");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("AGENTS.md"), "not this machine's to send").unwrap();

    let (endpoint, requests, server) =
        spawn_mock_api_with_workspace(4, None, elsewhere.to_string_lossy().into_owned());
    let paths = configured_paths(&temp, &endpoint);
    fs::create_dir_all(paths.home.join(".claude")).unwrap();
    fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();

    let result = sync(
        &SyncArgs {
            watch: false,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 0,
        },
        false,
        &paths,
    )
    .unwrap();

    assert_eq!(
        result.data["memory"]["found"], 1,
        "only this home's own instruction file"
    );
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert!(
        !requests.iter().any(|request| {
            String::from_utf8_lossy(&request.body).contains("not this machine's to send")
        }),
        "a directory the user never nominated was read and uploaded"
    );
}

/// Redaction was applied to transcripts and to nothing else.
///
/// Somebody who ran `memoar login --redact-secrets` had their sessions
/// scrubbed and their `~/.claude/CLAUDE.md`, every project `AGENTS.md` and
/// every `~/.claude/projects/*/memory/*.md` uploaded byte for byte — which
/// are precisely the files a connection string or an API key gets pasted
/// into, and they had been told masking was on.
#[test]
fn a_secret_in_an_instruction_file_is_masked_before_it_leaves() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, requests, server) = spawn_mock_api(4, None);
    let paths = configured_paths(&temp, &endpoint);
    let mut config = load_config(&paths).unwrap();
    config.redaction = RedactionConfig {
        secrets: true,
        email_addresses: false,
        home_paths: false,
    };
    save_config(&paths, &config).unwrap();
    fs::create_dir_all(paths.home.join(".claude")).unwrap();
    fs::write(
        paths.home.join(".claude/CLAUDE.md"),
        "Use the staging archive.\nANTHROPIC_API_KEY=sk-live-do-not-upload\n",
    )
    .unwrap();

    let result = sync(
        &SyncArgs {
            watch: false,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 0,
        },
        false,
        &paths,
    )
    .unwrap();

    assert_eq!(result.data["memory"]["uploaded"], 1);
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    let sent: Vec<String> = requests
        .iter()
        .filter(|request| request.path == "/v1/memory")
        .map(|request| String::from_utf8_lossy(&request.body).into_owned())
        .collect();
    assert_eq!(sent.len(), 1);
    assert!(
        !sent[0].contains("sk-live-do-not-upload"),
        "the key went up under a receipt saying masking was on: {}",
        sent[0]
    );
    assert!(
        sent[0].contains("[REDACTED]"),
        "masked, not dropped — the rest of the file is still the archive's: {}",
        sent[0]
    );
}
