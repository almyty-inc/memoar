//! Queues written by an agent that copied every artifact into `blobs/`.

use rusqlite::params;
use std::fs;
use std::path::{Path, PathBuf};

use super::fake::FakeTransport;
use crate::enqueue::{modified_at, sha256_bytes};
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::sync::SyncEngine;

const MACHINE: &str = "00000000-0000-4000-8000-000000000001";

/// A row the way schema 3 wrote it: a copy in `blobs/`, no source size, no
/// redaction key, no workspace.
fn legacy_row(queue: &OfflineQueue, dir: &Path, name: &str, body: &[u8]) -> (PathBuf, PathBuf) {
    let source = dir.join(name);
    fs::write(&source, body).unwrap();
    let sha = sha256_bytes(body);
    let blob = dir.join("blobs").join(&sha);
    fs::write(&blob, body).unwrap();
    queue
        .connection
        .execute(
            "INSERT INTO artifacts (sha256, source_path, size, source, local_path, modified_at,
                                    status, queued_at)
             VALUES (?1, ?2, ?3, 'claude-code', ?4, ?5, 'pending', '2026-01-01T00:00:00+00:00')",
            params![
                sha,
                source.to_string_lossy(),
                body.len() as i64,
                blob.to_string_lossy(),
                modified_at(&fs::metadata(&source).unwrap()),
            ],
        )
        .unwrap();
    (source, blob)
}

fn blob_count(dir: &Path) -> usize {
    fs::read_dir(dir.join("blobs")).unwrap().count()
}

#[test]
fn an_old_row_uploads_from_its_copy_and_the_copy_is_deleted_after() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let (source, _) = legacy_row(&queue, temp.path(), "a.jsonl", b"captured by 0.4.0");
    // The source is gone: the copy is the only place the bytes are.
    fs::remove_file(&source).unwrap();

    let engine = SyncEngine::new(FakeTransport::default());
    let report = engine.drain(&queue, MACHINE).unwrap();
    assert_eq!(report.uploaded, 1);
    assert_eq!(
        *engine.transport().uploaded.lock().unwrap(),
        vec![b"captured by 0.4.0".to_vec()]
    );
    assert_eq!(
        blob_count(temp.path()),
        0,
        "the copy went once it was synced"
    );
    assert!(queue.pending(10).unwrap().is_empty());
}

#[test]
fn an_old_copy_of_an_unchanged_source_is_released_before_upload() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    legacy_row(&queue, temp.path(), "same.jsonl", b"still as captured");
    let (changed, _) = legacy_row(&queue, temp.path(), "moved.jsonl", b"rewritten since");
    fs::write(&changed, b"rewritten since, and longer").unwrap();

    let pruned = queue.prune_blobs().unwrap();
    assert_eq!(pruned.released, 1, "only the copy of an unchanged source");
    assert_eq!(pruned.removed, 1);
    assert_eq!(
        blob_count(temp.path()),
        1,
        "the changed source's copy stays"
    );
    let waiting = queue.pending(10).unwrap();
    assert_eq!(waiting.len(), 2);
    assert_eq!(
        waiting
            .iter()
            .filter(|row| row.local_path.is_none())
            .count(),
        1
    );

    let report = SyncEngine::new(FakeTransport::default())
        .drain(&queue, MACHINE)
        .unwrap();
    assert_eq!(report.uploaded, 2, "one from its source, one from its copy");
    assert_eq!(blob_count(temp.path()), 0);
}

#[test]
fn a_redacted_copy_is_kept_until_synced_and_no_longer() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let source = temp.path().join("secret.jsonl");
    fs::write(&source, "contact me@example.com today").unwrap();
    let redaction = RedactionConfig {
        email_addresses: true,
        ..RedactionConfig::disabled()
    };
    let artifact = queue
        .enqueue_with_redaction("claude-code", &source, redaction)
        .unwrap();
    assert!(
        artifact.local_path.is_some(),
        "the source does not hold these bytes"
    );
    assert_eq!(blob_count(temp.path()), 1);
    // A prune before upload must not take a copy a waiting row needs.
    queue.prune_blobs().unwrap();
    assert_eq!(blob_count(temp.path()), 1);

    let engine = SyncEngine::new(FakeTransport::default());
    engine.drain(&queue, MACHINE).unwrap();
    let sent = engine.transport().uploaded.lock().unwrap().clone();
    assert!(
        !String::from_utf8(sent[0].clone())
            .unwrap()
            .contains("me@example.com")
    );
    assert_eq!(blob_count(temp.path()), 0);
}

#[test]
fn a_database_is_snapshotted_because_its_tool_rewrites_it() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let source = temp.path().join("state.vscdb");
    fs::write(&source, "sqlite bytes").unwrap();
    let artifact = queue.enqueue("cursor", &source).unwrap();
    assert!(artifact.local_path.is_some());
    fs::write(&source, "rewritten by the editor").unwrap();
    let engine = SyncEngine::new(FakeTransport::default());
    let report = engine.drain(&queue, MACHINE).unwrap();
    assert_eq!(report.uploaded, 1);
    assert_eq!(
        engine.transport().uploaded.lock().unwrap()[0],
        b"sqlite bytes".to_vec(),
        "the bytes hashed at capture"
    );
    assert_eq!(blob_count(temp.path()), 0);
}

#[test]
fn a_source_deleted_before_upload_is_forgotten() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let source = temp.path().join("gone.jsonl");
    fs::write(&source, "short-lived").unwrap();
    queue.enqueue("claude-code", &source).unwrap();
    fs::remove_file(&source).unwrap();
    let report = SyncEngine::new(FakeTransport::default())
        .drain(&queue, MACHINE)
        .unwrap();
    assert_eq!(report.vanished, 1);
    assert_eq!(report.uploaded, 0);
    assert!(queue.pending(10).unwrap().is_empty());
}
