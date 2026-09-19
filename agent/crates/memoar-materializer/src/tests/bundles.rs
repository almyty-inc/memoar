use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::Connection;
use serde_json::json;
use std::fs;

use super::fixtures::{finalized_bundle, fixture_session};
use crate::antigravity::antigravity_database_bytes;
use crate::bundle::{BundleFile, ConversionBundle};
use crate::entry::{materialize, materialize_bundle};
use crate::target::Target;

#[test]
fn materializes_all_gated_targets_and_is_idempotent() {
    for target in [Target::ClaudeCode, Target::Codex, Target::AntigravityCli] {
        let temp = tempfile::tempdir().unwrap();
        let first = materialize(&fixture_session(), target, temp.path()).unwrap();
        assert!(!first.written.is_empty());
        assert!(first.written.iter().all(|path| path.exists()));
        let second = materialize(&fixture_session(), target, temp.path()).unwrap();
        assert!(second.written.is_empty());
        assert_eq!(second.unchanged.len(), first.written.len());
    }
}

#[test]
fn server_native_bundle_decodes_and_materializes() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = fixture_session().id;
    let content = b"{\"type\":\"message\"}\n";
    let bundle = finalized_bundle(ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target: Target::ClaudeCode,
        session_id: session_id.clone(),
        files: vec![BundleFile {
            path: format!("~/.claude/projects/-tmp-project/{session_id}.jsonl"),
            media_type: "application/x-ndjson".to_owned(),
            base64: BASE64.encode(content),
            sha256: String::new(),
            size: 0,
        }],
        resume_command: format!("claude -r {session_id}"),
        report: json!({"mappedTurns": 1, "degradedBlocks": 0, "droppedBlocks": 0}),
    });
    let result = materialize_bundle(&bundle, temp.path()).unwrap();
    assert_eq!(fs::read(&result.written[0]).unwrap(), content);
}

#[test]
fn a_bundle_reports_what_the_archive_said_it_did() {
    // The archive writes {"mapped":N,"degraded":[...],"dropped":[...],
    // "fallback":bool}. That was parsed into this crate's own report
    // struct, whose fields are named differently, so the parse failed every
    // time and unwrap_or_default printed zeros: a conversion that dropped
    // half a session reported nothing dropped, and the fixture beside it
    // used this crate's names, so nothing caught it.
    let temp = tempfile::tempdir().unwrap();
    let session_id = fixture_session().id;
    let archive_report = json!({
        "mapped": 4,
        "degraded": [{"turnId": "t1", "blockId": "b1", "kind": "image", "reason": "no native representation"}],
        "dropped": [{"reference": "turns:5-900", "reason": "injection_token_budget_exceeded"}],
        "fallback": true,
    });
    let bundle = finalized_bundle(ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target: Target::ClaudeCode,
        session_id: session_id.clone(),
        files: vec![BundleFile {
            path: format!("~/.claude/projects/-tmp-project/{session_id}.jsonl"),
            media_type: "application/x-ndjson".to_owned(),
            base64: BASE64.encode(b"{\"type\":\"message\"}\n"),
            sha256: String::new(),
            size: 0,
        }],
        resume_command: format!("claude -r {session_id}"),
        report: archive_report.clone(),
    });

    let result = materialize_bundle(&bundle, temp.path()).unwrap();

    let reported = serde_json::to_value(&result.report).unwrap();
    assert_eq!(
        reported, archive_report,
        "the archive's report must survive the trip"
    );
    assert_eq!(reported["dropped"].as_array().unwrap().len(), 1);
    assert_eq!(reported["fallback"], json!(true));
}

#[test]
fn antigravity_bundle_builds_observed_sqlite_schema() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = fixture_session().id;
    let seed = serde_json::to_vec(
        &json!({"id": session_id, "workspacePath": "/tmp/project", "title": "Test"}),
    )
    .unwrap();
    let native_database = antigravity_database_bytes(&session_id, &seed).unwrap();
    let bundle = finalized_bundle(ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target: Target::AntigravityCli,
        session_id: session_id.clone(),
        files: vec![BundleFile {
            path: format!(
                "~/.gemini/antigravity-cli/brain/{session_id}/conversations/{session_id}.db"
            ),
            media_type: "application/vnd.sqlite3".to_owned(),
            base64: BASE64.encode(&native_database),
            sha256: String::new(),
            size: 0,
        }],
        resume_command: format!("agy --conversation {session_id}"),
        report: json!({}),
    });
    let result = materialize_bundle(&bundle, temp.path()).unwrap();
    assert_eq!(fs::read(&result.written[0]).unwrap(), native_database);
    let database = Connection::open(&result.written[0]).unwrap();
    let integrity: String = database
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    let version: i64 = database
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let trajectory: String = database
        .query_row("SELECT trajectory_id FROM trajectory_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(version, 1);
    assert_eq!(trajectory, session_id);
}
