use chrono::{Duration, TimeZone, Utc};

use super::*;

#[test]
fn globs_stay_in_a_segment_unless_doubled() {
    assert!(workspace_matches(
        "/private/tmp/**",
        "/private/tmp/claude-501/x"
    ));
    assert!(workspace_matches("/private/tmp/**", "/private/tmp"));
    assert!(!workspace_matches("/private/tmp/*", "/private/tmp/a/b"));
    assert!(workspace_matches("/private/tmp/*", "/private/tmp/a"));
    assert!(workspace_matches(
        "**/.claude/worktrees/**",
        "/Users/me/src/memoar/.claude/worktrees/agent-1"
    ));
    assert!(workspace_matches(
        "/Users/*/scratch-??",
        "/Users/me/scratch-01"
    ));
    assert!(!workspace_matches(
        "/Users/*/scratch-??",
        "/Users/me/scratch-001"
    ));
    assert!(workspace_matches(r"C:\work\**", "C:/work/tmp/x"));
}

#[test]
fn a_plain_pattern_is_a_directory_and_everything_under_it() {
    assert!(workspace_matches("/tmp", "/tmp"));
    assert!(workspace_matches("/tmp/", "/tmp/one/two"));
    assert!(!workspace_matches("/tmp", "/tmpfiles"));
}

#[test]
fn include_then_exclude_and_an_unknown_workspace_is_kept() {
    let policy = CapturePolicy {
        since: None,
        include: vec!["/Users/me/**".to_owned()],
        exclude: vec!["**/worktrees/**".to_owned()],
    };
    assert_eq!(policy.by_project(Some("/Users/me/app")), Verdict::Capture);
    assert_eq!(
        policy.by_project(Some("/Users/me/app/worktrees/a")),
        Verdict::Excluded
    );
    assert_eq!(policy.by_project(Some("/srv/other")), Verdict::Excluded);
    assert_eq!(policy.by_project(None), Verdict::Capture);
}

#[test]
fn age_is_judged_before_the_project() {
    let now = Utc.with_ymd_and_hms(2026, 11, 25, 12, 0, 0).unwrap();
    let policy = CapturePolicy {
        since: Some(now - Duration::days(30)),
        include: Vec::new(),
        exclude: vec!["/tmp/**".to_owned()],
    };
    assert_eq!(
        policy.judge(now - Duration::days(40), Some("/tmp/x")),
        Verdict::TooOld
    );
    assert_eq!(
        policy.judge(now - Duration::days(1), Some("/tmp/x")),
        Verdict::Excluded
    );
    assert_eq!(policy.judge(now, Some("/home/x")), Verdict::Capture);
}

#[test]
fn since_reads_dates_instants_durations_and_all() {
    let now = Utc.with_ymd_and_hms(2026, 11, 25, 12, 0, 0).unwrap();
    assert_eq!(parse_since("all", now).unwrap(), None);
    assert_eq!(
        parse_since("30d", now).unwrap(),
        Some(now - Duration::days(30))
    );
    assert_eq!(
        parse_since("2w", now).unwrap(),
        Some(now - Duration::weeks(2))
    );
    assert_eq!(
        parse_since("36h", now).unwrap(),
        Some(now - Duration::hours(36))
    );
    assert_eq!(
        parse_since("2026-01-31", now).unwrap(),
        Some(Utc.with_ymd_and_hms(2026, 1, 31, 0, 0, 0).unwrap())
    );
    assert_eq!(
        parse_since("2026-01-31T10:00:00+02:00", now).unwrap(),
        Some(Utc.with_ymd_and_hms(2026, 1, 31, 8, 0, 0).unwrap())
    );
    for bad in ["", "30", "30y", "-3d", "yesterday"] {
        assert!(parse_since(bad, now).is_err(), "{bad:?} should be refused");
    }
}
