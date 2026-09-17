use memoar_daemon::RedactionConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::args::Cli;
use crate::credential::{Credential, CredentialStore, FileCredentialStore};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    pub(crate) contract_version: String,
    pub(crate) endpoint: String,
    pub(crate) machine_id: String,
    pub(crate) disabled_sources: BTreeSet<String>,
    #[serde(default)]
    pub(crate) redaction: RedactionConfig,
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

impl RuntimePaths {
    pub fn resolve(cli: &Cli) -> Result<Self, AppError> {
        let user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(AppError::not_initialized)?;
        let home = cli
            .capture_home
            .clone()
            .unwrap_or_else(|| user_home.clone());
        let config_dir = cli
            .config_dir
            .clone()
            .unwrap_or_else(|| user_home.join(".config/memoar"));
        let data_dir = cli
            .data_dir
            .clone()
            .unwrap_or_else(|| user_home.join(".local/share/memoar"));
        Ok(Self {
            config_dir,
            data_dir,
            home,
        })
    }

    pub(crate) fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }

    pub(crate) fn credentials_file(&self) -> PathBuf {
        self.config_dir.join("credentials.json")
    }

    pub(crate) fn queue_file(&self) -> PathBuf {
        self.data_dir.join("queue.sqlite3")
    }

    pub(crate) fn credential_store(&self) -> FileCredentialStore {
        FileCredentialStore::new(self.credentials_file())
    }
}

pub(crate) fn authenticated_config(paths: &RuntimePaths) -> Result<(Config, Credential), AppError> {
    Ok((load_config(paths)?, load_credential(paths)?))
}

pub(crate) fn load_credential(paths: &RuntimePaths) -> Result<Credential, AppError> {
    paths
        .credential_store()
        .load()?
        .ok_or_else(AppError::not_initialized)
}

pub(crate) fn load_config(paths: &RuntimePaths) -> Result<Config, AppError> {
    load_config_optional(paths)?.ok_or_else(AppError::not_initialized)
}

pub(crate) fn load_config_optional(paths: &RuntimePaths) -> Result<Option<Config>, AppError> {
    let path = paths.config_file();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| {
        AppError::internal(format!("could not read {}: {error}", path.display()))
    })?;
    let config = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::internal(format!("invalid config {}: {error}", path.display()))
    })?;
    Ok(Some(config))
}

pub(crate) fn save_config(paths: &RuntimePaths, config: &Config) -> Result<(), AppError> {
    let bytes =
        serde_json::to_vec_pretty(config).map_err(|error| AppError::internal(error.to_string()))?;
    atomic_replace(&paths.config_file(), &bytes, 0o600)
}

pub(crate) fn atomic_replace(path: &Path, bytes: &[u8], unix_mode: u32) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("{} has no parent", path.display())))?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::internal(format!("could not create {}: {error}", parent.display()))
    })?;
    let temporary = parent.join(format!(".memoar-{}.tmp", Uuid::now_v7()));
    let result = (|| -> Result<(), std::io::Error> {
        let mut file = create_private(&temporary, unix_mode)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            // umask can only clear bits, never add them, so this cannot loosen
            // the file. It pins the exact mode when a restrictive umask would
            // otherwise have dropped a bit the caller asked for.
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(unix_mode))?;
        }
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| {
        AppError::internal(format!("could not replace {}: {error}", path.display()))
    })
}

/// Creates a file that has its final permissions from the moment it exists.
///
/// The access token used to be written into a temporary file opened with the
/// default umask — world-readable on a typical machine — and only chmod'ed to
/// 0600 after the bytes had been written and flushed. Any local process could
/// read the token during that window. The mode has to be part of the open, not
/// a correction applied afterwards.
#[cfg(unix)]
pub(crate) fn create_private(path: &Path, unix_mode: u32) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(unix_mode)
        .open(path)
}

#[cfg(not(unix))]
pub(crate) fn create_private(path: &Path, _unix_mode: u32) -> std::io::Result<File> {
    OpenOptions::new().create_new(true).write(true).open(path)
}
