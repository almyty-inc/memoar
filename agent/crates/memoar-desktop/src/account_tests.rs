//! Signing in and out without a network: what is built and what is kept.

use super::*;

fn password() -> Credentials {
    Credentials::Password {
        email: " person@example.com ".to_owned(),
        password: "hunter2".to_owned(),
    }
}

/// A first sign-in from the window used to ask for no masking at all, and
/// redaction does not reach backwards. This asserts the arguments the app
/// builds, so the default cannot be flipped back by an edit that leaves the
/// window looking the same.
#[test]
fn a_first_sign_in_masks_secrets_and_nothing_else() {
    let args = login_args(" https://archive.example/v1 ", &password());

    assert_eq!(args.endpoint.as_deref(), Some("https://archive.example/v1"));
    assert_eq!(args.email.as_deref(), Some("person@example.com"));
    assert_eq!(args.password.as_deref(), Some("hunter2"));
    assert!(args.token.is_none());
    assert!(args.redact_secrets);
    assert!(!args.redact_email_addresses);
    assert!(!args.redact_home_paths);
}

#[test]
fn an_api_key_signs_in_as_login_token_does() {
    let args = login_args(
        "https://archive.example/v1",
        &Credentials::ApiKey(" memoar_key ".to_owned()),
    );

    assert_eq!(args.token.as_deref(), Some("memoar_key"));
    assert!(args.email.is_none() && args.password.is_none());
    assert!(args.redact_secrets);
}

#[test]
fn incomplete_input_is_refused_before_anything_is_sent() {
    let empty_key = Credentials::ApiKey("  ".to_owned());
    let no_password = Credentials::Password {
        email: "person@example.com".to_owned(),
        password: String::new(),
    };

    assert!(validate("", &password()).is_err());
    assert!(validate("archive.example/v1", &password()).is_err());
    assert!(validate("https://archive.example/v1", &no_password).is_err());
    assert!(validate("https://archive.example/v1", &empty_key).is_err());
    assert!(validate("https://archive.example/v1", &password()).is_ok());
}

#[test]
fn an_archive_that_is_down_fails_sign_in_with_its_address() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("home"),
    };

    let failure = sign_in(
        &paths,
        &State::default(),
        "http://127.0.0.1:1/v1",
        &password(),
    )
    .unwrap_err();

    assert_eq!(failure.kind, FailureKind::Unreachable, "{failure:?}");
    assert!(failure.message.contains("http://127.0.0.1:1/v1"));
    assert!(!paths.credentials_file().exists());
}

#[test]
fn signing_out_keeps_the_machine_and_its_queue() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("home"),
    };
    crate::capture::tests::configured(&paths);
    let state = State::default();
    assert!(status(&paths, &state).signed_in);

    let after = sign_out(&paths, &state).unwrap();

    assert!(!after.signed_in);
    assert!(!paths.credentials_file().exists());
    assert!(
        paths.config_dir.join("config.json").exists(),
        "the machine record stays, so signing in again reuses it"
    );
    assert_eq!(
        after.endpoint.as_deref(),
        Some("http://127.0.0.1:1/v1"),
        "the sign-in form starts from the address used last"
    );
    assert!(
        sign_out(&paths, &state).is_ok(),
        "signing out twice is harmless"
    );
}
