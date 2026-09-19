//! What client-side redaction actually catches, in the shapes a secret arrives in.

use memoar_daemon::{DaemonError, OfflineQueue, RedactionConfig};
use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;

fn secrets() -> RedactionConfig {
    RedactionConfig {
        secrets: true,
        ..RedactionConfig::disabled()
    }
}

/// Puts one file through the real capture path and hands back what was stored.
fn captured(queue: &OfflineQueue, dir: &Path, name: &str, body: &str) -> (String, u32) {
    let source = dir.join(name);
    fs::write(&source, body).unwrap();
    let artifact = queue
        .enqueue_with_redaction("fixture", &source, secrets())
        .unwrap_or_else(|error| panic!("{name} should have been capturable: {error}"));
    let stored = fs::read_to_string(&artifact.local_path).unwrap();
    assert_eq!(
        artifact.redacted,
        artifact.redaction_count > 0,
        "the receipt has to agree with itself for {name}"
    );
    (stored, artifact.redaction_count)
}

/// Every shape the pattern has to catch, and what must not survive it.
///
/// The value group used to exclude `"` and `'`, and the key was anchored with
/// `\b`, which does not fire after `_`. Between them that left the pattern
/// matching `api_key=abc` and essentially nothing anyone writes: JSONL is the
/// primary format of several capture sources, so a quoted value is the ordinary
/// case, and every one of these went up whole under a receipt that read
/// `redacted: false, redaction_count: 0`.
#[test]
fn catches_a_secret_in_every_shape_it_is_written_in() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let cases: &[(&str, &str, &str)] = &[
        (
            "json-quoted.jsonl",
            r#"{"api_key": "sk-live-abc123"}"#,
            "sk-live-abc123",
        ),
        ("json-camel.jsonl", r#"{"apiKey":"abcdef"}"#, "abcdef"),
        ("toml-spaced.toml", r#"api_key = "abc123""#, "abc123"),
        (
            "env-export.sh",
            r#"export OPENAI_API_KEY="abcdefghij""#,
            "abcdefghij",
        ),
        (
            "aws.env",
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY",
            "wJalrXUtnFEMIK7MDENGbPxRfiCY",
        ),
        (
            "header.txt",
            "Authorization: Bearer abcdef123456",
            "abcdef123456",
        ),
        (
            "header.json",
            r#"{"authorization":"Bearer abcdef123456"}"#,
            "abcdef123456",
        ),
        (
            "nested.jsonl",
            r#"{"role":"user","content":"access_token: abc123def456"}"#,
            "abc123def456",
        ),
        // The two shapes that already worked, so a rewrite cannot lose them.
        (
            "plain-equals.jsonl",
            "api_key=super-secret-value",
            "super-secret-value",
        ),
        ("colon.log", "password: hunter2hunter2", "hunter2hunter2"),
    ];

    for (name, body, secret) in cases {
        let (stored, count) = captured(&queue, temp.path(), name, body);
        assert!(
            !stored.contains(secret),
            "{name}: the secret reached the queue: {stored}"
        );
        assert!(
            stored.contains("[REDACTED]"),
            "{name}: nothing was put in its place: {stored}"
        );
        assert!(count > 0, "{name}: reported as having redacted nothing");
    }
}

/// A redacted JSON line is still a JSON line.
///
/// The value stops before the closing quote, which is left where it was, so the
/// artifact the archive receives can still be parsed.
#[test]
fn leaves_the_document_it_rewrote_well_formed() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let (stored, _) = captured(
        &queue,
        temp.path(),
        "line.jsonl",
        r#"{"api_key": "sk-live-abc123", "model": "opus"}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&stored)
        .unwrap_or_else(|error| panic!("redaction broke the JSON: {error}: {stored}"));
    assert_eq!(value["api_key"], "[REDACTED]");
    assert_eq!(value["model"], "opus", "only the secret was touched");
}

/// And ordinary prose is left alone.
///
/// A pattern loose enough to catch every quoted value is loose enough to eat a
/// transcript, so the other half of the fix is here: none of these may be
/// rewritten, and a token accounting line in particular is not a credential.
#[test]
fn does_not_redact_ordinary_prose() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    for (name, body) in [
        ("prose-secret.md", "the secret to good tests is determinism"),
        (
            "prose-password.md",
            "passwords are stored hashed, never in plain text",
        ),
        ("accounting.jsonl", r#"{"tokens_used": 4500}"#),
        (
            "model.jsonl",
            r#"{"model":"claude-opus-5","max_tokens":4096}"#,
        ),
        ("docs.md", "see the API documentation for the rate limits"),
        (
            "bearer-prose.md",
            "the bearer instrument matured, and basic understanding followed",
        ),
    ] {
        let (stored, count) = captured(&queue, temp.path(), name, body);
        assert_eq!(count, 0, "{name}: redacted prose: {stored}");
        assert_eq!(stored, body, "{name}: prose was rewritten");
    }
}

fn archive_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A ZIP member fails closed exactly like a top-level artifact.
///
/// `redact_zip` read only `.replacements` and never asked whether the entry had
/// been scanned at all, and never took the lossy look the top level takes. So
/// bytes that could not be read as text were repacked exactly as found and
/// uploaded with `redacted: false` — an archive member was the one remaining
/// door an unscanned secret could leave by.
#[test]
fn an_unscannable_zip_member_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.zip");
    let mut member = b"api_key=abcdef123456 ".to_vec();
    member.extend_from_slice(&[0xff, 0xfe, 0x00]);
    fs::write(&source, archive_of(&[("inner.jsonl", &member)])).unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let error = queue
        .enqueue_with_redaction("fixture", &source, secrets())
        .expect_err("an entry that cannot be scanned must not be repacked and shipped");
    assert!(
        matches!(error, DaemonError::UnscannableSecret { .. }),
        "expected an unscannable-secret refusal, got: {error}"
    );
    assert_eq!(queue.counts().unwrap().pending, 0, "nothing may be queued");
    assert!(
        error.is_skippable(),
        "the pass carries on without this archive"
    );
}

/// The refusal is about the secret, not about the encoding.
#[test]
fn a_zip_member_of_harmless_bytes_is_still_captured() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("session.zip");
    fs::write(
        &source,
        archive_of(&[("inner.bin", &[0xff, 0xfe, 0x00, 0x41])]),
    )
    .unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let artifact = queue
        .enqueue_with_redaction("fixture", &source, secrets())
        .expect("bytes with nothing to hide are still capturable");
    assert!(!artifact.redacted);
}
