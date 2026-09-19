use std::fs;
use std::time::{Duration, Instant};

use super::mock::{MockOptions, configured_paths, spawn_mock, spawn_mock_api};
use crate::api::problem_message;
use crate::args::SyncArgs;
use crate::error::AppError;
use crate::sync::sync;
use crate::watch::fatal_for_watch;

/// The sweep remembers which instruction files it has already sent, and a
/// fresh one each cycle remembers nothing. Now that a watch survives its own
/// failures and runs indefinitely, that is every instruction file on the
/// machine re-uploaded every interval, for as long as the laptop is on.
#[test]
fn a_watch_does_not_re_upload_an_unchanged_instruction_file() {
    let temp = tempfile::tempdir().unwrap();
    // Room for a second upload, so the failure is an assertion about what
    // was sent rather than a test that hangs waiting for a request the fix
    // prevents. The server is left blocked on accept for the same reason.
    let (endpoint, requests, _server) = spawn_mock_api(9, None);
    let paths = configured_paths(&temp, &endpoint);
    fs::create_dir_all(paths.home.join(".claude")).unwrap();
    fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();

    sync(
        &SyncArgs {
            watch: true,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 2,
        },
        false,
        &paths,
    )
    .unwrap();

    let uploads = requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.path == "/v1/memory")
        .count();
    assert_eq!(
        uploads, 1,
        "two cycles, one unchanged file: it was sent {uploads} times"
    );
}

/// A watcher that dies on the first transport failure is a watcher that
/// cannot do its job: the offline queue exists so a closed lid or a changed
/// network costs nothing, and `sync --watch` was the one thing on the
/// machine that could not survive either.
#[test]
fn a_lost_network_does_not_end_a_watch() {
    let (endpoint, requests, server) = spawn_mock(MockOptions {
        request_count: 3,
        dropped_connections: 1,
        ..MockOptions::default()
    });
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let started = Instant::now();
    let result = sync(
        &SyncArgs {
            watch: true,
            interval_seconds: 1,
            debounce_seconds: 1,
            max_cycles: 1,
        },
        false,
        &paths,
    )
    .expect("a dropped connection must be retried, not fatal");

    assert!(
        result.data["sync"]["uploaded"].is_number(),
        "the cycle after the failure completed"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "the retry waited a poll interval rather than hammering the archive"
    );
    server.join().unwrap();
    assert!(!requests.lock().unwrap().is_empty());
}

/// Retrying forever is its own failure. A credential the archive refuses is
/// not going to start working, and a watch that keeps asking every five
/// minutes hides that from whoever has to fix it.
#[test]
fn a_refused_credential_ends_a_watch_but_a_dead_network_does_not() {
    assert!(fatal_for_watch(&AppError::network(problem_message(
        401, ""
    ))));
    assert!(fatal_for_watch(&AppError::network(problem_message(
        403, ""
    ))));
    assert!(fatal_for_watch(&AppError::usage("no such source")));
    assert!(fatal_for_watch(&AppError::internal("queue is corrupt")));
    assert!(!fatal_for_watch(&AppError::network(
        "error sending request: connection refused"
    )));
    assert!(!fatal_for_watch(&AppError::network(problem_message(
        503, ""
    ))));
    assert!(
        !fatal_for_watch(&AppError::locked("database is locked")),
        "another process holding the queue is a wait, not a stop"
    );
}
