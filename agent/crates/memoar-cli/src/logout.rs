//! `memoar logout`: sign this computer out, on the archive and on disk.
//!
//! Deleting `credentials.json` by hand left the key it held working on the
//! server, and deregistering the machine in the web app left the key too. So
//! this revokes the key first, says plainly whether that worked, and removes
//! the local copy either way: a person running `logout` wants this computer
//! signed out even when the archive is unreachable.
//!
//! `config.json` is kept. It names the installation, so a later `login` is
//! recognised as this computer rather than enrolled as another one.

use serde_json::{Value, json};

use crate::CommandOutput;
use crate::account::sign_in;
use crate::api::ApiClient;
use crate::args::LogoutArgs;
use crate::config::{Config, RuntimePaths, load_config_optional};
use crate::credential::{Credential, CredentialStore};
use crate::error::AppError;
use crate::revoke::{Revocation, key_hint, revocation_report, revoke_key};

pub(crate) fn logout(args: &LogoutArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let store = paths.credential_store();
    // A file that cannot be read is still a file to delete.
    let stored = store.load().ok().flatten();
    let key_id = store.key_id();
    let config = load_config_optional(paths).ok().flatten();
    let (Some(stored), Some(config)) = (stored, config) else {
        let removed = store.remove()?;
        return Ok(signed_out(removed, Value::Null, Value::Null));
    };
    let wants_account = args.email.is_some() || args.token.is_some();
    // The machine is deregistered with the stored key, which holds
    // `machines:write`, before that key is revoked.
    let machine = if args.deregister {
        deregister(&ApiClient::new(&config.endpoint, Some(&stored)), &config)
    } else {
        Value::Null
    };
    let key = match &stored {
        Credential::ApiKey(secret) => {
            let outcome = if wants_account {
                sign_in(
                    &config.endpoint,
                    args.email.as_deref(),
                    args.password.as_deref(),
                    args.token.as_deref(),
                    "logout",
                )
                .and_then(|account| {
                    let authority = ApiClient::new(&config.endpoint, Some(&account));
                    let result = revoke_key(&authority, secret, key_id.as_deref());
                    end_session(&authority, &account);
                    result
                })
            } else {
                // The key revoking itself, which the archive allows without
                // `keys:write`. It needs the id `login` recorded: a key stored
                // by an older agent has none and cannot list keys to find it,
                // and an archive older than self-revocation answers 403. Both
                // end in a report that names the next step.
                revoke_own_key(&config.endpoint, &stored, secret, key_id.as_deref())
            };
            revocation_report(outcome)
        }
        // An access token from an older agent: ending its session is the
        // whole of revoking it.
        Credential::Bearer(_) => {
            let api = ApiClient::new(&config.endpoint, Some(&stored));
            revocation_report(api.post_empty("/auth/logout").map(|()| Revocation::Revoked))
        }
    };
    let removed = store.remove()?;
    Ok(signed_out(removed, key, machine))
}

/// Asks the stored key to revoke itself.
///
/// A 401 means the archive no longer accepts the key at all, which is the
/// state `logout` wants, so it is reported as a key the archive no longer had.
fn revoke_own_key(
    endpoint: &str,
    stored: &Credential,
    secret: &str,
    key_id: Option<&str>,
) -> Result<Revocation, AppError> {
    match revoke_key(&ApiClient::new(endpoint, Some(stored)), secret, key_id) {
        Err(error) if error.http_status == Some(401) => Ok(Revocation::AlreadyGone),
        other => other,
    }
}

fn deregister(api: &ApiClient, config: &Config) -> Value {
    match api.delete(&format!("/machines/{}", config.machine_id)) {
        Ok(()) => json!({ "deregistered": true, "machineId": config.machine_id }),
        Err(error) if error.http_status == Some(404) => json!({
            "deregistered": true,
            "machineId": config.machine_id,
            "detail": "the archive no longer had this machine",
        }),
        Err(error) => json!({
            "deregistered": false,
            "machineId": config.machine_id,
            "detail": error.message,
            "hint": "Remove it in the web app under Settings > Machines.",
        }),
    }
}

/// Ends the browser session `logout` opened to revoke the key, so signing
/// out does not leave a new credential behind. Best effort: it expires anyway.
fn end_session(authority: &ApiClient, account: &Credential) {
    if matches!(account, Credential::Bearer(_)) {
        let _ = authority.post_empty("/auth/logout");
    }
}

fn signed_out(removed: bool, key: Value, machine: Value) -> CommandOutput {
    let revoked = key.get("revoked").and_then(Value::as_bool);
    CommandOutput {
        command: "logout".to_owned(),
        data: json!({
            "signedOut": true,
            "credentialsRemoved": removed,
            "key": key,
            "machine": machine,
            "nextStep": match revoked {
                Some(false) => key_hint(),
                _ => "Run memoar login to sign this computer in again.".to_owned(),
            },
        }),
    }
}
