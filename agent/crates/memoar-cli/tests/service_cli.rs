//! The service's own loop, run from the compiled binary against scratch
//! directories. Nothing here installs anything into a service manager: that
//! is `agent/scripts/service-smoke.*`, which CI runs on each platform.

use serde_json::Value;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

fn memoar(root: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_memoar"))
        .args(arguments)
        .arg("--config-dir")
        .arg(root.join("config"))
        .arg("--data-dir")
        .arg(root.join("data"))
        .arg("--capture-home")
        .arg(root.join("home"))
        .env_remove("MEMOAR_CONFIG_DIR")
        .env_remove("MEMOAR_DATA_DIR")
        .env_remove("MEMOAR_CAPTURE_HOME")
        .output()
        .unwrap()
}

/// A configuration that is signed out makes the watch exit 3. The service
/// must record why and exit 0, which every service manager here reads as
/// "stay stopped", rather than start it again forever.
#[test]
fn the_service_stops_cleanly_on_a_failure_retrying_cannot_fix() {
    let temp = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let output = memoar(temp.path(), &["service", "run", "--name", "ci-test"]);
    assert!(
        output.status.success(),
        "exit {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "it did not retry"
    );

    let state: Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("data/capture-state.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(state["stopped"]["exitCode"], 3, "{state}");
    assert_eq!(
        state["stopped"]["message"],
        "Memoar is not initialized on this machine."
    );
    assert_eq!(state["stopped"]["hint"], "Run memoar login.");

    let log = std::fs::read_to_string(temp.path().join("data/logs/agent.log")).unwrap();
    assert!(log.contains("service: ci-test started"), "{log}");
    assert!(
        log.contains("service: background capture stopped: memoar: Memoar is not initialized"),
        "{log}"
    );

    let logs = memoar(temp.path(), &["service", "logs", "--lines", "1"]);
    let text = String::from_utf8_lossy(&logs.stdout);
    assert!(text.contains("background capture stopped"), "{text}");
    assert_eq!(text.lines().count(), 1, "printed as text, one line: {text}");
}

#[test]
fn installing_needs_a_signed_in_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let output = memoar(
        temp.path(),
        &["--json", "service", "install", "--name", "ci-test"],
    );
    assert_eq!(output.status.code(), Some(3));
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["error"]["code"], "MEMOAR_NOT_INITIALIZED");
}

#[test]
fn removing_a_service_that_was_never_installed_says_so() {
    let temp = tempfile::tempdir().unwrap();
    let output = memoar(
        temp.path(),
        &[
            "--json",
            "service",
            "uninstall",
            "--name",
            "ci-never-installed",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["data"]["removed"], false, "{envelope}");
}
