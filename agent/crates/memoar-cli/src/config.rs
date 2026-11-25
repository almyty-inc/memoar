use memoar_daemon::RedactionConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::args::Cli;
use crate::credential::{Credential, CredentialStore, FileCredentialStore};
use crate::dirs::{Platform, default_dirs};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    /// The contract of the client that last wrote this file. A record, not a
    /// setting: `save_config` stamps the running client's contract on every
    /// write, and nothing decides anything by it.
    ///
    /// `doctor` used to compare it with the client's own contract. Nothing
    /// rewrote it on upgrade, so every upgraded install failed that check for
    /// good, while the comparison that matters, this client against the
    /// archive it downloads bundles from, went unchecked. It is still written
    /// so an older client can read a config a newer one saved, and read
    /// leniently so a file without it still loads.
    #[serde(default)]
    pub(crate) contract_version: String,
    pub(crate) endpoint: String,
    pub(crate) machine_id: String,
    /// Which installation of the agent this config directory is.
    ///
    /// Generated once, on the first `login` that writes this file, and carried
    /// forward by every later one. It is what lets the archive recognise a
    /// re-registration as the machine it already has, without the server
    /// guessing from a hostname that half the fleet reports as the same
    /// fallback string.
    ///
    /// Empty when the file was written by an agent from before this existed.
    #[serde(default)]
    pub(crate) installation_id: String,
    pub(crate) disabled_sources: BTreeSet<String>,
    #[serde(default)]
    pub(crate) redaction: RedactionConfig,
    /// How far back capture reaches, which projects it leaves out, and the
    /// free space it keeps. Absent from a file written before it existed.
    #[serde(default, skip_serializing_if = "CaptureSettings::is_default")]
    pub(crate) capture: CaptureSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureSettings {
    /// `all`, a date, an instant, or a duration such as `90d`. Unset means
    /// the default first-run window. See `capture_policy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) since: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) include: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) exclude: Vec<String>,
    /// An exact free-space floor in bytes, in place of the default rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) min_free_bytes: Option<u64>,
}

impl CaptureSettings {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

impl RuntimePaths {
    pub fn resolve(cli: &Cli) -> Result<Self, AppError> {
        // Asked for only when a directory was left to default, so a run that
        // names all three works in an environment without HOME or USERPROFILE,
        // a service account or a scrubbed CI step.
        let user_home = || user_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"));
        let home = match &cli.capture_home {
            Some(home) => home.clone(),
            None => user_home()?,
        };
        let (config_dir, data_dir) = match (&cli.config_dir, &cli.data_dir) {
            (Some(config), Some(data)) => (config.clone(), data.clone()),
            (config, data) => {
                let (default_config, default_data) =
                    default_dirs(&user_home()?, Platform::current(), |name| {
                        std::env::var_os(name)
                    });
                (
                    config.clone().unwrap_or(default_config),
                    data.clone().unwrap_or(default_data),
                )
            }
        };
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
    let config = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::damaged(&path, &error.to_string()))?;
    Ok(Some(config))
}

pub(crate) fn save_config(paths: &RuntimePaths, config: &Config) -> Result<(), AppError> {
    // Whatever the caller loaded, the file is now written by this client.
    let stamped = Config {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        ..config.clone()
    };
    let bytes = serde_json::to_vec_pretty(&stamped)
        .map_err(|error| AppError::internal(error.to_string()))?;
    atomic_replace(&paths.config_file(), &bytes, 0o600)
}

/// Creates a directory, and any parent it needs, readable by its owner only.
///
/// Only a directory this creates: one that exists keeps its permissions,
/// because `--config-dir` and `--data-dir` may name a directory somebody chose.
/// On Windows a new directory inherits the profile ACL, which already admits
/// only the user.
pub(crate) fn create_private_dir(path: &Path) -> Result<(), AppError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        AppError::internal(format!("could not create {}: {error}", path.display()))
    })
}
pub(crate) fn atomic_replace(path: &Path, bytes: &[u8], unix_mode: u32) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("{} has no parent", path.display())))?;
    // Owner-only when this creates it: the directory holds the credential.
    create_private_dir(parent)?;
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

/// The user's home directory, however this platform chooses to name it.
///
/// Windows has no `HOME`. It has `USERPROFILE`, and reading only `HOME` meant
/// every command on that platform ended with "not initialized" before doing
/// anything — `capabilities` and `introspect` included, which touch no disk at
/// all. The launcher ships a Windows binary, so `npx memoar` there had never
/// worked.
///
/// `HOME` still wins where it is set, so pointing it somewhere deliberately
/// keeps working on any platform.
///
/// Takes the values rather than reading the environment, because a test that
/// sets process-wide environment variables races every other test in the
/// binary.
pub(crate) fn user_home(
    home: Option<OsString>,
    user_profile: Option<OsString>,
) -> Result<PathBuf, AppError> {
    // Each is emptied before the choice, not after: an empty HOME must fall
    // through to USERPROFILE rather than short-circuit the fallback and then be
    // rejected. An empty value is not a home directory — taken literally it
    // resolves every path to the filesystem root.
    let usable = |value: OsString| (!value.is_empty()).then_some(value);
    home.and_then(usable)
        .or_else(|| user_profile.and_then(usable))
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::usage(
                "neither HOME nor USERPROFILE is set, so there is no home directory to work in. Set one, or pass --config-dir, --data-dir and --capture-home.",
            )
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
