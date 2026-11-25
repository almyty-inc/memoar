//! One sync at a time per data directory.
//!
//! Two `memoar sync` runs against the same queue both read the same pending
//! rows, both uploaded them, and both declared them in a manifest: every
//! artifact went over the wire twice, and a `sync --watch` started twice (a
//! login item and a terminal) did that on every cycle. SQLite's own locking
//! keeps the file consistent and does nothing about the duplicated work.
//!
//! The lock is an OS file lock, so it is released when the process ends
//! however it ends, a crash or Ctrl-C included, and a stale lock file left
//! behind locks nothing.

use std::fs::{File, OpenOptions, TryLockError};

use crate::config::RuntimePaths;
use crate::error::AppError;

/// Held for as long as the sync runs. Dropping it releases the lock.
pub(crate) struct SyncLock {
    _file: File,
}

pub(crate) fn acquire_sync_lock(paths: &RuntimePaths) -> Result<SyncLock, AppError> {
    let path = paths.data_dir.join("sync.lock");
    let holder_path = paths.data_dir.join("sync.pid");
    crate::config::create_private_dir(&paths.data_dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| {
            AppError::internal(format!("could not open {}: {error}", path.display()))
        })?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            let holder = std::fs::read_to_string(&holder_path).unwrap_or_default();
            let holder = holder.trim();
            let mut error = AppError::locked(if holder.is_empty() {
                "another memoar sync is already running with this data directory".to_owned()
            } else {
                format!(
                    "another memoar sync (process {holder}) is already running with this data directory"
                )
            });
            error.hint = "Wait for it to finish, or stop it if it is a sync --watch, then retry. It is uploading the same queue, so nothing is lost by waiting.".to_owned();
            return Err(error);
        }
        Err(TryLockError::Error(error)) => {
            return Err(AppError::internal(format!(
                "could not lock {}: {error}",
                path.display()
            )));
        }
    }
    // Who holds it, for the message the next one prints, in a file of its
    // own: Windows locks the bytes of a locked file against other handles,
    // so a note inside `sync.lock` could not be read by the process that
    // needs it. Best effort, and only read while the lock is held.
    let _ = std::fs::write(&holder_path, std::process::id().to_string());
    Ok(SyncLock { _file: file })
}

/// Whether some process holds the sync lock now, and its process id when it
/// wrote one. This is how `status` knows a watch is alive without trusting a
/// file that a killed process could not clean up.
///
/// The probe takes the lock for as long as one system call, and lets go.
pub(crate) fn sync_holder(paths: &RuntimePaths) -> Option<Option<u32>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(paths.data_dir.join("sync.lock"))
        .ok()?;
    match file.try_lock() {
        Ok(()) => None,
        Err(TryLockError::WouldBlock) => Some(
            std::fs::read_to_string(paths.data_dir.join("sync.pid"))
                .ok()
                .and_then(|text| text.trim().parse().ok()),
        ),
        Err(TryLockError::Error(_)) => None,
    }
}
