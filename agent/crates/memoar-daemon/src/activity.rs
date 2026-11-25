//! When the queue last moved, for telling a working capture from a stopped one.
//!
//! The counts say how much is waiting and nothing about how long it has been
//! waiting. A laptop whose watch died with its terminal kept a queue that
//! looked like any other, and nothing reached the archive for two months.

use rusqlite::params;
use serde::Serialize;

use crate::attempts::MAX_ATTEMPTS;
use crate::error::DaemonError;
use crate::queue::OfflineQueue;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueActivity {
    /// Artifacts still to upload that the queue will offer again. Ones that
    /// have used every attempt are left out, as nothing will send them.
    pub waiting: u64,
    /// The bytes those artifacts add up to, for a progress estimate.
    pub waiting_bytes: u64,
    /// When the oldest of those was queued, RFC 3339.
    pub oldest_waiting_at: Option<String>,
    /// When an artifact last reached the archive, RFC 3339.
    pub last_synced_at: Option<String>,
}

impl OfflineQueue {
    pub fn activity(&self) -> Result<QueueActivity, DaemonError> {
        let (waiting, waiting_bytes, oldest_waiting_at): (i64, i64, Option<String>) =
            self.connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(size), 0), MIN(queued_at) FROM artifacts
                 WHERE status IN ('pending', 'retry') AND attempts < ?1",
                params![MAX_ATTEMPTS],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let last_synced_at: Option<String> = self.connection.query_row(
            "SELECT MAX(synced_at) FROM artifacts WHERE status = 'synced'",
            [],
            |row| row.get(0),
        )?;
        Ok(QueueActivity {
            waiting: waiting.max(0) as u64,
            waiting_bytes: waiting_bytes.max(0) as u64,
            oldest_waiting_at,
            last_synced_at,
        })
    }
}
