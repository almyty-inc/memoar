use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::atomic_replace;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    /// A long-lived, revocable API key scoped to what the agent actually does.
    /// What `login` mints and stores now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// A user access token. What older installs stored, and what `--token`
    /// accepts when it is handed one. It expires in an hour, which is why it is
    /// no longer what `login` writes.
    #[serde(default)]
    access_token: String,
}

/// How the agent proves who it is.
///
/// `login` used to store the browser access token, which the server issues with
/// a one-hour lifetime and no refresh. Every command then depended on it, so
/// `sync --watch` — a command whose entire purpose is to keep running —
/// stopped working after an hour and could only be revived by typing a
/// password again. An API key has no expiry, is revocable from the account, and
/// carries only the scopes the agent needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    ApiKey(String),
    Bearer(String),
}

/// The prefix the server puts on every API key it mints, which is what lets a
/// secret handed to `--token` be classified without asking the user which kind
/// they pasted.
const API_KEY_PREFIX: &str = "memoar_";

impl Credential {
    pub(crate) fn classify(secret: &str) -> Self {
        if secret.starts_with(API_KEY_PREFIX) {
            Self::ApiKey(secret.to_owned())
        } else {
            Self::Bearer(secret.to_owned())
        }
    }

    pub(crate) fn secret(&self) -> &str {
        match self {
            Self::ApiKey(secret) | Self::Bearer(secret) => secret,
        }
    }
}

/// The scopes `login` asks for, and no others.
///
/// Deliberately short of what a browser token carries: no `sharing:write`, no
/// `keys:write`, no `mcp:use`. The agent captures, uploads, keeps its machine
/// record current, and reads back what it archived. It has never needed the
/// power to share a session, mint another credential, or act as an MCP client,
/// and a credential that sits on a laptop indefinitely should not hold rights
/// nothing on that laptop exercises.
pub(crate) const CAPTURE_SCOPES: [&str; 5] = [
    "archive:read",
    "archive:write",
    "ingest:write",
    "machines:write",
    "materialize:read",
];

pub trait CredentialStore {
    fn load(&self) -> Result<Option<Credential>, AppError>;
    fn store(&self, credential: &Credential) -> Result<(), AppError>;
}

#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    path: PathBuf,
}

impl FileCredentialStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl CredentialStore for FileCredentialStore {
    /// An API key wins over an access token when both are present, which is what
    /// an install written before the key existed looks like after its next
    /// `login`. The old token is left in place rather than deleted so that
    /// rolling back to an older agent does not lock the machine out.
    fn load(&self) -> Result<Option<Credential>, AppError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(|error| {
            AppError::internal(format!("could not read {}: {error}", self.path.display()))
        })?;
        let credentials: Credentials = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::internal(format!(
                "invalid credentials {}: {error}",
                self.path.display()
            ))
        })?;
        if let Some(key) = credentials.api_key.filter(|key| !key.is_empty()) {
            return Ok(Some(Credential::ApiKey(key)));
        }
        if credentials.access_token.is_empty() {
            return Ok(None);
        }
        Ok(Some(Credential::Bearer(credentials.access_token)))
    }

    fn store(&self, credential: &Credential) -> Result<(), AppError> {
        if credential.secret().is_empty() {
            return Err(AppError::usage("credential cannot be empty"));
        }
        let credentials = match credential {
            Credential::ApiKey(secret) => Credentials {
                api_key: Some(secret.clone()),
                access_token: String::new(),
            },
            Credential::Bearer(secret) => Credentials {
                api_key: None,
                access_token: secret.clone(),
            },
        };
        let bytes = serde_json::to_vec(&credentials)
            .map_err(|error| AppError::internal(error.to_string()))?;
        atomic_replace(&self.path, &bytes, 0o600)
    }
}
