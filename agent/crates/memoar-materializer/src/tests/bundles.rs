use rusqlite::Connection;
use serde_json::json;
use std::fs;

use super::fixtures::{SESSION_ID, single_file_bundle};
use crate::entry::materialize_bundle;
use crate::error::MaterializeError;
use crate::target::Target;

#[test]
fn server_native_bundle_decodes_and_materializes_idempotently() {
    let temp = tempfile::tempdir().unwrap();
    let content = b"{\"type\":\"user\"}\n";
    let bundle = single_file_bundle(
        Target::ClaudeCode,
        &format!("~/.claude/projects/-tmp-project/{SESSION_ID}.jsonl"),
        content,
    );
    let first = materialize_bundle(&bundle, temp.path()).unwrap();
    assert_eq!(fs::read(&first.written[0]).unwrap(), content);
    let second = materialize_bundle(&bundle, temp.path()).unwrap();
    assert!(second.written.is_empty());
    assert_eq!(second.unchanged.len(), 1);
}

#[test]
fn a_bundle_reports_what_the_archive_said_it_did() {
    // The archive writes {"mapped":N,"degraded":[...],"dropped":[...],
    // "fallback":bool}. It is passed on untouched, so a conversion that
    // dropped half a session cannot report nothing dropped.
    let temp = tempfile::tempdir().unwrap();
    let archive_report = json!({
        "mapped": 4,
        "degraded": [{"turnId": "t1", "blockId": "b1", "kind": "image", "reason": "no native representation"}],
        "dropped": [{"reference": "block:b2", "reason": "reasoning_not_portable"}],
        "fallback": false,
    });
    let mut bundle = single_file_bundle(
        Target::ClaudeCode,
        &format!("~/.claude/projects/-tmp-project/{SESSION_ID}.jsonl"),
        b"{}\n",
    );
    bundle.report = archive_report.clone();
    let bundle = super::fixtures::finalized_bundle(bundle);

    let result = materialize_bundle(&bundle, temp.path()).unwrap();

    let reported = serde_json::to_value(&result.report).unwrap();
    assert_eq!(reported, archive_report);
}

/// A database as Antigravity writes it: the two tables the check reads, and
/// `user_version` 1, without which Antigravity skips the conversation.
fn antigravity_database(cascade: &str, user_version: i64) -> Vec<u8> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("conversation.db");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&format!(
            "PRAGMA user_version = {user_version};
             CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
             CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, step_payload BLOB);"
        ))
        .unwrap();
    connection
        .execute(
            "INSERT INTO trajectory_meta VALUES (?1, ?1, 4, 17)",
            [cascade],
        )
        .unwrap();
    drop(connection);
    fs::read(path).unwrap()
}

#[test]
fn an_antigravity_database_lands_where_antigravity_opens_conversations() {
    let temp = tempfile::tempdir().unwrap();
    let database = antigravity_database(SESSION_ID, 1);
    let bundle = single_file_bundle(
        Target::AntigravityCli,
        &format!("~/.gemini/antigravity-cli/conversations/{SESSION_ID}.db"),
        &database,
    );
    let result = materialize_bundle(&bundle, temp.path()).unwrap();
    assert_eq!(
        result.written[0],
        temp.path()
            .join(".gemini/antigravity-cli/conversations")
            .join(format!("{SESSION_ID}.db"))
    );
    assert_eq!(fs::read(&result.written[0]).unwrap(), database);
}

#[test]
fn an_antigravity_database_antigravity_would_skip_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let path = format!("~/.gemini/antigravity-cli/conversations/{SESSION_ID}.db");
    for database in [
        antigravity_database(SESSION_ID, 0),
        antigravity_database("0198d8d0-977c-777b-9f8f-0f6d8416e799", 1),
    ] {
        let bundle = single_file_bundle(Target::AntigravityCli, &path, &database);
        assert!(matches!(
            materialize_bundle(&bundle, temp.path()),
            Err(MaterializeError::Integrity(_))
        ));
    }
    assert!(!temp.path().join(".gemini").exists());
}
