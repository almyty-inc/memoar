use std::collections::BTreeSet;

use super::mock::{MockOptions, RecordedRequest, configured_paths, spawn_mock, spawn_mock_api};
use crate::args::{LoginArgs, LogoutArgs};
use crate::config::{RuntimePaths, load_config, save_config};
use crate::credential::{Credential, CredentialStore};
use crate::login::login;
use crate::logout::logout;

const OLD_KEY: &str = "memoar_old-key-secret";

fn with_minted_key(paths: &RuntimePaths) {
    paths
        .credential_store()
        .store_minted(OLD_KEY, Some("key-old"))
        .unwrap();
}

fn asked(requests: &[RecordedRequest]) -> Vec<String> {
    requests
        .iter()
        .map(|request| format!("{} {}", request.method, request.path))
        .collect()
}

fn password_logout(deregister: bool) -> LogoutArgs {
    LogoutArgs {
        email: Some("person@example.com".to_owned()),
        password: Some("correct horse battery staple".to_owned()),
        token: None,
        deregister,
        keep_service: false,
    }
}

/// Every `login` minted a key and left the one before it working: one laptop
/// signing in five times held five live keys, four of them in no file.
#[test]
fn a_re_login_revokes_the_key_it_replaces() {
    let (endpoint, requests, _server) = spawn_mock_api(5, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    with_minted_key(&paths);

    let result = login(
        &LoginArgs {
            endpoint,
            email: Some("person@example.com".to_owned()),
            password: Some("correct horse battery staple".to_owned()),
            token: None,
            machine_id: None,
            redact_secrets: false,
            redact_email_addresses: false,
            redact_home_paths: false,
        },
        &paths,
    )
    .unwrap();

    assert_eq!(result.data["previousKey"]["revoked"], true);
    let requests = requests.lock().unwrap();
    let revoke = requests
        .iter()
        .find(|request| request.method == "DELETE")
        .expect("the previous key was not revoked");
    assert_eq!(revoke.path, "/v1/auth/api-keys/key-old");
    assert!(
        revoke.headers.contains("authorization: Bearer user-token"),
        "revoked with the password session, which holds keys:write"
    );
    assert_eq!(
        paths.credential_store().key_id().as_deref(),
        Some("key-1"),
        "the new key's id is kept so it can be revoked in turn"
    );
}

/// A re-login reset the sources somebody turned off, and switched off the
/// redaction they chose with `memoar redaction`, because the flags default
/// to false.
#[test]
fn a_re_login_keeps_sources_and_redaction() {
    let (endpoint, _requests, _server) = spawn_mock_api(4, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    let mut config = load_config(&paths).unwrap();
    config.redaction.secrets = true;
    config.redaction.home_paths = true;
    config.disabled_sources = BTreeSet::from(["cursor".to_owned()]);
    save_config(&paths, &config).unwrap();

    login(
        &LoginArgs {
            endpoint,
            email: Some("person@example.com".to_owned()),
            password: Some("correct horse battery staple".to_owned()),
            token: None,
            machine_id: None,
            redact_secrets: false,
            redact_email_addresses: true,
            redact_home_paths: false,
        },
        &paths,
    )
    .unwrap();

    let after = load_config(&paths).unwrap();
    assert!(after.redaction.secrets, "secrets masking was switched off");
    assert!(
        after.redaction.home_paths,
        "home path masking was switched off"
    );
    assert!(after.redaction.email_addresses, "a flag still turns one on");
    assert!(after.disabled_sources.contains("cursor"));
}

#[test]
fn logout_with_a_password_revokes_the_key_deregisters_and_forgets() {
    let (endpoint, requests, _server) = spawn_mock_api(4, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    with_minted_key(&paths);

    let result = logout(&password_logout(true), &paths).unwrap();

    assert_eq!(result.data["key"]["revoked"], true);
    assert_eq!(result.data["machine"]["deregistered"], true);
    assert_eq!(result.data["credentialsRemoved"], true);
    assert!(paths.credential_store().load().unwrap().is_none());
    assert!(
        load_config(&paths).is_ok(),
        "config.json names the installation, so a later login is this computer"
    );
    let asked = asked(&requests.lock().unwrap());
    assert!(
        asked.contains(&"DELETE /v1/auth/api-keys/key-old".to_owned()),
        "{asked:?}"
    );
    assert!(
        asked
            .iter()
            .any(|line| line.starts_with("DELETE /v1/machines/")),
        "{asked:?}"
    );
    assert!(
        asked.contains(&"POST /v1/auth/logout".to_owned()),
        "the session opened to revoke the key is ended too: {asked:?}"
    );
}

fn bare_logout() -> LogoutArgs {
    LogoutArgs {
        email: None,
        password: None,
        token: None,
        deregister: false,
        keep_service: false,
    }
}

/// Without an account credential the key revokes itself, which the archive
/// allows without `keys:write`. Before that, `logout` signed the computer out
/// and left the key working on the server.
#[test]
fn logout_without_a_password_revokes_the_key_with_itself() {
    let (endpoint, requests, _server) = spawn_mock_api(1, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    with_minted_key(&paths);

    let result = logout(&bare_logout(), &paths).unwrap();

    assert_eq!(result.data["key"]["revoked"], true, "{}", result.data);
    assert!(
        result.data["nextStep"]
            .as_str()
            .unwrap()
            .contains("memoar login")
    );
    let requests = requests.lock().unwrap();
    assert_eq!(asked(&requests), ["DELETE /v1/auth/api-keys/key-old"]);
    assert!(
        requests[0]
            .headers
            .contains(&format!("x-memoar-key: {OLD_KEY}")),
        "revoked with the key itself"
    );
    assert!(paths.credential_store().load().unwrap().is_none());
}

/// An archive from before a key could revoke itself answers 403. The computer
/// is still signed out, and the report says the key is live and where to
/// revoke it.
#[test]
fn logout_against_an_older_archive_says_the_key_is_still_live() {
    let (endpoint, _requests, _server) = spawn_mock(MockOptions {
        request_count: 1,
        refuse_self_revocation: true,
        ..MockOptions::default()
    });
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    with_minted_key(&paths);

    let result = logout(&bare_logout(), &paths).unwrap();

    assert_eq!(result.data["key"]["revoked"], false);
    assert!(
        result.data["nextStep"]
            .as_str()
            .unwrap()
            .contains("Settings > API keys")
    );
    assert!(paths.credential_store().load().unwrap().is_none());
}

/// A key created by hand and given to `login --token` may be serving an MCP
/// client or a script too. Signing this computer out does not revoke it.
#[test]
fn logout_leaves_a_hand_made_key_alone() {
    let (endpoint, requests, _server) = spawn_mock_api(3, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);
    paths
        .credential_store()
        .store(&Credential::ApiKey("memoar_by-hand-secret".to_owned()))
        .unwrap();

    let result = logout(&password_logout(false), &paths).unwrap();

    assert_eq!(result.data["key"]["revoked"], false);
    assert!(
        !asked(&requests.lock().unwrap())
            .iter()
            .any(|line| line.starts_with("DELETE")),
        "a key logout did not mint was revoked"
    );
}

#[test]
fn logout_when_signed_out_is_not_an_error() {
    let temp = tempfile::tempdir().unwrap();
    let paths = super::mock::fixture_paths(&temp);
    let result = logout(&password_logout(false), &paths).unwrap();
    assert_eq!(result.data["credentialsRemoved"], false);
}
