use memoar_materializer::{ConversionBundle, Target};
use serde_json::json;
use std::fs;

use super::mock::{MACHINE_ID, configured_paths, spawn_mock_api};
use crate::args::{ConvertArgs, PackArgs, RedactionArgs, SearchArgs, ViewArgs};
use crate::config::load_config;
use crate::convert::convert;
use crate::query::{pack, search, view};
use crate::settings::redaction;
// Only the symlink test reads these, and that test is unix-only, so on Windows
// the import is dead and `-D warnings` says so.
#[cfg(unix)]
use crate::status::{doctor, status};

/// Redaction was writable at `login` and nowhere else: a CLI user who forgot
/// the flags had to delete their configuration and sign in again, and the
/// desktop app passed all three as false with nothing anywhere to change
/// them.
#[test]
fn redaction_is_changeable_after_login() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
    assert!(!load_config(&paths).unwrap().redaction.secrets);

    let output = redaction(
        &RedactionArgs {
            secrets: Some(true),
            email_addresses: None,
            home_paths: None,
        },
        &paths,
    )
    .unwrap();

    assert_eq!(output.data["changed"], true);
    assert_eq!(output.data["redaction"]["secrets"], true);
    let stored = load_config(&paths).unwrap().redaction;
    assert!(stored.secrets, "the setting must survive the process");
    assert!(
        !stored.email_addresses && !stored.home_paths,
        "a flag left off leaves that setting alone"
    );
    // Reading is not writing: asking what the settings are must not change
    // them or rewrite the file.
    let shown = redaction(
        &RedactionArgs {
            secrets: None,
            email_addresses: None,
            home_paths: None,
        },
        &paths,
    )
    .unwrap();
    assert_eq!(shown.data["changed"], false);
    assert_eq!(shown.data["redaction"]["secrets"], true);
}

/// A symlinked session store is skipped by discovery without a word, while
/// `detected` follows the link and says the source is there. So `status`
/// reported a source it was capturing nothing from, and nothing anywhere
/// said why.
///
/// Unix only, and the whole test rather than just the `symlink` call: creating
/// one on Windows needs a privilege the runner does not grant, so the link
/// would silently not exist and the assertion would look for a skipped source
/// that nothing had skipped.
#[cfg(unix)]
#[test]
fn status_and_doctor_name_a_source_behind_a_symlink() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, _requests, server) = spawn_mock_api(3, None);
    let paths = configured_paths(&temp, &endpoint);
    let external = temp.path().join("external-volume/projects");
    fs::create_dir_all(external.join("a-project")).unwrap();
    fs::write(external.join("a-project/session.jsonl"), b"{}\n").unwrap();
    fs::create_dir_all(paths.home.join(".claude")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, paths.home.join(".claude/projects")).unwrap();

    let status = status(&paths).unwrap();
    let skipped = status.data["skippedSymlinks"].as_array().unwrap().clone();
    assert_eq!(skipped.len(), 1, "one source is behind a link: {skipped:?}");
    assert_eq!(skipped[0]["source"], "claude-code");
    assert_eq!(
        skipped[0]["path"],
        json!(paths.home.join(".claude/projects"))
    );
    assert!(
        status.data["detectedSources"].as_u64().unwrap() > 0,
        "the source still reads as detected, which is exactly the lie"
    );

    let doctor = doctor(&paths).unwrap();
    server.join().unwrap();
    let check = doctor.data["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["name"] == "source_symlinks")
        .expect("doctor must report it");
    assert_eq!(check["ok"], false);
    assert!(
        check["detail"]
            .as_str()
            .unwrap()
            .contains(".claude/projects"),
        "the check must name the path: {check}"
    );
    assert_eq!(doctor.data["ok"], false);
}

#[test]
fn http_search_view_and_pack_use_authenticated_api() {
    let (endpoint, requests, server) = spawn_mock_api(3, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    search(
        &SearchArgs {
            query: "queue bug".to_owned(),
            mode: "hybrid".to_owned(),
            limit: 5,
            agent: None,
            workspace: None,
        },
        &paths,
    )
    .unwrap();
    view(
        &ViewArgs {
            session_id: "session".to_owned(),
            chunk_size: 50,
            cursor: None,
        },
        &paths,
    )
    .unwrap();
    pack(
        &PackArgs {
            query: "queue bug".to_owned(),
            max_tokens: 1000,
            max_evidence: 4,
            max_sessions: 2,
            max_excerpt_chars: 1000,
            freshness_policy: "mixed".to_owned(),
            stale_after_days: None,
        },
        &paths,
    )
    .unwrap();
    server.join().unwrap();
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.headers.contains("authorization: Bearer user-token"))
    );
}

#[test]
fn http_convert_here_downloads_verified_bundle_and_writes_locally() {
    let content = b"hello\n";
    let mut bundle = ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target: Target::ClaudeCode,
        session_id: MACHINE_ID.to_owned(),
        files: vec![memoar_materializer::BundleFile {
            path: format!("~/.claude/projects/-fixture/{MACHINE_ID}.jsonl"),
            media_type: "application/x-ndjson".to_owned(),
            base64: "aGVsbG8K".to_owned(),
            sha256: memoar_materializer::content_sha256(content),
            size: content.len() as u64,
        }],
        resume_command: format!("claude -r {MACHINE_ID}"),
        report: json!({"mappedTurns": 1, "degradedBlocks": 0, "droppedBlocks": 0}),
    };
    bundle.bundle_sha256 = memoar_materializer::bundle_sha256(&bundle).unwrap();
    let (endpoint, _requests, server) =
        spawn_mock_api(2, Some(serde_json::to_value(&bundle).unwrap()));
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    let result = convert(
        &ConvertArgs {
            session_id: MACHINE_ID.to_owned(),
            target: "claude-code".to_owned(),
            fallback: "fail".to_owned(),
            here: true,
            bundle: None,
            wait_seconds: 1,
            poll_milliseconds: 25,
        },
        &paths,
    )
    .unwrap();
    server.join().unwrap();
    let written = result.data["written"][0].as_str().unwrap();
    assert_eq!(fs::read(written).unwrap(), content);
}
