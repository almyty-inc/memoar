//! How the mock archive answers `DELETE /auth/api-keys/{id}` from an API key.

use serde_json::{Value, json};

/// The keys the mock archive knows, by id, with the prefix of each secret.
const KEYS: &[(&str, &str)] = &[
    ("key-old", "memoar_old-key"),
    ("key-by-hand", "memoar_by-hand"),
    ("key-1", "memoar_test-capture-key"),
];

/// A key may revoke itself. Any other id answers 404, the same as an unknown
/// one, because the key does not hold keys:write. An older archive refused
/// even that with 403.
pub(crate) fn key_deleting(
    path: &str,
    headers: &str,
    refuse_self_revocation: bool,
) -> (u16, Value) {
    if refuse_self_revocation {
        return (
            403,
            json!({"title": "Forbidden", "detail": "Missing required scope: keys:write"}),
        );
    }
    let id = path.trim_start_matches("/v1/auth/api-keys/");
    let secret = headers
        .lines()
        .find_map(|line| line.strip_prefix("x-memoar-key:"))
        .map(str::trim)
        .unwrap_or_default();
    let own = KEYS
        .iter()
        .any(|(key, prefix)| *key == id && secret.starts_with(prefix));
    if own {
        (200, json!({}))
    } else {
        (
            404,
            json!({"title": "Not Found", "detail": "API key not found"}),
        )
    }
}
