use crate::account::{sign_in, validated_endpoint};
use crate::credential::Credential;
use crate::error::EXIT_USAGE;

/// An endpoint without a scheme reached the HTTP client as typed and came
/// back as "builder error", exit 4 and retryable: a typo reported as an
/// outage.
#[test]
fn an_endpoint_that_is_not_a_url_is_a_usage_error() {
    for bad in [
        "",
        "   ",
        "localhost:4000/v1",
        "memoar.example.com/v1",
        "ftp://host/v1",
        "http://",
    ] {
        let error = validated_endpoint(bad).expect_err(bad);
        assert_eq!(error.exit_code, EXIT_USAGE, "{bad:?}");
    }
}

#[test]
fn an_endpoint_is_trimmed_of_space_and_trailing_slashes() {
    assert_eq!(
        validated_endpoint("  https://memoar.example.com/v1/ ").unwrap(),
        "https://memoar.example.com/v1"
    );
    assert_eq!(
        validated_endpoint("http://127.0.0.1:4000/v1").unwrap(),
        "http://127.0.0.1:4000/v1"
    );
}

/// MEMOAR_TOKEN or MEMOAR_PASSWORD left in the environment made the other way
/// of signing in a clap conflict, so `login --email` failed with a usage error
/// on any machine that exported a token. The email decides.
#[test]
fn an_email_wins_over_a_token_from_the_environment() {
    let error = sign_in(
        "http://127.0.0.1:9/v1",
        Some("person@example.com"),
        Some("correct horse battery staple"),
        Some("memoar_from-the-environment"),
        "login",
    )
    .unwrap_err();
    assert!(error.message.contains("/auth/login"), "{}", error.message);

    let credential = sign_in(
        "http://127.0.0.1:9/v1",
        None,
        Some("from MEMOAR_PASSWORD"),
        Some("memoar_typed-token"),
        "login",
    )
    .unwrap();
    assert_eq!(
        credential,
        Credential::ApiKey("memoar_typed-token".to_owned())
    );
}
