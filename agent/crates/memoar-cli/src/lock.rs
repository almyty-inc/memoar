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
use std::io::{Read, Seek, SeekFrom, Write};

use crate::config::RuntimePaths;
use crate::error::AppError;

/// Held for as long as the sync runs. Dropping it releases the lock.
pub(crate) struct SyncLock {
    _file: File,
}

pub(crate) fn acquire_sync_lock(paths: &RuntimePaths) -> Result<SyncLock, AppError> {
    let path = paths.data_dir.join("sync.lock");
    crate::config::create_private_dir(&paths.data_dir)?;
    let mut file = OpenOptions::new()
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
            let mut holder = String::new();
            let _ = file.read_to_string(&mut holder);
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
    // Who holds it, for the message the next one prints. Best effort: the
    // lock is what matters, not this note.
    let _ = file.set_len(0);
    let _ = file.seek(SeekFrom::Start(0));
    let _ = write!(file, "{}", std::process::id());
    let _ = file.flush();
    Ok(SyncLock { _file: file })
}
