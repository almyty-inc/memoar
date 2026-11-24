use crate::account::validated_endpoint;
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
