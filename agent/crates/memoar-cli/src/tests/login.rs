use memoar_daemon::RedactionConfig;
use std::collections::BTreeSet;
use std::fs;

use super::mock::{INSTALLATION_ID, MACHINE_ID, RETIRED_MACHINE_ID, fixture_paths, spawn_mock_api};
use crate::args::LoginArgs;
use crate::config::{Config, load_config, load_credential, save_config};
use crate::credential::{CAPTURE_SCOPES, Credential};
use crate::login::login;
use crate::machine::resolve_machine_name;
use crate::status::doctor;

fn login_args(endpoint: &str) -> LoginArgs {
    LoginArgs {
        endpoint: endpoint.to_owned(),
        email: Some("person@example.com".to_owned()),
        password: Some("correct horse battery staple".to_owned()),
        token: None,
        machine_id: None,
        redact_secrets: true,
        redact_email_addresses: false,
        redact_home_paths: false,
    }
}

fn registrations(requests: &[super::mock::RecordedRequest]) -> Vec<&super::mock::RecordedRequest> {
    requests
        .iter()
        .filter(|request| request.method == "POST" && request.path == "/v1/machines")
        .collect()
}

/// `login` must not leave the agent holding the account's browser token.
///
/// That token expires in an hour and the server issues no refresh for it, so
/// every later command — above all `sync --watch`, which exists to keep
/// running — died on `401 Valid bearer, machine, or API-key credentials are
/// required` and could only be revived by typing a password again. What is
/// stored is a capture-scoped API key, and what goes on the wire afterwards
/// is `x-memoar-key`, not the bearer.
#[test]
fn login_trades_the_hour_long_token_for_a_capture_key() {
    let (endpoint, requests, server) = spawn_mock_api(7, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    fs::create_dir_all(&paths.home).unwrap();
    let result = login(
        &LoginArgs {
            endpoint,
            email: Some("person@example.com".to_owned()),
            password: Some("correct horse battery staple".to_owned()),
            token: None,
            machine_id: None,
            redact_secrets: true,
            redact_email_addresses: false,
            redact_home_paths: false,
        },
        &paths,
    )
    .unwrap();
    assert_eq!(result.data["machineId"], MACHINE_ID);
    assert_eq!(result.data["credential"], "api-key");
    assert_eq!(
        load_credential(&paths).unwrap(),
        Credential::ApiKey("memoar_test-capture-key".to_owned()),
        "the stored credential must be the key, not the hour-long token"
    );
    assert_eq!(doctor(&paths).unwrap().data["ok"], true);
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/v1/auth/login");
    assert!(
        requests[1]
            .headers
            .contains("authorization: Bearer user-token")
    );
    assert!(
        requests[2]
            .body
            .windows(12)
            .any(|part| part == b"agentVersion")
    );
    let key_request = requests
        .iter()
        .find(|request| request.path == "/v1/auth/api-keys")
        .expect("login must mint a capture key");
    let scopes = String::from_utf8_lossy(&key_request.body);
    for scope in CAPTURE_SCOPES {
        assert!(scopes.contains(scope), "capture key must request {scope}");
    }
    for withheld in ["sharing:write", "keys:write", "mcp:use"] {
        assert!(
            !scopes.contains(withheld),
            "a credential that lives on a laptop forever must not carry {withheld}"
        );
    }
    // Everything after the key exists is authenticated by the key.
    let after_key = requests
        .iter()
        .skip_while(|request| request.path != "/v1/auth/api-keys")
        .skip(1);
    for request in after_key {
        assert!(
            request.headers.contains("x-memoar-key: memoar_"),
            "{} still used the expiring token",
            request.path
        );
    }
}

/// Logging in twice on one computer must leave the account with one machine.
///
/// `login` used to `POST /machines` unconditionally and take whatever id came
/// back, never reading the `machine_id` already in `config.json`. So every
/// re-login — a changed endpoint, a fresh password, an expired credential —
/// enrolled the same laptop again. Memory documents are unique on (tenant,
/// machine, path), so each surplus machine duplicated every instruction file:
/// one account reached 346 documents across 173 paths, every path twice, each
/// pair sharing a content hash and differing only in which machine claimed it.
#[test]
fn logging_in_again_reuses_the_machine_this_computer_already_registered() {
    let (endpoint, requests, server) = spawn_mock_api(8, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    fs::create_dir_all(&paths.home).unwrap();

    let first = login(&login_args(&endpoint), &paths).unwrap();
    let enrolled = load_config(&paths).unwrap().installation_id;
    let second = login(&login_args(&endpoint), &paths).unwrap();

    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        registrations(&requests).len(),
        1,
        "the second login registered the same computer a second time"
    );
    assert_eq!(first.data["machineId"], MACHINE_ID);
    assert_eq!(
        second.data["machineId"], first.data["machineId"],
        "the second login moved this computer to a different machine record"
    );
    assert_eq!(first.data["machineRegistered"], true);
    assert_eq!(second.data["machineRegistered"], false);
    let config = load_config(&paths).unwrap();
    assert_eq!(config.machine_id, MACHINE_ID);
    assert_eq!(
        config.installation_id, enrolled,
        "the installation must keep the identity it was given, or the archive \
         cannot recognise it either"
    );
    assert!(!enrolled.is_empty(), "login must record an installation id");
}

/// A machine that is gone is a reason to enrol, not a reason to refuse.
///
/// The stored id can name a machine somebody deleted in the web app, or a
/// machine belonging to an archive this config used to point at. Neither is the
/// operator's fault and neither is repairable by hand without knowing to edit
/// `config.json`, so `login` registers afresh — and carries the installation id
/// it already had, which is what lets the archive recognise the re-registration
/// as this computer rather than a new one.
#[test]
fn logging_in_registers_again_when_the_archive_no_longer_has_the_machine() {
    let (endpoint, requests, server) = spawn_mock_api(5, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    fs::create_dir_all(&paths.home).unwrap();
    save_config(
        &paths,
        &Config {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            endpoint: endpoint.clone(),
            machine_id: RETIRED_MACHINE_ID.to_owned(),
            installation_id: INSTALLATION_ID.to_owned(),
            disabled_sources: BTreeSet::new(),
            redaction: RedactionConfig::disabled(),
        },
    )
    .unwrap();

    let result = login(&login_args(&endpoint), &paths).unwrap();

    // Asserted before the mock is joined: a login that skips the registration
    // leaves the mock waiting for a request that never comes, and a test that
    // hangs says less than one that names what went wrong.
    assert_eq!(
        result.data["machineRegistered"], true,
        "login kept a machine the archive does not have"
    );
    assert_eq!(result.data["machineId"], MACHINE_ID);
    assert_eq!(load_config(&paths).unwrap().machine_id, MACHINE_ID);
    {
        let requests = requests.lock().unwrap();
        let registrations = registrations(&requests);
        assert_eq!(registrations.len(), 1);
        let body = String::from_utf8_lossy(&registrations[0].body);
        assert!(
            body.contains(INSTALLATION_ID),
            "registration must name the installation it came from, got {body}"
        );
    }
    server.join().unwrap();
}

/// The machine list has to read as a list of computers.
///
/// `HOSTNAME` is a shell variable that bash does not export, and `COMPUTERNAME`
/// exists only on Windows, so reading only those two fell through to the literal
/// `memoar-machine` on practically every Unix machine. A dev account ended up
/// with four rows all called that, for one laptop. Asking the system is what the
/// variables were standing in for.
#[test]
fn a_machine_is_named_after_the_computer_not_after_the_agent() {
    assert_eq!(
        resolve_machine_name(None, None, || Some("franes-mac".to_owned())),
        "franes-mac"
    );
    // A variable that is set still wins, and the system is not asked at all.
    assert_eq!(
        resolve_machine_name(Some("shell-host".into()), None, || panic!(
            "the system must not be asked when HOSTNAME says so"
        )),
        "shell-host"
    );
    assert_eq!(
        resolve_machine_name(Some("   ".into()), Some("WIN-BOX".into()), || None),
        "WIN-BOX",
        "an empty variable is not a name"
    );
    // Only when nothing at all can say, which is not an error worth failing a
    // login over — the name identifies nothing.
    assert_eq!(resolve_machine_name(None, None, || None), "memoar-machine");
}
