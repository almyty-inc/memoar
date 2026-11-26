//! Writing another program's configuration without losing anything in it.
//!
//! Every change is a whole-file replacement through a temporary file and a
//! rename, so an agent reading its config mid-write sees the old file or the
//! new one and never half of each. Before an existing file is changed, its
//! previous bytes are copied beside it under a name that no earlier backup
//! already holds.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::atomic_replace;
use crate::error::AppError;

/// What happened, or with `--dry-run` what would happen, to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Created,
    Updated,
    Unchanged,
    Removed,
    /// Uninstalling found nothing of memoar's to remove.
    Absent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChange {
    pub(crate) path: PathBuf,
    pub(crate) action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) backup: Option<PathBuf>,
}

/// One change, worked out before anything is written. `integrate` plans every
/// file for every agent first, so a file it cannot parse stops the run before
/// any other file was touched.
#[derive(Debug, Clone)]
pub(crate) enum FileOp {
    Write {
        path: PathBuf,
        previous: Option<String>,
        next: String,
        removing: bool,
    },
    /// Deletes a file memoar installed, when it is there.
    Delete { path: PathBuf, present: bool },
}

impl FileOp {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Write { path, .. } | Self::Delete { path, .. } => path,
        }
    }

    pub(crate) fn apply(&self, dry_run: bool) -> Result<FileChange, AppError> {
        match self {
            Self::Write {
                path,
                previous,
                next,
                removing,
            } => replace(path, previous.as_deref(), next, *removing, dry_run),
            Self::Delete { path, present } => {
                if *present && !dry_run {
                    fs::remove_file(path).map_err(|error| {
                        AppError::local(
                            format!("could not remove {}: {error}", path.display()),
                            "Check that the directory is writable by this user.",
                        )
                    })?;
                }
                Ok(FileChange {
                    path: path.clone(),
                    action: if *present {
                        Action::Removed
                    } else {
                        Action::Absent
                    },
                    backup: None,
                })
            }
        }
    }
}

/// The file's text, or `None` when there is no file.
pub(crate) fn read_existing(path: &Path) -> Result<Option<String>, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::local(
            format!("could not read {}: {error}", path.display()),
            "Check that the file is readable by this user.",
        )),
    }
}

/// Replaces `path` with `next` unless it already says exactly that.
///
/// `removing` only changes how a change is named in the report: taking
/// memoar's entry out of a file is a removal even though the file stays.
pub(crate) fn replace(
    path: &Path,
    previous: Option<&str>,
    next: &str,
    removing: bool,
    dry_run: bool,
) -> Result<FileChange, AppError> {
    let action = match previous {
        Some(text) if text == next => Action::Unchanged,
        Some(_) if removing => Action::Removed,
        Some(_) => Action::Updated,
        None => Action::Created,
    };
    let mut change = FileChange {
        path: path.to_owned(),
        action,
        backup: None,
    };
    if dry_run || action == Action::Unchanged {
        return Ok(change);
    }
    // A config kept in a dotfiles repository is often a symlink. Renaming over
    // the link would replace it with a plain file and cut it loose from the
    // repository, so the write goes to what the link points at.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if let Some(text) = previous {
        let backup = free_backup_path(&target);
        fs::write(&backup, text).map_err(|error| {
            AppError::local(
                format!("could not back up {}: {error}", target.display()),
                "Nothing was changed. Check that the directory is writable.",
            )
        })?;
        change.backup = Some(backup);
    }
    atomic_replace(&target, next.as_bytes(), existing_mode(&target))?;
    Ok(change)
}

/// `name.memoar-backup`, or the first `name.memoar-backup-N` that is free, so
/// a second run never overwrites the copy the first one made.
fn free_backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut candidate = path.with_file_name(format!("{name}.memoar-backup"));
    let mut index = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{name}.memoar-backup-{index}"));
        index += 1;
    }
    candidate
}

/// The mode a replaced file keeps. A new file is owner-only, because some of
/// these files hold other servers' tokens.
fn existing_mode(path: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            return metadata.permissions().mode() & 0o777;
        }
    }
    let _ = path;
    0o600
}
