use std::fs;

use super::mock::{MACHINE_ID, fixture_paths, spawn_mock_api};
use crate::args::LoginArgs;
use crate::config::load_credential;
use crate::credential::{CAPTURE_SCOPES, Credential};
use crate::login::login;
use crate::status::doctor;

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
