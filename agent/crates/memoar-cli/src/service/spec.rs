//! What a service runs, and the note it leaves in the data directory.
//!
//! The service is written with absolute paths for the binary and all three
//! directories, so it does not depend on the environment the service manager
//! starts it in. launchd and Task Scheduler start a program with almost no
//! environment, and a `HOME` or `XDG_CONFIG_HOME` that differs from the
//! shell's would point the watch at a configuration nobody signed in.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{RuntimePaths, atomic_replace};
use crate::error::AppError;

pub(crate) const DEFAULT_NAME: &str = "agent";

/// Everything a platform needs to write its definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServiceSpec {
    pub(crate) name: String,
    pub(crate) program: PathBuf,
    /// Arguments after the program.
    pub(crate) arguments: Vec<String>,
    pub(crate) data_dir: PathBuf,
    pub(crate) log_dir: PathBuf,
}

impl ServiceSpec {
    pub(crate) fn new(name: &str, program: &Path, paths: &RuntimePaths) -> Result<Self, AppError> {
        let absolute = absolute_paths(paths)?;
        let mut arguments = vec![
            "service".to_owned(),
            "run".to_owned(),
            "--name".to_owned(),
            name.to_owned(),
        ];
        arguments.extend(directory_arguments(&absolute)?);
        Ok(Self {
            name: name.to_owned(),
            program: program.to_path_buf(),
            arguments,
            data_dir: absolute.data_dir.clone(),
            log_dir: log_dir(&absolute),
        })
    }

    pub(crate) fn program_text(&self) -> Result<String, AppError> {
        utf8(&self.program)
    }
}

/// `--config-dir`, `--data-dir` and `--capture-home`, absolute.
pub(crate) fn directory_arguments(paths: &RuntimePaths) -> Result<Vec<String>, AppError> {
    Ok(vec![
        "--config-dir".to_owned(),
        utf8(&paths.config_dir)?,
        "--data-dir".to_owned(),
        utf8(&paths.data_dir)?,
        "--capture-home".to_owned(),
        utf8(&paths.home)?,
    ])
}

pub(crate) fn absolute_paths(paths: &RuntimePaths) -> Result<RuntimePaths, AppError> {
    let absolute = |path: &Path| {
        std::path::absolute(path).map_err(|error| {
            AppError::local(
                format!("could not resolve {}: {error}", path.display()),
                "Pass absolute --config-dir, --data-dir and --capture-home paths.",
            )
        })
    };
    Ok(RuntimePaths {
        config_dir: absolute(&paths.config_dir)?,
        data_dir: absolute(&paths.data_dir)?,
        home: absolute(&paths.home)?,
    })
}

pub(crate) fn log_dir(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("logs")
}

pub(crate) fn log_file(paths: &RuntimePaths) -> PathBuf {
    log_dir(paths).join("agent.log")
}

fn utf8(path: &Path) -> Result<String, AppError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        AppError::local(
            format!("{} is not valid UTF-8", path.display()),
            "Service definitions are text. Use a directory whose path is valid UTF-8.",
        )
    })
}

/// A service name: lower-case letters, digits and dashes, so it is the same
/// string in a launchd label, a systemd unit name and a task path.
pub(crate) fn validate_name(name: &str) -> Result<String, AppError> {
    let valid = !name.is_empty()
        && name.len() <= 40
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(name.to_owned())
    } else {
        Err(AppError::usage(format!(
            "{name:?} is not a service name: use up to 40 lower-case letters, digits and dashes"
        )))
    }
}

/// The binary the service should start, as an absolute path that survives an
/// upgrade.
///
/// `current_exe` resolves symlinks on Linux, and a Homebrew install is a
/// symlink into a versioned Cellar directory that the next upgrade deletes.
/// So the path this was invoked by wins when it names the same file, and the
/// resolved one is only the fallback.
pub(crate) fn current_program() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe().map_err(|error| {
        AppError::internal(format!("could not find this program's path: {error}"))
    })?;
    let resolved = exe.canonicalize().unwrap_or_else(|_| exe.clone());
    let invoked = std::env::args_os().next().map(PathBuf::from);
    let candidate = invoked.and_then(|invoked| {
        if invoked.components().count() > 1 {
            std::path::absolute(&invoked).ok()
        } else {
            search_path(&invoked)
        }
    });
    match candidate {
        Some(candidate) if candidate.canonicalize().ok().as_ref() == Some(&resolved) => {
            Ok(candidate)
        }
        _ => Ok(exe),
    }
}

fn search_path(name: &Path) -> Option<PathBuf> {
    let mut names = vec![name.to_path_buf()];
    if cfg!(windows) && name.extension().is_none() {
        names.push(name.with_extension("exe"));
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|directory| directory.is_absolute())
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Written beside the queue when a service is installed for it, so `status`,
/// `logout` and `uninstall` know there is one without being told its name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceRecord {
    pub(crate) name: String,
    pub(crate) manager: String,
    pub(crate) definition: String,
    pub(crate) program: PathBuf,
    pub(crate) installed_at: DateTime<Utc>,
}

fn record_file(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("service.json")
}

pub(crate) fn load_record(paths: &RuntimePaths) -> Option<ServiceRecord> {
    serde_json::from_slice(&fs::read(record_file(paths)).ok()?).ok()
}

pub(crate) fn save_record(paths: &RuntimePaths, record: &ServiceRecord) -> Result<(), AppError> {
    let bytes =
        serde_json::to_vec_pretty(record).map_err(|error| AppError::internal(error.to_string()))?;
    atomic_replace(&record_file(paths), &bytes, 0o600)
}

pub(crate) fn remove_record(paths: &RuntimePaths) {
    let _ = fs::remove_file(record_file(paths));
}

/// A note for a binary that an upgrade will not replace.
pub(crate) fn program_note(program: &Path) -> Option<String> {
    let text = program.to_string_lossy().replace('\\', "/");
    (text.contains("/.cache/memoar/") || text.contains("/memoar/Cache/")).then(|| {
        format!(
            "{} is the npm launcher's cached copy of one release. The service keeps running that release after an upgrade. Install the standalone binary and run `memoar service install` again to follow upgrades.",
            program.display()
        )
    })
}
