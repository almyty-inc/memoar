//! Sign-in and capture against a stand-in archive, through the same functions
//! the window calls.

mod support;

use memoar_desktop::{Credentials, FailureKind, Paths, State, account, capture, schedule};
use support::stub;

fn scratch() -> (tempfile::TempDir, Paths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("home"),
    };
    (temp, paths)
}

fn password(email: &str, password: &str) -> Credentials {
    Credentials::Password {
        email: email.to_owned(),
        password: password.to_owned(),
    }
}

fn session(paths: &Paths) {
    let file = paths.home.join(".claude/projects/-fixture/session.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"{\"type\":\"user\"}\n").unwrap();
}

#[test]
fn signs_in_captures_and_uploads_a_session() {
    let endpoint = stub::serve("127.0.0.1:0");
    let (_temp, paths) = scratch();
    session(&paths);
    let state = State::default();

    let signed = account::sign_in(
        &paths,
        &state,
        &endpoint,
        &password("person@example.com", stub::PASSWORD),
    )
    .unwrap();
    assert!(signed.signed_in);
    assert_eq!(signed.endpoint.as_deref(), Some(endpoint.as_str()));
    assert!(signed.machine_id.is_some());

    let captured = capture::sync_now(&paths, &state, "2026-09-04T10:00:00Z").unwrap();

    assert_eq!(captured.last_uploaded, Some(1));
    assert_eq!(captured.uploaded_total, Some(1));
    assert_eq!(captured.queued, Some(0));
    assert!(captured.last_error.is_none());
}

#[test]
fn a_wrong_password_is_refused_and_nothing_is_written() {
    let endpoint = stub::serve("127.0.0.1:0");
    let (_temp, paths) = scratch();

    let failure = account::sign_in(
        &paths,
        &State::default(),
        &endpoint,
        &password("person@example.com", "wrong"),
    )
    .unwrap_err();

    assert_eq!(failure.kind, FailureKind::Rejected);
    assert!(failure.detail.contains("Email or password is incorrect"));
    assert!(!paths.credentials_file().exists());
}

#[test]
fn an_api_key_signs_in_as_login_token_does() {
    let endpoint = stub::serve("127.0.0.1:0");
    let (_temp, paths) = scratch();

    let signed = account::sign_in(
        &paths,
        &State::default(),
        &endpoint,
        &Credentials::ApiKey(stub::API_KEY.to_owned()),
    )
    .unwrap();
    assert!(signed.signed_in);

    let (_other, elsewhere) = scratch();
    let refused = account::sign_in(
        &elsewhere,
        &State::default(),
        &endpoint,
        &Credentials::ApiKey("memoar_unknown".to_owned()),
    )
    .unwrap_err();
    assert_eq!(refused.kind, FailureKind::Rejected);
}

#[test]
fn a_revoked_key_stops_capture_until_a_new_sign_in() {
    let endpoint = stub::serve("127.0.0.1:0");
    let (_temp, paths) = scratch();
    let state = State::default();
    account::sign_in(
        &paths,
        &state,
        &endpoint,
        &password(stub::REVOKED_EMAIL, stub::PASSWORD),
    )
    .unwrap();

    let failure = capture::sync_now(&paths, &state, "2026-09-04T10:00:00Z").unwrap_err();

    assert_eq!(failure.kind, FailureKind::Revoked);
    let status = capture::status(&paths, &state);
    let gate = schedule::Gate {
        signed_in: status.signed_in,
        paused: false,
        busy: false,
    };
    assert!(
        !schedule::automatic(gate, status.last_error.as_ref()),
        "the timer must not retry a revoked key"
    );
    assert!(!schedule::manual(gate, status.last_error.as_ref()));

    account::sign_out(&paths, &state).unwrap();
    let again = account::sign_in(
        &paths,
        &state,
        &endpoint,
        &password("person@example.com", stub::PASSWORD),
    )
    .unwrap();
    assert!(again.last_error.is_none(), "a new sign-in starts clean");
    assert_eq!(
        again.machine_id, status.machine_id,
        "the same machine record is reused"
    );
    assert!(capture::sync_now(&paths, &state, "2026-09-04T10:02:00Z").is_ok());
}

#[test]
fn an_archive_that_went_away_is_retried() {
    let endpoint = stub::serve("127.0.0.1:0");
    let (_temp, paths) = scratch();
    let state = State::default();
    account::sign_in(
        &paths,
        &state,
        &endpoint,
        &password("person@example.com", stub::PASSWORD),
    )
    .unwrap();
    let config = paths.config_dir.join("config.json");
    let moved = std::fs::read_to_string(&config)
        .unwrap()
        .replace(&endpoint, "http://127.0.0.1:1/v1");
    std::fs::write(&config, moved).unwrap();

    let failure = capture::sync_now(&paths, &state, "2026-09-04T10:00:00Z").unwrap_err();

    assert_eq!(failure.kind, FailureKind::Unreachable);
    assert!(!failure.stops_capture());
}
