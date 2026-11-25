//! What the queue does with a row once its upload is settled.

use rusqlite::{OptionalExtension, params};
use std::fs;
use std::path::Path;

use crate::error::DaemonError;
use crate::queue::{OfflineQueue, QueuedArtifact};
use crate::redaction::RedactionConfig;

impl OfflineQueue {
    /// A synced row's copy is deleted at once, unless another waiting row
    /// shares it. Waiting for the end of a long drain kept every uploaded
    /// copy on disk for hours.
    pub(crate) fn drop_copy(&self, artifact: &QueuedArtifact) -> Result<(), DaemonError> {
        let Some(blob) = &artifact.local_path else {
            return Ok(());
        };
        self.connection.execute(
            "UPDATE artifacts SET local_path = '' WHERE sha256 = ?1 AND source_path = ?2",
            params![artifact.sha256, artifact.source_path],
        )?;
        let shared: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM artifacts
                 WHERE sha256 = ?1 AND local_path != '' AND status != 'synced' LIMIT 1",
                [&artifact.sha256],
                |row| row.get(0),
            )
            .optional()?;
        if shared.is_none() {
            let _ = fs::remove_file(blob);
        }
        Ok(())
    }

    /// The source changed since it was hashed. The old row is dropped, as its
    /// bytes no longer exist anywhere, and the file as it is now is queued
    /// under `redaction` when the caller knows it. Without it, the next
    /// capture pass queues the file, with the settings that pass is given.
    pub(crate) fn supersede(
        &self,
        artifact: &QueuedArtifact,
        redaction: Option<RedactionConfig>,
    ) -> Result<bool, DaemonError> {
        self.forget(artifact)?;
        let Some(redaction) = redaction else {
            return Ok(false);
        };
        match self.enqueue_with_redaction(
            &artifact.source,
            Path::new(&artifact.source_path),
            redaction,
        ) {
            Ok(_) => Ok(true),
            Err(error) if error.is_skippable() || matches!(error, DaemonError::Io { .. }) => {
                Ok(false)
            }
            Err(other) => Err(other),
        }
    }

    /// The source is gone and nothing else holds its bytes.
    pub(crate) fn forget(&self, artifact: &QueuedArtifact) -> Result<(), DaemonError> {
        self.connection.execute(
            "DELETE FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
            params![artifact.sha256, artifact.source_path],
        )?;
        Ok(())
    }
}
