//! What the window shows, and what it does before anybody touches it.
//!
//! Split out of `capture.rs`, which was over the file-size rule and got
//! there by carrying its own test module. Nothing moved but the tests.

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
}

#[test]
fn a_failed_capture_is_remembered_and_shown() {
    // The window polls; if the failure were only returned to the caller of
    // sync_now it would vanish on the next refresh and the app would look
    // like it was capturing.
    let (_temp, paths) = scratch();
    let state = State::default();

    let failure = sync_now(&paths, &state, "2026-09-04T10:00:00Z");

    assert!(
        failure.is_err(),
        "syncing without a configured archive cannot succeed"
    );
    let status = status(&paths, &state);
    assert!(
        status.last_error.is_some(),
        "the reason is kept for the window"
    );
}

/// What is masked was decided at sign-in and never again: this file passed
/// three `false`s and the window offered nothing, so somebody who is not
/// going to edit `config.json` by hand had no way to turn masking on after
/// seeing what was being uploaded.
#[test]
fn redaction_is_changeable_from_the_window() {
    let (_temp, paths) = scratch();
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
    let state = State::default();

    let before = status(&paths, &state);
    assert_eq!(
        before.redaction.map(|redaction| redaction.secrets),
        Some(false),
        "the window must be able to see the setting before changing it"
    );

    let after = set_redaction(&paths, &state, true, false, true).unwrap();

    assert_eq!(
        after.redaction.map(|redaction| redaction.secrets),
        Some(true)
    );
    assert_eq!(
        after.redaction.map(|redaction| redaction.home_paths),
        Some(true)
    );
    assert_eq!(
        status(&paths, &state)
            .redaction
            .map(|redaction| redaction.secrets),
        Some(true),
        "the change must survive the process, not just this call"
    );
}

/// A first sign-in from the window used to ask for no masking at all.
///
/// Nothing about that was visible from the window, and redaction does not
/// reach backwards: a key pasted into a transcript before anybody found the
/// toggles is in the archive for good. This asserts the arguments the app
/// actually builds, not the screen, so the default cannot be flipped back by
/// an edit that leaves the window looking the same.
#[test]
fn a_first_sign_in_masks_secrets_and_nothing_else() {
    let args = login_args(
        " https://archive.example/v1 ",
        " person@example.com ",
        "hunter2",
    );

    assert!(
        args.redact_secrets,
        "a secret uploaded before anybody found the toggles is in the archive for good"
    );
    assert!(
        !args.redact_email_addresses,
        "an address is usually what makes a transcript legible; it stays opt-in"
    );
    assert!(
        !args.redact_home_paths,
        "a path is usually what makes a transcript legible; it stays opt-in"
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
fn uses_the_same_directories_the_cli_uses() {
    // A machine set up with one is already set up for the other, and the
    // offline queue is never duplicated between them.
    let (_temp, paths) = scratch();
    let runtime = paths.runtime();

    assert_eq!(runtime.config_dir, paths.config_dir);
    assert_eq!(runtime.data_dir, paths.data_dir);
    assert_eq!(runtime.home, paths.home);
}
