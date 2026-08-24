use serde_json::Value;
use std::process::Command;

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_memoar"))
        .args(arguments)
        .output()
        .expect("memoar binary should run")
}

#[test]
fn compiled_binary_capabilities_match_golden_exactly() {
    let output = run(&["--json", "capabilities"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_str(include_str!("golden/capabilities.json")).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn compiled_binary_introspect_matches_golden_exactly() {
    let output = run(&["--json", "introspect"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_str(include_str!("golden/introspect.json")).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn compiled_binary_error_envelope_and_exit_are_stable() {
    let temp = tempfile::tempdir().unwrap();
    let output = run(&[
        "--json",
        "--config-dir",
        temp.path().join("missing-config").to_str().unwrap(),
        "--data-dir",
        temp.path().join("data").to_str().unwrap(),
        "status",
    ]);
    assert_eq!(
        output.status.code(),
        Some(memoar_cli::EXIT_NOT_INITIALIZED.into())
    );
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("golden/error-not-initialized.json")).unwrap();
    assert_eq!(actual, expected);
}
