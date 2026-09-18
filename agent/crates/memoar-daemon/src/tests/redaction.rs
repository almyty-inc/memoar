use std::fs;
use std::io::{Cursor, Read, Write};

use super::fake::token_fixture;
use crate::enqueue::sha256_bytes;
use crate::error::DaemonError;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;

#[test]
fn client_redaction_happens_before_hashing_and_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.jsonl");
    fs::write(
        &source,
        "api_key=super-secret-value user=person@example.com /Users/alice/project",
    )
    .unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let artifact = queue
        .enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                email_addresses: true,
                home_paths: true,
            },
        )
        .unwrap();
    let bytes = fs::read(&artifact.local_path).unwrap();
    let content = String::from_utf8(bytes).unwrap();
    assert!(artifact.redacted);
    assert!(artifact.redaction_count >= 3);
    assert!(!content.contains("super-secret-value"));
    assert!(!content.contains("person@example.com"));
    assert!(!content.contains("/Users/alice"));
    assert_eq!(artifact.sha256, sha256_bytes(content.as_bytes()));
}

#[test]
fn zip_redaction_repacks_entries_with_limits() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.zip");
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    writer
        .start_file("session.jsonl", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"api_key=super-secret-value").unwrap();
    let archive = writer.finish().unwrap().into_inner();
    fs::write(&source, archive).unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let artifact = queue
        .enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            },
        )
        .unwrap();
    let bytes = fs::read(artifact.local_path).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut content = String::new();
    archive
        .by_name("session.jsonl")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert!(!content.contains("super-secret-value"));
    assert!(content.contains("[REDACTED]"));
}

#[test]
fn opaque_sqlite_redaction_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.db");
    fs::write(&source, b"SQLite format 3\0opaque").unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    assert!(matches!(
        queue.enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            }
        ),
        Err(DaemonError::UnsupportedRedaction(_))
    ));
    assert_eq!(queue.counts().unwrap().pending, 0);
}

#[test]
fn refuses_an_unscannable_artifact_that_still_shows_a_secret() {
    // Invalid UTF-8 means no pattern can be applied, so the artifact used
    // to be queued exactly as found while redaction was switched on. An
    // opaque database is refused for the same reason; this is the same
    // situation arriving through a different door.
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("capture.jsonl");
    let mut bytes = format!("token={} ", token_fixture()).into_bytes();
    bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
    fs::write(&source, &bytes).unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let error = queue
        .enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            },
        )
        .expect_err("an unscannable artifact holding a secret must not be queued");
    assert!(
        matches!(error, DaemonError::UnscannableSecret { .. }),
        "expected an unscannable-secret refusal, got: {error}"
    );
    assert_eq!(queue.counts().unwrap().pending, 0, "nothing may be queued");
}

#[test]
fn still_accepts_unscannable_bytes_that_hold_no_secret() {
    // Refusing every non-UTF-8 artifact would block ordinary captures, so
    // the refusal has to be about the secret, not about the encoding.
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("capture.bin");
    fs::write(&source, [0xff, 0xfe, 0x00, 0x41, 0x42]).unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let artifact = queue
        .enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            },
        )
        .expect("bytes with nothing to hide are still capturable");
    assert!(
        !artifact.redacted,
        "nothing was replaced, so nothing was redacted"
    );
    assert_eq!(artifact.redaction_count, 0);
}

#[test]
fn reports_redaction_only_when_something_was_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("capture.jsonl");
    fs::write(&source, format!("token={}", token_fixture())).unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let artifact = queue
        .enqueue_with_redaction(
            "fixture",
            &source,
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            },
        )
        .unwrap();
    assert!(artifact.redacted);
    assert!(artifact.redaction_count > 0);
    let stored = fs::read_to_string(&artifact.local_path).unwrap();
    assert!(
        !stored.contains(&token_fixture()),
        "the secret reached the queue"
    );
}
