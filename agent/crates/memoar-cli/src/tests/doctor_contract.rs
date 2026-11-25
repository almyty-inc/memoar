//! `contract_version`: this client against its archive, not against its config.
//!
//! The check compared the client with the `contractVersion` config.json was
//! first written with. Nothing moved that forward on an upgrade, so on
//! 2026-11-25 a healthy laptop upgraded to 0.4.1, talking to a 0.4.1 archive,
//! reported `config says 0.3.0, this client speaks 0.4.1` and would have done
//! so forever.

use serde_json::{Value, json};
use std::fs;

use crate::config::{load_config, save_config};
use crate::doctor::doctor;
use crate::tests::mock::{MACHINE_ID, MockOptions, configured_paths, spawn_mock, spawn_mock_api};

/// Every network call `doctor` makes against a healthy mock archive.
const DOCTOR_REQUESTS: usize = 5;

fn named<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .expect("checks")
        .iter()
        .find(|check| check["name"] == name)
        .unwrap_or_else(|| panic!("doctor must report a {name} check: {report}"))
}

/// A config.json as a 0.3.0 client wrote it: no installation id, no capture
/// settings, and the contract it was written under.
fn write_old_config(paths: &crate::config::RuntimePaths, endpoint: &str) {
    let old = json!({
        "contractVersion": "0.3.0",
        "endpoint": endpoint,
        "machineId": MACHINE_ID,
        "disabledSources": [],
        "redaction": { "secrets": false, "emailAddresses": false, "homePaths": false }
    });
    fs::write(
        paths.config_file(),
        serde_json::to_vec_pretty(&old).unwrap(),
    )
    .unwrap();
}

#[test]
fn an_install_upgraded_from_0_3_0_passes_against_an_archive_on_its_contract() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, _requests, server) = spawn_mock_api(DOCTOR_REQUESTS, None);
    let paths = configured_paths(&temp, &endpoint);
    write_old_config(&paths, &endpoint);

    let report = doctor(&paths).expect("an old config is readable").data;
    server.join().unwrap();

    let contract = named(&report, "contract_version");
    assert_eq!(contract["ok"], json!(true), "{contract}");
    assert!(
        !contract["detail"].as_str().unwrap().contains("0.3.0"),
        "what an old client once wrote is not a finding: {contract}"
    );
}

#[test]
fn an_archive_on_another_contract_is_a_red_check_naming_both() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, _requests, server) = spawn_mock(MockOptions {
        request_count: DOCTOR_REQUESTS,
        archive_contract: "0.3.0",
        ..MockOptions::default()
    });
    let paths = configured_paths(&temp, &endpoint);

    let report = doctor(&paths).unwrap().data;
    server.join().unwrap();

    let contract = named(&report, "contract_version");
    assert_eq!(contract["ok"], json!(false), "{contract}");
    let detail = contract["detail"].as_str().unwrap();
    assert!(
        detail.contains("0.3.0") && detail.contains(memoar_canonical::CONTRACT_VERSION),
        "both sides are named: {contract}"
    );
    assert!(contract["hint"].is_string(), "and what to do: {contract}");
    assert_eq!(report["ok"], json!(false));
}

#[test]
fn any_write_records_the_contract_of_the_client_that_made_it() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
    write_old_config(&paths, "http://127.0.0.1:1/v1");

    let config = load_config(&paths).expect("a 0.3.0 config loads");
    assert_eq!(config.contract_version, "0.3.0");
    assert_eq!(config.machine_id, MACHINE_ID);
    save_config(&paths, &config).unwrap();

    let written: Value = serde_json::from_slice(&fs::read(paths.config_file()).unwrap()).unwrap();
    assert_eq!(
        written["contractVersion"],
        json!(memoar_canonical::CONTRACT_VERSION)
    );
    assert_eq!(written["machineId"], json!(MACHINE_ID), "the rest is kept");
}

#[test]
fn a_config_without_a_contract_version_still_loads() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
    let mut config: Value =
        serde_json::from_slice(&fs::read(paths.config_file()).unwrap()).unwrap();
    config.as_object_mut().unwrap().remove("contractVersion");
    fs::write(paths.config_file(), serde_json::to_vec(&config).unwrap()).unwrap();

    let loaded = load_config(&paths).expect("the field is a record, not a requirement");
    assert_eq!(loaded.contract_version, "");
}
