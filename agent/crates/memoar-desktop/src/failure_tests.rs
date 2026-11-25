//! How a CLI error becomes something the window can act on.

use super::*;

const ENDPOINT: &str = "https://archive.example/v1";

fn answered(status: u16) -> AppError {
    AppError::network(format!("Unauthorized (HTTP {status})"))
}

#[test]
fn reads_the_status_the_archive_answered_with() {
    assert_eq!(http_status("Invalid credentials (HTTP 401)"), Some(401));
    assert_eq!(http_status("a (HTTP 3) then (HTTP 503)"), Some(503));
    assert_eq!(http_status("error sending request for url"), None);
    assert_eq!(http_status("(HTTP abc)"), None);
}

#[test]
fn a_wrong_password_is_a_rejection_not_a_network_problem() {
    let failure = classify_sign_in(&answered(401), ENDPOINT);

    assert_eq!(failure.kind, FailureKind::Rejected);
    assert!(failure.message.contains("did not accept"));
    assert_eq!(failure.detail, "Unauthorized (HTTP 401)");
}

#[test]
fn an_archive_that_does_not_answer_says_where_it_looked() {
    let error = AppError::network("error sending request: connection refused");

    let failure = classify_sign_in(&error, ENDPOINT);

    assert_eq!(failure.kind, FailureKind::Unreachable);
    assert!(failure.message.contains(ENDPOINT));
    assert!(!failure.stops_capture());
}

#[test]
fn a_revoked_key_stops_capture() {
    for status in [401, 403, 404] {
        let failure = classify_capture(&answered(status), ENDPOINT);

        assert_eq!(failure.kind, FailureKind::Revoked, "HTTP {status}");
        assert!(failure.stops_capture(), "HTTP {status} must not be retried");
        assert!(failure.message.contains("Sign in again"));
    }
}

#[test]
fn a_struggling_archive_is_retried() {
    for status in [429, 500, 503] {
        let failure = classify_capture(&answered(status), ENDPOINT);

        assert_eq!(failure.kind, FailureKind::Temporary, "HTTP {status}");
        assert!(!failure.stops_capture());
    }
}

#[test]
fn an_archive_that_is_down_is_retried() {
    let failure = classify_capture(&AppError::network("connection refused"), ENDPOINT);

    assert_eq!(failure.kind, FailureKind::Unreachable);
    assert!(!failure.stops_capture());
}

#[test]
fn a_missing_credential_returns_to_sign_in() {
    let failure = classify_capture(&AppError::not_initialized(), ENDPOINT);

    assert_eq!(failure.kind, FailureKind::SignedOut);
    assert!(failure.stops_capture());
}

#[test]
fn a_competing_capture_is_temporary() {
    let failure = classify_capture(&AppError::locked("queue is locked"), ENDPOINT);

    assert_eq!(failure.kind, FailureKind::Temporary);
}

#[test]
fn a_usage_error_is_shown_as_the_cli_worded_it() {
    let failure = classify_sign_in(&AppError::usage("--endpoint cannot be empty"), ENDPOINT);

    assert_eq!(failure.kind, FailureKind::Other);
    assert_eq!(failure.message, "--endpoint cannot be empty");
}

#[test]
fn an_address_that_is_not_an_archive_is_said_so() {
    let failure = classify_sign_in(&answered(404), ENDPOINT);

    assert!(failure.message.contains("/v1"));
}
