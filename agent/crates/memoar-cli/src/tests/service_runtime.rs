use std::fs;
use std::time::Duration;

use crate::capture_state::{self, StateRecorder};
use crate::config::RuntimePaths;
use crate::error::AppError;
use crate::service::logfile::{LogFile, tail};
use crate::service::supervisor::{backoff_after, should_restart, split_error};

fn scratch(temp: &tempfile::TempDir) -> RuntimePaths {
    RuntimePaths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("home"),
    }
}

/// Exit 5 is a revoked key or a retired machine, 3 is signed out and 2 a
/// setting no capture can satisfy. Restarting any of them is a loop that
/// changes nothing, which is the restart storm this has to prevent.
#[test]
fn the_service_restarts_what_waiting_can_fix_and_nothing_else() {
    for code in [Some(4), Some(7), Some(9), Some(101), None] {
        assert!(should_restart(code), "{code:?} should be retried");
    }
    for code in [Some(0), Some(2), Some(3), Some(5)] {
        assert!(!should_restart(code), "{code:?} should stop the service");
    }
}

#[test]
fn backoff_doubles_to_a_ceiling_and_resets_after_a_healthy_run() {
    let short = Duration::from_secs(1);
    let (wait, next) = backoff_after(Duration::from_secs(10), short);
    assert_eq!((wait.as_secs(), next.as_secs()), (10, 20));
    let (wait, next) = backoff_after(Duration::from_secs(300), short);
    assert_eq!((wait.as_secs(), next.as_secs()), (300, 300));
    let (wait, next) = backoff_after(Duration::from_secs(300), Duration::from_secs(3_600));
    assert_eq!((wait.as_secs(), next.as_secs()), (10, 20));
}

#[test]
fn the_reason_is_read_back_out_of_what_main_prints() {
    let (message, hint) =
        split_error("memoar: Memoar is not initialized on this machine. hint: Run memoar login.");
    assert_eq!(message, "Memoar is not initialized on this machine.");
    assert_eq!(hint, "Run memoar login.");
    let (message, _) = split_error("thread 'main' panicked");
    assert_eq!(message, "thread 'main' panicked");
}

#[test]
fn the_log_counts_repeats_and_rotates_at_its_cap() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("agent.log");
    let mut log = LogFile::new(path.clone(), 200);
    log.line("captured 0 artifacts, uploaded 0");
    log.line("captured 0 artifacts, uploaded 0");
    log.line("captured 0 artifacts, uploaded 0");
    log.line("captured 2 artifacts, uploaded 2");
    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 3, "{text}");
    assert!(
        text.contains("(the line above repeated 2 more times)"),
        "{text}"
    );
    for index in 0..20 {
        log.line(&format!("line {index}"));
    }
    assert!(
        fs::metadata(&path).unwrap().len() < 400,
        "rotated near the cap"
    );
    assert!(temp.path().join("agent.log.1").exists());
    assert!(
        !temp.path().join("agent.log.3").exists(),
        "two old copies at most"
    );
    let last = tail(&path, 3);
    assert_eq!(last.len(), 3);
    assert!(last[2].ends_with("line 19"), "{last:?}");
}

#[test]
fn a_watch_records_its_progress_and_why_it_stopped() {
    let temp = tempfile::tempdir().unwrap();
    let paths = scratch(&temp);
    let mut recorder = StateRecorder::start(&paths);
    let started = capture_state::load(&paths).expect("written at start");
    assert_eq!(started.pid, std::process::id());
    assert!(started.stopped.is_none());

    recorder.failed(&AppError::network("archive unreachable"));
    let failing = capture_state::load(&paths).unwrap();
    assert_eq!(
        failing
            .last_error
            .as_ref()
            .map(|error| error.message.as_str()),
        Some("archive unreachable")
    );

    recorder.succeeded();
    let recovered = capture_state::load(&paths).unwrap();
    assert!(
        recovered.last_error.is_none(),
        "a recovery is written at once"
    );
    assert!(recovered.last_success_at.is_some());

    let refusal = AppError::refused(
        "MEMOAR_MACHINE_RETIRED",
        "machine retired",
        "Run memoar login.",
    );
    recorder.stopped(&refusal);
    let stopped = capture_state::load(&paths).unwrap();
    let reason = stopped.stopped.expect("stop recorded");
    assert_eq!(
        (reason.code.as_str(), reason.exit_code),
        ("MEMOAR_MACHINE_RETIRED", 5)
    );

    // The next watch starts clean, and keeps the last upload it knew of.
    StateRecorder::start(&paths);
    let restarted = capture_state::load(&paths).unwrap();
    assert!(restarted.stopped.is_none());
    assert_eq!(restarted.last_success_at, recovered.last_success_at);
}
