use std::sync::mpsc;
use std::time::Duration;

use super::mock::{MockOptions, configured_paths, spawn_mock};
use crate::args::SyncArgs;
use crate::error::{EXIT_NETWORK, EXIT_REFUSED};
use crate::http_error::http_error;
use crate::sync::sync;
use crate::watch::fatal_for_watch;

/// `DELETE /machines/{id}` retires the machine, and the watch on that laptop
/// went on asking about it every five minutes for ever, printing "Machine not
/// found (HTTP 404), retrying". It has to stop, say why, and say how back.
#[test]
fn a_watch_on_a_deregistered_machine_stops_and_says_how_to_re_register() {
    let (endpoint, requests, _server) = spawn_mock(MockOptions {
        request_count: 2,
        retired_machine: true,
        ..MockOptions::default()
    });
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    let (done, outcome) = mpsc::channel();
    std::thread::spawn(move || {
        let result = sync(
            &SyncArgs {
                watch: true,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 0,
            },
            false,
            &paths,
        );
        let _ = done.send(result.map(|_| ()));
    });
    let error = outcome
        .recv_timeout(Duration::from_secs(30))
        .expect("the watch kept retrying a machine the archive no longer has")
        .expect_err("a deregistered machine cannot be synced");
    assert_eq!(error.code, "MEMOAR_MACHINE_RETIRED");
    assert_eq!(error.exit_code, EXIT_REFUSED);
    assert!(!error.retryable);
    assert!(error.hint.contains("memoar login"), "{}", error.hint);
    let asked: Vec<_> = requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| format!("{} {}", request.method, request.path))
        .collect();
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[1], "GET /v1/machines", "the machine list settles it");
}

/// A refusal is not a network failure. A wrong password, a revoked key and a
/// 404 were all exit 4 and `retryable: true`, which tells every wrapper to try
/// again with no hope of a different answer.
#[test]
fn refusals_are_exit_5_and_overload_is_worth_retrying() {
    for status in [400_u16, 401, 403, 404, 409, 413, 422] {
        let error = http_error(status, "");
        assert_eq!(error.exit_code, EXIT_REFUSED, "HTTP {status}");
        assert!(!error.retryable, "HTTP {status}");
        assert!(fatal_for_watch(&error), "HTTP {status}");
        assert_eq!(error.http_status, Some(status));
    }
    assert_eq!(http_error(401, "").code, "MEMOAR_UNAUTHORIZED");
    assert_eq!(http_error(403, "").code, "MEMOAR_FORBIDDEN");
    for status in [408_u16, 429, 500, 502, 503, 504] {
        let error = http_error(status, "");
        assert_eq!(error.exit_code, EXIT_NETWORK, "HTTP {status}");
        assert!(error.retryable, "HTTP {status}");
        assert!(!fatal_for_watch(&error), "HTTP {status}");
    }
    assert_eq!(http_error(429, "").code, "MEMOAR_RATE_LIMITED");
}

/// The problem document's own sentence is what is shown, not the document.
#[test]
fn a_refusal_carries_the_archives_detail() {
    let error = http_error(
        400,
        r#"{"title":"Bad request","detail":"password must be longer than or equal to 10 characters"}"#,
    );
    assert_eq!(
        error.message,
        "password must be longer than or equal to 10 characters (HTTP 400)"
    );
}
