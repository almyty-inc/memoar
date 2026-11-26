use serde_json::Value;
use std::process::Command;

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_memoar"))
        .args(arguments)
        .output()
        .expect("memoar binary should run")
}

/// The build version is expected to move; the contract is not.
///
/// The goldens pinned `clientVersion`, so bumping the crate broke both of them
/// while `contractVersion` — the thing they exist to protect — had not changed.
/// That is churn with no signal, and it trains you to re-record goldens without
/// reading them. The version is asserted against the crate directly instead.
fn take_client_version(value: &mut Value) -> Option<String> {
    value
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .and_then(|data| data.remove("clientVersion"))
        .and_then(|version| version.as_str().map(str::to_owned))
}

/// Compares the contract, and separately holds the binary to its own version.
fn assert_contract_matches(mut actual: Value, mut expected: Value) {
    let reported = take_client_version(&mut actual);
    take_client_version(&mut expected);
    assert_eq!(
        reported.as_deref(),
        Some(env!("CARGO_PKG_VERSION")),
        "the binary must report the version it was built at"
    );
    assert_eq!(actual, expected);
}

#[test]
fn compiled_binary_capabilities_match_golden_exactly() {
    let output = run(&["--json", "capabilities"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_str(include_str!("golden/capabilities.json")).unwrap();
    assert_contract_matches(actual, expected);
}

#[test]
fn compiled_binary_introspect_matches_golden_exactly() {
    let output = run(&["--json", "introspect"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_str(include_str!("golden/introspect.json")).unwrap();
    assert_contract_matches(actual, expected);
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

/// Asking a program its version is not a mistake.
///
/// clap reports `--version` and `--help` as errors, and they were handled as
/// usage failures: rendered to stderr with exit 2. Anything probing for the
/// tool — a package manager, a CI step, `memoar --version` in a script — read
/// that as the tool being broken. The release workflow's own "the binary must
/// run on the machine that built it" step is what surfaced it, on four of five
/// platforms at once.
#[test]
fn version_and_help_succeed_on_stdout() {
    for arguments in [["--version"], ["--help"]] {
        let output = run(&arguments);
        assert!(
            output.status.success(),
            "{arguments:?} exited {:?}",
            output.status.code()
        );
        assert!(
            output.stderr.is_empty(),
            "{arguments:?} wrote to stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.stdout.is_empty(), "{arguments:?} printed nothing");
    }
}

#[test]
fn a_real_usage_error_still_fails() {
    // The fix must not turn every parse error into success.
    let output = run(&["definitely-not-a-command"]);
    assert_eq!(
        output.status.code(),
        Some(memoar_cli::EXIT_USAGE.into()),
        "an unknown subcommand must still be a usage failure"
    );
}

/// Without HOME or USERPROFILE (a service account, a scrubbed CI step) every
/// command failed with "Memoar is not initialized", `capabilities` included,
/// and naming all three directories did not help.
#[test]
fn no_home_directory_is_needed_when_none_is_used() {
    let temp = tempfile::tempdir().unwrap();
    let bare = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_memoar"))
            .args(arguments)
            .env_remove("HOME")
            .env_remove("USERPROFILE")
            .output()
            .expect("memoar binary should run")
    };
    let output = bare(&["--json", "capabilities"]);
    assert!(output.status.success(), "{:?}", output.status.code());

    let dir = |name: &str| temp.path().join(name).to_str().unwrap().to_owned();
    let output = bare(&[
        "--json",
        "--config-dir",
        &dir("config"),
        "--data-dir",
        &dir("data"),
        "--capture-home",
        &dir("home"),
        "status",
    ]);
    assert_eq!(
        output.status.code(),
        Some(memoar_cli::EXIT_NOT_INITIALIZED.into()),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );

    let output = bare(&["--json", "status"]);
    assert_eq!(output.status.code(), Some(memoar_cli::EXIT_USAGE.into()));
}

/// `memoar tui` draws in a terminal. Asked for JSON, or run with its output
/// in a pipe, it says so with a usage error instead of filling the pipe with
/// escape sequences.
#[test]
fn tui_refuses_json_and_a_pipe() {
    let temp = tempfile::tempdir().unwrap();
    let dir = |name: &str| temp.path().join(name).to_str().unwrap().to_owned();
    let (config, data, home) = (dir("config"), dir("data"), dir("home"));
    let base = [
        "--config-dir",
        config.as_str(),
        "--data-dir",
        data.as_str(),
        "--capture-home",
        home.as_str(),
    ];

    let mut arguments = vec!["--json"];
    arguments.extend(base);
    arguments.push("tui");
    let output = run(&arguments);
    assert_eq!(output.status.code(), Some(memoar_cli::EXIT_USAGE.into()));
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["ok"], false);
    assert!(
        envelope["error"]["message"]
            .as_str()
            .unwrap()
            .contains("interactive")
    );

    let mut arguments = base.to_vec();
    arguments.push("tui");
    let output = run(&arguments);
    assert_eq!(output.status.code(), Some(memoar_cli::EXIT_USAGE.into()));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("needs a terminal"), "{stderr}");
    assert!(output.stdout.is_empty(), "nothing drawn into the pipe");
}
