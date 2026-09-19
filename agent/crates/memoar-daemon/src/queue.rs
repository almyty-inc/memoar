//! The queue table: its rows, its schema, and the migrations onto it.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::DaemonError;

const SCHEMA_VERSION: i64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Pending,
    Retry,
    Synced,
}

impl QueueStatus {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "synced" => Self::Synced,
            "retry" => Self::Retry,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedArtifact {
    pub sha256: String,
    pub size: u64,
    pub source: String,
    pub source_path: String,
    /// Immutable content-addressed snapshot. Sync never re-reads the mutable source file.
    pub local_path: PathBuf,
    pub modified_at: String,
    pub status: QueueStatus,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub redacted: bool,
    pub redaction_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCounts {
    pub pending: u64,
    pub retry: u64,
    pub synced: u64,
}

pub struct OfflineQueue {
    pub(crate) connection: Connection,
    pub(crate) blob_dir: PathBuf,
}

impl OfflineQueue {
    pub fn open(path: &Path) -> Result<Self, DaemonError> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|source| DaemonError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
        let blob_dir = parent.join("blobs");
        fs::create_dir_all(&blob_dir).map_err(|source| DaemonError::Io {
            path: blob_dir.clone(),
            source,
        })?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS artifacts (
               sha256 TEXT NOT NULL,
               source_path TEXT NOT NULL,
               size INTEGER NOT NULL,
               source TEXT NOT NULL,
               local_path TEXT NOT NULL,
               modified_at TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               attempts INTEGER NOT NULL DEFAULT 0,
               last_error TEXT,
               queued_at TEXT NOT NULL,
               synced_at TEXT,
               redacted INTEGER NOT NULL DEFAULT 0,
               redaction_count INTEGER NOT NULL DEFAULT 0,
               next_attempt_at TEXT,
               PRIMARY KEY (sha256, source_path)
             );
             CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status, attempts, queued_at);",
        )?;
        ensure_column(
            &connection,
            "artifacts",
            "redacted",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "artifacts",
            "redaction_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "artifacts", "next_attempt_at", "TEXT")?;
        connection.execute(
            "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self {
            connection,
            blob_dir,
        })
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|candidate| candidate == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}
