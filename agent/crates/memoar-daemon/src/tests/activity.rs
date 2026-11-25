use std::fs;

use crate::{MAX_ATTEMPTS, OfflineQueue};

#[test]
fn activity_reports_what_waits_and_when_the_queue_last_moved() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let empty = queue.activity().unwrap();
    assert_eq!(empty.waiting, 0);
    assert_eq!(empty.oldest_waiting_at, None);
    assert_eq!(empty.last_synced_at, None);

    let first = temp.path().join("a.jsonl");
    let second = temp.path().join("b.jsonl");
    let third = temp.path().join("c.jsonl");
    fs::write(&first, "one").unwrap();
    fs::write(&second, "two").unwrap();
    fs::write(&third, "three").unwrap();
    let synced = queue.enqueue("claude-code", &first).unwrap();
    queue.enqueue("claude-code", &second).unwrap();
    let abandoned = queue.enqueue("claude-code", &third).unwrap();
    queue
        .mark_synced(&synced.sha256, &synced.source_path)
        .unwrap();
    for _ in 0..MAX_ATTEMPTS {
        queue
            .mark_retry(&abandoned.sha256, &abandoned.source_path, "refused")
            .unwrap();
    }

    let activity = queue.activity().unwrap();
    assert_eq!(activity.waiting, 1, "an abandoned artifact is not waiting");
    assert!(activity.oldest_waiting_at.is_some());
    assert!(activity.last_synced_at.is_some());
}
