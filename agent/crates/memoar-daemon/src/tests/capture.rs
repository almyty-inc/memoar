use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

use super::fake::FakeTransport;
use crate::capture::capture_sources;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::sync::SyncEngine;
use crate::watcher::{DebouncedChanges, FileFingerprint, PollingCapture};
use memoar_connectors::OperatingSystem;

#[test]
fn fixture_home_captures_and_syncs_immutable_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let source = home.join(".claude/projects/-workspace/session.jsonl");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, "first").unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let enabled = HashSet::from(["claude-code".to_owned()]);
    assert_eq!(
        capture_sources(&queue, &home, OperatingSystem::Linux, &enabled).unwrap(),
        1
    );
    fs::write(&source, "changed after enqueue").unwrap();

    let transport = FakeTransport::default();
    let report = SyncEngine::new(transport)
        .sync(&queue, "00000000-0000-4000-8000-000000000001")
        .unwrap();
    assert_eq!(report.uploaded, 1);
    let batch_id = Uuid::parse_str(report.batch_id.as_deref().unwrap()).unwrap();
    assert_eq!(batch_id.get_version_num(), 7);
    assert_eq!(queue.counts().unwrap().synced, 1);
    assert!(queue.integrity_check().unwrap());
}

#[test]
fn watcher_emits_only_after_stability_window() {
    let start = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    let fingerprint = FileFingerprint {
        len: 10,
        modified: start,
    };
    let mut watcher = DebouncedChanges::new(Duration::from_secs(2));
    let path = PathBuf::from("session.jsonl");
    assert!(!watcher.observe(path.clone(), fingerprint, start));
    assert!(!watcher.observe(path.clone(), fingerprint, start + Duration::from_secs(1)));
    assert!(watcher.observe(path.clone(), fingerprint, start + Duration::from_secs(2)));
    assert!(!watcher.observe(path, fingerprint, start + Duration::from_secs(3)));
}

#[test]
fn polling_capture_debounces_real_fixture_file() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("fixture-home");
    let source = home.join(".claude/projects/-workspace/session.jsonl");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, "one").unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let enabled = HashSet::from(["claude-code".to_owned()]);
    let start = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    let mut capture = PollingCapture::new(Duration::from_secs(2));
    assert_eq!(
        capture
            .scan(
                &queue,
                &home,
                OperatingSystem::Linux,
                &enabled,
                RedactionConfig::disabled(),
                start,
            )
            .unwrap(),
        0
    );
    assert_eq!(
        capture
            .scan(
                &queue,
                &home,
                OperatingSystem::Linux,
                &enabled,
                RedactionConfig::disabled(),
                start + Duration::from_secs(2),
            )
            .unwrap(),
        1
    );
}
