use chrono::{DateTime, Duration, Utc};
use memoar_daemon::QueueActivity;

use crate::capture_state::{CaptureState, Failure};
use crate::health::{HealthInputs, ServiceView, assess};

fn now() -> DateTime<Utc> {
    "2026-11-20T12:00:00Z".parse().unwrap()
}

fn ago(hours: i64) -> String {
    (now() - Duration::hours(hours)).to_rfc3339()
}

fn installed(running: Option<bool>) -> ServiceView {
    ServiceView::Installed {
        name: "agent".to_owned(),
        running,
        detail: "launchd state not running, last exit 9".to_owned(),
    }
}

fn activity(waiting: u64, oldest_hours: i64, last_hours: Option<i64>) -> QueueActivity {
    QueueActivity {
        waiting,
        oldest_waiting_at: (waiting > 0).then(|| ago(oldest_hours)),
        last_synced_at: last_hours.map(ago),
    }
}

fn failure(message: &str) -> Failure {
    Failure {
        at: now() - Duration::hours(3),
        code: "MEMOAR_MACHINE_RETIRED".to_owned(),
        exit_code: 5,
        message: message.to_owned(),
        hint: "Run memoar login.".to_owned(),
    }
}

fn verdict(
    service: &ServiceView,
    sync_running: bool,
    state: Option<&CaptureState>,
    activity: &QueueActivity,
) -> crate::health::Health {
    assess(&HealthInputs {
        now: now(),
        service,
        sync_running,
        state,
        activity,
    })
}

/// The incident: a watch in a terminal, the terminal closed, no service.
/// Nothing on disk changed, so `status` used to look exactly as it did the
/// day before.
#[test]
fn nothing_running_and_no_service_is_not_ok() {
    let health = verdict(
        &ServiceView::NotInstalled,
        false,
        None,
        &activity(3, 1_400, Some(1_500)),
    );
    assert_eq!((health.state, health.ok), ("not_running", false));
    assert!(
        health
            .summary
            .starts_with("background capture is not running"),
        "{}",
        health.summary
    );
    assert!(
        health.summary.contains("3 artifacts wait to upload"),
        "{}",
        health.summary
    );
    assert!(health.hint.unwrap().contains("memoar service install"));
}

#[test]
fn a_refusal_that_stopped_the_watch_is_named() {
    let state = CaptureState {
        stopped: Some(failure("This machine was removed from the archive")),
        ..CaptureState::default()
    };
    let health = verdict(
        &installed(Some(false)),
        false,
        Some(&state),
        &activity(0, 0, Some(5)),
    );
    assert_eq!((health.state, health.ok), ("stopped", false));
    assert!(
        health
            .summary
            .starts_with("background capture stopped: This machine was removed"),
        "{}",
        health.summary
    );
    assert!(health.hint.unwrap().starts_with("Run memoar login."));
}

#[test]
fn an_installed_service_that_is_not_running_is_stopped() {
    let health = verdict(
        &installed(Some(false)),
        false,
        None,
        &activity(0, 0, Some(1)),
    );
    assert_eq!((health.state, health.ok), ("stopped", false));
    assert!(
        health.summary.contains("the agent service is installed but not running (launchd state not running, last exit 9)"),
        "{}",
        health.summary
    );
}

#[test]
fn a_running_service_that_has_not_uploaded_for_a_day_is_stale() {
    let state = CaptureState {
        last_error: Some(Failure {
            exit_code: 4,
            message: "archive unreachable".to_owned(),
            ..failure("")
        }),
        ..CaptureState::default()
    };
    let health = verdict(
        &installed(Some(true)),
        true,
        Some(&state),
        &activity(7, 30, Some(26)),
    );
    assert_eq!((health.state, health.ok), ("stale", false));
    assert!(
        health.summary.contains("7 artifacts wait to upload"),
        "{}",
        health.summary
    );
    assert!(
        health.summary.contains("Last error: archive unreachable"),
        "{}",
        health.summary
    );
}

#[test]
fn a_fresh_backlog_is_not_stale() {
    // Captured an hour ago into a queue whose last upload was last week:
    // the backlog is new, so nothing has been waiting a day yet.
    let health = verdict(
        &installed(Some(true)),
        true,
        None,
        &activity(2, 1, Some(24 * 7)),
    );
    assert_eq!((health.state, health.ok), ("running", true));
}

#[test]
fn a_recent_upload_from_the_watch_counts_even_when_the_queue_is_old() {
    let state = CaptureState {
        last_success_at: Some(now() - Duration::minutes(5)),
        ..CaptureState::default()
    };
    let health = verdict(
        &installed(Some(true)),
        true,
        Some(&state),
        &activity(1, 48, Some(72)),
    );
    assert_eq!((health.state, health.ok), ("running", true));
}

#[test]
fn a_retrying_watch_is_running_and_says_why() {
    let state = CaptureState {
        last_error: Some(failure("archive unreachable")),
        ..CaptureState::default()
    };
    let health = verdict(
        &ServiceView::NotInstalled,
        true,
        Some(&state),
        &activity(0, 0, Some(1)),
    );
    assert_eq!((health.state, health.ok), ("retrying", true));
    assert!(health.summary.contains("archive unreachable"));
}

#[test]
fn a_terminal_watch_without_a_service_is_running() {
    let health = verdict(
        &ServiceView::NotInstalled,
        true,
        None,
        &activity(0, 0, Some(1)),
    );
    assert_eq!((health.state, health.ok), ("running", true));
    assert!(
        health.summary.contains("Last upload 2026-11-20 11:00 UTC"),
        "{}",
        health.summary
    );
}

#[test]
fn a_service_manager_that_cannot_be_asked_defers_to_the_queue() {
    let fine = verdict(&installed(None), false, None, &activity(0, 0, Some(1)));
    assert_eq!((fine.state, fine.ok), ("running", true));
    let stale = verdict(&installed(None), false, None, &activity(4, 40, None));
    assert_eq!((stale.state, stale.ok), ("stale", false));
    assert!(
        stale.summary.contains("nothing uploaded yet"),
        "{}",
        stale.summary
    );
}

#[test]
fn a_stop_record_does_not_outrank_a_running_watch() {
    let state = CaptureState {
        stopped: Some(failure("old news")),
        ..CaptureState::default()
    };
    let health = verdict(
        &installed(Some(true)),
        true,
        Some(&state),
        &activity(0, 0, Some(1)),
    );
    assert_eq!((health.state, health.ok), ("running", true));
}
