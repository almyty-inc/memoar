use chrono::Utc;
use std::collections::HashSet;
use std::fs;

use super::fake::{FakeTransport, PartialTransport};
use crate::capture::capture_sources;
use crate::enqueue::sha256_bytes;
use crate::queue::{OfflineQueue, QueueStatus};
use crate::sync::SyncEngine;
use crate::transport::{
    CONNECT_TIMEOUT, MAX_ARTIFACT_BYTES, SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC, UPLOAD_TIMEOUT,
};
use memoar_connectors::OperatingSystem;

#[test]
fn failed_manifest_remains_resumable_in_retry_state() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.jsonl");
    fs::write(&source, "queued").unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    queue.enqueue("fixture", &source).unwrap();
    let error = SyncEngine::new(FakeTransport {
        fail_manifest: true,
        ..FakeTransport::default()
    })
    .sync(&queue, "machine")
    .unwrap_err();
    assert!(error.to_string().contains("offline"));
    // Past the backoff a failed artifact now waits out, which is the point
    // of it being resumable rather than immediately retried.
    let pending = queue
        .pending_at(10, Utc::now() + chrono::Duration::hours(12))
        .unwrap();
    assert_eq!(pending[0].status, QueueStatus::Retry);
    assert_eq!(pending[0].attempts, 1);
}

#[test]
fn partial_receipt_keeps_artifacts_queued() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.jsonl");
    fs::write(&source, "queued").unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    queue.enqueue("fixture", &source).unwrap();
    let error = SyncEngine::new(FakeTransport {
        partial_receipt: true,
        ..FakeTransport::default()
    })
    .sync(&queue, "machine")
    .unwrap_err();
    assert!(error.to_string().contains("receipt mismatch"));
    let pending = queue
        .pending_at(10, Utc::now() + chrono::Duration::hours(12))
        .unwrap();
    assert_eq!(pending[0].status, QueueStatus::Retry);
    assert_eq!(pending[0].attempts, 1);
}

/// A failed upload is not a duplicate.
///
/// `duplicates` was `considered - uploaded`, so a pass that lost an upload
/// reported it as bytes the archive already held — the one number that says
/// "nothing to do here" standing in for the one that says "this never
/// arrived".
#[test]
fn a_lost_upload_is_not_reported_as_a_duplicate() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let dir = home.join(".claude/projects/-workspace");
    fs::create_dir_all(&dir).unwrap();
    for (name, body) in [
        ("held.jsonl", "already in the archive"),
        ("lost.jsonl", "never arrives"),
        ("fresh.jsonl", "new capture"),
    ] {
        fs::write(dir.join(name), body).unwrap();
    }
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let enabled = HashSet::from(["claude-code".to_owned()]);
    assert_eq!(
        capture_sources(&queue, &home, OperatingSystem::Linux, &enabled).unwrap(),
        3
    );

    let hash_of = |body: &str| sha256_bytes(body.as_bytes());
    let transport = PartialTransport {
        present: HashSet::from([hash_of("already in the archive")]),
        refuse: HashSet::from([hash_of("never arrives")]),
    };
    let report = SyncEngine::new(transport)
        .sync(&queue, "00000000-0000-4000-8000-000000000001")
        .unwrap();

    assert_eq!(report.considered, 3);
    assert_eq!(report.uploaded, 1, "only the fresh capture went up");
    assert_eq!(report.failed, 1, "the refused upload is a failure");
    assert_eq!(
        report.duplicates, 1,
        "only the hash the archive already held is a duplicate"
    );
    // The one that never arrived stays queued rather than being marked done.
    assert_eq!(queue.counts().unwrap().synced, 2);
}
/// The upload deadline has to be reachable for the largest artifact the
/// archive will accept.
///
/// reqwest's blocking client caps a whole request at 30 seconds by default,
/// and `Client::new()` took that default. Every transcript over roughly
/// 30 MB therefore failed on a deadline it could not meet, was requeued, and
/// failed again — one 116 MB session reached twenty attempts having never
/// once had the time to finish. This fails if the timeout drops or the size
/// ceiling rises without the other moving too.
#[test]
fn the_upload_deadline_is_reachable_at_the_size_ceiling() {
    let needed = MAX_ARTIFACT_BYTES / SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC;
    assert!(
        UPLOAD_TIMEOUT.as_secs() >= needed,
        "a {MAX_ARTIFACT_BYTES}-byte artifact needs {needed}s at the slowest \
         tolerated uplink, but uploads are cut off after {}s",
        UPLOAD_TIMEOUT.as_secs()
    );
    assert!(
        CONNECT_TIMEOUT < UPLOAD_TIMEOUT,
        "an unreachable host must fail long before a slow upload does"
    );
}
