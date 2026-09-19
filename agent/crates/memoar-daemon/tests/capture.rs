//! What a file the agent cannot take costs the rest of the pass.

use memoar_connectors::OperatingSystem;
use memoar_daemon::{OfflineQueue, PollingCapture, RedactionConfig};
use std::collections::HashSet;
use std::fs;
use std::time::{Duration, SystemTime};

/// One file `sync --watch` cannot scan must not end continuous capture.
///
/// `PollingCapture::scan` listed two of the three refusals by hand —
/// `UnsupportedRedaction` and `Zip` — so `UnscannableSecret` fell through to
/// `Err(other) => return Err(other)` and aborted the whole watch. The one-shot
/// path had already been fixed to ask `is_unredactable()`; this call site was
/// missed. A single non-UTF-8 blob under `~/.claude/projects` — a Zed
/// write-ahead log, a Cursor state file, a transcript truncated mid-write —
/// therefore stopped the daemon archiving anything, from any source, until it
/// was restarted onto the same file.
#[test]
fn one_unscannable_file_does_not_end_the_watch() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let project = home.join(".claude/projects/-workspace");
    fs::create_dir_all(&project).unwrap();

    // Sorted first, so it is reached before the file beside it.
    let mut blob = b"api_key=abcdef123456 ".to_vec();
    blob.extend_from_slice(&[0xff, 0xfe, 0x00]);
    fs::write(project.join("a-wal.jsonl"), &blob).unwrap();
    fs::write(project.join("b-session.jsonl"), "{\"type\":\"user\"}\n").unwrap();

    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let mut watcher = PollingCapture::new(Duration::ZERO);
    let captured = watcher
        .scan(
            &queue,
            &home,
            OperatingSystem::Linux,
            &HashSet::from(["claude-code".to_owned()]),
            RedactionConfig {
                secrets: true,
                ..RedactionConfig::disabled()
            },
            SystemTime::UNIX_EPOCH + Duration::from_secs(100),
        )
        .expect("a file that cannot be scanned is skipped, not fatal");

    assert_eq!(
        captured, 1,
        "the transcript beside it should have been taken"
    );
    let queued = queue.pending(10).unwrap();
    assert_eq!(queued.len(), 1);
    assert!(
        queued[0].source_path.ends_with("b-session.jsonl"),
        "the clean transcript never reached the queue: {:?}",
        queued[0].source_path
    );
    assert_eq!(
        queue.counts().unwrap().pending,
        1,
        "and the blob stayed on the machine"
    );
}
