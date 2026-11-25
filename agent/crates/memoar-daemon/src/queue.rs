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
        create_private_dir(parent)?;
        let blob_dir = parent.join("blobs");
        create_private_dir(&blob_dir)?;
        // The blobs are the captured transcripts themselves, and the queue
        // used to keep them in a directory every user on the machine could
        // list and read. A directory made by an older agent is tightened.
        restrict_to_owner(&blob_dir)?;
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

/// Creates a directory, and any parent it needs, readable by its owner only.
///
/// On Windows a new directory inherits the ACL of the profile it sits in,
/// which already admits only the user, so there is nothing to add.
fn create_private_dir(path: &Path) -> Result<(), DaemonError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), DaemonError> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.permissions().mode() & 0o077 == 0 {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), DaemonError> {
    Ok(())
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
