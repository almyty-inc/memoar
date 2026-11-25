//! A store of thousands of sessions: no copies, steady progress, all of it sent.

use memoar_connectors::OperatingSystem;
use std::collections::HashSet;
use std::fs;
use std::time::{Duration, Instant};

use super::fake::FakeTransport;
use super::policy::session;
use crate::capture::capture_sources_with_policy;
use crate::policy::CapturePolicy;
use crate::progress::Progress;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::sync::SyncEngine;

const MACHINE: &str = "00000000-0000-4000-8000-000000000001";

#[test]
fn three_thousand_sessions_are_captured_without_copies_and_all_uploaded() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    for index in 0..3000 {
        session(
            &home,
            &format!("/work/p{}", index % 40),
            &format!("s{index}"),
            1,
        );
    }
    let queue = OfflineQueue::open(&temp.path().join("data/queue.sqlite3")).unwrap();
    let summary = capture_sources_with_policy(
        &queue,
        &home,
        OperatingSystem::Linux,
        &HashSet::from(["claude-code".to_owned()]),
        RedactionConfig::disabled(),
        &CapturePolicy::everything(),
    )
    .unwrap();
    assert_eq!(summary.captured, 3000);
    assert_eq!(
        fs::read_dir(temp.path().join("data/blobs"))
            .unwrap()
            .count(),
        0
    );

    let mut seen: Vec<Progress> = Vec::new();
    let engine = SyncEngine::new(FakeTransport::default()).with_workers(4);
    let report = engine
        .drain_with_progress(&queue, MACHINE, &mut |progress| seen.push(*progress))
        .unwrap();
    assert_eq!(report.uploaded, 3000);
    assert_eq!(engine.transport().uploaded.lock().unwrap().len(), 3000);
    assert_eq!(queue.counts().unwrap().synced, 3000);
    let last = seen.last().unwrap();
    assert_eq!((last.total, last.done, last.uploaded), (3000, 3000, 3000));
    assert!(
        seen.windows(2).all(|pair| pair[0].done < pair[1].done),
        "progress only moves forward"
    );
}

#[test]
fn uploads_are_paced_to_the_rate_asked_for() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    for index in 0..7 {
        let path = temp.path().join(format!("s{index}.jsonl"));
        fs::write(&path, format!("session {index}")).unwrap();
        queue.enqueue("claude-code", &path).unwrap();
    }
    // 600 a minute is one every 100 ms: seven uploads take at least 600 ms
    // however many workers there are.
    let engine = SyncEngine::new(FakeTransport::default())
        .with_workers(4)
        .with_upload_rate(600);
    let started = Instant::now();
    let report = engine.drain(&queue, MACHINE).unwrap();
    assert_eq!(report.uploaded, 7);
    assert!(
        started.elapsed() >= Duration::from_millis(590),
        "{:?}",
        started.elapsed()
    );
}
