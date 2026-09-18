use std::fs;
use std::io::{Cursor, Read, Write};

use super::fake::token_fixture;
use crate::artifact::redact_artifact;
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

/// A secret written two bytes to the character must not sail through.
///
/// ASCII encoded as UTF-16 is *valid UTF-8* — every other byte is a NUL, and a
/// NUL is a legal code point. So the artifact was reported scanned, no pattern
/// could match across the NULs, and the fail-closed check never ran, because it
/// only fires on bytes that are not UTF-8 at all. The key went up verbatim
/// under a receipt saying it had been scanned, which is the one outcome
/// redaction is supposed to make impossible.
#[test]
fn a_secret_stored_two_bytes_to_the_character_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let config = RedactionConfig {
        secrets: true,
        email_addresses: false,
        home_paths: false,
    };

    for (name, bom, little_endian) in [
        ("log-le.txt", [0xFF_u8, 0xFE], true),
        ("log-be.txt", [0xFE_u8, 0xFF], false),
        // No mark at all: half the bytes being NUL is the other tell.
        ("log-bare.txt", [b'a', 0x00], true),
    ] {
        let plain = "deploy with api_key=sk-live-not-for-the-archive";
        let mut bytes = if name == "log-bare.txt" {
            Vec::new()
        } else {
            bom.to_vec()
        };
        for unit in plain.encode_utf16() {
            bytes.extend_from_slice(&if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        // The premise: these bytes really are valid UTF-8, which is why the
        // existing check could never see them.
        assert!(
            String::from_utf8(bytes.clone()).is_ok() || name != "log-bare.txt",
            "{name} should be valid UTF-8, which is the whole problem",
        );

        let path = temp.path().join(name);
        std::fs::write(&path, &bytes).unwrap();
        let error = redact_artifact(&path, &bytes, config)
            .expect_err("a secret it cannot rewrite must be refused, not uploaded");
        assert!(
            matches!(error, DaemonError::UnscannableSecret { .. }),
            "{name}: {error:?}",
        );
    }
}

/// And ordinary UTF-16 with nothing to hide is still captured.
#[test]
fn utf16_text_without_a_secret_is_still_captured() {
    let temp = tempfile::tempdir().unwrap();
    let config = RedactionConfig {
        secrets: true,
        email_addresses: false,
        home_paths: false,
    };
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "the build finished in four seconds".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let path = temp.path().join("quiet.txt");
    std::fs::write(&path, &bytes).unwrap();

    let redacted = redact_artifact(&path, &bytes, config).expect("nothing here to refuse");
    assert_eq!(redacted.bytes, bytes, "untouched bytes for untouched text");
}
