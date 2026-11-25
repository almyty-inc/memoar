//! The private copies the queue still keeps, and giving the space back.
//!
//! A copy is kept until its row is synced and deleted after. Queues written by
//! an older agent copied every artifact, so this also releases those copies
//! whose source file is still exactly as it was captured: the upload reads the
//! source and checks its hash, the same as for a row queued today.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

use crate::enqueue::{modified_at, must_snapshot};
use crate::error::DaemonError;
use crate::queue::OfflineQueue;

/// A temporary file older than this was left by a capture that died.
const STALE_TEMPORARY: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    /// Rows now read from their source instead of a copy.
    pub released: u64,
    /// Copies deleted, and the bytes they held.
    pub removed: u64,
    pub removed_bytes: u64,
}

impl OfflineQueue {
    /// Deletes every copy no waiting row needs.
    pub fn prune_blobs(&self) -> Result<PruneReport, DaemonError> {
        let mut report = PruneReport {
            released: self.release_reproducible()?,
            ..PruneReport::default()
        };
        self.connection.execute(
            "UPDATE artifacts SET local_path = '' WHERE status = 'synced' AND local_path != ''",
            [],
        )?;
        let Ok(entries) = fs::read_dir(&self.blob_dir) else {
            return Ok(report);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() || !self.removable(&path, &metadata)? {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                report.removed += 1;
                report.removed_bytes += metadata.len();
            }
        }
        Ok(report)
    }

    fn removable(&self, path: &Path, metadata: &fs::Metadata) -> Result<bool, DaemonError> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.contains(".tmp-") {
            let age = metadata
                .modified()
                .ok()
                .and_then(|at| SystemTime::now().duration_since(at).ok())
                .unwrap_or_default();
            return Ok(age > STALE_TEMPORARY);
        }
        // A copy is named by the hash of its bytes, which is the row's hash.
        // Matched on the hash rather than the stored path, because a path
        // written under a differently spelled data directory would not match
        // and the copy would be deleted from under a row that needs it.
        let needed: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM artifacts WHERE sha256 = ?1 AND local_path != '' LIMIT 1",
                [&name],
                |row| row.get(0),
            )
            .optional()?;
        Ok(needed.is_none())
    }

    /// Unredacted rows with a copy whose source still has the size and
    /// modification time it was captured with stop pointing at the copy.
    fn release_reproducible(&self) -> Result<u64, DaemonError> {
        let rows: Vec<(String, String, i64, String)> = {
            let mut statement = self.connection.prepare(
                "SELECT sha256, source_path, size, modified_at FROM artifacts
                 WHERE local_path != '' AND redacted = 0 AND status != 'synced'",
            )?;
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<_, _>>()?
        };
        let mut released = 0;
        self.batch(|| {
            for (sha256, source_path, size, recorded) in &rows {
                let source = Path::new(source_path);
                if must_snapshot(source) {
                    continue;
                }
                let Ok(metadata) = fs::metadata(source) else {
                    continue;
                };
                if metadata.len() as i64 != *size || modified_at(&metadata) != *recorded {
                    continue;
                }
                released += self.connection.execute(
                    "UPDATE artifacts SET local_path = '' WHERE sha256 = ?1 AND source_path = ?2",
                    params![sha256, source_path],
                )? as u64;
            }
            Ok(())
        })?;
        Ok(released)
    }
}

pub(crate) fn write_blob_once(path: &Path, bytes: &[u8]) -> Result<(), DaemonError> {
    if path.exists() {
        let existing = fs::read(path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if existing == bytes {
            return Ok(());
        }
        return Err(DaemonError::Protocol(format!(
            "content-addressed blob collision at {}",
            path.display()
        )));
    }
    let temp = path.with_extension(format!("tmp-{}", Uuid::now_v7()));
    let result = (|| -> Result<(), DaemonError> {
        let io = |source| DaemonError::Io {
            path: temp.clone(),
            source,
        };
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(io)?;
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        fs::rename(&temp, path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
