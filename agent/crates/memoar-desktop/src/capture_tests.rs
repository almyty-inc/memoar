//! What the window shows, and what it does before anybody touches it.

use super::*;
use serde_json::json;

fn scratch() -> (tempfile::TempDir, Paths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("home"),
    };
    (temp, paths)
}

/// A machine configured as `memoar login` leaves it, pointing at an archive
/// that is not there.
pub(crate) fn configured(paths: &Paths) {
    std::fs::create_dir_all(&paths.config_dir).unwrap();
    std::fs::write(
        paths.config_dir.join("config.json"),
        serde_json::to_vec(&json!({
            "contractVersion": "0.3.0",
            "endpoint": "http://127.0.0.1:1/v1",
            "machineId": "0198d8d0-977c-777b-9f8f-0f6d8416e700",
            "disabledSources": [],
            "redaction": { "secrets": false, "emailAddresses": false, "homePaths": false }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        paths.config_dir.join("credentials.json"),
        br#"{"apiKey":"memoar_test-capture-key"}"#,
    )
    .unwrap();
}

#[test]
fn a_machine_that_has_never_signed_in_says_so() {
    // Not an error dialog and not a page of zeros: an unconfigured machine
    // is the ordinary state of one nobody has connected yet, and the window
    // asks for credentials rather than reporting a healthy idle capture.
    let (_temp, paths) = scratch();

    let status = status(&paths, &State::default());

    assert!(!status.signed_in);
    assert!(status.endpoint.is_none());
    assert!(status.machine_id.is_none());
    assert!(status.queued.is_none());
    assert!(status.sources.is_empty());
}

#[test]
fn a_configured_machine_reports_its_queue_and_sources() {
    let (_temp, paths) = scratch();
    configured(&paths);
    let session = paths.home.join(".claude/projects/-fixture/session.jsonl");
    std::fs::create_dir_all(session.parent().unwrap()).unwrap();
    std::fs::write(&session, b"{\"type\":\"user\"}\n").unwrap();

    let status = status(&paths, &State::default());

    assert!(status.signed_in);
    assert_eq!(status.endpoint.as_deref(), Some("http://127.0.0.1:1/v1"));
    assert_eq!(status.queued, Some(0));
    assert_eq!(status.uploaded_total, Some(0));
    assert!(
        status.sources.iter().any(|name| name.contains("Claude")),
        "a Claude Code store on disk is a detected source: {:?}",
        status.sources
    );
}

#[test]
fn a_failed_capture_is_remembered_and_shown() {
    // The window polls. If the failure were only returned to the caller of
    // sync_now it would vanish on the next refresh and the app would look
    // like it was capturing.
    let (_temp, paths) = scratch();
    let state = State::default();

    let failure = sync_now(&paths, &state, "2026-09-04T10:00:00Z").unwrap_err();

    assert_eq!(failure.kind, FailureKind::SignedOut);
    let status = status(&paths, &state);
    assert_eq!(status.last_error, Some(failure), "the reason is kept");
    assert_eq!(status.last_sync_at.as_deref(), Some("2026-09-04T10:00:00Z"));
}

#[test]
fn an_archive_that_is_down_is_a_retryable_failure() {
    let (_temp, paths) = scratch();
    configured(&paths);
    let state = State::default();

    let failure = sync_now(&paths, &state, "2026-09-04T10:00:00Z").unwrap_err();

    assert_eq!(failure.kind, FailureKind::Unreachable, "{failure:?}");
    assert!(!failure.stops_capture());
    assert!(failure.message.contains("http://127.0.0.1:1/v1"));
}

/// What is masked was decided at sign-in and never again: the old window
/// offered nothing, so somebody who is not going to edit `config.json` by
/// hand had no way to turn masking on after seeing what was being uploaded.
#[test]
fn redaction_is_changeable_from_the_window() {
    let (_temp, paths) = scratch();
    configured(&paths);
    let state = State::default();

    let before = status(&paths, &state);
    assert_eq!(
        before.redaction.map(|redaction| redaction.secrets),
        Some(false),
        "the window must be able to see the setting before changing it"
    );

    let wanted = Redaction {
        secrets: true,
        email_addresses: false,
        home_paths: true,
    };
    let after = set_redaction(&paths, &state, wanted).unwrap();

    assert_eq!(after.redaction, Some(wanted));
    assert_eq!(
        status(&paths, &state).redaction,
        Some(wanted),
        "the change must survive the process, not just this call"
    );
}

#[test]
fn reads_only_the_fields_the_archive_sends() {
    // These paths are how the window learns what happened. Reading a field
    // that is not there must yield nothing rather than a zero that looks
    // like a measurement.
    let payload = json!({
        "endpoint": "https://archive.example/v1",
        "machineId": "0191cafe-0000-7000-8000-00000000d001",
        "queue": { "pending": 3, "retry": 0, "synced": 12 },
    });

    assert_eq!(
        text(&payload, &["endpoint"]).as_deref(),
        Some("https://archive.example/v1")
    );
    assert_eq!(number(&payload, &["queue", "pending"]), Some(3));
    assert_eq!(number(&payload, &["queue", "missing"]), None);
    assert_eq!(number(&payload, &["sync", "uploaded"]), None);
    assert_eq!(
        text(&payload, &["queue", "pending"]),
        None,
        "a number is not a string"
    );
}

#[test]
fn names_only_the_sources_found_on_disk() {
    let payload = json!({ "items": [
        { "id": "claude-code", "displayName": "Claude Code", "detected": true },
        { "id": "codex", "displayName": "Codex", "detected": false },
        { "id": "cursor", "detected": true },
    ]});

    assert_eq!(detected_sources(&payload), vec!["Claude Code", "cursor"]);
    assert!(detected_sources(&json!({})).is_empty());
}

#[test]
fn the_web_app_lives_beside_the_api() {
    assert_eq!(
        archive_url("https://archive.example/v1"),
        "https://archive.example"
    );
    assert_eq!(
        archive_url("https://archive.example/v1/"),
        "https://archive.example"
    );
    assert_eq!(
        archive_url(" http://127.0.0.1:4000 "),
        "http://127.0.0.1:4000"
    );
}

#[test]
fn the_record_of_the_last_run_survives_a_restart() {
    let run = LastRun {
        at: Some("2026-09-04T10:00:00Z".to_owned()),
        error: Some(Failure::new(FailureKind::Revoked, "stopped", "HTTP 401")),
        uploaded: Some(2),
        memory_recorded: None,
    };
    let saved = serde_json::to_string(&run).unwrap();
    let state = State::with_last_run(serde_json::from_str(&saved).unwrap());

    assert_eq!(state.last_run(), run);
    state.forget();
    assert_eq!(state.last_run(), LastRun::default());
}
