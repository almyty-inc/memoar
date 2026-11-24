//! Taking back the API key `login` left on this computer.
//!
//! `login` mints a capture key and stores it. Nothing ever revoked one: a
//! second `login` minted another and left the first live, and deregistering
//! the machine in the web app took its machine tokens and left its key. A key
//! sitting in a file on a laptop that was handed back is the credential most
//! worth revoking, and it was the one nothing touched.
//!
//! Revoking needs `keys:write`, which the capture key deliberately lacks, so
//! this is done with whatever account credential is at hand: the password
//! session `login` already opened, or one `logout` is given.

use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::error::AppError;

/// What revoking a key came to, short of an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Revocation {
    Revoked,
    /// The archive had no such key: the same outcome as revoking it.
    AlreadyGone,
    /// A key somebody created by hand and handed to `login --token`. It may
    /// be in use elsewhere, an MCP client or a script, so signing this
    /// computer out does not revoke it.
    NotMinted,
}

/// What became of a key this machine asked the archive to revoke.
pub(crate) fn revocation_report(outcome: Result<Revocation, AppError>) -> Value {
    match outcome {
        Ok(Revocation::Revoked) => json!({ "revoked": true }),
        Ok(Revocation::AlreadyGone) => {
            json!({ "revoked": true, "detail": "the archive no longer had this key" })
        }
        Ok(Revocation::NotMinted) => json!({
            "revoked": false,
            "detail": "this key was not created by memoar login, so it may be in use elsewhere and was left alone",
            "hint": "Revoke it in the web app under Settings > API keys if nothing else uses it.",
        }),
        Err(error) => json!({
            "revoked": false,
            "detail": error.message,
            "hint": key_hint(),
        }),
    }
}

/// Where a key this command could not revoke can still be revoked.
///
/// The local copy is already gone by the time anybody reads this, so the web
/// app is the way, and the key is named the way `login` named it.
pub(crate) fn key_hint() -> String {
    format!(
        "The key still works on the archive. Revoke it in the web app under Settings > API keys, where it is named \"{MINTED_KEY_NAME} · {}\". Next time, memoar logout --email <you> --password - revokes it in the same step.",
        crate::machine::machine_name()
    )
}

/// The name `login` gives every key it mints, before the machine name.
pub(crate) const MINTED_KEY_NAME: &str = "memoar agent";

/// Revokes the key whose secret is `secret`.
///
/// `key_id` is what `login` recorded, and only a key `login` minted has one.
/// A key stored by an older agent has none, and is found in the account's
/// key list by the prefix the archive keeps of every secret it issues. It is
/// revoked only when its name says `login` minted it.
pub(crate) fn revoke_key(
    authority: &ApiClient,
    secret: &str,
    key_id: Option<&str>,
) -> Result<Revocation, AppError> {
    let id = match key_id {
        Some(id) => id.to_owned(),
        None => match find_key(authority, secret)? {
            None => return Ok(Revocation::AlreadyGone),
            Some((_, name)) if !name.starts_with(MINTED_KEY_NAME) => {
                return Ok(Revocation::NotMinted);
            }
            Some((id, _)) => id,
        },
    };
    match authority.delete(&format!("/auth/api-keys/{id}")) {
        Ok(()) => Ok(Revocation::Revoked),
        Err(error) if error.http_status == Some(404) => Ok(Revocation::AlreadyGone),
        Err(error) => Err(error),
    }
}

/// The id and name of the account key whose secret this is.
fn find_key(authority: &ApiClient, secret: &str) -> Result<Option<(String, String)>, AppError> {
    let keys = authority.get("/auth/api-keys")?;
    let text = |key: &Value, field: &str| {
        key.get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Ok(keys
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|key| {
            let prefix = text(key, "prefix");
            !prefix.is_empty() && secret.starts_with(&prefix)
        })
        .map(|key| (text(key, "id"), text(key, "name"))))
}
