//! What `memoar convert` says when the conversion does not happen.
//!
//! "The archive refused this" and "the archive never answered" call for
//! different actions from the person holding the terminal, and they used to be
//! the same error code, the same exit status, the same `retryable: true`, and
//! the same hint — "check the endpoint, connection, and credentials, then
//! retry" — which is advice that cannot work for the first of them.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;

use super::mock::{MACHINE_ID, configured_paths};
use crate::args::ConvertArgs;
use crate::convert::convert;
use crate::error::{EXIT_NETWORK, EXIT_REFUSED, EXIT_USAGE};

/// Answers every request with the same body, once per expected request.
fn spawn_answering(body: Value, requests: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for _ in 0..requests {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut head = [0_u8; 4096];
            let _ = stream.read(&mut head);
            let bytes = serde_json::to_vec(&body).unwrap();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                bytes.len()
            );
            let _ = stream.write_all(&bytes);
        }
    });
    endpoint
}

fn convert_args(session_id: &str) -> ConvertArgs {
    ConvertArgs {
        session_id: session_id.to_owned(),
        target: "claude-code".to_owned(),
        fallback: "injection".to_owned(),
        here: true,
        bundle: None,
        wait_seconds: 1,
        poll_milliseconds: 25,
    }
}

/// A conversion the archive refused is not a network condition.
///
/// It was reported as one: `MEMOAR_NETWORK`, exit 4, `retryable: true`. A CI
/// step that retries on the network code retries this forever, and it is
/// refused identically every time.
#[test]
fn a_refused_conversion_is_not_reported_as_a_network_failure() {
    let endpoint = spawn_answering(
        json!({
            "id": "conversion-job",
            "status": "failed",
            "report": { "reason": "this session has no assistant turns to convert" }
        }),
        1,
    );
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let error = convert(&convert_args(MACHINE_ID), &paths).expect_err("a refusal is a failure");

    assert_eq!(error.exit_code, EXIT_REFUSED, "{error:?}");
    assert_eq!(error.code, "MEMOAR_CONVERSION_FAILED");
    assert!(
        !error.retryable,
        "retrying is refused the same way: {error:?}"
    );
    assert!(
        error
            .message
            .contains("this session has no assistant turns to convert"),
        "the reason the archive gave is the message: {error:?}"
    );
    // The report used to be interpolated whole, so a refusal reached the
    // terminal as `conversion failed: {"reason":...,"mappedTurns":0}`.
    assert!(!error.message.contains('{'), "no wire format: {error:?}");
    assert!(
        !error.hint.contains("connection"),
        "and the hint must not send them to check their network: {error:?}"
    );
}

/// A conversion that has not finished is a different thing entirely, and its
/// remedy — wait longer — is a real one.
#[test]
fn a_conversion_still_running_is_told_apart_from_one_that_was_refused() {
    let endpoint = spawn_answering(
        json!({ "id": "conversion-job", "status": "running" }),
        // The initial POST plus however many polls fit in the window.
        64,
    );
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let error = convert(&convert_args(MACHINE_ID), &paths).expect_err("the window closed");

    assert_eq!(error.code, "MEMOAR_TIMEOUT");
    assert_eq!(error.exit_code, EXIT_NETWORK);
    assert!(error.retryable, "waiting longer is a real remedy");
    assert!(
        error.message.contains("conversion-job") && error.message.contains("running"),
        "the message names the job and its last known state: {error:?}"
    );
    assert!(
        error.hint.contains("--wait-seconds"),
        "and the hint is the thing that would help: {error:?}"
    );
}

/// A path the person typed is theirs to correct.
///
/// `--bundle` pointing at nothing surfaced as `MEMOAR_UNKNOWN`, exit 9, with
/// "Run memoar doctor and retry with the latest client" — and `doctor`
/// inspects the install. It has nothing whatever to say about a file named on
/// the command line.
#[test]
fn a_missing_bundle_file_is_not_an_unknown_internal_fault() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
    let mut args = convert_args(MACHINE_ID);
    args.bundle = Some(temp.path().join("no-such-bundle.json"));

    let error = convert(&args, &paths).expect_err("a missing file is a failure");

    assert_eq!(error.exit_code, EXIT_USAGE, "{error:?}");
    assert_eq!(error.code, "MEMOAR_LOCAL_FILE");
    assert!(
        error.message.contains("no-such-bundle.json"),
        "the message names the path that was tried: {error:?}"
    );
    assert!(
        !error.hint.contains("doctor"),
        "and must not send them to a command that cannot help: {error:?}"
    );
}
