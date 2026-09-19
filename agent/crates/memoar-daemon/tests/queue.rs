//! What the offline queue refuses, gives up on, and lets past.

use chrono::{Duration as Span, Utc};
use memoar_daemon::{DaemonError, MAX_ARTIFACT_BYTES, MAX_ATTEMPTS, OfflineQueue, QueueStatus};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

fn queue(dir: &Path) -> OfflineQueue {
    OfflineQueue::open(&dir.join("queue.sqlite3")).unwrap()
}

fn file(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, body).unwrap();
    path
}

/// Nothing past the archive's ceiling is read, hashed, copied or queued.
///
/// `MAX_ARTIFACT_BYTES` was declared and never consulted: `enqueue` read the
/// whole file into memory before it knew anything about it, wrote a second copy
/// into the blob directory, and queued it for a server whose ingress answers
/// 413 — forever, because nothing ever gave up. Stat first.
#[test]
fn refuses_an_artifact_larger_than_the_archive_accepts() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("huge.jsonl");
    // Sparse: this costs no disk, and the point is that it is never read.
    OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&source)
        .unwrap()
        .set_len(MAX_ARTIFACT_BYTES + 1)
        .unwrap();

    let queue = queue(temp.path());
    let error = queue
        .enqueue("fixture", &source)
        .expect_err("a file past the ceiling must not be queued");
    assert!(
        matches!(error, DaemonError::TooLarge { .. }),
        "expected a size refusal, got: {error}"
    );
    assert!(error.is_skippable(), "and the rest of the pass carries on");
    assert_eq!(queue.counts().unwrap().pending, 0);
    let blobs = temp.path().join("blobs");
    assert_eq!(
        fs::read_dir(&blobs).unwrap().count(),
        0,
        "no snapshot was written for a file that was never accepted"
    );
}

/// An artifact the server will not take is eventually left alone.
#[test]
fn stops_offering_an_artifact_the_server_keeps_refusing() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue(temp.path());
    let source = file(temp.path(), "poison.jsonl", "the server will not take this");
    let artifact = queue.enqueue("fixture", &source).unwrap();

    let long_after = Utc::now() + Span::days(30);
    for attempt in 1..=MAX_ATTEMPTS {
        assert_eq!(
            queue.pending_at(10, long_after).unwrap().len(),
            1,
            "attempt {attempt} should still have been offered"
        );
        queue
            .mark_retry(&artifact.sha256, &artifact.source_path, "HTTP 413")
            .unwrap();
    }
    assert!(
        queue.pending_at(10, long_after).unwrap().is_empty(),
        "after {MAX_ATTEMPTS} refusals the queue has to stop asking"
    );
    assert_eq!(queue.abandoned().unwrap(), 1);
}

/// And in between, it waits.
#[test]
fn a_failed_artifact_waits_before_it_is_tried_again() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue(temp.path());
    let source = file(temp.path(), "flaky.jsonl", "the connection dropped");
    let artifact = queue.enqueue("fixture", &source).unwrap();
    queue
        .mark_retry(&artifact.sha256, &artifact.source_path, "connection closed")
        .unwrap();

    assert!(
        queue.pending(10).unwrap().is_empty(),
        "a retry must not be re-offered in the same breath it failed in"
    );
    let later = queue.pending_at(10, Utc::now() + Span::hours(12)).unwrap();
    assert_eq!(later.len(), 1, "but it does come back");
    assert_eq!(later[0].status, QueueStatus::Retry);
    assert_eq!(later[0].attempts, 1);
}

/// A fresh capture never queues behind something already refused.
///
/// `pending` selected `ORDER BY queued_at ASC LIMIT 256` and `mark_retry` left
/// `queued_at` alone, so artifacts the server had permanently rejected kept the
/// oldest timestamps in the table and were re-offered, in full, on every pass.
/// Two hundred and fifty-six of them and no session captured afterwards is ever
/// looked at again.
#[test]
fn a_fresh_capture_is_never_starved_by_refused_ones() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue(temp.path());
    for index in 0..3 {
        let source = file(
            temp.path(),
            &format!("poison-{index}.jsonl"),
            &format!("refused {index}"),
        );
        let artifact = queue.enqueue("fixture", &source).unwrap();
        queue
            .mark_retry(&artifact.sha256, &artifact.source_path, "HTTP 413")
            .unwrap();
    }
    let fresh = file(
        temp.path(),
        "fresh.jsonl",
        "a session recorded this morning",
    );
    queue.enqueue("fixture", &fresh).unwrap();

    // A batch no larger than the backlog: the old order filled it entirely with
    // artifacts that had already been refused.
    let batch = queue.pending_at(3, Utc::now() + Span::hours(12)).unwrap();
    assert!(
        batch
            .iter()
            .any(|artifact| artifact.source_path == fresh.to_string_lossy()),
        "this morning's session never got into the batch: {:?}",
        batch
            .iter()
            .map(|artifact| artifact.source_path.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        batch[0].attempts, 0,
        "what has failed least should go first"
    );
}

/// The same bytes found in two places are two rows, and one upload settles one.
///
/// `mark_synced` and `mark_retry` keyed on `sha256` while the primary key is
/// `(sha256, source_path)`. So a single successful upload marked every row
/// carrying those bytes synced, and the other rows' `source_path` — where the
/// transcript was actually found, which is half of what makes it a record —
/// was never sent to the archive at all.
#[test]
fn marking_one_row_synced_leaves_the_other_place_it_was_found_queued() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue(temp.path());
    let here = file(temp.path(), "here.jsonl", "the same session, copied");
    let there = file(temp.path(), "there.jsonl", "the same session, copied");
    let first = queue.enqueue("fixture", &here).unwrap();
    let second = queue.enqueue("fixture", &there).unwrap();
    assert_eq!(first.sha256, second.sha256, "the same bytes, twice");
    assert_eq!(queue.counts().unwrap().pending, 2, "and two rows");

    queue
        .mark_synced(&first.sha256, &first.source_path)
        .unwrap();

    let counts = queue.counts().unwrap();
    assert_eq!(counts.synced, 1, "one upload settles one row");
    assert_eq!(counts.pending, 1);
    let left = queue.pending(10).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(
        left[0].source_path,
        there.to_string_lossy(),
        "the other place it was found still has to be reported"
    );
}
