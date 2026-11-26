//! A compressed Codex rollout goes up as the plaintext, redacted.

use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use std::collections::HashSet;
use std::fs;

use super::fake::{FakeTransport, token_fixture};
use crate::capture::capture_sources_with_redaction;
use crate::enqueue::sha256_bytes;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::sync::SyncEngine;
use memoar_connectors::OperatingSystem;

fn rollout(secret: &str) -> Vec<u8> {
    format!(
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"r\",\"cwd\":\"/work/app\"}}}}\n\
         {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"key {secret}\"}}]}}}}\n"
    )
    .into_bytes()
}

#[test]
fn a_compressed_rollout_is_queued_and_sent_as_redacted_plaintext() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let path = home.join(".codex/sessions/2025/09/24/rollout-2025-09-24T06-56-02-a.jsonl.zst");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let secret = token_fixture();
    fs::write(
        &path,
        compress_to_vec(&rollout(&secret)[..], CompressionLevel::Fastest),
    )
    .unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let redaction = RedactionConfig {
        secrets: true,
        ..RedactionConfig::disabled()
    };
    let enabled = HashSet::from(["codex".to_owned()]);
    let summary =
        capture_sources_with_redaction(&queue, &home, OperatingSystem::Linux, &enabled, redaction)
            .unwrap();
    assert_eq!(summary.captured, 1, "skipped: {:?}", summary.skipped);

    let engine = SyncEngine::new(FakeTransport::default());
    let report = engine
        .drain(&queue, "00000000-0000-4000-8000-000000000001")
        .unwrap();
    assert_eq!(report.uploaded, 1);
    let uploaded = engine.transport().uploaded.lock().unwrap().clone();
    let text = String::from_utf8(uploaded[0].clone()).expect("plaintext went up");
    assert!(
        text.contains("\"session_meta\""),
        "decompressed before upload"
    );
    assert!(!text.contains(&secret), "redacted before upload");
}

#[test]
fn an_unredacted_compressed_rollout_is_read_from_the_source_and_verified() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let path = home.join(".codex/sessions/2025/09/24/rollout-b.jsonl.zst");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let plain = rollout("nothing secret");
    fs::write(
        &path,
        compress_to_vec(&plain[..], CompressionLevel::Fastest),
    )
    .unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let enabled = HashSet::from(["codex".to_owned()]);
    let summary = capture_sources_with_redaction(
        &queue,
        &home,
        OperatingSystem::Linux,
        &enabled,
        RedactionConfig::disabled(),
    )
    .unwrap();
    assert_eq!(summary.captured, 1);
    assert_eq!(
        fs::read_dir(temp.path().join("blobs")).map_or(0, Iterator::count),
        0,
        "no copy is kept: the source decompresses to the same bytes again"
    );

    let engine = SyncEngine::new(FakeTransport::default());
    let report = engine
        .drain(&queue, "00000000-0000-4000-8000-000000000001")
        .unwrap();
    assert_eq!(report.uploaded, 1, "{report:?}");
    let uploaded = engine.transport().uploaded.lock().unwrap().clone();
    assert_eq!(sha256_bytes(&uploaded[0]), sha256_bytes(&plain));
}
