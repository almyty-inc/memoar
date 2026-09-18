//! What the queue offers next, and what a refusal costs the artifact that drew it.

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use std::path::PathBuf;
use std::time::Duration;

use crate::error::DaemonError;
use crate::queue::{OfflineQueue, QueueCounts, QueueStatus, QueuedArtifact};

/// How many times one artifact is offered to the server before the queue stops
/// offering it.
///
/// An artifact the server will never accept — the wrong shape, past a limit the
/// ingress enforces and the agent does not — is not made acceptable by a ninth
/// try. Counting the attempts was already being done; this is the number that
/// was missing.
pub const MAX_ATTEMPTS: u32 = 8;

/// The wait after the first failure, doubled each time up to `MAX_RETRY_BACKOFF`.
const RETRY_BACKOFF: Duration = Duration::from_secs(60);

/// A ceiling on the doubling: an artifact that fails all day should still be
/// tried tomorrow morning without waiting a week for it.
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(6 * 60 * 60);

/// How long an artifact waits after its `attempts`-th failure.
fn retry_delay(attempts: u32) -> Duration {
    let doublings = attempts.saturating_sub(1).min(16);
    RETRY_BACKOFF
        .saturating_mul(1_u32 << doublings)
        .min(MAX_RETRY_BACKOFF)
}

impl OfflineQueue {
    pub fn pending(&self, limit: usize) -> Result<Vec<QueuedArtifact>, DaemonError> {
        self.pending_at(limit, Utc::now())
    }

    /// What this pass may try, as of a given instant.
    ///
    /// Three things were missing here and they composed into one failure.
    /// `attempts` was incremented and never read, so nothing ever gave up.
    /// `mark_retry` left `queued_at` alone, so a rejected artifact kept the
    /// oldest timestamp in the table. And the order was `queued_at ASC` with a
    /// limit of 256. Two hundred and fifty-six artifacts the server would never
    /// accept therefore sat at the head of the queue forever, were re-offered
    /// in full on every single pass, and no session captured afterwards was
    /// ever looked at again.
    ///
    /// So: artifacts past the cap are done being tried, a failed artifact waits
    /// out its backoff, and what has failed least goes first — a fresh capture
    /// can never queue behind something that has already been refused.
    pub fn pending_at(
        &self,
        limit: usize,
        now: DateTime<Utc>,
    ) -> Result<Vec<QueuedArtifact>, DaemonError> {
        let mut statement = self.connection.prepare(
            "SELECT sha256, size, source, source_path, local_path, modified_at,
                    status, attempts, last_error, redacted, redaction_count
             FROM artifacts
             WHERE status IN ('pending', 'retry')
               AND attempts < ?2
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
             ORDER BY attempts ASC, queued_at ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(
            params![limit as i64, MAX_ATTEMPTS, now.to_rfc3339()],
            row_to_artifact,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Artifacts that have used up every attempt they are going to get.
    pub fn abandoned(&self) -> Result<u64, DaemonError> {
        let value: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM artifacts WHERE status != 'synced' AND attempts >= ?1",
            [MAX_ATTEMPTS],
            |row| row.get(0),
        )?;
        Ok(value.max(0) as u64)
    }

    pub fn counts(&self) -> Result<QueueCounts, DaemonError> {
        // SQLite integers are signed, and rusqlite 0.40 stopped pretending
        // otherwise. A row count cannot be negative, so the conversion is
        // stated here rather than implied by a type that never fitted.
        let count = |status: &str| -> Result<u64, rusqlite::Error> {
            let value: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM artifacts WHERE status = ?1",
                [status],
                |row| row.get(0),
            )?;
            Ok(value.max(0) as u64)
        };
        Ok(QueueCounts {
            pending: count("pending")?,
            retry: count("retry")?,
            synced: count("synced")?,
        })
    }

    /// Identified by the whole primary key, never by the hash alone.
    ///
    /// The same bytes reached from two places are two rows — the archive wants
    /// both source paths, because where a transcript was found is part of what
    /// it is. Keying on `sha256` alone marked every one of those rows synced
    /// off the back of one upload, and the provenance of the others was never
    /// sent at all.
    pub fn mark_synced(&self, sha256: &str, source_path: &str) -> Result<(), DaemonError> {
        self.connection.execute(
            "UPDATE artifacts SET status = 'synced', synced_at = ?3, last_error = NULL
             WHERE sha256 = ?1 AND source_path = ?2",
            params![sha256, source_path, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn mark_retry(
        &self,
        sha256: &str,
        source_path: &str,
        message: &str,
    ) -> Result<(), DaemonError> {
        let previous: i64 = self
            .connection
            .query_row(
                "SELECT attempts FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
                params![sha256, source_path],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let attempts = (previous.max(0) as u32).saturating_add(1);
        let delay = chrono::Duration::from_std(retry_delay(attempts))
            .unwrap_or_else(|_| chrono::Duration::zero());
        self.connection.execute(
            "UPDATE artifacts
             SET status = 'retry', attempts = ?3, last_error = ?4, next_attempt_at = ?5
             WHERE sha256 = ?1 AND source_path = ?2",
            params![
                sha256,
                source_path,
                attempts,
                message,
                (Utc::now() + delay).to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn mark_retry_all(
        &self,
        artifacts: &[QueuedArtifact],
        message: &str,
    ) -> Result<(), DaemonError> {
        for artifact in artifacts {
            self.mark_retry(&artifact.sha256, &artifact.source_path, message)?;
        }
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<bool, DaemonError> {
        let result: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(result == "ok")
    }

    pub(crate) fn get(
        &self,
        sha256: &str,
        source_path: &str,
    ) -> Result<Option<QueuedArtifact>, DaemonError> {
        self.connection
            .query_row(
                "SELECT sha256, size, source, source_path, local_path, modified_at,
                        status, attempts, last_error, redacted, redaction_count
                 FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
                params![sha256, source_path],
                row_to_artifact,
            )
            .optional()
            .map_err(Into::into)
    }
}

fn row_to_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedArtifact> {
    let status: String = row.get(6)?;
    Ok(QueuedArtifact {
        sha256: row.get(0)?,
        size: row.get::<_, i64>(1)?.max(0) as u64,
        source: row.get(2)?,
        source_path: row.get(3)?,
        local_path: PathBuf::from(row.get::<_, String>(4)?),
        modified_at: row.get(5)?,
        status: QueueStatus::parse(&status),
        attempts: row.get(7)?,
        last_error: row.get(8)?,
        redacted: row.get(9)?,
        redaction_count: row.get(10)?,
    })
}
