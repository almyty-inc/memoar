//! Capture inside the backfill window and the project rules, and only there.

use chrono::{Duration, Utc};
use memoar_connectors::OperatingSystem;
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::capture::capture_sources_with_policy;
use crate::error::DaemonError;
use crate::plan::plan_capture;
use crate::policy::CapturePolicy;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::space::SpaceFloor;
use crate::workspace::WorkspaceResolver;

/// A Claude Code transcript for `workspace`, last modified `days_ago`.
pub(crate) fn session(home: &Path, workspace: &str, name: &str, days_ago: i64) -> PathBuf {
    let dir = home
        .join(".claude/projects")
        .join(workspace.replace('/', "-"));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.jsonl"));
    fs::write(
        &path,
        format!("{{\"cwd\":\"{workspace}\",\"uuid\":\"{name}\",\"message\":\"hi\"}}\n"),
    )
    .unwrap();
    let when = SystemTime::now() - std::time::Duration::from_secs(days_ago as u64 * 86_400);
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(when)
        .unwrap();
    path
}

fn claude() -> HashSet<String> {
    HashSet::from(["claude-code".to_owned()])
}

fn last_30_days() -> CapturePolicy {
    CapturePolicy {
        since: Some(Utc::now() - Duration::days(30)),
        include: Vec::new(),
        exclude: vec!["/private/tmp/**".to_owned()],
    }
}

#[test]
fn old_and_excluded_sessions_are_counted_and_left_alone() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    session(&home, "/work/app", "recent", 1);
    session(&home, "/work/app", "ancient", 400);
    session(&home, "/private/tmp/scratch", "throwaway", 1);
    let queue = OfflineQueue::open(&temp.path().join("data/queue.sqlite3")).unwrap();
    let policy = last_30_days();

    let plan = plan_capture(
        Some(&queue),
        &home,
        OperatingSystem::Linux,
        &claude(),
        RedactionConfig::disabled(),
        &policy,
    )
    .unwrap();
    assert_eq!(plan.totals.found.files, 3);
    assert_eq!(plan.totals.to_capture.files, 1);
    assert_eq!(plan.totals.too_old.files, 1);
    assert_eq!(plan.totals.excluded.files, 1);
    let projects: Vec<&str> = plan.sources[0]
        .projects
        .iter()
        .map(|project| project.workspace.as_str())
        .collect();
    assert!(projects.contains(&"/work/app") && projects.contains(&"/private/tmp/scratch"));
    assert_eq!(queue.counts().unwrap().pending, 0, "a plan queues nothing");

    let summary = capture_sources_with_policy(
        &queue,
        &home,
        OperatingSystem::Linux,
        &claude(),
        RedactionConfig::disabled(),
        &policy,
    )
    .unwrap();
    assert_eq!(summary.captured, 1);
    assert_eq!(summary.too_old.files, 1);
    assert_eq!(summary.excluded.files, 1);

    let again = capture_sources_with_policy(
        &queue,
        &home,
        OperatingSystem::Linux,
        &claude(),
        RedactionConfig::disabled(),
        &policy,
    )
    .unwrap();
    assert_eq!(again.captured, 0);
    assert_eq!(
        again.unchanged, 1,
        "an unchanged file is known from its stat"
    );
}

#[test]
fn rows_already_queued_are_held_by_a_narrower_policy_and_released_by_a_wider_one() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    session(&home, "/work/app", "ancient", 400);
    session(&home, "/private/tmp/x", "scratch", 1);
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let everything = CapturePolicy::everything();
    let run = |policy: &CapturePolicy| {
        capture_sources_with_policy(
            &queue,
            &home,
            OperatingSystem::Linux,
            &claude(),
            RedactionConfig::disabled(),
            policy,
        )
        .unwrap()
    };
    assert_eq!(run(&everything).captured, 2);

    let narrowed = run(&last_30_days());
    assert_eq!(narrowed.policy.held, 2);
    assert_eq!(queue.counts().unwrap().held, 2);
    assert!(
        queue.pending(10).unwrap().is_empty(),
        "held rows are not offered"
    );

    let widened = queue
        .apply_policy(&everything, &mut WorkspaceResolver::new())
        .unwrap();
    assert_eq!(widened.released, 2);
    assert_eq!(queue.pending(10).unwrap().len(), 2);
}

#[test]
fn the_default_backfill_window_is_fixed_when_first_asked_for() {
    let temp = tempfile::tempdir().unwrap();
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    let first = queue.backfill_anchor(Duration::days(30)).unwrap();
    let later = queue.backfill_anchor(Duration::days(1)).unwrap();
    assert_eq!(first, later, "the window does not roll forward");
    assert!(Utc::now() - first >= Duration::days(30));
}

#[test]
fn capture_refuses_to_start_below_the_free_space_floor() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    session(&home, "/work/app", "recent", 1);
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3"))
        .unwrap()
        .with_space_floor(SpaceFloor::exact(u64::MAX / 2));
    let error = capture_sources_with_policy(
        &queue,
        &home,
        OperatingSystem::Linux,
        &claude(),
        RedactionConfig::disabled(),
        &CapturePolicy::everything(),
    )
    .unwrap_err();
    assert!(matches!(error, DaemonError::DiskLow { .. }), "{error}");
    assert_eq!(queue.counts().unwrap().pending, 0);
}
