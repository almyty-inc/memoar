use clap::Parser;
use serde_json::Value;
use uuid::Uuid;

use super::mock::fixture_paths;
use crate::CommandOutput;
use crate::args::{Cli, ConvertArgs};
use crate::convert::convert;
use crate::envelope::{capabilities_value, error_envelope, introspect_value, success_envelope};
use crate::error::{AppError, EXIT_NOT_INITIALIZED, EXIT_USAGE};

#[test]
fn every_required_command_parses() {
    let commands = [
        vec!["memoar", "login", "--token", "test"],
        vec!["memoar", "status"],
        vec!["memoar", "sources", "list"],
        vec!["memoar", "sources", "enable", "codex"],
        vec!["memoar", "sources", "disable", "codex"],
        vec!["memoar", "sync"],
        vec!["memoar", "search", "queue bug"],
        vec!["memoar", "view", "session-id"],
        vec!["memoar", "pack", "queue bug"],
        vec!["memoar", "convert", "session-id", "--target", "codex"],
        vec!["memoar", "doctor"],
        vec!["memoar", "capabilities"],
        vec!["memoar", "introspect"],
    ];
    for command in commands {
        Cli::try_parse_from(command).unwrap();
    }
}

#[test]
fn capabilities_match_golden_contract() {
    let expected: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/golden/capabilities.json"
    )))
    .unwrap();
    let output = CommandOutput {
        command: "capabilities".to_owned(),
        data: capabilities_value(),
    };
    assert_eq!(success_envelope(&output), expected);
}

#[test]
fn introspect_matches_golden_contract() {
    let expected: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/golden/introspect.json"
    )))
    .unwrap();
    let output = CommandOutput {
        command: "introspect".to_owned(),
        data: introspect_value(),
    };
    assert_eq!(success_envelope(&output), expected);
}

#[test]
fn not_initialized_error_matches_golden_and_exit() {
    let error = AppError::not_initialized();
    let expected: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/golden/error-not-initialized.json"
    )))
    .unwrap();
    assert_eq!(error.exit_code, EXIT_NOT_INITIALIZED);
    assert_eq!(error_envelope(&error), expected);
}

#[test]
fn generated_local_ids_are_uuid_v7() {
    let id = Uuid::now_v7();
    assert_eq!(id.get_version_num(), 7);
}

#[test]
fn arbitrary_target_is_allowed_only_for_remote_injection() {
    let args = ConvertArgs {
        session_id: "session".to_owned(),
        target: "future-agent".to_owned(),
        fallback: "injection".to_owned(),
        here: true,
        bundle: None,
        wait_seconds: 1,
        poll_milliseconds: 25,
    };
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    assert_eq!(convert(&args, &paths).unwrap_err().exit_code, EXIT_USAGE);
}
